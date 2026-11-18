// 节点接入管理（PRD FR-1 + TDD P0/P1）：nodeId 寻址、站点维度、显式接入方式（direct/jump）、批量绑定 / 删除（强制下线）/ 维护 / 凭据轮换
import express from 'express';
import { store, newId } from '../store.js';
import * as state from '../state.js';
import { verifyChain, closeConn } from '../collector.js';
import { forceDeleteNode } from '../kill.js';
import { encrypt } from '../secret.js';
import { parseIpLine, nowISO } from '../util.js';

export const router = express.Router();

const isLocalIp = (ip) => ip === '127.0.0.1' || ip === 'localhost';
const ACCESS_MODES = ['direct', 'jump'];

function sanitize(rec) {
  return {
    nodeId: rec.nodeId,
    site: rec.site || 'default',
    accessMode: rec.accessMode || 'direct',
    jumpId: rec.jumpId || null,
    ip: rec.ip,
    port: rec.port,
    name: rec.name,
    group: rec.group,
    status: rec.status,
    local: !!rec.local,
    platform: rec.platform || null,
    hasCred: !!rec.cred,
    gpuCount: (rec.gpus || []).length,
    driver: rec.driver || null,
    lastHeartbeat: rec.lastHeartbeat || null,
    failReason: rec.failReason || null,
    hwAlert: rec.hwAlert || null,
    createdAt: rec.createdAt,
  };
}

function emitBind(ip, step, st, detail) {
  state.sseSend('bind', { ip, step, state: st, detail });
}

// 绑定/验证共用的记录创建（P0：显式 accessMode；127.0.0.1 + direct 为本机直连，无需凭据）
function createRecord({ site, accessMode, jumpId, ip, port, name, group, username, password }) {
  const mode = ACCESS_MODES.includes(accessMode) ? accessMode : 'direct';
  const local = mode === 'direct' && isLocalIp(ip);
  if (mode === 'jump' && !store.getJump(jumpId)) throw new Error('所选跳板机不存在');
  return {
    nodeId: newId('n'),
    site: (site || 'default').trim() || 'default',
    accessMode: mode,
    jumpId: mode === 'jump' ? jumpId : null,
    ip,
    port: port || 22,
    local,
    platform: null, // 平台在接入验证时探测（本机直连节点直接取）
    name: name || (local ? '本机' : `node-${ip.split('.')[3]}`),
    group: group || '未分组',
    // direct 远程节点与 jump 目标节点都需要目标凭据；本机直连不需要
    cred: !local && username ? encrypt(JSON.stringify({ username, password })) : null,
    status: 'joining',
    driver: null,
    gpus: [],
    lastHeartbeat: null,
    failReason: null,
    hwAlert: null,
    createdAt: nowISO(),
  };
}

const dupKey = (site, ip, port) => `${(site || 'default').trim() || 'default'}|${ip}|${port || 22}`;

router.get('/', (req, res) => {
  res.json({ nodes: store.listNodes().map(sanitize) });
});

// 批量绑定（FR-1.1）：逐行校验，重复/非法不阻断整批；有效行异步并行验证，进度经 SSE 推送
router.post('/batch', (req, res) => {
  const { text, username, password, port, group, namePrefix, site, accessMode, jumpId } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'IP 清单不能为空' });
  const actor = req.user.username;

  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const result = { parsed: lines.length, accepted: [], invalid: [], duplicate: [], existing: [] };
  const seen = new Set();
  for (const line of lines) {
    const parsed = parseIpLine(line);
    if (!parsed) {
      result.invalid.push({ line, reason: '格式错误（应为 IP 或 IP:端口）' });
      continue;
    }
    const dk = dupKey(site, parsed.ip, parsed.port || port || 22);
    if (seen.has(dk)) {
      result.duplicate.push({ line, ip: parsed.ip, reason: '清单内重复，跳过' });
      continue;
    }
    if (store.getNodeByAddress(site, parsed.ip, parsed.port || (port && Number(port)) || 22)) {
      result.existing.push({ line, ip: parsed.ip, reason: '同站点已存在，跳过（跨站点同 IP 需换站点名）' });
      continue;
    }
    seen.add(dk);
    let rec;
    try {
      rec = createRecord({
        site,
        accessMode,
        jumpId,
        ip: parsed.ip,
        port: parsed.port || (port && Number(port)) || 22,
        name: namePrefix ? `${namePrefix}-${parsed.ip.split('.')[3]}` : undefined,
        group,
        username,
        password,
      });
    } catch (e) {
      result.invalid.push({ line, reason: e.message });
      continue;
    }
    store.saveNode(rec);
    result.accepted.push({ ip: rec.ip, port: rec.port, name: rec.name });
    verifyChain(rec, { actor }).catch(() => {});
  }
  res.json(result);
});

// 新增单个节点（FR-1.2）
router.post('/', (req, res) => {
  const { site, accessMode, jumpId, ip, port, name, group, username, password } = req.body || {};
  if (!parseIpLine(ip || '')) return res.status(400).json({ error: 'IP 格式错误' });
  const sport = (port && Number(port)) || 22;
  if (store.getNodeByAddress(site, ip, sport)) return res.status(409).json({ error: '该站点下此 IP 已绑定（跨站点同 IP 请更换站点名）' });
  let rec;
  try {
    rec = createRecord({ site, accessMode, jumpId, ip, port: sport, name, group, username, password });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  store.saveNode(rec);
  verifyChain(rec, { actor: req.user.username }).catch(() => {});
  res.json(sanitize(rec));
});

// 重新验证（失败行修正凭据后重试 / 常规体检）
router.post('/:nodeId/reverify', async (req, res) => {
  const rec = store.getNode(req.params.nodeId);
  if (!rec) return res.status(404).json({ error: '节点不存在' });
  if (rec.status === 'joining') return res.status(409).json({ error: '该节点正在验证中' });
  rec.status = 'joining';
  await store.saveNode(rec);
  verifyChain(rec, { actor: req.user.username }).catch(() => {});
  res.json({ ok: true, message: '已开始重新验证，进度见页面提示' });
});

// 编辑：改名/分组/维护模式/凭据轮换（FR-1.4）
router.patch('/:nodeId', async (req, res) => {
  const rec = store.getNode(req.params.nodeId);
  if (!rec) return res.status(404).json({ error: '节点不存在' });
  const { name, group, maintenance, username, password } = req.body || {};
  const actor = req.user.username;
  let needVerify = false;
  const target = `${rec.site || 'default'}/${rec.ip}`;

  if (typeof name === 'string' && name.trim()) rec.name = name.trim();
  if (typeof group === 'string' && group.trim()) rec.group = group.trim();
  if (typeof username === 'string' && username && typeof password === 'string' && password) {
    rec.cred = encrypt(JSON.stringify({ username, password }));
    needVerify = true;
    store.appendAudit({ actor, action: 'node_cred_update', target, reason: '', result: `凭据已更新（用户 ${username}）` });
  }
  if (typeof maintenance === 'boolean') {
    if (maintenance && rec.status !== 'maint') {
      rec.status = 'maint';
      store.appendAudit({ actor, action: 'node_maint_on', target, reason: '手动进入维护模式', result: '不参与统计，显卡状态转为未知' });
    } else if (!maintenance && rec.status === 'maint') {
      rec.status = 'online'; // 下一采集周期自动校准（不可达时按心跳规则转离线）
      store.appendAudit({ actor, action: 'node_maint_off', target, reason: '', result: '退出维护模式' });
    }
  }
  await store.saveNode(rec);
  if (needVerify) {
    rec.status = 'joining';
    await store.saveNode(rec);
    verifyChain(rec, { actor }).catch(() => {});
  }
  state.broadcastOverview();
  res.json(sanitize(rec));
});

// 硬件变更确认（FR-1.5）：以最近一次采集结果更新显卡档案
router.post('/:nodeId/reregister', async (req, res) => {
  const rec = store.getNode(req.params.nodeId);
  if (!rec) return res.status(404).json({ error: '节点不存在' });
  const snap = state.getSnapshot(rec.nodeId);
  if (!snap) return res.status(409).json({ error: '该节点当前无可用采集结果，稍后重试' });
  rec.gpus = snap.gpus.map((g) => ({ index: g.index, uuid: g.uuid, model: g.model, totalMemMB: g.totalMemMB }));
  rec.hwAlert = null;
  await store.saveNode(rec);
  store.appendAudit({ actor: req.user.username, action: 'gpu_reregister', target: `${rec.site || 'default'}/${rec.ip}`, reason: req.body?.reason || '硬件变更确认', result: `已按最新采集更新 ${rec.gpus.length} 张显卡档案` });
  state.broadcastOverview();
  res.json(sanitize(rec));
});

// 删除节点（FR-1.3）：有活动进程默认阻止；force 时逐进程走两段式终止再删除
router.delete('/:nodeId', async (req, res) => {
  const rec = store.getNode(req.params.nodeId);
  if (!rec) return res.status(404).json({ error: '节点不存在' });
  const { force, confirm, reason } = req.body || {};
  const actor = req.user.username;

  if (confirm !== rec.ip) return res.status(400).json({ error: '请输入节点 IP 以确认删除' });
  if (force && !(typeof reason === 'string' && reason.trim())) {
    return res.status(400).json({ error: '强制下线必须填写原因' });
  }

  const snap = state.getSnapshot(rec.nodeId);
  const procs = [];
  for (const g of (snap && snap.gpus) || []) {
    for (const p of g.processes) procs.push({ pid: p.pid, gpu: g.index, user: p.user, env: p.env && p.env.label, memMB: p.memMB });
  }

  if (rec.status === 'online' && procs.length > 0 && !force) {
    return res.status(409).json({ error: 'processes_active', processes: procs, message: '该节点存在活动占用进程，默认阻止删除；如需强制请勾选强制下线并填写原因' });
  }

  if (procs.length > 0 && force) {
    const task = await forceDeleteNode(rec, { actor, reason: reason.trim() });
    return res.json({ taskId: task.id, message: '强制下线已启动，正在清理进程并删除节点' });
  }

  store.deleteNode(rec.nodeId);
  closeConn(rec.nodeId);
  state.clearSnapshot(rec.nodeId);
  store.appendAudit({ actor, action: 'node_delete', target: `${rec.site || 'default'}/${rec.ip}`, reason: reason || '', result: '无活动进程，直接删除' });
  state.broadcastOverview();
  res.json({ deleted: true });
});
