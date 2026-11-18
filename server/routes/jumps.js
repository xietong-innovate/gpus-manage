// 跳板机管理（TDD P1 / FR-N3）：CRUD；凭据 AES 加密、接口永不回显；删除前校验无节点引用
import express from 'express';
import { store, newId } from '../store.js';
import { encrypt } from '../secret.js';
import { closeJumpConn } from '../jump.js';
import { nowISO } from '../util.js';

export const router = express.Router();

function sanitize(j) {
  return {
    jumpId: j.jumpId,
    name: j.name,
    host: j.host,
    port: j.port,
    username: j.username,
    inUse: store.listNodes().filter((n) => n.jumpId === j.jumpId).length,
    createdAt: j.createdAt,
  };
}

router.get('/', (req, res) => {
  res.json({ jumps: store.listJumps().map(sanitize) });
});

// 新增跳板机（host 即跳板地址；username/password 为跳板机登录凭据）
router.post('/', async (req, res) => {
  const { name, host, port, username, password } = req.body || {};
  if (!host || !/^\d{1,3}(\.\d{1,3}){3}$|^[\w.-]+$/.test(String(host))) return res.status(400).json({ error: '跳板机地址格式错误' });
  if (!username || !password) return res.status(400).json({ error: '跳板机 SSH 用户名与密码必填' });
  const jump = {
    jumpId: newId('j'),
    name: (name || '').trim() || `jump-${host}`,
    host: String(host).trim(),
    port: (port && Number(port)) || 22,
    username: String(username),
    cred: encrypt(JSON.stringify({ username, password })),
    createdAt: nowISO(),
  };
  await store.saveJump(jump);
  store.appendAudit({ actor: req.user.username, action: 'jump_create', target: `${jump.name} (${jump.host}:${jump.port})`, reason: '', result: '跳板机已添加' });
  res.json(sanitize(jump));
});

// 编辑（改密码后立即断开池中连接，下一节点操作按新凭据重建）
router.patch('/:jumpId', async (req, res) => {
  const jump = store.getJump(req.params.jumpId);
  if (!jump) return res.status(404).json({ error: '跳板机不存在' });
  const { name, host, port, username, password } = req.body || {};
  if (typeof name === 'string' && name.trim()) jump.name = name.trim();
  if (typeof host === 'string' && host.trim()) jump.host = host.trim();
  if (port) jump.port = Number(port) || 22;
  if (typeof username === 'string' && username) jump.username = username;
  if (typeof password === 'string' && password) jump.cred = encrypt(JSON.stringify({ username: jump.username, password }));
  await store.saveJump(jump);
  closeJumpConn(jump.jumpId); // 凭据/地址变更 → 旧连接作废
  store.appendAudit({ actor: req.user.username, action: 'jump_update', target: `${jump.name} (${jump.host}:${jump.port})`, reason: '', result: '跳板机配置已更新，旧连接已断开' });
  res.json(sanitize(jump));
});

router.delete('/:jumpId', async (req, res) => {
  const jump = store.getJump(req.params.jumpId);
  if (!jump) return res.status(404).json({ error: '跳板机不存在' });
  const refs = store.listNodes().filter((n) => n.jumpId === jump.jumpId);
  if (refs.length > 0) return res.status(409).json({ error: `仍有 ${refs.length} 个节点经此跳板接入（${refs.map((n) => n.ip).join('、')}），请先删除或改其接入方式` });
  store.deleteJump(jump.jumpId);
  closeJumpConn(jump.jumpId);
  store.appendAudit({ actor: req.user.username, action: 'jump_delete', target: `${jump.name} (${jump.host}:${jump.port})`, reason: '', result: '跳板机已删除' });
  res.json({ deleted: true });
});
