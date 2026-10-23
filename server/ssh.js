// SSH 直连节点：持久连接 + 按需重连 + 超时控制
// 注意：按 PRD 假设，节点 SSH 账户需能读取任意进程的 /proc 信息并 kill 任意进程（通常为 root）
import ssh2pkg from 'ssh2';
import { config } from './config.js';

const { Client } = ssh2pkg;

export class SshNode {
  constructor({ ip, port, username, password }) {
    this.ip = ip;
    this.port = port;
    this.username = username;
    this.password = password;
    this.client = null;
    this.ready = false;
    this.connecting = null;
  }

  ensureConnected() {
    if (this.ready && this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.ready = false;
        this.client = null;
        this.connecting = null;
        try {
          conn.end();
        } catch {}
        reject(err);
      };
      conn.on('ready', () => {
        if (settled) return;
        settled = true;
        this.ready = true;
        this.client = conn;
        this.connecting = null;
        resolve(conn);
      });
      conn.on('error', fail);
      conn.on('close', () => {
        this.ready = false;
        this.client = null;
        this.connecting = null;
      });
      conn.connect({
        host: this.ip,
        port: this.port,
        username: this.username,
        password: this.password,
        readyTimeout: config.sshTimeoutSec * 1000,
        keepaliveInterval: 10000,
      });
    });
    return this.connecting;
  }

  // 执行远程命令，返回 {out, err, code}；超时抛错
  async exec(cmd, timeoutSec = config.sshTimeoutSec) {
    const conn = await this.ensureConnected();
    return new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('exec timeout'));
      }, timeoutSec * 1000);
      conn.exec(cmd, (e, stream) => {
        if (e) {
          clearTimeout(timer);
          return reject(e);
        }
        stream.on('data', (d) => (out += d.toString()));
        stream.stderr.on('data', (d) => (err += d.toString()));
        stream.on('close', (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ out, err, code });
        });
      });
    });
  }

  close() {
    this.ready = false;
    this.client = null;
    try {
      if (this.client) this.client.end();
    } catch {}
  }
}

// 连接错误分类（FR-1.1 接入验证步骤 ①② 的失败原因）
export function classifyConnError(err) {
  const code = err && (err.code || '');
  const level = err && err.level;
  if (level === 'client-authentication') {
    return { step: 2, kind: 'auth', message: '登录验证失败（用户名或密码错误）' };
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code) || level === 'client-timeout' || level === 'client-socket') {
    return { step: 1, kind: 'network', message: `网络不可达（${config.sshTimeoutSec} 秒超时）` };
  }
  return { step: 1, kind: 'network', message: (err && err.message) || '连接失败' };
}
