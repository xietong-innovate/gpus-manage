# GPU 管理系统跨网段接入 · 技术实现方案（TDD）

| 项目 | 内容 |
|---|---|
| 文档性质 | 技术实现方案（Technical Design Doc），供开发排期与评审 |
| 编写日期 | 2026-11-14 |
| 上游文档 | [gpu-cross-network-access-prd.md](./gpu-cross-network-access-prd.md)（PRD v0.1，定义场景 S1–S7 与需求 FR-N1~N12，本文不重复其内容） |
| 代码基线 | `src/gpu-manager` @ commit `1ac1d4e`（main 分支） |
| 状态 | **纯方案，未改动任何代码** |

> 阅读方式：第 1–2 章是全局判断（为什么这样分层）；第 3 章按阶段给出**文件级改动清单**，可直接拆任务；第 8 章 ADR 记录关键取舍，评审时重点讨论。

---

## 1. 现状代码盘点

### 1.1 模块与数据流（基线）

```
public/app.js (SPA, SSE 消费)
      ▲ SSE: snapshot/bind/kill/alert
server/index.js (Express, 路由挂载, /api/audit/*)
      ├─ routes/nodes.js    节点 CRUD / 批量绑定 / 重验 / 删除
      ├─ routes/auth.js     登录/改凭据（不动）
      ├─ store.js           Map<ip, rec> 持久化 data/nodes.json + 审计 data/audit.jsonl
      ├─ secret.js          AES 凭据加解密（不动）
      ├─ collector.js       轮询调度 + LocalNode/SshNode 连接管理 + 解析
      │     ├─ ssh.js       ssh2 直连 SshNode: ensureConnected/exec/close
      │     └─ kill.js      两段式终止（复用 getConn 通道）
      └─ state.js           snapshops Map<ip, snapshot> + buildOverview
```

采集主链路：`startMonitor()`（5s tick）→ 逐节点 `getConn(rec)` → `conn.exec(nvidia-smi 查询串)` → 解析 → `state.setSnapshot(ip, snap)` → SSE 全量推送。终止链路：`startKill({ip, pid})` → `isAlive/sendSignal`（同一条 SSH 连接）。

### 1.2 跨网段改造涉及的全部硬编码点（一次盘点，避免遗漏）

| # | 位置 | 现状 | 问题 | 归属阶段 |
|---|---|---|---|---|
| H1 | `collector.js` `isLocalIp()` | `ip === '127.0.0.1' \|\| 'localhost'` 即本机直连 | 反向隧道/端口映射场景下 `127.0.0.1:20022` 会被误判 | P0 |
| H2 | `store.js` | `Map<ip, rec>`，`nodes.json` 以 ip 为键 | 地址重叠互相覆盖（PRD S6） | P0 |
| H3 | `nodes.js` 路由 | `/:ip` 全套（reverify/patch/reregister/delete/force-delete） | 同 IP 跨站点不可寻址 | P0 |
| H4 | `nodes.js` `createRecord` | 无 `site`/`accessMode`；本机判断隐式 | 接入方式无法显式声明 | P0 |
| H5 | `nodes.js` `/batch` | 整批共用一套凭据 | 多网段多凭据要拆多次操作（FR-N6） | P0 |
| H6 | `state.js` | `snapshots Map<ip>`；`buildOverview` 节点/gpu 载荷无 site | 前端无法区分站点 | P0 |
| H7 | `kill.js` | `startKill({ip,...})`；`retryWindow` 键 `"ip:pid"`；审计 `target: task.ip`；`forceDeleteNode` 用 `rec.ip` | 同 H3；跨通道终止无 requestId | P0/P3 |
| H8 | `ssh.js` | 仅 `host+port` 直连；无 `sock` 注入点 | 无法级联跳板（PRD S3） | P1 |
| H9 | `collector.js` `startMonitor` | 固定 5s、无退避、无并发上限、同秒齐发 | WAN/大规模下抖动与雪崩（FR-N8） | P0/P4 |
| H10 | `collector.js` `classifyConnError` | 错误分类面向直连 | 跳板层错误无法与目标节点错误区分（FR-N4 前置） | P1 |
| H11 | `app.js` | `selGpu(ip,...)`/`openKill(ip,...)`/节点行操作全用 ip | 同 H3；需同步切 nodeId | P0 |
| H12 | 全局 | 无任何 Agent/上报通道 | NAT/严格白名单不可达（PRD S4/S5） | P3 |

### 1.3 现有可复用的资产（方案便宜的部分）

- **`exec(cmd, timeoutSec) → {out, err, code}` 已是稳定接口契约**：`LocalNode` 与 `SshNode` 天然同构——这即是现成的"Transport 抽象"，P1 只是加第三个实现，采集/解析层零改动。
- 采集脚本串（Linux/Windows 两套）与解析器与"连接"解耦（`gpuQueryFor(rec)`/`procScriptFor(rec, pids)`），Agent（P3）可原样复用。
- `secret.js` 的 AES 加密、`store.js` 的原子写、审计管线可直接服务跳板凭据与 Agent 令牌。
- `verifyChain()` 已有四步 `onStep` 进度回调，P1 跳板只需在其前插入跳板步。

---

## 2. 目标架构

### 2.1 核心决策：把"如何到达节点"从"节点上做什么"中剥离

```
                ┌────────────────────────────────────────────┐
                │  业务层（不动）：采集脚本、解析、终止规则、审计 │
                └────────────────────────────────────────────┘
                                  ▲ 统一接口 Transport
        ┌──────────────┬─────────┴────────┬───────────────────┐
        │ DirectNode   │ JumpNode        │ AgentChannel       │   ← P4 再加 GatewayChannel
        │ (现有 Ssh/   │ (P1: ssh2 级联  │ (P3: 出站 WSS，   │
        │  LocalNode)  │  forwardOut+sock)│  语义适配成 exec) │
        └──────────────┴────────────────┴───────────────────┘
```

**Transport 接口契约**（以现有 `SshNode` 为蓝本固化）：

```js
// 所有实现必须满足：
interface Transport {
  kind: 'direct' | 'jump' | 'agent' | 'gateway';
  ensureConnected(): Promise<this>;     // 幂等；失败按 H10 分类
  exec(cmd, timeoutSec?): Promise<{out, err, code}>;
  close(): void;
  lastError?: {layer, code, message};   // 供诊断与 UI 徽章
}
```

业务层（`collector.runPollCycle`、`kill.js`）只持有 `Transport`，**不感知**通道差异；跳板/Agent 的差异被压缩在各自实现内部。这是整个方案的支点：P1/P3 的改动量从"波及全链路"降为"新增一个文件 + 一个工厂分支"。

### 2.2 寻址模型变更：`ip` → `(site, nodeId, address)`

```js
// nodes.json 单条记录（向后兼容：旧字段全部保留）
{
  nodeId: 'n_a1b2c3',        // 不可变主键，创建时生成
  site: 'default',           // 站点/网络域（新，必填，UI 可自由命名）
  accessMode: 'direct',      // direct | jump | agent | gateway（新）
  ip: '10.31.29.230',       // 保留原字段名（兼容迁移与审计文本）
  port: 22, jumpId: null, agentId: null,   // 按模式二选一
  // ...其余字段不变
}
```

**路由从 `/:ip` 改为 `/:nodeId`**；展示层一律三元组 `站点/IP(:端口)`。PRD FR-N1/N2/N7 的落点。

---

## 3. 分阶段实现（文件级拆解）

> 阶段间严格串行发布，每阶段独立可回滚（见 §4.3）。人日按 1 名熟悉本代码库的全栈开发估算。

### P0 — 寻址重构 + 显式接入 + 调度退避（一切的前置）

**为什么最先做**：H1–H7、H9、H11 是同一件事（换键）的两面，任何一个新通道挂上去之前，寻址必须先稳定；且它是纯内部重构，外部行为不变，风险最低。

| 文件 | 改动 |
|---|---|
| `store.js` | `Map<ip>`→`Map<nodeId>`；`getNode(ip)`→`getNode(nodeId)`；新增 `getNodeBySiteAddress(site, ip, port)`；启动迁移（§4） |
| `nodes.js` | 全部路由 `/:ip`→`/:nodeId`；`createRecord` 生成 `nodeId`、必填 `site`/`accessMode`；本机直连由 `accessMode==='direct' && rec.local` 显式决定（删 `isLocalIp` 隐式判断）；重复检测口径 `site+ip+port`；`/batch` 支持行内 `ip:port` |
| `collector.js` | `conns`/`failCount` 键换 `nodeId`；`getConn(rec)` 按 `accessMode` 工厂分发（P0 只有 direct 分支，预留 switch）；轮询循环加**退避**：`nextAttemptAt` 时间戳，失败后 `5→10→20→40s`（封顶 60s），成功复位；tick 内加全局并发闸门（`inflight >= 32` 则本轮顺延）；周期加 ±10% 抖动 |
| `state.js` | `snapshots` 键换 `nodeId`；overview 的 node/gpu 载荷加 `site`、`nodeId`、`accessMode` |
| `kill.js` | `startKill({nodeId, pid})`；`retryWindow` 键 `"nodeId:pid"`；审计 `target` 统一 `${site}/${ip}` 格式 |
| `index.js` | `/api/meta` 加 `schemaVersion`；SSE snapshot 载荷版本号 |
| `app.js` | 所有 `selGpu/openKill/节点行操作` 切 `nodeId`；卡片/详情显示 `站点`；节点列表按站点分组；新增节点表单加"站点 + 接入方式"字段 |
| 新文件 `server/migrate.js` | §4 的迁移逻辑独立成模块，启动调用一次 |

**验收**：迁移后旧节点全部自动在线；两个 site 各绑一个同 IP 节点互不覆盖；把一台节点断网，退避生效（采集间隔肉眼可见变长）、恢复后 5s 内回到正常；前端全功能回归（绑定/筛选/下钻/终止/审计/删除）。
**规模**：≈ 5 人日（其中回归 1 人日）。**风险**：换键遗漏——对策：`grep -n "\.ip\b\|/:ip\|byIp" server/ public/` 列出所有命中逐一核对，SSE 载荷新旧字段并存一个版本周期。

### P1 — 跳板机级联（覆盖 PRD S3：堡垒机场景）

**新增文件 `server/jump.js` + `JumpNode` Transport 实现**，核心 40 行：

```js
// ssh2 官方 Connection hopping 模式（forwardOut + sock 注入）
async function openViaJump(jumpConn, targetIp, targetPort) {
  return new Promise((res, rej) =>
    jumpConn.forwardOut('127.0.0.1', 0, targetIp, targetPort, (err, stream) =>
      err ? rej(classifyJumpErr(err)) : res(stream)));
}
// JumpNode.ensureConnected():
//   jumpConn = await jumpPool.acquire(rec.jumpId)   // 见下
//   sock = await openViaJump(jumpConn, rec.ip, rec.port)
//   this.ssh.connect({ sock, ...targetCred })       // 其余与 SshNode 完全一致
```

| 文件 | 改动 |
|---|---|
| 新 `server/jump.js` | `JumpNode`（实现 Transport）+ `jumpPool`：`Map<jumpId, SshNode>` 跨节点复用第一跳连接（ssh2 单 client 可并发多 `forwardOut`，每节点一个独立 channel）；跳板断连时池内全部失效并逐节点重建 |
| 新 `server/routes/jumps.js` | 跳板 CRUD（`data/jumps.json`，凭据走 `secret.js` 加密，接口永不回显，同节点凭据口径）；`DELETE` 前校验无节点引用 |
| `collector.js` | `getConn` 工厂加 `accessMode==='jump'` 分支；`classifyConnError` 扩展：`forwardOut` 错误（典型 `Administratively prohibited` = 堡垒机禁 direct-tcpip、`Connection refused` = 跳板到目标不通、认证类 = 区分跳板/目标用户）映射到 `jump:*` 错误码 |
| `nodes.js` | 绑定/批量绑定支持选 `jumpId`；`verifyChain` 步进改为：`跳板认证 → 目标端口可达 → 目标认证 → GPU 采集 → 登记` |
| `store.js` | 新集合 `jumps`（§4） |
| `app.js` | 节点表单接入方式选"跳板"时出现跳板下拉；节点列表接入方式徽章（直连/跳板）；跳板管理独立小页签（复用凭据表单组件） |

**验收**（对应 PRD M1 用例 2/3/5）：经一级跳板绑定成功且四步进度正确；跳板密码错 → 错误文案指明"跳板认证失败"；跳板下线时终止请求返回"通道不可用"并审计失败原因；同跳板下 2 个节点只建 1 条跳板连接（日志可证）。
**规模**：≈ 4 人日。**风险**：堡垒机禁 `direct-tcpip`——绑定前 `verifyChain` 第一步即探测并给出改用 VPN/Agent 的引导文案（不静默失败）。

### P2 — 连通性分层诊断（FR-N4；纯增量，无重构）

| 文件 | 改动 |
|---|---|
| 新 `server/diag.js` | 六层检查器（L1 解析 → L2 TCP+RTT（`net.connect` 计时，跳板场景测跳板端口）→ L3 SSH 认证（跳板场景先跳板后目标）→ L4 `exec echo`+平台探测 → L5 nvidia-smi 解析 → L6 他人进程可读/`kill -0` 权限）；逐层 `{layer, ok, ms, code, hint}`，失败即停；整体结果可复制文本 |
| `nodes.js` | `POST /api/nodes/:nodeId/diagnose`；审计 `node_diag` |
| `app.js` | 节点行"诊断"按钮 → 结果弹窗（通过/失败/耗时三列 + 一键复制） |

**验收**：PRD M1 用例 3/4；每层耗时记录（WAN 链路评估数据顺带获得）。**规模**：≈ 2 人日。

### P3 — 出站 Agent（FR-N5/N10；覆盖 S4/S5，改动量最大，放最后但价值最高）

**协议**：复用 Express 同端口挂 `ws`，路径 `/api/agent/ws`（新增唯一运行时依赖 `ws`，Agent 端零依赖单文件）。

```
注册: POST /api/agent/enroll {token, hostname, platform, version} → {agentId, secret}
通道: WSS  /api/agent/ws   Bearer agentId:secret
帧:   {type:'hello'} | {type:'heartbeat', ts, ver}          ← Agent
      {type:'snapshot', snap}                                 ← Agent（结构与 state snapshot 完全一致）
      {type:'cmd', requestId, op:'probe'|'kill', payload}     → Agent（白名单指令，非任意 shell）
      {type:'cmd_result', requestId, ok, result}              ← Agent
```

| 文件 | 改动 |
|---|---|
| 新 `server/agent-hub.js` | ws 服务端：连接鉴权、心跳超时（30s）判离线、快照直写 `state.setSnapshot`、指令下发与 `requestId → Promise` 回执等待（超时 10s → `unknown`）、令牌签发/撤销（`data/agents.json`） |
| 新 `agent/agent.mjs` | 单文件客户端：enroll → 长连（指数退避 1→60s 带抖动）→ 周期采集。**采集脚本与 collector 共享**：把 `GPU_QUERY*`/`procScript*` 抽到新 `server/scripts.js`，两边 import 同一份字符串（保证口径永远一致，这是关键设计） |
| `kill.js` | `accessMode==='agent'` 分支：`isAlive/sendSignal` 改走 AgentChannel（语义适配成 exec 同构）；全部指令带 `requestId` 幂等；超时置 `unknown` 后由**下一轮快照的 PID 存在性做事后校正**（复用现有 `kill_target_gone` 逻辑） |
| `routes/nodes.js` | 生成一次性注册令牌接口（24h 有效、可撤销）；节点表单 agent 模式无需 IP（address 可空，展示用 hostname） |
| `state.js` | 接收 agent 快照入口（结构与轮询快照相同，仅来源标记 `via:'agent'`） |
| `index.js` | 挂 ws；HTTPS 建议写入 README（自签证书或前置反代二选一，文档给命令） |
| `app.js` | 节点表单 agent 模式：显示注册令牌 + 安装命令行；徽章"Agent" |

**验收**（对应 PRD M2 全部用例）：NAT 后节点注册成功且管理端无反连；断网 60s 恢复自动重连；终止有回执且审计含 `requestId`；撤销令牌后无法新注册。
**规模**：≈ 8 人日（Agent 客户端 3 + Hub 3 + kill 通道改造与事后校正 2）。**风险**：信任模型反转（节点可伪造上报）——对策在 §5。

### P4 — 站点网关 + 调度强化（S7 与规模；依赖 P3 的 Agent 通道，是它的多路复用版）

- `agent/agent.mjs` 加 `--scan=10.31.29.0/24` 或静态清单模式：网关 Agent 持一组节点凭据，横向 SSH 采集多机、聚合上报（`GatewayChannel` 实现 Transport，`exec` 转发为网关指令）。
- 调度强化（H9 收尾）：站点级默认周期 + 节点覆盖（`site.defaultPollSec`）；带宽估算表输出（N × 周期 × 快照字节）。
- **规模**：≈ 4 人日。P0 的退避/并发已覆盖大部分稳定性诉求，本阶段可视规模压力裁剪。

---

## 4. 数据迁移与发布策略

### 4.1 迁移算法（`server/migrate.js`，P0 一次性）

```
启动 → 读 nodes.json
  ├─ 已含 nodeId（schemaVersion>=2）→ 跳过
  ├─ 无 → 逐条补 {nodeId: 'n_'+crypto.randomUUID().slice(0,8), site:'default', accessMode: rec.local?'direct':'direct', local: !!rec.local}
  ├─ 旧 ip 键 Map → 新 nodeId 键 Map，原 ip 存入 rec.ip
  ├─ 原子写回 + data/nodes.json.bak 备份 + schemaVersion: 2
  └─ 任一步失败 → 拒绝启动并打印备份路径（宁可停机不可半迁移）
```

### 4.2 新增数据文件

`data/jumps.json`（P1）、`data/agents.json`（P3）——均走 `store.js` 原子写与 `secret.js` 加密，`.gitignore` 已排除 `data/`，无泄露面。

### 4.3 发布与回滚

- 每阶段一个独立 commit + 打 tag（`p0-addressing` / `p1-jump` / …），GitHub main 直接发（现单人节奏）；阶段间禁止交叉改动，回滚 = `git revert` + 恢复 `nodes.json.bak`。
- P0 是唯一动数据结构的阶段，发布前手动 `cp data/nodes.json` 再操作。

---

## 5. 安全设计要点（贯穿各阶段）

1. **凭据三分离**：节点凭据 / 跳板凭据 / Agent 令牌分文件存储，全部过 `secret.js`；接口永不回显（对齐现状）。
2. **跳板**：`jumps.json` 凭据 AES 加密；`DELETE` 需无引用；跳板连接 keepalive 15s。
3. **Agent**：一次性注册令牌（24h、可撤销、单用）→ 长期 secret 可轮换；指令**白名单**（`probe`/`kill` 两个 op，参数服务端拼接，Agent 拒绝任意 shell）——管理端被攻破也无法借 Agent 横向提权；对外入口建议 HTTPS + 反代限流。
4. **审计**：新增动作 `node_diag`、`jump_create/update/delete`、`agent_enroll/revoke/offline`（PRD FR-N11 全量落齐）。
5. **SSH 主机指纹固定**：P1 顺带实现 `hostVerifier` 首次信任 + 变更拒绝（现状缺此防线，直连同样受益）。

---

## 6. 测试策略

- **P0**：现有 `test/real-gpu-test.mjs` 与 parser fixture 保持全绿（换键后立即跑）；新增迁移单测（伪造旧格式 nodes.json → 断言新键与备份）。
- **P1**：本机可完整模拟——WSL/另一台 Linux 起 sshd 当跳板，Windows 本机当目标；sshd 配 `PermitOpen none` 模拟堡垒机禁转发，验证错误码 `jump:forward-denied` 路径。
- **P2**：诊断每层制造一种失败（改 hosts 名错误、错端口、错密码、卸 nvidia-smi 的 PATH、非 root 账号）断言分层结果。
- **P3**：两台真机（一台做 NAT 模拟：防火墙仅放出站 443）跑 M2 用例；断网恢复用 `pfctl`/`netsh` 直接断。
- 每阶段完成后跑一遍浏览器端到端（登录→绑定→监控→终止→审计）。

## 7. 工作量汇总与建议排期

| 阶段 | 内容 | 人日 | 累计 | 对应 PRD |
|---|---|---|---|---|
| P0 | 寻址重构+显式接入+退避 | 5 | 5 | FR-N1/2/7/8(基础)/9 |
| P1 | 跳板级联 | 4 | 9 | FR-N3/6(凭据档并入) |
| P2 | 分层诊断 | 2 | 11 | FR-N4 |
| P3 | 出站 Agent | 8 | 19 | FR-N5/10/11(后半) |
| P4 | 站点网关+调度强化 | 4 | 23 | FR-N8(收尾)/12 |

建议节奏：**P0+P1+P2 连续交付**（合计 11 人日，覆盖 S1–S3 与 S6，即"10.31.x 两台直连 + 10.32.x 若路由可达也直连、不可达走跳板"的全部近期需求）；P3 单独立项评审（协议与安全模型值得单独过一遍）；P4 按实际节点规模决定做不做。

## 8. 决策记录（ADR）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| ADR-1 | 以现有 `exec()` 契约为 Transport 抽象，不引新框架 | 自建 RPC/gRPC | Local/Ssh 已同构，抽象成本≈0；保持零构建与极少依赖的项目哲学 |
| ADR-2 | 主键 `nodeId` + 必填 `site`，路由整体切 `/:nodeId` | 复合键 `(site,ip)` 进路由 | 路由里塞复合键易错且 URL 丑；nodeId 不可变可承载未来一切（地址/凭据/接入方式都可改） |
| ADR-3 | 跳板在服务端用 `forwardOut+sock` 级联，不做本地端口映射 | 服务端起本地 `ssh -L` 进程 | 不依赖系统 ssh 二进制、无端口占用、错误可控可分类 |
| ADR-4 | Agent 用 `ws`（WSS）复用 Express 端口 | MQTT/专用 Agent 框架/gRPC | 管理端仍单进程单端口部署；Agent 零依赖单文件；代价是加 1 个运行时依赖 `ws`，可接受 |
| ADR-5 | 采集脚本串抽 `server/scripts.js` 双端共享 | Agent 复制一份脚本 | 口径漂移是监控系统最隐蔽的 bug 源，共享模块一次性根除 |
| ADR-6 | 终止指令 `requestId` 幂等 + 快照事后校正 | 只靠回执 | 断线瞬间的指令结果永远无法同步确认，事后校正是唯一可靠兜底 |
| ADR-7 | P0 强制先行且独立发布 | 与跳板功能合并上线 | 换键改动全链路，混入功能会让回滚与归因都失效 |
| ADR-8 | VPN（WireGuard/Tailscale）不纳入代码，仅写入 README 部署章节 | 系统内自动化配置 VPN | 网络层方案系统零改动即受益；自动化配置 VPN 超出系统职责边界且维护成本高 |

## 9. 开放问题（影响 P1/P3 范围，评审时定）

1. 堡垒机是否允许 TCP 转发（`AllowTcpForwarding`）？——不允许则 P1 对该场景失效，需提前确认（P2 诊断会自动暴露）。
2. Agent 部署形态：`node agent.mjs` 即可，还是需要打包单 exe（Windows 节点无 Node 环境）？后者 +2 人日（pkg/nexe 打包）。
3. 管理端对外是否已有 HTTPS 证书/反代条件？——P3 前置。
4. `10.32.83.152` 所在网段从管理端是否路由可达（上一轮待测）？——可达则近期只需 P0，P1/P3 优先级可降。

---

*本方案与 PRD v0.1 配套评审。评审通过后，按 §3 逐阶段开工，每阶段交付时以本文件的"验收"小节作为完成定义（DoD）。*
