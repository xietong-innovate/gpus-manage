// 持久化：admin/nodes 为 JSON 文件（原子写），审计为 JSONL 追加（只增不改不删，PRD FR-5）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const adminFile = path.join(DATA_DIR, 'admin.json');
const nodesFile = path.join(DATA_DIR, 'nodes.json');
const auditFile = path.join(DATA_DIR, 'audit.jsonl');

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

const nodes = new Map(); // ip → 节点档案
for (const n of loadJson(nodesFile, [])) nodes.set(n.ip, n);

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
  getNode(ip) {
    return nodes.get(ip) || null;
  },
  saveNode(rec) {
    nodes.set(rec.ip, rec);
    return serialized(() => saveJson(nodesFile, [...nodes.values()]));
  },
  deleteNode(ip) {
    nodes.delete(ip);
    return serialized(() => saveJson(nodesFile, [...nodes.values()]));
  },

  // 审计：只追加；entry = {ts, actor, action, target, reason, result}
  appendAudit(entry) {
    const line = JSON.stringify({ ts: entry.ts || new Date().toISOString(), ...entry });
    fs.appendFileSync(auditFile, line + '\n');
  },
  queryAudit({ action, actor, q, from, to, limit = 200 } = {}) {
    let lines;
    try {
      lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    const out = [];
    for (const line of lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (action && !String(e.action).includes(action)) continue;
      if (actor && !String(e.actor).includes(actor)) continue;
      if (q && !String(e.target || '').includes(q)) continue;
      if (from && e.ts < from) continue;
      if (to && e.ts > to) continue;
      out.push(e);
    }
    return out.reverse().slice(0, Math.min(limit, 1000));
  },
};
