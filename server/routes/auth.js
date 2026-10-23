// 管理员认证：首次启动预置初始管理员（adminxt）、登录锁定、会话签发、凭据修改（登录后方可改，旧凭据即时作废）
import express from 'express';
import bcrypt from 'bcryptjs';
import { store } from '../store.js';
import { config } from '../config.js';
import { signSession, verifySession } from '../secret.js';
import { parseCookies } from '../util.js';

export const router = express.Router();

const failTrack = new Map(); // username → {n, lockUntil}

// 首次启动自动创建预置初始管理员（用户名/密码见 config.initialAdmin*，可用环境变量覆盖）
export function ensureInitialAdmin() {
  if (store.getAdmin()) return;
  const username = config.initialAdminUsername;
  store.setAdmin({ username, hash: bcrypt.hashSync(config.initialAdminPassword, 10), createdAt: new Date().toISOString() });
  store.appendAudit({ actor: username, action: 'setup', target: username, reason: '首次部署预置初始管理员', result: '成功（建议登录后尽快在"改账号"中修改用户名与密码）' });
}

export function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[config.cookieName];
  const user = verifySession(token);
  // 会话用户必须是当前管理员：修改凭据后，旧用户名签发的所有会话立即失效
  const admin = user ? store.getAdmin() : null;
  if (!admin || user.username !== admin.username) return res.status(401).json({ error: '未登录或会话已失效' });
  req.user = user;
  next();
}

function setSession(res, username) {
  res.cookie(config.cookieName, signSession(username), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.sessionHours * 3600 * 1000,
  });
}

function validatePassword(pwd) {
  if (typeof pwd !== 'string' || pwd.length < 10) return '密码长度不得少于 10 位';
  if (!/[a-zA-Z]/.test(pwd) || !/[0-9]/.test(pwd)) return '密码须同时包含字母与数字';
  return null;
}

// 状态：是否已初始化管理员（预置账户在启动时自动创建，正常恒为 true，保留字段兼容前端）
router.get('/status', (req, res) => {
  const admin = store.getAdmin();
  const token = parseCookies(req.headers.cookie)[config.cookieName];
  const user = verifySession(token);
  res.json({ initialized: !!admin, user: user ? user.username : null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = store.getAdmin();
  const t = failTrack.get(username) || { n: 0, lockUntil: 0 };
  if (t.lockUntil > Date.now()) {
    return res.status(423).json({ error: `失败次数过多，已锁定，请 ${Math.ceil((t.lockUntil - Date.now()) / 60000)} 分钟后重试` });
  }
  if (!admin || admin.username !== username || !bcrypt.compareSync(String(password || ''), admin.hash)) {
    t.n += 1;
    if (t.n >= config.loginMaxFails) {
      t.lockUntil = Date.now() + config.lockMinutes * 60000;
      t.n = 0;
      store.appendAudit({ actor: username || '未知', action: 'login_locked', target: username, reason: `连续 ${config.loginMaxFails} 次失败`, result: `锁定 ${config.lockMinutes} 分钟` });
    }
    failTrack.set(username, t);
    if (admin) store.appendAudit({ actor: username || '未知', action: 'login_fail', target: username, reason: '密码错误', result: '失败' });
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  failTrack.delete(username);
  store.appendAudit({ actor: username, action: 'login_ok', target: username, reason: '', result: '登录成功' });
  setSession(res, username);
  res.json({ username });
});

router.post('/logout', (req, res) => {
  if (req.user) store.appendAudit({ actor: req.user.username, action: 'logout', target: req.user.username, reason: '', result: '登出' });
  res.clearCookie(config.cookieName);
  res.json({ ok: true });
});

// 修改管理员用户名与密码：必须先用当前（旧）用户名和密码登录（requireAuth）并复核旧密码；
// 成功后唯一管理员记录被整体替换——旧用户名与旧密码即刻删除作废，旧用户名签发的其他会话全部失效
router.post('/credentials', requireAuth, (req, res) => {
  const { oldPassword, newUsername, newPassword } = req.body || {};
  const admin = store.getAdmin();
  if (!bcrypt.compareSync(String(oldPassword || ''), admin.hash)) {
    return res.status(401).json({ error: '旧密码错误' });
  }
  if (typeof newUsername !== 'string' || !/^[a-zA-Z0-9_\-]{3,32}$/.test(newUsername)) {
    return res.status(400).json({ error: '新用户名须为 3-32 位字母、数字、下划线或连字符' });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const usernameChanged = newUsername !== admin.username;
  store.setAdmin({ username: newUsername, hash: bcrypt.hashSync(newPassword, 10), createdAt: admin.createdAt, updatedAt: new Date().toISOString() });
  store.appendAudit({
    actor: req.user.username,
    action: 'cred_change',
    target: usernameChanged ? `${req.user.username} → ${newUsername}` : newUsername,
    reason: '',
    result: '用户名与密码已修改，旧用户名与旧密码已删除（其他已登录会话全部失效）',
  });
  setSession(res, newUsername); // 当前会话平滑切换到新凭据
  res.json({ username: newUsername, usernameChanged });
});
