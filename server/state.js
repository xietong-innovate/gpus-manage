// 内存实时状态 + SSE 广播中心
import { config } from './config.js';
import { store } from './store.js';

const snapshots = new Map(); // ip → {ts, driver, gpus:[...]}
const sseClients = new Set();

export function addSseClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

export function sseSend(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

// SSE 心跳，防止中间层断开空闲连接
setInterval(() => {
  for (const res of sseClients) res.write(':hb\n\n');
}, 15000).unref();

export function setSnapshot(ip, snap) {
  snapshots.set(ip, snap);
}

export function getSnapshot(ip) {
  return snapshots.get(ip) || null;
}

export function clearSnapshot(ip) {
  snapshots.delete(ip);
}

// 显卡状态计算（PRD 4.3 唯一口径）：
// 节点非在线/无快照 → 状态未知（绝不沿用旧数据）；eccErr>0 → 故障；
// 有进程 → 占用中；无进程且已用 ≤ 阈值 → 空闲；无进程但超阈值 → 空闲 + leaky 警示
export function buildOverview() {
  const nodesOut = [];
  const gpusOut = [];
  const sum = { total: 0, idle: 0, busy: 0, err: 0, unknown: 0, totalMemMB: 0, usedMemMB: 0 };

  for (const n of store.listNodes()) {
    const snap = snapshots.get(n.ip);
    const live = n.status === 'online' && !!snap;
    nodesOut.push({
      ip: n.ip,
      port: n.port,
      name: n.name,
      group: n.group,
      status: n.status,
      local: !!n.local,
      platform: n.platform || null,
      gpuCount: (n.gpus || []).length,
      driver: (snap && snap.driver) || n.driver || null,
      lastHeartbeat: n.lastHeartbeat || null,
      failReason: n.failReason || null,
      hwAlert: n.hwAlert || null,
      createdAt: n.createdAt,
    });

    for (const reg of n.gpus || []) {
      const s = live ? snap.gpus.find((g) => g.index === reg.index) : null;
      const gpu = {
        ip: n.ip,
        index: reg.index,
        model: reg.model,
        uuid: reg.uuid,
        totalMemMB: reg.totalMemMB,
        usedMemMB: null,
        util: null,
        temp: null,
        status: 'unknown',
        leaky: false,
        eccErr: null,
        otherMemMB: null,
        dataErr: false,
        processes: [],
      };
      if (s) {
        gpu.usedMemMB = s.usedMemMB;
        gpu.util = s.util;
        gpu.temp = s.temp;
        gpu.processes = s.processes;
        const other = s.usedMemMB - s.processes.reduce((t, p) => t + p.memMB, 0);
        if (other < 0) {
          gpu.dataErr = true; // 勾稽异常（PRD 6.6）：显示 — 并标记
        } else {
          gpu.otherMemMB = other;
        }
        const ecc = Number(s.eccErr);
        if (Number.isFinite(ecc) && ecc > 0) {
          gpu.status = 'err';
          gpu.eccErr = s.eccErr;
        } else if (s.processes.length > 0) {
          gpu.status = 'busy';
        } else if (s.usedMemMB <= config.idleMemThresholdMB) {
          gpu.status = 'idle';
        } else {
          gpu.status = 'idle';
          gpu.leaky = true; // 空闲但显存异常（疑似泄漏）
        }
      }
      // 硬件变更未确认的卡位 → 状态未知（PRD FR-1.5）
      if (n.hwAlert && n.hwAlert.changed.includes(reg.index)) gpu.status = 'unknown';
      if (n.status !== 'online') gpu.status = 'unknown';

      sum.total++;
      sum[gpu.status] += 1;
      if (gpu.status !== 'unknown') {
        sum.totalMemMB += reg.totalMemMB;
        sum.usedMemMB += gpu.usedMemMB || 0;
      }
      gpusOut.push(gpu);
    }
  }
  return { summary: sum, nodes: nodesOut, gpus: gpusOut };
}

export function broadcastOverview() {
  sseSend('snapshot', buildOverview());
}
