// 密钥管理与加密：节点凭据 AES-256-GCM 加密存储（PRD 4.4 敏感数据边界），会话 HMAC 签名
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, config } from './config.js';
import { b64url, unb64url } from './util.js';

const keyFile = path.join(DATA_DIR, 'secret.key');
let key;
if (fs.existsSync(keyFile)) {
  key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
} else {
  key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}

export function decrypt(blob) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
    d.setAuthTag(Buffer.from(blob.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(blob.data, 'hex')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// 会话令牌：payload.signature，payload 为 base64url(JSON {u, exp})
export function signSession(username) {
  const payload = b64url(JSON.stringify({ u: username, exp: Date.now() + config.sessionHours * 3600e3 }));
  const sig = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(unb64url(payload));
    if (!obj.u || !obj.exp || Date.now() > obj.exp) return null;
    return { username: obj.u };
  } catch {
    return null;
  }
}
