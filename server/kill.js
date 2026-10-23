// 进程终止（PRD FR-4.2）：优雅终止 → 宽限期 → 强杀兜底；全部写审计；节点强制下线复用同一管线
import { config } from './config.js';
import { store } from './store.js';
import * as state from './state.js';
import { getConn, closeConn } from './collector.js';
import { nowISO } from './util.js';

const activeTasks = new Map(); // taskId → task
const retryWindow = new Map(); // "ip:pid" → {n, from}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function killRetryCheck(ip, pid) {
  const key = `${ip}:${pid}`;
  const now = Date.now();
  const w = retryWindow.get(key);
  if (!w || now - w.from > 60000) {
    retryWindow.set(key, { n: 1, from: now });
    return { ok: true };
  }
  w.n += 1;
  if (w.n > config.killRetryPerMin) return { ok: false, retryAfter: Math.ceil((60000 - (now - w.from)) / 1000) };
  return { ok: true };
}

export function listActiveTasks() {
  return [...activeTasks.values()].filter((t) => !t.settledAt || Date.now() - t.settledAt < 2 * 60 * 1000);
}

function emitTask(t) {
  state.sseSend('kill', t);
}

// 检查节点上进程是否仍在运行（Linux/Windows 两条路径）
async function isAlive(rec, pid) {
  const conn = getConn(rec);
  try {
    if ((rec.platform || 'linux') === 'windows') {
      const r = await conn.exec(`powershell -NoProfile -Command "if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' }"`, 8);
      return /ALIVE/.test(r.out);
    }
    const r = await conn.exec(`ps -o pid= -p ${pid}`, 8);
    return /^\s*\d+\s*$/.test(r.out.trim());
  } catch {
    throw new Error('命令执行失败，无法确认进程状态');
  }
}

async function sendSignal(rec, pid, sig) {
  const conn = getConn(rec);
  if ((rec.platform || 'linux') === 'windows') {
    // Windows 无 POSIX 信号：温和 taskkill（发 WM_CLOSE，GPU 计算进程通常不响应）→ 宽限期后 taskkill /F 强杀
    const cmd = sig === 'KILL' ? `taskkill /F /PID ${pid}` : `taskkill /PID ${pid}`;
    try {
      return await conn.exec(cmd, 10);
    } catch (e) {
      return { code: 1, out: '', err: e.message };
    }
  }
  return conn.exec(`kill -${sig} ${pid}`, 10);
}

// 单个进程的两段式终止；onDone 用于强制下线计数
export async function startKill({ ip, pid, reason, actor }) {
  const rec = store.getNode(ip);
  const snap = state.getSnapshot(ip);
  let gpuIndex = null;
  let procInfo = null;
  for (const g of (snap && snap.gpus) || []) {
    const p = g.processes.find((x) => x.pid === pid);
    if (p) {
      gpuIndex = g.index;
      procInfo = p;
      break;
    }
  }
  const grace = config.killGraceSec;
  const task = {
    id: `k${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    type: 'kill',
    ip,
    pid,
    gpuIndex,
    reason,
    actor,
    user: (procInfo && procInfo.user) || null,
    env: (procInfo && procInfo.env && procInfo.env.label) || null,
    memMB: (procInfo && procInfo.memMB) || null,
    state: 'init',
    graceSec: grace,
    startedAt: nowISO(),
    message: '',
  };
  activeTasks.set(task.id, task);
  emitTask(task);
  runKill(task, rec).finally(() => {
    task.settledAt = Date.now();
    emitTask(task);
  });
  return task;
}

async function runKill(task, rec) {
  try {
    // 发起时进程已不存在 → 仅记备注，不写终止审计（PRD FR-4.3）
    const alive0 = await isAlive(rec, task.pid);
    if (!alive0) {
      task.state = 'gone';
      task.message = '进程已退出，无需终止';
      store.appendAudit({ actor: task.actor, action: 'kill_target_gone', target: `${task.ip} PID ${task.pid}`, reason: task.reason, result: '发起时进程已不存在' });
      return;
    }

    // ① 优雅终止
    await sendSignal(rec, task.pid, 'TERM');
    task.state = 'grace';
    task.message = `已发送优雅终止信号，宽限期 ${task.graceSec} 秒`;
    emitTask(task);

    const deadline = Date.now() + task.graceSec * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const alive = await isAlive(rec, task.pid);
      if (!alive) {
        task.state = 'done';
        task.message = '进程已退出（宽限期内响应优雅终止）';
        store.appendAudit({ actor: task.actor, action: 'kill_graceful', target: `${task.ip} GPU${task.gpuIndex} PID ${task.pid}${task.user ? `（属主 ${task.user}）` : ''}`, reason: task.reason, result: '优雅终止成功，显存已释放' });
        return;
      }
    }

    // ② 宽限期届满 → 强杀兜底
    await sendSignal(rec, task.pid, 'KILL');
    await sleep(1000);
    const still = await isAlive(rec, task.pid);
    task.state = still ? 'failed' : 'forced';
    task.message = still ? '强制终止未能结束进程（权限不足或进程不可杀）' : '宽限期届满，已强制终止';
    store.appendAudit({
      actor: task.actor,
      action: still ? 'kill_unknown' : 'kill_forced',
      target: `${task.ip} GPU${task.gpuIndex} PID ${task.pid}${task.user ? `（属主 ${task.user}）` : ''}`,
      reason: task.reason,
      result: still ? '强杀后进程仍在，建议走节点维护流程' : '强制终止成功',
    });
  } catch (err) {
    task.state = 'unknown';
    task.message = `无法确认终止结果：${err.message}`;
    store.appendAudit({ actor: task.actor, action: 'kill_unknown', target: `${task.ip} PID ${task.pid}`, reason: task.reason, result: `执行异常：${err.message}` });
  }
}

// 节点强制下线（FR-1.3）：逐进程走同一管线，完成后删除节点
export async function forceDeleteNode(rec, { actor, reason }) {
  const snap = state.getSnapshot(rec.ip);
  const procs = [];
  for (const g of (snap && snap.gpus) || []) {
    for (const p of g.processes) procs.push({ pid: p.pid, gpuIndex: g.index, p });
  }
  const task = {
    id: `d${Date.now().toString(36)}`,
    type: 'forcedelete',
    ip: rec.ip,
    total: procs.length,
    done: 0,
    state: procs.length ? 'killing' : 'deleting',
    actor,
    reason,
    startedAt: nowISO(),
    message: procs.length ? `正在按两段式规则清理 ${procs.length} 个进程` : '无活动进程，直接删除',
  };
  activeTasks.set(task.id, task);
  emitTask(task);

  (async () => {
    for (const { pid, gpuIndex } of procs) {
      const t = await startKill({ ip: rec.ip, pid, reason, actor });
      // 等待该进程任务结束（上限：宽限期 + 10s）
      const limit = Date.now() + (t.graceSec + 10) * 1000;
      while (!t.settledAt && Date.now() < limit) await sleep(500);
      task.done += 1;
      task.message = `已处理 ${task.done}/${task.total} 个进程`;
      emitTask(task);
    }
    store.deleteNode(rec.ip);
    closeConn(rec.ip);
    state.clearSnapshot(rec.ip);
    task.state = 'done';
    task.message = '节点已删除';
    task.settledAt = Date.now();
    store.appendAudit({ actor, action: 'node_force_delete', target: rec.ip, reason, result: `强制下线完成，共清理 ${procs.length} 个进程` });
    emitTask(task);
  })().catch(() => {});
  return task;
}
