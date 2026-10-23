// 入口：装配路由、实时 SSE、静态前端，启动采集监控
import express from 'express';
import { config, PUBLIC_DIR } from './config.js';
import { store } from './store.js';
import * as state from './state.js';
import { startMonitor } from './collector.js';
import { startKill, killRetryCheck, listActiveTasks } from './kill.js';
import { router as authRouter, requireAuth, ensureInitialAdmin } from './routes/auth.js';
import { router as nodesRouter } from './routes/nodes.js';
import { resolveEnvName } from './util.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

// —— 公开路由：认证状态 / 引导 / 登录 ——
app.use('/api/auth', authRouter);

// —— 其余 API 全部需要登录（PRD 4.4）——
app.use('/api', (req, res, next) => {
  if (req.path === '/meta') return next(); // 前端需要的只读参数
  return requireAuth(req, res, next);
});

// 只读参数：前端展示宽限期/周期等口径
app.get('/api/meta', (req, res) => {
  res.json({
    pollIntervalSec: config.pollIntervalSec,
    killGraceSec: config.killGraceSec,
    idleMemThresholdMB: config.idleMemThresholdMB,
    sessionHours: config.sessionHours,
  });
});

// 总览（初始加载；后续经 SSE 增量推送全量快照）
app.get('/api/overview', (req, res) => {
  res.json(state.buildOverview());
});

// 实时事件流：snapshot / bind / kill / alert
app.get('/api/stream', (req, res) => {
  state.addSseClient(res);
});

// 终止进程（管理员确认）：原因选填（UI 已改为 PID 确认制）；1 分钟重试上限
app.post('/api/processes/kill', async (req, res) => {
  const { ip, pid, reason } = req.body || {};
  const rec = store.getNode(ip || '');
  if (!rec) return res.status(404).json({ error: '节点不存在' });
  const pidNum = Number(pid);
  if (!Number.isInteger(pidNum) || pidNum <= 0) return res.status(400).json({ error: 'PID 不合法' });
  const reasonTxt = typeof reason === 'string' ? reason.trim() : ''; // 原因选填，空则审计记录为 —
  if (rec.status === 'offline') return res.status(409).json({ error: '节点离线，无法发起终止' });
  const rc = killRetryCheck(ip, pidNum);
  if (!rc.ok) return res.status(429).json({ error: `同一进程 1 分钟内最多允许 ${config.killRetryPerMin} 次终止，请 ${rc.retryAfter} 秒后重试` });
  const task = await startKill({ ip, pid: pidNum, reason: reasonTxt, actor: req.user.username });
  res.json({ taskId: task.id, message: '终止指令已进入执行队列' });
});

app.get('/api/kill-tasks', (req, res) => {
  res.json({ tasks: listActiveTasks() });
});

// 审计查询（FR-5）
app.get('/api/audit', (req, res) => {
  const { action, actor, q, from, to, limit } = req.query;
  res.json({ entries: store.queryAudit({ action, actor, q, from, to, limit: Number(limit) || 200 }) });
});

// 虚拟环境识别自检接口（联调用）
app.get('/api/env-resolve', (req, res) => {
  res.json(resolveEnvName(String(req.query.exe || '')));
});

app.use('/api/nodes', nodesRouter);

// —— 静态前端 ——
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(`${PUBLIC_DIR}/index.html`));

// 统一错误出口
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

ensureInitialAdmin(); // 首次启动预置初始管理员（adminxt）
startMonitor();
app.listen(config.port, () => {
  console.log(`[gpu-manager] listening on http://localhost:${config.port}`);
});
