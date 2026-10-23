// GPU 管理系统前端 SPA（无构建步骤，直接由后端静态托管）
/* global EventSource */

// ---------- 工具 ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtMB = (mb) => (mb == null ? '—' : mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
const fmtDur = (sec) => {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 时`;
  if (h) return `${h} 时 ${m} 分`;
  return `${m} 分`;
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');

async function api(path, opts = {}) {
  const o = { headers: {}, ...opts };
  if (o.body && typeof o.body !== 'string') {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(path, o);
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && path !== '/api/auth/status') { S.user = null; boot(); throw new Error(data.error || '未登录'); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function toast(msg, kind = '', title = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${title ? `<div class="t1">${esc(title)}</div>` : ''}<div>${esc(msg)}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function openModal(html) {
  closeModal();
  const m = document.createElement('div');
  m.className = 'mask';
  m.innerHTML = `<div class="modal">${html}</div>`;
  m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
  document.body.appendChild(m);
}
function closeModal() { document.querySelectorAll('.mask').forEach((x) => x.remove()); }
window.closeModal = closeModal;

// ---------- 全局状态 ----------
const S = {
  user: null, meta: {}, overview: null, route: '#/dashboard',
  paused: false, selected: null, alerts: [], tasks: [], es: null, bindListener: null,
};
const ST_TXT = { idle: ['空闲', 'st-idle'], busy: ['占用中', 'st-busy'], err: ['故障', 'st-err'], unknown: ['状态未知', 'st-unk'] };
const NODE_TXT = { online: ['在线', 'st-online'], offline: ['离线', 'st-offline'], maint: ['维护中', 'st-maint'], joining: ['接入验证中', 'st-joining'], failed: ['接入失败', 'st-failed'] };
const ST_COLOR = { idle: '#3ddc97', busy: '#5db8ff', err: '#ff7a68', unknown: '#7b8aa5' };

// ---------- 启动 ----------
async function boot() {
  const st = await fetch('/api/auth/status').then((r) => r.json()).catch(() => ({ user: null }));
  if (!st.user) { renderLogin(); return; }
  S.user = st.user;
  S.meta = await fetch('/api/meta').then((r) => r.json()).catch(() => ({}));
  renderMain();
  connectSSE();
  await refreshOverview();
}
window.boot = boot;

function renderLogin() {
  $('#app').innerHTML = `
  <div class="authwrap"><div class="authcard">
    <h1>GPU 管理系统</h1>
    <div class="sub">共享 GPU 集群实时监控与管控</div>
    <label>用户名</label><input id="lg-user">
    <label>密码</label><input id="lg-pass" type="password">
    <button class="btn" style="width:100%;margin-top:16px" onclick="doLogin()">登录</button>
  </div></div>`;
}
window.doLogin = async () => {
  try { await api('/api/auth/login', { method: 'POST', body: { username: $('#lg-user').value.trim(), password: $('#lg-pass').value } }); boot(); }
  catch (e) { toast(e.message, 'err'); }
};
window.doLogout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); };

// ---------- 主框架 ----------
function renderMain() {
  const route = location.hash || S.route;
  $('#app').innerHTML = `
  <div class="topbar">
    <div class="logo">GPU<span>·管理</span></div>
    <span class="ssedot" id="sse-dot"></span>
    <button class="btn ghost sm" id="btn-pause" onclick="togglePause()">暂停刷新</button>
    <div class="spacer"></div>
    <span class="user">${esc(S.user || '')} · 管理员</span>
    <button class="btn ghost sm" onclick="changeCreds()">改账号</button>
    <button class="btn ghost sm" onclick="doLogout()">登出</button>
  </div>
  <div class="layout">
    <nav class="sidenav">
      <a href="#/dashboard" class="${route === '#/dashboard' ? 'active' : ''}">总览</a>
      <a href="#/nodes" class="${route === '#/nodes' ? 'active' : ''}">节点管理</a>
      <a href="#/audit" class="${route === '#/audit' ? 'active' : ''}">审计日志</a>
    </nav>
    <div class="content" id="content"></div>
  </div>`;
  window.addEventListener('hashchange', renderMain);
  renderRoute();
}
window.togglePause = () => {
  S.paused = !S.paused;
  $('#btn-pause').textContent = S.paused ? '恢复刷新' : '暂停刷新';
  toast(S.paused ? '已暂停实时刷新（后台仍在采集）' : '已恢复实时刷新');
};
window.changeCreds = () => {
  openModal(`<h3>修改管理员用户名与密码</h3>
    <div class="sub" style="margin-bottom:10px">需先用当前用户名和密码登录，并复核旧密码。修改成功后旧用户名与旧密码立即删除作废，其他已登录会话全部失效。</div>
    <div class="row"><label>旧密码</label><input id="pw-old" type="password"></div>
    <div class="row"><label>新用户名</label><input id="pw-newuser" placeholder="3-32 位字母/数字/下划线"></div>
    <div class="row"><label>新密码（≥10 位，含字母与数字）</label><input id="pw-new" type="password"></div>
    <div class="row"><label>确认新密码</label><input id="pw-new2" type="password"></div>
    <div class="actions"><button class="btn ghost" onclick="closeModal()">取消</button>
    <button class="btn" onclick="doChangeCreds()">确认修改</button></div>`);
};
window.doChangeCreds = async () => {
  if ($('#pw-new').value !== $('#pw-new2').value) return toast('两次输入的新密码不一致', 'err');
  try {
    const r = await api('/api/auth/credentials', { method: 'POST', body: { oldPassword: $('#pw-old').value, newUsername: $('#pw-newuser').value.trim(), newPassword: $('#pw-new').value } });
    closeModal(); S.user = r.username; renderMain(); toast('已修改：旧用户名与旧密码已作废', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

function renderRoute() {
  const route = location.hash || '#/dashboard';
  S.route = route;
  document.querySelectorAll('.sidenav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === route));
  if (route === '#/nodes') renderNodes();
  else if (route === '#/audit') renderAudit();
  else renderDashboard();
}

async function refreshOverview() {
  try { S.overview = await api('/api/overview'); renderRoute(); } catch {}
}

// ---------- SSE ----------
function connectSSE() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/stream');
  S.es = es;
  es.onopen = () => { const d = $('#sse-dot'); if (d) d.classList.remove('off'); };
  es.onerror = () => { const d = $('#sse-dot'); if (d) d.classList.add('off'); };
  es.addEventListener('snapshot', (e) => {
    if (S.paused) return;
    S.overview = JSON.parse(e.data);
    if (S.route === '#/dashboard') renderDashboard();
    if (S.route === '#/nodes') renderNodes();
  });
  es.addEventListener('bind', (e) => {
    const d = JSON.parse(e.data);
    if (S.bindListener) S.bindListener(d);
  });
  es.addEventListener('kill', (e) => {
    const t = JSON.parse(e.data);
    onKillEvent(t);
  });
  es.addEventListener('alert', (e) => {
    const d = JSON.parse(e.data);
    S.alerts.unshift({ ...d, ts: Date.now() });
    S.alerts = S.alerts.slice(0, 8);
    toast(d.message, d.type === 'node_offline' ? 'err' : 'warn', '集群告警');
    if (S.route === '#/dashboard') renderDashboard();
  });
}

function onKillEvent(t) {
  const i = S.tasks.findIndex((x) => x.id === t.id);
  if (i >= 0) S.tasks[i] = t; else S.tasks.unshift(t);
  if (t.type === 'kill') {
    if (t.state === 'grace') toast(`PID ${t.pid}：已发送优雅终止信号，宽限期 ${t.graceSec}s`, 'warn', '终止执行中');
    if (t.state === 'done') toast(`PID ${t.pid} 已退出（宽限期内优雅退出）`, 'ok', '终止成功');
    if (t.state === 'forced') toast(`PID ${t.pid} 宽限期届满，已强制终止`, 'warn', '强制终止');
    if (t.state === 'gone') toast(`PID ${t.pid} 发起时已退出，无需处理`, '', '目标已消失');
    if (t.state === 'unknown' || t.state === 'failed') toast(t.message || '终止结果未知', 'err', '终止异常');
  } else if (t.type === 'forcedelete') {
    if (t.state === 'done') { toast(`节点 ${t.ip} 已强制下线并删除`, 'ok', '强制下线完成'); if (S.route === '#/nodes') renderNodes(); }
    else toast(t.message || `${t.ip}：${t.done}/${t.total}`, 'warn', '强制下线进行中');
  }
  renderTasks();
  if (S.route === '#/dashboard') renderDashboard();
}

function renderTasks() {
  let box = $('#ktask-box');
  if (!box) return;
  const act = S.tasks.filter((t) => !['done', 'gone', 'forced', 'unknown', 'failed'].includes(t.state) || (t.settledAt && Date.now() - Date.parse(t.settledAt) < 4000));
  if (!act.length) { box.innerHTML = ''; return; }
  box.innerHTML = act.map((t) => {
    const state = t.state === 'grace' || t.state === 'init' || t.state === 'killing'
      ? `<span class="spin"></span> 优雅终止中`
      : esc(t.message || t.state);
    return `<div class="ktask">${t.type === 'forcedelete' ? `节点 ${esc(t.ip)} · 清理 ${t.done}/${t.total}` : `PID ${esc(t.pid)} · ${esc(t.user || '?')} · ${esc(t.env || '')}`}<span>${state}</span></div>`;
  }).join('');
}
setInterval(() => {
  const act = S.tasks.filter((t) => t.state === 'grace' || t.state === 'killing');
  if (act.length) renderTasks();
  S.tasks = S.tasks.filter((t) => !t.settledAt || Date.now() - Date.parse(t.settledAt) < 2 * 60 * 1000);
}, 1000);

// ---------- 总览 ----------
function renderDashboard() {
  const c = $('#content');
  if (!c) return;
  const ov = S.overview;
  if (!ov) { c.innerHTML = '<div class="hint">正在加载实时数据…</div>'; return; }
  const s = ov.summary;
  const paused = S.paused ? '<div class="alertbar errA">实时刷新已暂停，以下为暂停前快照</div>' : '';
  const alertBars = S.alerts.slice(0, 3).map((a) => `<div class="alertbar errA">${esc(a.message)} <span class="mini">${fmtTime(a.ts)}</span></div>`).join('');

  let grid = '';
  const f = S.filter || 'all'; // 状态筛选：all / idle / busy / err / unknown
  for (const n of ov.nodes) {
    const gpus = ov.gpus.filter((g) => g.ip === n.ip && (f === 'all' || g.status === f));
    if (!gpus.length) continue;
    const [txt, cls] = NODE_TXT[n.status] || [n.status, 'st-unk'];
    grid += `<div class="gnode"><b>${esc(n.name)}</b><span>${esc(n.ip)}</span><span class="pill ${cls}">${txt}</span>` +
      `${n.driver ? `<span>驱动 ${esc(n.driver)}</span>` : ''}<span class="mini">心跳 ${fmtTime(n.lastHeartbeat)}</span>` +
      `${n.hwAlert ? '<span style="color:#ffd27a">硬件变更待确认</span>' : ''}</div>`;
    grid += '<div class="gpu-grid">' + gpus.map((g) => gpuCard(g, n)).join('') + '</div>';
  }
  if (!ov.nodes.length) grid = `<div class="alertbar">尚未绑定任何节点。前往 <a href="#/nodes">节点管理</a> 批量绑定 GPU 机器。</div>`;
  else if (f !== 'all' && !grid) grid = `<div class="alertbar">当前没有【${ST_TXT[f] ? ST_TXT[f][0] : f}】状态的显卡。点击对应标签可取消筛选。</div>`;

  const detail = S.selected ? gpuDetail(S.selected) : '';
  c.innerHTML = `
    <h2 class="page">集群总览 <span class="mini">刷新周期 ${S.meta.pollIntervalSec || 5}s</span>${f !== 'all' ? `<span class="mini">（已筛选：仅显示【${ST_TXT[f] ? ST_TXT[f][0] : f}】显卡，点击标签取消）</span>` : ''}</h2>
    ${paused}${alertBars}
    <div class="ktasks" id="ktask-box"></div>
    <div class="chips">
      <span class="chip ${f === 'all' ? 'on' : 'ck'}" onclick="setFilter('all')">总卡数 <b>${s.total}</b></span>
      <span class="chip ${f === 'idle' ? 'on' : 'ck'}" onclick="setFilter('idle')">空闲 <b style="color:var(--ok)">${s.idle}</b></span>
      <span class="chip ${f === 'busy' ? 'on' : 'ck'}" onclick="setFilter('busy')">占用中 <b style="color:var(--busy)">${s.busy}</b></span>
      <span class="chip ${f === 'err' ? 'on' : 'ck'}" onclick="setFilter('err')">故障 <b style="color:var(--err)">${s.err}</b></span>
      <span class="chip ${f === 'unknown' ? 'on' : 'ck'}" onclick="setFilter('unknown')">状态未知 <b style="color:var(--unk)">${s.unknown}</b></span>
      <span class="chip">总显存 <b>${fmtMB(s.totalMemMB)}</b></span>
      <span class="chip">已用 <b>${fmtMB(s.usedMemMB)}</b></span>
    </div>
    ${grid}${detail}`;
  renderTasks();
}

// 状态标签筛选：点击选中，再点同一标签取消（回到全部）
window.setFilter = (key) => {
  S.filter = (S.filter || 'all') === key ? 'all' : key;
  renderDashboard();
};

function gpuCard(g, n) {
  const [txt, cls] = ST_TXT[g.status] || ['状态未知', 'st-unk'];
  const clickable = g.status !== 'unknown' && g.status !== 'err';
  const pct = g.totalMemMB ? Math.min(100, Math.round((g.usedMemMB || 0) / g.totalMemMB * 100)) : 0;
  const barColor = g.status === 'err' ? '#ff7a68' : pct > 85 ? '#ff9e5e' : ST_COLOR[g.status] || '#7b8aa5';
  const sel = S.selected && S.selected.ip === g.ip && S.selected.index === g.index;
  const errTxt = g.status === 'err' ? `（ECC 错误 ${esc(g.eccErr ?? '')}）` : '';
  return `<div class="gpu-card ${clickable ? '' : 'dis'} ${sel ? 'sel' : ''}" ${clickable ? `onclick="selGpu('${g.ip}',${g.index})"` : ''}>
    <div class="gname"><span>${esc(n.name)} GPU${g.index}<span class="mini" style="font-weight:400;margin-left:6px">IP ${esc(g.ip)}</span></span><span class="pill ${cls}">${txt}</span></div>
    <div class="gmem">${esc(g.model)} · 总显存 ${fmtMB(g.totalMemMB)}</div>
    <div class="bar"><i style="width:${pct}%;background:${barColor}"></i></div>
    <div class="gmeta"><span>已用 ${fmtMB(g.usedMemMB)} / ${pct}%</span><span>util ${g.util ?? '—'}%</span></div>
    <div class="gmeta"><span>${g.status === 'err' ? esc(errTxt) : `temp ${g.temp ?? '—'}°C`}</span><span>${g.processes.length} 进程</span></div>
    ${g.leaky ? '<div class="gwarn">无进程但显存异常，疑似泄漏</div>' : ''}
    ${g.status === 'unknown' && n.hwAlert ? '<div class="gwarn">硬件变更待确认</div>' : ''}
  </div>`;
}

function selGpu(ip, index) {
  const g = S.overview.gpus.find((x) => x.ip === ip && x.index === index);
  if (!g) return;
  S.selected = g;
  renderDashboard();
}
window.selGpu = selGpu;

function gpuDetail(g) {
  const n = S.overview.nodes.find((x) => x.ip === g.ip);
  const rows = g.processes.map((p) => `
    <tr>
      <td style="font-family:var(--mono)">${p.pid}</td><td>${esc(p.user)}</td>
      <td><span class="env ${p.env.kind}">${esc(p.env.label)}</span></td>
      <td style="font-family:var(--mono)">${fmtMB(p.memMB)}</td>
      <td>${fmtDur(p.etimes)}</td>
      <td style="font-family:var(--mono);font-size:11.5px">${esc(p.cmd || '不可读')}</td>
      <td><button class="btn danger sm" onclick="openKill('${g.ip}',${g.index},${p.pid})">终止</button></td>
    </tr>`).join('');
  const otherRow = g.dataErr
    ? '<tr><td colspan="3" style="color:#7d8db0">其他 / 系统占用</td><td style="font-family:var(--mono);color:#ff8f7f">数据异常</td><td colspan="3" style="color:#55627e;font-size:11.5px">进程显存之和大于卡级占用，已标记数据质量问题</td></tr>'
    : `<tr><td colspan="3" style="color:#7d8db0">其他 / 系统占用</td><td style="font-family:var(--mono);color:#9fb0c8">${fmtMB(g.otherMemMB)}</td><td colspan="3" style="color:#55627e;font-size:11.5px">驱动上下文与碎片开销 = 卡已用 − Σ进程</td></tr>`;
  const empty = !g.processes.length
    ? `<div class="alertbar" style="margin:8px 0 0">该卡当前无占用进程。${g.leaky ? `显存占用 ${fmtMB(g.usedMemMB)} 高于空闲阈值（${S.meta.idleMemThresholdMB || 500}MB），疑似残留上下文泄漏。` : ''}</div>`
    : '';
  return `<div class="detail" id="gpu-detail">
    <div class="dhead">
      <b>${esc(n.name)} GPU${g.index} 占用明细 <span class="mini" style="font-weight:400">IP ${esc(g.ip)}</span></b>
      <span class="mini">已用 ${fmtMB(g.usedMemMB)} / 总 ${fmtMB(g.totalMemMB)} · ${esc(g.model)} · 状态：${ST_TXT[g.status][0]}</span>
      <button class="btn ghost sm" onclick="S.selected=null;renderDashboard()">关闭</button>
    </div>
    ${g.processes.length ? `<table>
      <tr><th>PID</th><th>属主</th><th>虚拟环境</th><th>显存</th><th>运行时长</th><th>命令行摘要</th><th>操作</th></tr>
      ${rows}${otherRow}
    </table>` : ''}${empty}
  </div>`;
}

// ---------- 终止流程（管理员确认：输入 PID 二次确认；原因改为选填） ----------
function openKill(ip, index, pid) {
  const g = S.overview.gpus.find((x) => x.ip === ip && x.index === index);
  const p = g && g.processes.find((x) => x.pid === pid);
  if (!p) return;
  const grace = S.meta.killGraceSec || 30;
  openModal(`<h3>终止进程确认（管理员最高权限）</h3>
    <div class="kv">节点/GPU：<b>${esc(g.ip)} · GPU${g.index}</b>（${esc(g.model)}）</div>
    <div class="kv">PID：<b>${p.pid}</b>　属主：<b>${esc(p.user)}</b>　环境：<span class="env ${p.env.kind}">${esc(p.env.label)}</span></div>
    <div class="kv">占用显存：<b>${fmtMB(p.memMB)}</b>　已运行：<b>${fmtDur(p.etimes)}</b></div>
    <div class="kv" style="font-family:var(--mono);font-size:11.5px">${esc(p.cmd || '')}</div>
    <div class="warnbox">警告：终止他人进程可能造成不可恢复的现场丢失。系统将先发送优雅终止信号，宽限期 ${grace} 秒后强制终止。</div>
    <div class="row"><label>请输入目标 PID <b>${p.pid}</b> 以确认</label>
      <input id="k-pid" autocomplete="off" placeholder="${p.pid}"></div>
    <div class="actions">
      <button class="btn ghost" onclick="closeModal()">取消</button>
      <button class="btn danger" id="k-go" disabled onclick="doKill('${ip}',${p.pid})">发送终止指令</button>
    </div>`);
  const upd = () => { $('#k-go').disabled = !($('#k-pid').value.trim() === String(p.pid)); };
  $('#k-pid').oninput = upd;
}
window.openKill = openKill;
window.doKill = async (ip, pid) => {
  try {
    await api('/api/processes/kill', { method: 'POST', body: { ip, pid } });
    closeModal();
    toast(`PID ${pid} 终止指令已发出`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

// ---------- 节点管理 ----------
async function renderNodes() {
  const c = $('#content');
  if (!c) return;
  let nodes = [];
  try { nodes = (await api('/api/nodes')).nodes; } catch { return; }
  const rows = nodes.map((n) => {
    const [txt, cls] = NODE_TXT[n.status] || [n.status, 'st-unk'];
    return `<tr>
      <td>${esc(n.name)}<div class="mini">${esc(n.group)}</div></td>
      <td style="font-family:var(--mono)">${esc(n.ip)}:${n.port}</td>
      <td>${n.gpuCount}</td>
      <td style="font-family:var(--mono)">${esc(n.driver || '—')}</td>
      <td>${fmtTime(n.lastHeartbeat)}</td>
      <td><span class="pill ${cls}">${txt}</span>
        ${n.failReason ? `<div class="mini" style="color:#ff8f7f">${esc(n.failReason)}</div>` : ''}
        ${n.hwAlert ? '<div class="mini" style="color:#ffd27a">硬件变更待确认</div>' : ''}</td>
      <td style="white-space:nowrap">
        <button class="btn ghost sm" onclick="toggleMaint('${n.ip}',${n.status === 'maint'})">${n.status === 'maint' ? '恢复' : '维护'}</button>
        ${n.status !== 'online' ? `<button class="btn ghost sm" onclick="reverify('${n.ip}')">重验</button>` : ''}
        ${n.hwAlert ? `<button class="btn ghost sm" onclick="reregister('${n.ip}')">确认档案</button>` : ''}
        <button class="btn danger sm" onclick="openDel('${n.ip}',${n.status === 'online'})">删除</button>
      </td></tr>`;
  }).join('');
  c.innerHTML = `
    <h2 class="page">节点管理 <span class="mini">绑定对象为 GPU 节点（机器）；显卡随接入自动发现登记</span></h2>
    <div class="ktasks" id="ktask-box"></div>
    <div>
      <button class="btn" onclick="openBatch()">批量绑定节点</button>
      <button class="btn ghost" onclick="openAddOne()">新增节点</button>
      <span class="hint" style="display:inline;margin-left:10px">粘贴 IP 清单一次接入全部机器；删除有活动进程的节点须强制下线并确认</span>
    </div>
    <div class="mt">${rows ? `<table><tr><th>名称/分组</th><th>IP:端口</th><th>显卡数</th><th>驱动</th><th>最后心跳</th><th>状态</th><th>操作</th></tr>${rows}</table>` : '<div class="alertbar">还没有任何节点，点击"批量绑定节点"录入首批 GPU 机器。</div>'}</div>`;
  renderTasks();
}

window.toggleMaint = async (ip, inMaint) => {
  try { await api(`/api/nodes/${ip}`, { method: 'PATCH', body: { maintenance: !inMaint } }); renderNodes(); }
  catch (e) { toast(e.message, 'err'); }
};
window.reverify = async (ip) => {
  try { const r = await api(`/api/nodes/${ip}/reverify`, { method: 'POST' }); toast(r.message, 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};
window.reregister = async (ip) => {
  try { await api(`/api/nodes/${ip}/reregister`, { method: 'POST', body: { reason: '界面确认硬件变更' } }); toast('已按最新采集更新显卡档案', 'ok'); renderNodes(); }
  catch (e) { toast(e.message, 'err'); }
};

// 批量绑定（FR-1.1）
window.openBatch = () => {
  openModal(`<h3>批量绑定节点</h3>
    <div class="kv">每行一个 <b>IP</b> 或 <b>IP:端口</b>。整批共用一套节点凭据（加密存储，永不回显）。127.0.0.1 / localhost 为本机直连节点，无需凭据。</div>
    <div class="row"><textarea id="b-text" rows="6" placeholder="127.0.0.1&#10;192.168.1.21:22"></textarea></div>
    <div class="row" style="display:grid;grid-template-columns:1fr 1fr 80px;gap:8px">
      <div><label>SSH 用户名</label><input id="b-user" placeholder="root"></div>
      <div><label>SSH 密码</label><input id="b-pass" type="password"></div>
      <div><label>端口</label><input id="b-port" value="22"></div></div>
    <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><label>分组标签</label><input id="b-group" placeholder="如：一楼机房"></div>
      <div><label>名称前缀（可选）</label><input id="b-prefix" placeholder="如：lab"></div></div>
    <div class="actions">
      <button class="btn ghost" onclick="closeModal()">关闭</button>
      <button class="btn ghost" id="b-parse" onclick="parseBatch()">解析并校验</button>
      <button class="btn" id="b-go" onclick="startBatch()" disabled>开始接入（仅有效行）</button>
    </div>
    <div id="b-result" class="mt"></div>`);
};
window.parseBatch = () => {
  const lines = $('#b-text').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const existing = new Set((S.overview ? S.overview.nodes : []).map((n) => n.ip));
  const seen = new Set();
  const valid = [];
  const rows = lines.map((l) => {
    const m = l.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
    const octetsOk = m ? m[1].split('.').every((s) => Number(s) <= 255) : false;
    const portOk = !m || !m[2] || (Number(m[2]) >= 1 && Number(m[2]) <= 65535);
    let tag, cls;
    if (!m || !octetsOk || !portOk) { tag = '格式错误'; cls = 'st-err'; }
    else if (seen.has(m[1])) { tag = '清单内重复，跳过'; cls = 'st-unk'; }
    else if (existing.has(m[1])) { tag = '已存在，跳过'; cls = 'st-unk'; }
    else { tag = '有效'; cls = 'st-idle'; seen.add(m[1]); valid.push(m[1]); }
    return { ip: l, tag, cls };
  });
  window._batchValid = valid;
  $('#b-result').innerHTML = (rows.length ? `<table><tr><th>行内容</th><th>校验结果</th></tr>` +
    rows.map((r) => `<tr><td style="font-family:var(--mono)">${esc(r.ip)}</td><td><span class="pill ${r.cls}">${r.tag}</span></td></tr>`).join('') + '</table>' : '<div class="hint">没有可解析的行</div>');
  $('#b-go').disabled = valid.length === 0;
};
window.startBatch = async () => {
  const body = {
    text: $('#b-text').value,
    username: $('#b-user') ? $('#b-user').value : undefined,
    password: $('#b-pass') ? $('#b-pass').value : undefined,
    port: $('#b-port') ? Number($('#b-port').value) || 22 : 22,
    group: $('#b-group').value || undefined,
    namePrefix: $('#b-prefix').value || undefined,
  };
  // 仅当有效行含远程节点时必填 SSH 凭据；127.0.0.1/localhost 为本机直连，无需凭据
  const needCred = (window._batchValid || []).some((ip) => ip !== '127.0.0.1' && ip !== 'localhost');
  if (needCred && !body.username) return toast('远程节点必须填写 SSH 用户名；127.0.0.1 / localhost 为本机直连，无需凭据', 'err');
  let r;
  try { r = await api('/api/nodes/batch', { method: 'POST', body }); } catch (e) { return toast(e.message, 'err'); }
  $('#b-go').disabled = true;
  $('#b-result').innerHTML = `<div class="okbox">解析 ${r.parsed} 行：接受 ${r.accepted.length}，无效 ${r.invalid.length}，重复 ${r.duplicate.length}，已存在 ${r.existing.length}</div>
    <table><tr><th>IP</th><th>接入进度</th></tr>
    ${r.accepted.map((a) => `<tr id="bind-${a.ip}"><td style="font-family:var(--mono)">${esc(a.ip)}</td><td><span class="pill st-unk">排队中</span></td></tr>`).join('')}</table>`;
  const STEP_TXT = { 1: '网络可达', 2: '登录验证', 3: 'GPU 清单采集', 4: '登记显卡档案' };
  S.bindListener = (d) => {
    const row = $(`#bind-${d.ip}`);
    if (!row) return;
    const cell = row.children[1];
    if (d.state === 'ok') {
      cell.innerHTML = `<span class="pill st-busy">第${d.step}/4步：${STEP_TXT[d.step] || ''} 通过</span>`;
      if (d.step === 4) { cell.innerHTML = `<span class="pill st-idle">${esc(d.detail || '成功：在线')}</span>`; setTimeout(refreshOverview, 800); }
    } else if (d.state === 'fail') {
      cell.innerHTML = `<span class="pill st-failed">失败：${esc(d.detail || '')}</span>`;
    } else {
      cell.innerHTML = `<span class="pill st-unk">第${d.step}/4步 进行中</span>`;
    }
  };
};
window.openAddOne = () => {
  openModal(`<h3>新增单个节点</h3>
    <div class="row" style="display:grid;grid-template-columns:1fr 1fr 80px;gap:8px">
      <div><label>SSH 用户名</label><input id="a-user" placeholder="root"></div>
      <div><label>SSH 密码</label><input id="a-pass" type="password"></div>
      <div><label>端口</label><input id="a-port" value="22"></div></div>
    <div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><label>IP</label><input id="a-ip" placeholder="192.168.1.50"></div>
      <div><label>分组</label><input id="a-group"></div></div>
    <div class="actions"><button class="btn ghost" onclick="closeModal()">取消</button>
    <button class="btn" onclick="addOne()">接入</button></div>`);
};
window.addOne = async () => {
  try {
    await api('/api/nodes', {
      method: 'POST',
      body: {
        ip: $('#a-ip').value.trim(),
        port: $('#a-port') ? Number($('#a-port').value) || 22 : 22,
        group: $('#a-group').value || undefined,
        username: $('#a-user') ? $('#a-user').value : undefined,
        password: $('#a-pass') ? $('#a-pass').value : undefined,
      },
    });
    closeModal(); toast('已提交接入验证', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

// 删除（FR-1.3）
window.openDel = (ip, online) => {
  let procRows = '';
  if (S.overview) {
    const procs = [];
    for (const g of S.overview.gpus.filter((x) => x.ip === ip)) {
      for (const p of g.processes) procs.push({ ...p, gpu: g.index });
    }
    if (procs.length) {
      procRows = `<div class="errbox">该节点有 ${procs.length} 个活动占用进程，默认阻止删除：
        ${procs.map((p) => `<div class="mini">GPU${p.gpu} · PID <b>${p.pid}</b> · 属主 <b>${esc(p.user)}</b> · ${fmtMB(p.memMB)}</div>`).join('')}</div>`;
    }
  }
  openModal(`<h3>删除节点 ${esc(ip)}</h3>
    ${procRows || '<div class="kv">该节点无活动占用进程（或状态未知），可直接删除。此操作不可撤销。</div>'}
    ${online ? `<label style="display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" id="d-force" style="width:auto"> 强制终止该节点全部进程并删除（两段式终止，全部写入审计）</label>` : ''}
    <div class="row"><label>原因${online ? '（强制时必填）' : '（选填）'}，写入审计</label>
      <textarea id="d-reason" rows="2" placeholder="例如：机器退役，归还机房"></textarea></div>
    <div class="row"><label>请输入节点 IP <b>${esc(ip)}</b> 以确认</label>
      <input id="d-confirm" autocomplete="off" placeholder="${esc(ip)}"></div>
    <div class="actions"><button class="btn ghost" onclick="closeModal()">取消</button>
    <button class="btn danger" id="d-go" disabled onclick="doDel('${ip}')">确认删除</button></div>`);
  const upd = () => {
    const force = $('#d-force') && $('#d-force').checked;
    $('#d-go').disabled = !($('#d-confirm').value.trim() === ip && (!force || $('#d-reason').value.trim().length > 0));
  };
  $('#d-confirm').oninput = upd;
  const f = $('#d-force'); if (f) f.onchange = upd;
  const r = $('#d-reason'); if (r) r.oninput = upd;
};
window.doDel = async (ip) => {
  const force = $('#d-force') && $('#d-force').checked;
  try {
    const r = await api(`/api/nodes/${ip}`, {
      method: 'DELETE',
      body: { force: !!force, confirm: $('#d-confirm').value.trim(), reason: $('#d-reason').value.trim() },
    });
    closeModal();
    toast(r.message || '节点已删除', 'ok');
    S.bindListener = null;
    refreshOverview(); renderNodes();
  } catch (e) {
    if (e.message === 'processes_active') toast('该节点存在活动进程，请勾选强制下线并填写原因', 'err');
    else toast(e.message, 'err');
  }
};

// ---------- 审计 ----------
async function renderAudit() {
  const c = $('#content');
  if (!c) return;
  const action = c.dataset.action || '';
  const actor = c.dataset.actor || '';
  const q = c.dataset.q || '';
  let entries = [];
  try { entries = (await api(`/api/audit?action=${encodeURIComponent(action)}&actor=${encodeURIComponent(actor)}&q=${encodeURIComponent(q)}`)).entries; } catch {}
  const actNames = ['', 'login_ok', 'login_fail', 'login_locked', 'kill_graceful', 'kill_forced', 'kill_unknown', 'kill_target_gone', 'node_bind_ok', 'node_bind_fail', 'node_delete', 'node_force_delete', 'node_offline', 'node_hwchange', 'gpu_reregister', 'audit_delete', 'audit_clear'];
  c.innerHTML = `
    <h2 class="page">审计日志 <span class="mini">支持勾选删除与一键清空（不可恢复）· 删除/清空操作本身会记入一条新审计留痕</span></h2>
    <div class="filters">
      <label>动作</label><select id="f-action">${actNames.map((a) => `<option value="${a}" ${a === action ? 'selected' : ''}>${a || '全部'}</option>`).join('')}</select>
      <label>操作者</label><input id="f-actor" placeholder="如 admin" value="${esc(actor)}" style="min-width:110px">
      <label>目标</label><input id="f-q" placeholder="IP / PID 关键词" value="${esc(q)}" style="min-width:140px">
      <button class="btn sm" onclick="filterAudit()">筛选</button>
      <button class="btn danger sm" id="aud-del" disabled onclick="auditDelSel()">删除所选</button>
      <button class="btn danger sm" onclick="auditClearAll()">清空全部</button>
    </div>
    <div class="count">${entries.length} 条（最近 200 条）</div>
    ${entries.length ? `<table><tr><th style="width:26px"><input type="checkbox" id="ck-all" style="width:auto" onchange="auditToggleAll(this.checked)"></th><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>原因</th><th>结果</th></tr>
      ${entries.map((e) => `<tr><td><input type="checkbox" class="ck-row" data-line="${e.line}" style="width:auto" onclick="auditUpdBtns()"></td><td class="mini">${fmtTime(e.ts)}</td><td>${esc(e.actor)}</td><td><code>${esc(e.action)}</code></td><td style="font-family:var(--mono);font-size:11.8px">${esc(e.target)}</td><td>${esc(e.reason || '—')}</td><td>${esc(e.result)}</td></tr>`).join('')}</table>`
      : '<div class="hint">暂无符合条件的审计记录</div>'}`;
  $('#f-actor').onkeydown = (e) => { if (e.key === 'Enter') filterAudit(); };
  $('#f-q').onkeydown = (e) => { if (e.key === 'Enter') filterAudit(); };
}
window.filterAudit = () => {
  const c = $('#content');
  c.dataset.action = $('#f-action').value;
  c.dataset.actor = $('#f-actor').value.trim();
  c.dataset.q = $('#f-q').value.trim();
  renderAudit();
};

// 审计删除/清空（管理员功能）：line 为审计文件物理行号，由 /api/audit 查询返回
window.auditToggleAll = (ck) => { document.querySelectorAll('.ck-row').forEach((x) => { x.checked = ck; }); auditUpdBtns(); };
window.auditUpdBtns = () => {
  const n = document.querySelectorAll('.ck-row:checked').length;
  const b = $('#aud-del');
  if (b) { b.disabled = n === 0; b.textContent = n ? `删除所选（${n}）` : '删除所选'; }
};
window.auditDelSel = () => {
  const lines = [...document.querySelectorAll('.ck-row:checked')].map((x) => Number(x.dataset.line));
  if (!lines.length) return;
  window._auditDelLines = lines;
  openModal(`<h3>删除所选审计记录</h3>
    <div class="kv">即将删除 <b>${lines.length}</b> 条审计记录，此操作不可恢复。</div>
    <div class="warnbox">删除操作本身会记入一条新审计（动作 audit_delete），用于保留管理痕迹。</div>
    <div class="actions"><button class="btn ghost" onclick="closeModal()">取消</button>
    <button class="btn danger" onclick="doAuditDel()">确认删除</button></div>`);
};
window.doAuditDel = async () => {
  try {
    const r = await api('/api/audit/delete', { method: 'POST', body: { lines: window._auditDelLines } });
    closeModal(); toast(r.message || '已删除', 'ok'); renderAudit();
  } catch (e) { toast(e.message, 'err'); }
};
window.auditClearAll = () => {
  openModal(`<h3>清空全部审计日志</h3>
    <div class="errbox">将删除全部审计记录，此操作不可恢复。清空后系统会保留一条「audit_clear」记录（谁在何时清空）。</div>
    <div class="row"><label>请输入 <b>清空</b> 以确认</label><input id="ac-confirm" autocomplete="off" placeholder="清空"></div>
    <div class="actions"><button class="btn ghost" onclick="closeModal()">取消</button>
    <button class="btn danger" id="ac-go" disabled onclick="doAuditClear()">确认清空</button></div>`);
  $('#ac-confirm').oninput = () => { $('#ac-go').disabled = $('#ac-confirm').value.trim() !== '清空'; };
};
window.doAuditClear = async () => {
  try {
    const r = await api('/api/audit/clear', { method: 'POST' });
    closeModal(); toast(r.message || '已清空', 'ok'); renderAudit();
  } catch (e) { toast(e.message, 'err'); }
};

boot();
