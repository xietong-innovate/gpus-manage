import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const config = {
  port: num('PORT', 9286),
  pollIntervalSec: num('POLL_INTERVAL_SEC', 5),          // 采集/刷新周期（PRD 6.3）
  heartbeatFails: num('HEARTBEAT_FAILS', 3),            // 连续 N 次无数据 → 节点离线
  killGraceSec: num('KILL_GRACE_SEC', 30),              // 终止宽限期（PRD 6.4）
  idleMemThresholdMB: num('IDLE_MEM_THRESHOLD_MB', 500),// 空闲判定显存阈值（PRD 4.3）
  sessionHours: num('SESSION_HOURS', 12),                // 会话闲置过期（PRD 4.4）
  loginMaxFails: num('LOGIN_MAX_FAILS', 5),              // 连续失败锁定阈值
  lockMinutes: num('LOCK_MINUTES', 15),                  // 锁定时长
  sshTimeoutSec: num('SSH_TIMEOUT_SEC', 15),            // 单步 SSH 超时（FR-1.5）
  killRetryPerMin: num('KILL_RETRY_PER_MIN', 3),        // 同进程 1 分钟内重试上限（FR-4.3）
  cookieName: 'gpum_session',
  // 预置初始管理员：首次启动自动创建，登录后可在"改账号"中修改（旧凭据即时作废）
  initialAdminUsername: process.env.INITIAL_ADMIN_USERNAME || 'adminxt',
  initialAdminPassword: process.env.INITIAL_ADMIN_PASSWORD || 'XieTong0504@',
};

fs.mkdirSync(DATA_DIR, { recursive: true });
