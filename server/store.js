// 持久化：admin/nodes/jumps 为 JSON 文件（原子写），审计为 JSONL 追加；
// 节点以 nodeId 为唯一键（跨网段/地址重叠场景），启动时自动迁移旧 ip 键档案
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const adminFile = path.join(DATA_DIR, 'admin.json');
const nodesFile = path.join(DATA_DIR, 'nodes.json');
const jumpsFile = path.join(DATA_DIR, 'jumps.json');
const auditFile = path.join(DATA_DIR, 'audit.jsonl');

export const newId = (prefix) => prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 近似原子写：先写临时文件再替换（Windows 上 rename 不覆盖已存在文件，先删后换）
function saveJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
}

// 串行化写，避免并发轮询保存交错
let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- 节点：nodeId 主键 + 旧档案迁移（P0，TDD §4.1） ----------
const nodes = new Map(); // nodeId → 节点档案
{
  const list = loadJson(nodesFile, []);
  let migrated = false;
  for (const n of list) {
    if (!n.nodeId) {
      migrated = true;
      n.nodeId = newId('n');
      n.site = n.site || 'default';
      n.accessMode = n.accessMode || 'direct';
      n.jumpId = n.jumpId || null;
    }
    nodes.set(n.nodeId, n);
  }
  if (migrated && list.length) {
    try {
      if (fs.existsSync(nodesFile)) fs.copyFileSync(nodesFile, nodesFile + '.bak');
    } catch {}
    saveJson(nodesFile, [...nodes.values()]);
    console.log(`[store] 节点档案已迁移至 nodeId 主键（备份：nodes.json.bak，共 ${list.length} 条）`);
  }
}

// ---------- 跳板机集合（P1） ----------
const jumps = new Map(); // jumpId → {jumpId, name, host, port, username, cred, createdAt}
for (const j of loadJson(jumpsFile, [])) jumps.set(j.jumpId, j);

export const store = {
  getAdmin() {
    return loadJson(adminFile, null);
  },
  setAdmin(admin) {
    saveJson(adminFile, admin);
  },

  listNodes() {
    return [...nodes.values()];
  },
  getNode(nodeId) {
    return nodes.get(nodeId) || null;
  },
  // 按 站点+地址 查重（跨站点允许同 IP）
  getNodeByAddress(site, ip, port) {
    return [...nodes.values()].find((n) => n.site === (site || 'default') && n.ip === ip && Number(n.port) === Number(port || 22)) || null;
  },
  saveNode(rec) {
    nodes.set(rec.nodeId, rec);
    return serialized(() => saveJson(nodesFile, [...nodes.values()]));
  },
  deleteNode(nodeId) {
    nodes.delete(nodeId);
    return serialized(() => saveJson(nodesFile, [...nodes.values()]));
  },

  listJumps() {
    return [...jumps.values()];
  },
  getJump(jumpId) {
    return jumps.get(jumpId) || null;
  },
  saveJump(j) {
    jumps.set(j.jumpId, j);
    return serialized(() => saveJson(jumpsFile, [...jumps.values()]));
  },
  deleteJump(jumpId) {
    jumps.delete(jumpId);
    return serialized(() => saveJson(jumpsFile, [...jumps.values()]));
  },

  // 审计：只追加；entry = {ts, actor, action, target, reason, result}
  appendAudit(entry) {
    const line = JSON.stringify({ ts: entry.ts || new Date().toISOString(), ...entry });
    fs.appendFileSync(auditFile, line + '\n');
  },
  queryAudit({ action, actor, q, from, to, limit = 200 } = {}) {
    let raw;
    try {
      raw = fs.readFileSync(auditFile, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (!text) continue;
      let e;
      try {
        e = JSON.parse(text);
      } catch {
        continue;
      }
      if (action && !String(e.action).includes(action)) continue;
      if (actor && !String(e.actor).includes(actor)) continue;
      if (q && !String(e.target || '').includes(q)) continue;
      if (from && e.ts < from) continue;
      if (to && e.ts > to) continue;
      e.line = i + 1; // 物理行号（1-based），删除接口按此定位
      out.push(e);
    }
    return out.reverse().slice(0, Math.min(limit, 1000));
  },
  // 按物理行号删除审计条目：读全文 → 跳过所选行 → 原子重写；返回实际删除条数。
  // 与 appendAudit 均为同步 fs 操作，Node 单线程下不会交错；追加只会发生在文件尾部，已查询行号不受影响
  deleteAuditLines(lineSet) {
    let raw;
    try {
      raw = fs.readFileSync(auditFile, 'utf8');
    } catch {
      return 0;
    }
    const lines = raw.split('\n');
    let deleted = 0;
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] && lineSet.has(i + 1)) { deleted++; continue; }
      kept.push(lines[i]);
    }
    const tmp = auditFile + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n'));
    if (fs.existsSync(auditFile)) fs.rmSync(auditFile, { force: true });
    fs.renameSync(tmp, auditFile);
    return deleted;
  },
  // 清空全部审计（保留文件本身），返回清空前条数
  clearAudit() {
    let raw = '';
    try {
      raw = fs.readFileSync(auditFile, 'utf8');
    } catch {}
    const removed = raw.split('\n').filter(Boolean).length;
    fs.writeFileSync(auditFile, '');
    return removed;
  },
};
