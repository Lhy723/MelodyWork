# 后台终端任务的可见与停止

## Decision (2026-11-07)

Product owner approved: **Q1 = B**（会话信息面板列表）, **Q2 = 运行中 + 最近 5 条已结束**,
**Q3 = 不做时间线卡片停止**. 方案 A / C 仅作为历史分析保留，不实施。实现计划见 `implement.md`。

## Goal

用户能在会话里看到当前仍在运行的 Host 后台终端任务，并逐个停止；停止结果（已停止 / 已结束 / 停止失败）在界面上可确认，且只能停止本会话自己的任务。

用户价值：`run_terminal_command` 带 `background: true` 会起一个 Host 拥有的子进程（`pi-terminal-task:*`），`run_background_task` 却能起一个后台 Pi 会话、一个后台 shell，两者在界面上都无法单独停止。现在唯一的出口是切换工作区或停 worker，会连带杀掉该工作区的全部后台终端任务。

## Problem

1. **没有列表。** Host 注册表 `BACKGROUND_TERMINAL_TASKS`（`src-tauri/src/pi_tool_gateway/terminal_tasks.rs:79-85`）没有任何 Tauri 命令暴露；`src-tauri/src/lib.rs:93-199` 的 `invoke_handler` 只有 `list_agent_monitors` / `cancel_agent_monitor`。
2. **`task.cancel` 停不了终端任务。** 命令面 `cancelTask` 只查 worker 的 `this.tasks`（`packages/agent-worker/src/pi/subagent-runtime.ts:541-556`），Host id 必然落 `pi.task_not_found`；只有模型侧工具 `kill_command_or_subagent` 走 Host 分支（`:499-523`）。
3. **界面完全不知道终端任务存在。** `src/` 里对 `pi-terminal-task` / `run_background_task` 的引用为零（只有 `projection-store-patch.test.mjs:278` 一个无关的 `backgroundTasks: true` 测试字面量）。

## Evidence

| 事实 | 证据 |
| --- | --- |
| 终端任务由 `run_terminal_command { background: true }` 创建，不是 `run_background_task` | `src-tauri/src/pi_tool_gateway/terminal_tasks.rs:343-354`（background 分支）→ `:406-509`（`start_background_terminal`） |
| `run_background_task` 是 worker 侧子任务（子 Pi 会话），Host 明确拒绝处理它 | `packages/agent-worker/src/pi/task-tools.ts:129-167`（`spawnSubagent({background:true})`）；`src-tauri/src/pi_tool_gateway.rs:318-320` |
| 启动结果 JSON 含 `task_id` | `terminal_tasks.rs:503-509`；id 前缀 `:34`，生成 `:420-424` |
| 注册表全局、容量 64、结束任务保留到裁剪 | `terminal_tasks.rs:79-85`、`:121-144`、`:35` |
| 归属校验：owner 会话 + 规范化根路径 | `terminal_tasks.rs:520-538` |
| kill 路径：置位 `cancel`、等 ≤5s、返回快照 | `terminal_tasks.rs:580-586`、`:87-97` |
| 已结束的任务不会报错，返回终态快照 | 结束任务保留在注册表（`:121-144` 仅在容量上限时裁剪）；`resolve_control` 的 kill 分支只置位 `cancel` 并等待快照（`:580-586`） |
| 无终端任务 Tauri 命令 | `lib.rs:93-199`；`grep -n "background\\|terminal_task" src-tauri/src/lib.rs` 零命中 |
| 命令面不路由 Host id | `subagent-runtime.ts:541-556` vs `:499-523` |
| `task.changed` 缺 `childSessionId` 会被投影丢弃 | `src/domain/agent/subagent-projection.ts:186-194`；Host 从不发 `task.changed`（`grep` 仅命中恢复逻辑与 Condvar 同名成员） |
| Host 工具失败的错误 scope 是 `tool`，不会终结根轮次 | `src-tauri/src/pi_tool_gateway/request_policy.rs:70-78`；`src/stores/agent-store-pi.ts:41-46` 只把 `run`/`session` 当终结 |
| 工具卡能拿到命令与输出，但没有任务 id 字段 | `src/domain/acp.ts:265-280`；`src/domain/tool-activity.ts:175-206`（`output = contentText || JSON.stringify(rawOutput)`） |
| 面板插件位与属性下钻 | `src/features/chat/session-workspace-content.tsx:410-450`；`agent-workspace.tsx:281,640`；`agent-workspace-view-types.ts:174-177` |
| 监视器先例：list + cancel 两个命令、无归属校验 | `src-tauri/src/pi_monitor_runtime.rs:604-616`；`src/lib/melody-bridge-monitors.ts:29-50` |

详细行号见 `research/task-control-evidence.md` §10。

## Feasibility（选项 A 的前置问题）

时间线工具条目**能**恢复任务 id，但只能靠解析 `entry.output` 的 JSON（启动结果就是 `{"task_id":"pi-terminal-task:…","status":"running",…}`，`terminal_tasks.rs:503-509`；`projectToolText` 原样保留该字符串，`tool-activity.ts:175-206`）。代价与限制：解析纯字符串、无 Schema；条目**没有实时状态**（工具调用在启动后即 `completed`），所以卡片无法知道任务是否仍在跑，也无法显示“已停止”。→ A 可行但信息不足。

## Scope

**In（推荐方案 B）**
- Host 新增两个命令：`list_background_terminal_tasks(sessionId)`、`cancel_background_terminal_task(sessionId, taskId)`，均按会话归属过滤。
- 注册表快照补 `command` 字段（当前结构体不存命令，列表无法自解释）。
- 会话信息面板新增“后台终端任务”小节：运行中优先，逐行停止，停止中/已停止/失败三态。
- 渲染进程：`src/lib/melody-bridge-background-tasks.ts` + 轮询 hook + 纯派生函数 + 组件。
- 列表只传 `{task_id, command, status}`，不传 `output`（模型快照的 output 上限 64 KiB，轮询会放大成 MB 级 IPC）。

**Out**
- 会话级停止（已撤销本次范围：输入框停止仍是唯一会话停止入口）。
- `run_background_task` 子任务（worker 子代理）的独立停止——它已由 `task.cancel` 覆盖但无 UI，单独立项。
- 监视器清单的归属修复、`stop_pi_worker` / 工作区切换的爆炸半径。
- 重启后恢复：注册表是内存态，进程随 Host 退出而消失。

## Options

| | A 工具卡停止 | B 信息面板列表（推荐） | C 并入监视器清单 |
| --- | --- | --- | --- |
| 入口 | 时间线 `run_terminal_command` 卡片 | 会话信息面板“后台终端任务” | 现有“监视器”小节 |
| 数据来源 | 解析卡片 `output` 的 `task_id` | 新 Host 列表命令（注册表真值） | 两注册表合并 |
| 实时状态 | 无（卡片是启动瞬间快照） | 有（每轮轮询） | 有 |
| Host 改动 | 1 个取消命令 | 列表 + 取消两个命令 + 快照加 `command` | 合并命令，需改 `pi_monitor_runtime.rs` |
| 归属 | `authorize_background_task` | 同左 | 监视器清单无归属，需先补 |
| 失败文案 | 卡片内一行 | 行内一行 + `title` | 同 B |
| 新增/改动 LOC | ~160 src + ~45 Rust | ~280 src + ~100 Rust + ~90 test | ~150 src + ~60 Rust |
| 主要风险 | 任务跑完后卡片仍是“可停”；用户要翻历史 | 多两个命令与一份轮询 | 触碰禁改文件，且继承监视器归属缺陷 |

### A. 工具卡停止

- 文件/LOC：新 `src/domain/agent/background-terminal-task.ts`（~45，解析 + 前缀校验 + 单测）；`tool-task-rows.tsx` +35（按钮）、`tool-task-group.tsx` +10；新 `src/hooks/use-background-terminal-tasks.ts`（~55，取消态与刷新）；`src/lib/melody-bridge-background-tasks.ts`（~25）；Rust 取消命令 + wrapper（~45）。
- 协议/Host：新 `cancel_background_terminal_task`（见“协议选择”）。
- 归属：Host `authorize_background_task`（`terminal_tasks.rs:520-538`）。
- 失败文案：卡片内 `停止失败：<message>`；已结束显示 `任务已结束`。
- 验收：能从 `output` 解析出 id 且前缀匹配；按钮仅在解析成功时出现；停止后卡片显示终态。

### B. 信息面板列表（推荐）

- 文件/LOC：Rust 新 `src-tauri/src/background_task_runtime.rs`（~70：两个命令 + DB 取 cwd）、`pi_tool_gateway.rs` +20（两个 wrapper）、`terminal_tasks.rs` +6（`command` 字段 + 快照）、`lib.rs` +2、`permissions/default.toml` +2；渲染进程 `src/lib/melody-bridge-background-tasks.ts`（~40）、`src/hooks/use-background-terminal-tasks.ts`（~75）、`src/domain/agent/background-task-list.ts`（~35）、`src/features/chat/background-task-list.tsx`（~110）、`session-workspace-content.tsx` +8、`agent-workspace.tsx` +10、view 类型与转交 +6、测试 ~90。
- 协议/Host：两个新 Tauri 命令；不动 agent 协议。
- 归属：命令按 `sessionId` 从 SQLite 取 `cwd`（`database_agent_bindings/preflight.rs:272-293` 同款校验），再交给 `authorize_background_task`（owner + 规范化根）。
- 失败文案：行内 `停止失败：<message>`；竞态结束时 `任务已结束`（Host 返回终态快照而非错误，`terminal_tasks.rs:580-586` + `:121-144`）。
- 验收：见下方“验收标准”。

### C. 并入监视器清单

- 文件/LOC：`pi_monitor_runtime.rs` +60、`melody-bridge-monitors.ts` +30、`monitor-feed.tsx` +60。
- 协议/Host：合并快照类型与合并 cancel。
- 归属：现有 `list_agent_monitors` / `cancel_agent_monitor` **没有**归属校验（`pi_monitor_runtime.rs:604-616`、`:425-436`），合并会把缺陷扩散到终端任务。
- 结论：否决——触碰本任务禁改文件 `pi_monitor_runtime.rs`，且两个注册表的生命周期语义不同（监视器发 `task.notification`，终端任务不发事件）。

## Recommendation

**方案 B**（信息面板列表）。它是唯一以 Host 注册表为真值的方案：能显示实时状态、能确认停止结果、能表达“已结束”，并且与会话信息面板里已有的“监视器”小节语义相邻。A 的卡片是启动瞬间的静态快照，跑完的任务仍会显示可停；C 需要改禁改文件并继承监视器缺失的归属校验。

**协议选择：(b) 新 Tauri 命令**（`list_` + `cancel_background_terminal_task`），不走 worker `task.cancel`。理由见下节。

## 协议选择：为什么是 (b) 而不是 (a)

- (a) 路由进 worker `cancelTask` 后，成功路径**没有任何渲染进程可读的结果**：`emitTaskCommandResult` 需要 `TaskHandle`（`subagent-runtime.ts:293-317`），Host 任务没有；即便补发 `task.changed`，缺 `childSessionId` 也会被投影丢弃（`subagent-projection.ts:186-194`）。要让 UI 确认成功，还得新增一种事件或改投影——成本高于两个命令。
- (a) 的错误不会误伤根轮次（Host 工具失败 scope 是 `tool`，`request_policy.rs:70-78`），但同样**无法被 UI 看到**：`promptForPiEvent` 只把 `run`/`session` 当终结（`agent-store-pi.ts:41-46`），`runtime.error(scope=tool)` 只会写进时间线，不会回到发起停止的那一行。
- (b) 是请求/响应：命令直接返回快照或错误消息，UI 可以精确渲染“已停止 / 已结束 / 停止失败”，与 `cancel_agent_monitor`（`pi_monitor_runtime.rs:609-616`）同构；归属仍在 Rust 侧重做一次，渲染进程拿不到绕过的路径。

## Resolved Questions

- **Q1 入口**：B（会话信息面板列表）。A/C 不实施。
- **Q2 已结束任务**：展示运行中 + 最近 5 条已结束（保留“已停止”的落点）。
- **Q3 时间线卡片停止**：不做。

## Acceptance Criteria（方案 B）

- [ ] 面板小节只列出**当前会话**的终端任务（`owner_session_id` + 会话 cwd 双重校验）；其他会话的任务不出现，且其 id 直接调用取消命令会被拒绝。
- [ ] 行显示命令（截断到一行）与状态；运行中的行有“停止”按钮。
- [ ] 点击停止：按钮立即 `disabled` + “停止中”，成功后在下一轮轮询内变为 `已停止` 且按钮消失。
- [ ] 对已结束任务不显示按钮；若点击与结束竞态，响应返回终态快照时显示 `任务已结束`（不是错误）。
- [ ] Host 拒绝（不存在 / 非本会话）时行内显示 `停止失败：<message>`，行仍为运行中，可重试。
- [ ] 切换会话/项目后列表立即刷新，旧会话的行不会残留（latest-request 优先）。
- [ ] 非 Tauri 预览环境不轮询、不渲染小节。
- [ ] `pnpm check`、`pnpm test:unit`、`pnpm lint`、`pnpm check:architecture`、`pnpm format:check`、`cargo test --manifest-path src-tauri/Cargo.toml --lib`、`cargo fmt --check` 全绿（`pnpm check` 内含命令权限交叉校验）。

## Constraints

- 不改 `src-tauri/src/pi_monitor_runtime.rs`；不改 `packages/agent-contract` 与 `packages/agent-worker`（方案 B 不需要）。
- 新命令四件套齐全：`#[tauri::command]`、`lib.rs` 注册、`permissions/default.toml` 白名单、`src/lib/melody-bridge-*.ts` 类型包装（`.trellis/spec/tauri-host/index.md:20-30`）。
- 渲染进程遵循 `.trellis/spec/frontend/conventions.md:81-120`：一次读取 + 纯 `src/domain` 派生 + props 下钻，叶子不订阅 store。
