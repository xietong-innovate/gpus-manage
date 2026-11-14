// 跳板机级联通道（TDD P1）：服务端 → 跳板机 → 目标节点的 SSH 级联
// 实现：跳板连接按 jumpId 池化复用；目标连接经 forwardOut + sock 注入（ssh2 官方 Connection hopping 模式）
import ssh2pkg from 'ssh2';
import { config } from './config.js';
import { store } from './store.js';
import { decrypt } from './secret.js';
import { SshNode } from './ssh.js';

const { Client } = ssh2pkg;

function jumpCred(jump) {
  return jump.cred ? JSON.parse(decrypt(jump.cred) || '{}') : {};
}

// ---------- 跳板连接池：jumpId → 持久连接 ----------
const jumpPool = new Map(); // jumpId → SshNode（跳板机本身就是一个直连 SSH）

export function getJumpConn(jumpId) {
  const jump = store.getJump(jumpId);
  if (!jump) throw new Error('跳板机不存在（可能已被删除）');
  let c = jumpPool.get(jumpId);
  const cred = jumpCred(jump);
  if (!c || c.username !== cred.username || c.password !== cred.password) {
    if (c) c.close();
    c = new SshNode({ ip: jump.host, port: jump.port, username: cred.username, password: cred.password });
    jumpPool.set(jumpId, c);
  }
  return c;
}

export function closeJumpConn(jumpId) {
  const c = jumpPool.get(jumpId);
  if (c) c.close();
  jumpPool.delete(jumpId);
}

// forwardOut 打开跳板 → 目标 22 端口的 TCP 通道；错误分类（堡垒机禁转发 / 目标不通）
function forwardToTarget(conn, ip, port) {
  return new Promise((resolve, reject) => {
    conn.forwardOut('127.0.0.1', 0, ip, port, (err, stream) => {
      if (err) {
        const msg = /prohibited|denied|not allowed/i.test(err.message || '')
          ? `跳板机拒绝转发（堡垒机可能禁用了 TCP 转发 / AllowTcpForwarding）`
          : `经跳板机无法到达目标 ${ip}:${port}（连接被拒绝或超时）`;
        const e = new Error(msg);
        e.step = 1;
        e.kind = 'network';
        reject(e);
      } else {
        resolve(stream);
      }
    });
  });
}

// ---------- JumpNode：与 SshNode 同接口的 Transport 实现 ----------
export class JumpNode {
  constructor(rec, cred) {
    this.rec = rec;
    this.ip = rec.ip;
    this.port = rec.port;
    this.username = cred.username;
    this.password = cred.password;
    this.client = null;
    this.ready = false;
    this.connecting = null;
  }

  ensureConnected() {
    if (this.ready && this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      // ① 跳板连接（失败与目标节点失败严格区分，供诊断定位）
      let jumpConn;
      try {
        jumpConn = await getJumpConn(this.rec.jumpId).ensureConnected();
      } catch (err) {
        const e = new Error(`跳板机连接失败：${err.message || '未知错误'}`);
        e.step = 1;
        e.kind = 'network';
        throw e;
      }
      // ② 跳板 → 目标端口转发
      const sock = await forwardToTarget(jumpConn, this.ip, this.port);
      // ③ 目标节点 SSH 登录（经注入的 sock）
      return new Promise((resolve, reject) => {
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
          // 目标认证失败 ≠ 跳板失败：保持原有分类语义
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
          sock,
          host: this.ip, // 仅用于 hostkey 识别
          port: this.port,
          username: this.username,
          password: this.password,
          readyTimeout: config.sshTimeoutSec * 1000,
          keepaliveInterval: 10000,
        });
      });
    })();
    return this.connecting;
  }

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
    const c = this.client;
    this.client = null;
    try {
      if (c) c.end();
    } catch {}
  }
}
