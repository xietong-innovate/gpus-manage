// 真实 GPU 测试脚本：node test/real-gpu-test.mjs [kill <pid>]
// 默认流程：登录 → 绑定 127.0.0.1 → 等待采集 → 输出节点/显卡状态
// kill 流程：登录 → 对 127.0.0.1 上的 PID 发起终止 → 轮询任务状态与显存变化
const BASE = 'http://localhost:9286';
const CRED = { username: 'adminxt', password: 'XieTong0504@' };

let cookie = '';
async function api(path, opts = {}) {
  const o = { headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) }, ...opts };
  const r = await fetch(BASE + path, o);
  const setC = r.headers.get('set-cookie');
  if (setC) cookie = setC.split(';')[0];
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`[${r.status}] ${data.error || r.statusText}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify(CRED) });
  console.log('登录成功');

  const mode = process.argv[2];
  if (mode === 'kill') {
    const pid = Number(process.argv[3]);
    const t = await api('/api/processes/kill', { method: 'POST', body: JSON.stringify({ ip: '127.0.0.1', pid }) });
    console.log('终止指令已发出:', t.message);
    for (let i = 0; i < 12; i++) {
      await sleep(3000);
      const { tasks } = await api('/api/kill-tasks');
      const task = tasks.find((x) => x.id === t.taskId);
      if (task) console.log(`[${i * 3 + 3}s] state=${task.state} ${task.message || ''}`);
      if (!task || task.settledAt) break;
    }
    const ov = await api('/api/overview');
    for (const g of ov.gpus) console.log(`显存回落检查: GPU${g.index} used=${g.usedMemMB}MB processes=${g.processes.length}`);
    return;
  }

  const bind = await api('/api/nodes', { method: 'POST', body: JSON.stringify({ ip: '127.0.0.1', name: '本机', group: '测试组' }) });
  console.log('绑定请求已受理:', JSON.stringify(bind));
  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    const { nodes } = await api('/api/nodes');
    const n = nodes.find((x) => x.ip === '127.0.0.1');
    if (n) console.log(`[${(i + 1) * 3}s] status=${n.status} platform=${n.platform} driver=${n.driver} gpuCount=${n.gpuCount} fail=${n.failReason || '-'}`);
    if (n && n.status === 'online') break;
  }
  const ov = await api('/api/overview');
  console.log('summary:', JSON.stringify(ov.summary));
  for (const g of ov.gpus) {
    console.log(`GPU${g.index}: ${g.model} 总${g.totalMemMB}MB 已用${g.usedMemMB}MB util=${g.util}% temp=${g.temp}°C 状态=${g.status} 进程数=${g.processes.length}`);
    for (const p of g.processes) {
      console.log(`  PID ${p.pid} ${p.user} ${p.memMB}MB env=${p.env.label} etime=${p.etimes}s cmd=${(p.cmd || '').slice(0, 80)}`);
    }
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
