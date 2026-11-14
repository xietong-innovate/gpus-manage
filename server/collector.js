// 采集核心：本机直连 / SSH 直连 nvidia-smi 采集、进程/虚拟环境解析、硬件变更检测、轮询与接入验证
import { exec as cpExec } from 'node:child_process';
import os from 'node:os';
import { config } from './config.js';
import { store } from './store.js';
import * as state from './state.js';
import { SshNode, classifyConnError } from './ssh.js';
import { JumpNode } from './jump.js';
import { decrypt } from './secret.js';
import { resolveEnvName, nowISO } from './util.js';

const conns = new Map(); // nodeId → Transport（LocalNode/SshNode/JumpNode）
const failCount = new Map(); // nodeId → 连续失败次数
const nextAttempt = new Map(); // nodeId → 下次允许采集的时间戳（失败退避 + 成功周期 ±10% 抖动）
const inflight = new Set();
const MAX_CONCURRENCY = 32; // 全局并发上限（TDD FR-N8）

// ---------- 本机直连：127.0.0.1/localhost 无需 SSH，child_process 直接执行 ----------
export const isLocalIp = (ip) => ip === '127.0.0.1' || ip === 'localhost';

class LocalNode {
  constructor() {
    this.username = os.userInfo().username || 'local';
  }
  ensureConnected() {
    return Promise.resolve(this);
  }
  exec(cmd, timeoutSec = config.sshTimeoutSec) {
    return new Promise((resolve) => {
      cpExec(cmd, { timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ out: stdout || '', err: stderr || (err ? err.message : ''), code: err ? (err.code || 1) : 0 });
      });
    });
  }
  close() {}
}
const localNode = new LocalNode();

// Transport 工厂：按 accessMode 分发（本机直连 / 跳板级联 / SSH 直连）
export function getConn(rec) {
  if (rec.local) return localNode;
  let c = conns.get(rec.nodeId);
  const cred = rec.cred ? JSON.parse(decrypt(rec.cred) || '{}') : {};
  const credSig = `${cred.username}|${cred.password}|${rec.jumpId || ''}`;
  if (!c || c.credSig !== credSig) {
    if (c) c.close();
    c = rec.accessMode === 'jump'
      ? new JumpNode(rec, cred)
      : new SshNode({ ip: rec.ip, port: rec.port, username: cred.username, password: cred.password });
    c.credSig = credSig;
    conns.set(rec.nodeId, c);
  }
  return c;
}

export function closeConn(nodeId) {
  const c = conns.get(nodeId);
  if (c) c.close();
  conns.delete(nodeId);
  failCount.delete(nodeId);
  nextAttempt.delete(nodeId);
}

// ---------- 采集脚本 ----------
// Linux：无嵌套引号，经远程 shell 单层解析
const GPU_QUERY =
  'echo ==GPU==; nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu,ecc.errors.uncorrected.volatile.total --format=csv,noheader,nounits 2>&1; ' +
  'echo ==APPS==; nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>&1; ' +
  'echo ==DRV==; nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits 2>&1 | head -n 1; echo ==END==';

// Windows：powershell 包裹，兼容 cmd / PowerShell 两种默认 shell
const GPU_QUERY_WIN =
  'powershell -NoProfile -Command "echo ==GPU==; nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu,ecc.errors.uncorrected.volatile.total --format=csv,noheader,nounits 2>&1; ' +
  'echo ==APPS==; nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>&1; ' +
  'echo ==DRV==; (nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits 2>&1 | Select-Object -First 1); echo ==END=="';

function procScript(pids) {
  // JS 模板串中 \\0 输出为字面 \0，供远程 shell 执行 tr '\0' ' '
  return `for p in ${pids.join(' ')}; do u=$(ps -o user= -p $p 2>/dev/null); e=$(readlink /proc/$p/exe 2>/dev/null); t=$(ps -o etimes= -p $p 2>/dev/null); c=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-256); echo "$p|$u|$e|$t|$c"; done`;
}

function procScriptWin(pids) {
  // 输出与 Linux 相同的 pid|user|exe|etimes|cmd；exe/cmd 中的 | 替换为空格防串位
  return `powershell -NoProfile -Command "$ids=@(${pids.join(',')}); Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { $u='unknown'; try { $o=Invoke-CimMethod -InputObject $_ -Name GetOwner; if ($o.User) { $u=$o.Domain+'\\'+$o.User } } catch {}; $et=0; try { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $et=[int]((Get-Date)-$p.StartTime).TotalSeconds } } catch {}; $exe=$_.ExecutablePath; $cmd=$_.CommandLine; if ($exe) { $exe=$exe.Replace('|',' ') }; if ($cmd) { $cmd=$cmd.Replace('|',' ') }; Write-Output ($_.ProcessId.ToString()+'|'+$u+'|'+$exe+'|'+$et.ToString()+'|'+$cmd) }"`;
}

const gpuQueryFor = (rec) => ((rec.platform || 'linux') === 'windows' ? GPU_QUERY_WIN : GPU_QUERY);
const procScriptFor = (rec, pids) => ((rec.platform || 'linux') === 'windows' ? procScriptWin(pids) : procScript(pids));

async function detectPlatform(conn) {
  // cmd 输出 %OS%=Windows_NT；PowerShell 输出 $env:OS=Windows_NT；Linux 两者均为字面量
  const r = await conn.exec('echo %OS%; echo $env:OS', 8);
  return /Windows_NT/i.test(String(r.out)) ? 'windows' : 'linux';
}

const NVML_ERR_RE = /command not found|No devices found|Failed to initialize|NVIDIA-SMI has failed|Driver\/library version mismatch|couldn't communicate/i;

// ---------- 解析（导出以便 fixture 测试） ----------
export function parseGpuScriptOutput(text) {
  const body = String(text || '').split('==END==')[0];
  const gpuPart = body.split('==APPS==')[0].split('==GPU==')[1] || '';
  const appsPart = (body.split('==APPS==')[1] || '').split('==DRV==')[0];
  const drvPart = (body.split('==DRV==')[1] || '').trim();

  const gpuLines = gpuPart.split('\n').map((s) => s.trim()).filter(Boolean);
  if (gpuLines.length === 0) {
    return { error: '未检测到 GPU（nvidia-smi 无输出）', gpus: [], apps: [], driver: null };
  }
  if (NVML_ERR_RE.test(gpuLines[0])) {
    return { error: `GPU 清单采集失败：${gpuLines[0].slice(0, 120)}`, gpus: [], apps: [], driver: null };
  }

  const gpus = [];
  for (const line of gpuLines) {
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 7) continue;
    const num = (v) => (/^\d+$/.test(v) ? Number(v) : null);
    gpus.push({
      index: Number(f[0]),
      uuid: f[1],
      model: f[2],
      totalMemMB: num(f[3]) || 0,
      usedMemMB: num(f[4]) || 0,
      util: num(f[5]),
      temp: num(f[6]),
      eccErr: f[7] === '[Not Supported]' || f[7] === '[N/A]' || f[7] === '' ? null : f[7],
    });
  }

  const apps = [];
  for (const line of appsPart.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const f = line.split(',').map((s) => s.trim());
    if (f.length < 3 || !/^GPU-/.test(f[0])) continue;
    apps.push({ uuid: f[0], pid: Number(f[1]), memMB: Number(f[2]) || 0 });
  }

  let driver = drvPart.split('\n').map((s) => s.trim()).filter(Boolean)[0] || null;
  if (driver && NVML_ERR_RE.test(driver)) driver = null;
  return { error: null, gpus, apps, driver };
}

export function parseProcessLines(text) {
  const out = new Map(); // pid → {user, exe, etimes, cmd}
  for (const line of String(text || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    const f = line.split('|');
    const pid = Number(f[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.set(pid, {
      user: f[1] || '未知',
      exe: f[2] || '',
      etimes: /^\d+$/.test(f[3] || '') ? Number(f[3]) : null,
      cmd: f.slice(4).join('|').trim().slice(0, 200),
    });
  }
  return out;
}

// ---------- 真实采集 ----------
async function pollReal(rec) {
  const conn = getConn(rec);
  const r = await conn.exec(gpuQueryFor(rec));
  const parsed = parseGpuScriptOutput(r.out);
  if (parsed.error) {
    const err = new Error(parsed.error);
    err.kind = 'nvml';
    throw err;
  }

  let procInfo = new Map();
  if (parsed.apps.length > 0) {
    const pids = [...new Set(parsed.apps.map((a) => a.pid))];
    const r2 = await conn.exec(procScriptFor(rec, pids));
    procInfo = parseProcessLines(r2.out);
  }

  const gpus = parsed.gpus.map((g) => {
    const processes = parsed.apps
      .filter((a) => a.uuid === g.uuid)
      .map((a) => {
        const pi = procInfo.get(a.pid);
        return {
          pid: a.pid,
          memMB: a.memMB,
          user: pi ? pi.user : '不可读',
          exe: pi ? pi.exe : '',
          cmd: pi ? pi.cmd : '不可读',
          etimes: pi ? pi.etimes : null,
          env: resolveEnvName(pi ? pi.exe : ''),
        };
      })
      .sort((x, y) => y.memMB - x.memMB);
    return { ...g, processes };
  });
  return { ts: nowISO(), driver: parsed.driver, gpus };
}

// ---------- 硬件变更检测（PRD FR-1.5） ----------
function detectHwChange(rec, snap) {
  const reg = rec.gpus || [];
  const disc = snap.gpus || [];
  const changed = [];
  if (reg.length !== disc.length) {
    changed.push(...reg.map((g) => g.index), ...disc.map((g) => g.index));
  } else {
    for (let i = 0; i < reg.length; i++) {
      const d = disc.find((g) => g.index === i);
      if (!d || d.uuid !== reg[i].uuid || d.model !== reg[i].model || d.totalMemMB !== reg[i].totalMemMB) changed.push(i);
    }
  }
  if (changed.length > 0 && !rec.hwAlert) {
    rec.hwAlert = { ts: nowISO(), changed: [...new Set(changed)], detail: '显卡硬件与登记档案不符（换卡/加减卡）' };
    store.saveNode(rec);
    store.appendAudit({ actor: 'system', action: 'node_hwchange', target: `${rec.site || 'default'}/${rec.ip}`, reason: `检测到 ${changed.length} 个卡位硬件变更`, result: '变动卡位转为状态未知，待管理员确认' });
    state.sseSend('alert', { type: 'hwchange', ip: rec.ip, nodeId: rec.nodeId, site: rec.site, message: `节点 ${rec.name || rec.ip} 检测到硬件变更，变动卡位转为状态未知` });
  }
}

// ---------- 轮询循环（失败退避 5→10→20→40s 封顶 60s；成功后 ±10% 抖动周期） ----------
function scheduleNext(nodeId, isFail, fails) {
  const base = config.pollIntervalSec * 1000;
  const delay = isFail
    ? Math.min(60000, base * 2 ** Math.min(fails, 4))
    : Math.round(base * (0.9 + 0.2 * Math.random()));
  nextAttempt.set(nodeId, Date.now() + delay);
}

async function pollNode(rec) {
  if (inflight.has(rec.nodeId)) return;
  inflight.add(rec.nodeId);
  try {
    const snap = await pollReal(rec);
    failCount.set(rec.nodeId, 0);
    let needSave = false;
    if (rec.status !== 'online') {
      rec.status = 'online';
      needSave = true;
    }
    rec.lastHeartbeat = nowISO();
    if (snap.driver && snap.driver !== rec.driver) {
      rec.driver = snap.driver;
      needSave = true;
    }
    detectHwChange(rec, snap);
    state.setSnapshot(rec.nodeId, snap);
    if (needSave || Date.now() - (rec._lastSave || 0) > 60000) {
      rec._lastSave = Date.now();
      await store.saveNode(rec);
    }
    scheduleNext(rec.nodeId, false, 0);
  } catch (err) {
    const n = (failCount.get(rec.nodeId) || 0) + 1;
    failCount.set(rec.nodeId, n);
    scheduleNext(rec.nodeId, true, n);
    if (n >= config.heartbeatFails && rec.status === 'online') {
      rec.status = 'offline';
      await store.saveNode(rec);
      store.appendAudit({ actor: 'system', action: 'node_offline', target: `${rec.site || 'default'}/${rec.ip}`, reason: `连续 ${n} 次采集失败：${err.message || '未知错误'}`, result: '节点转为离线，显卡状态未知' });
      state.sseSend('alert', { type: 'node_offline', ip: rec.ip, nodeId: rec.nodeId, site: rec.site, message: `节点 ${rec.name || rec.ip} 心跳超时，显卡状态转为未知` });
    }
  } finally {
    inflight.delete(rec.nodeId);
  }
}

export async function runPollCycle() {
  const now = Date.now();
  const due = store.listNodes().filter(
    (r) => (r.status === 'online' || r.status === 'offline') && (nextAttempt.get(r.nodeId) || 0) <= now
  );
  // 全局并发闸门：每批最多 MAX_CONCURRENCY 个节点同时采集，超出的下一批继续
  for (let i = 0; i < due.length; i += MAX_CONCURRENCY) {
    await Promise.allSettled(due.slice(i, i + MAX_CONCURRENCY).map((r) => pollNode(r)));
  }
  state.broadcastOverview();
}

export function startMonitor() {
  runPollCycle();
  setInterval(runPollCycle, config.pollIntervalSec * 1000);
}

// ---------- 接入验证链（FR-1.1 四步：网络可达 → 登录 → GPU 清单 → 登记档案） ----------
export async function verifyChain(rec, { onStep = () => {}, actor = 'admin' } = {}) {
  try {
    // ① 网络可达/跳板转发 ② 登录验证（本机直连节点免凭据，直接探测平台）
    if (rec.local) {
      rec.platform = process.platform === 'win32' ? 'windows' : 'linux';
      onStep(1, 'ok', '本机直连');
      onStep(2, 'ok', '本机节点无需凭据');
    } else {
      try {
        await getConn(rec).ensureConnected();
      } catch (err) {
        const cls = classifyConnError(err);
        onStep(cls.step, 'fail', `${err.message || cls.message}${rec.accessMode === 'jump' ? '（经跳板机）' : ''}`);
        throw new Error(err.message || cls.message);
      }
      onStep(1, 'ok', rec.accessMode === 'jump' ? '跳板转发可达' : '');
      onStep(2, 'ok', rec.accessMode === 'jump' ? '经跳板登录成功' : '');
      rec.platform = await detectPlatform(getConn(rec)).catch(() => 'linux');
    }

    // ③ GPU 清单采集
    const r = await getConn(rec).exec(gpuQueryFor(rec));
    const parsed = parseGpuScriptOutput(r.out);
    if (parsed.error) {
      onStep(3, 'fail', parsed.error);
      throw new Error(parsed.error);
    }
    const discovered = parsed.gpus.map((g) => ({ index: g.index, uuid: g.uuid, model: g.model, totalMemMB: g.totalMemMB }));
    onStep(3, 'ok', `发现 ${discovered.length} 张显卡`);

    // ④ 登记显卡档案
    rec.gpus = discovered;
    rec.driver = parsed.driver || null;
    rec.status = 'online';
    rec.failReason = null;
    rec.hwAlert = null;
    rec.lastHeartbeat = nowISO();
    nextAttempt.set(rec.nodeId, 0); // 立即进入首轮采集
    await store.saveNode(rec);
    onStep(4, 'ok', `登记 ${discovered.length} 张显卡`);
    store.appendAudit({ actor, action: 'node_bind_ok', target: `${rec.site || 'default'}/${rec.ip}`, reason: '接入验证通过', result: `自动发现并登记 ${discovered.length} 张显卡` });
    return { ok: true, gpus: discovered };
  } catch (err) {
    rec.status = 'failed';
    rec.failReason = err.message || '接入验证失败';
    await store.saveNode(rec);
    onStep(0, 'fail', rec.failReason);
    store.appendAudit({ actor, action: 'node_bind_fail', target: `${rec.site || 'default'}/${rec.ip}`, reason: '接入验证失败', result: rec.failReason });
    return { ok: false, error: rec.failReason };
  }
}
