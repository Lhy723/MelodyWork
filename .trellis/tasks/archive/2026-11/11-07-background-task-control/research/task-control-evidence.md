# 停止控制：已验证调用链与证据

基线：`beta` @ `f24c81df`，工作区干净。本文件所有 `file:line` 均在规划阶段实读确认；
标注 `[未运行验证]` 的结论来自代码推理，未在运行中的应用里复现。

> **范围修订（2026-11-07，用户决定）**：停止入口只保留输入框（会话停止方案全部撤销），
> 本任务改为 Host 后台终端任务（`pi-terminal-task:*`）的可见与停止。§1–§9 保留为背景证据，
> 会话停止相关的结论不再驱动实现；新证据见 §10。

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 后台会话能停吗 | 不能。唯一发送者是 `cancelPrompt`，只作用于活动会话。 |
| `task.cancel` 能用吗 | 协议、worker、Host 白名单都在，渲染进程零调用者。 |
| Host 终端任务能通过 `task.cancel` 停吗 | 不能，会被 worker 判为 `pi.task_not_found`。 |
| 现有停止入口有归属校验吗 | 监视器停止没有；`turn.cancel` 有（Host 会校验会话绑定）。 |

## 1. 活动会话取消（可用，但不覆盖后台）

`src/stores/agent-store.ts:130-198` `cancelPrompt`：

- `:135-140` 早退守卫：`chatStatus` 不是 `submitted`/`streaming` 且该会话没有挂起 prompt
  就 `return`。后台会话运行时，活动会话的 `chatStatus` 是 `ready`，因此后台运行不可达。
- `:143-150` 从 `pendingPrompts` 找该会话的挂起项，先 `removePendingPrompt` +
  `rememberCancelledPrompt`。
- `:155-168` 仅当 `sessionId && isTauriRuntime()` 时发送
  `turn.cancel { sessionId, promptId?, cancelSubagents: true, reason }`。
  `sessionId` 取自 `state.runtimeSessionId`（`:134`）。
- `:169-180` 发送成功后**乐观**把 `runningSessions[localSessionId]` 置 `false`、`chatStatus`
  置 `ready`。即：清理发生在“命令帧被接受”时，而不是 `run.finished`。
- `:185-198` 失败时把全局 `chatStatus` 置 `error` 并往**活动会话时间线**追加错误。
  这段逻辑不能复用于后台会话——它写的是活动会话的全局状态。

挂起 prompt 注册表 `src/stores/agent-store-runtime.ts:64-76`（`requestId → { runtimeSessionId,
localSessionId, promptId }`）与 `:185-188` `pendingPromptForSession(sessionId)` 是跨会话的，
这为后台停止提供了现成的身份解析。

Pi 模式下产品会话 id 就是运行时会话 id：`src/stores/agent-store-session.ts:134-136`
（`expectedRuntimeSessionId = localSessionId`）。因此侧栏行的 `session.id` 可直接作为
`turn.cancel.sessionId`。

## 2. `task.cancel` / `task.wait` 端到端

| 层 | 位置 | 行为 |
| --- | --- | --- |
| 契约 | `packages/agent-contract/src/index.ts:407-412` | `task.wait \| task.cancel { sessionId, taskId }` |
| worker 分发 | `packages/agent-worker/src/main.ts:104-110` | `adapter.waitTask` / `adapter.cancelTask` |
| worker 实现 | `packages/agent-worker/src/pi/subagent-runtime.ts:525-539` / `:541-556` | 从 `this.tasks` 取句柄，`task.rootSessionId !== command.sessionId` 即 `pi.task_not_found` |
| 归属 | 同上 `:546` | 仅比对根会话，不看子会话 |
| id 形状 | `:705` | `${rootSessionId}:task:${randomUUID()}`；子会话 `${taskId}:session` |
| Host 白名单 | `src-tauri/src/pi_worker_runtime/session_commands.rs:33-46` | `task.wait` / `task.cancel` / `task.continue` 均放行 |
| Host 校验 | 同文件 `:204-210`、`:279-282` → `validate_pi_session_command` | 只校验会话绑定到当前工作区，不限制“必须是活动会话” |
| 渲染进程 | `grep -rn "cancelTask" src/` | 零命中 |

`subagent-runtime.ts:299-317` `emitTaskCommandResult` 在取消后发出 `task.changed`
（`taskId`、`status`、`childSessionId`），渲染进程的 `src/domain/agent/subagent-projection.ts:168-172`
用 `taskId` 作为 `subagentId` 建索引，因此 store 里的 `subagents` 键就是 worker 任务 id，
可以直接作为 `taskId` 回发。

## 3. Host 终端任务（`pi-terminal-task:`）

- 前缀定义：`packages/agent-worker/src/pi/tool-names.ts:49`
  `PI_BACKGROUND_TERMINAL_TASK_PREFIX = "pi-terminal-task:"`；
  Rust 侧同值 `src-tauri/src/pi_tool_gateway/terminal_tasks.rs:34`。
- 识别：`packages/agent-worker/src/pi/host-task-control.ts:35` `isHostBackgroundTaskId`。
- 模型侧工具路由：`subagent-runtime.ts:499-523` `cancelTaskForSession` 对 Host id 走
  `hostTaskControl.request(parentSessionId, kill_command_or_subagent, { task_id })`。
- 命令侧**没有**这条路：`subagent-runtime.ts:541-556` 的 `cancelTask` 只查 `this.tasks`，
  Host id 必然落进 `pi.task_not_found`。
- Host 侧实现：`terminal_tasks.rs:580-586`（`resolve_control` 的 kill 分支），
  归属校验在 `:520-538` `authorize_background_task`：
  `task.owner_session_id != owner_session_id || task_root != canonical_root` 即拒绝。
- Host 没有列出终端任务的 Tauri command：`src-tauri/src/lib.rs:93-199` 的 `invoke_handler`
  只有 `list_agent_monitors` / `cancel_agent_monitor`，没有终端任务清单。
- Host 也不为终端任务发 `task.changed`（`grep -rn "task.changed" src-tauri/src` 仅命中
  `database_agent_recovery.rs:288` 的恢复逻辑与 `pi_monitor_runtime.rs` 的 Condvar 同名成员）。

## 4. 运行状态如何翻转（决定 UI 的“停止中”语义）

- 置 `true`：`src/stores/agent-store-submit.ts:130-134`、`:178-182`、`:193-198`
  （键是产品会话 id `localSessionId`）。
- 置 `false` 的三条路：
  1. `src/stores/agent-store-pi.ts:202-211`：仅当事件属于**活动**会话且 `chatStatus` 变成
     `ready`/`error`。
  2. `src/stores/agent-store-pi.ts:214-233`：`promptForPiEvent` 命中挂起 prompt 后，
     按 `pendingPrompt.localSessionId` 置 `false`——这是后台会话唯一能清掉转圈的路径。
     判定 `:40-73` 依次尝试 promptId、数字 requestId、runId、sessionId。
  3. ACP 预览路径 `src/stores/agent-store-receive.ts:367-403`。
- 后台路由：`src/domain/agent/event-store-adapter.ts:24-31,33-46` 把非活动会话的事件投影进
  `backgroundTimelines[streamSessionId]`，不会碰活动时间线。
- worker 成功取消才会发 `run.finished`：`packages/agent-worker/src/pi/session-turn-runtime.ts:242-270`。
  `:243-244` `wasRunning` 为假时**不发**任何事件。

推论 `[未运行验证]`：对已空闲的会话发 `turn.cancel`，worker 静默返回，渲染进程收不到
`run.finished`；若 UI 以 `run.finished` 作为“停止完成”的唯一信号，必须有超时兜底。

## 5. 现有停止入口与归属缺口

| 入口 | 位置 | 归属校验 | 影响面 |
| --- | --- | --- | --- |
| 输入框停止 | `src/features/chat/agent-workspace.tsx:480` → `cancelPrompt` | 活动会话 | 正确 |
| 监视器停止 | `src/features/chat/monitor-feed.tsx:66-78` → `src/hooks/use-agent-monitors.ts:37-46` → `src/lib/melody-bridge-monitors.ts:47-50` → `src-tauri/src/pi_monitor_runtime.rs:609-616` | **无**。`cancel_monitor`（`:476-490`）只按 id 查表 | 可停止任意工作区的监视器 |
| 监视器清单 | `pi_monitor_runtime.rs:425-436` | 无 | 返回全进程注册表（含已结束） |
| 停止 worker | `src/lib/melody-bridge-runtime.ts:550` → `src-tauri/src/pi_worker_runtime.rs:1049-1060` | 工作区级 | 杀掉该工作区全部会话 |
| 删除会话 | `src-tauri/src/agent_session_lifecycle.rs:17-50` | — | `stop_if_workspace`：删一个会话会停整个工作区 worker |
| 关闭终端 | `src-tauri/src/workspace_terminal.rs:269-291` | 终端 pane | 与本主题无关的 PTY |

`MonitorSnapshot.owner_session_id` 存在但 `#[serde(skip)]`（`pi_monitor_runtime.rs:122-133`），
所以渲染进程拿不到归属信息；要在 UI 侧过滤必须显式暴露该字段。

## 6. UI 管线

- 侧栏行：`src/features/sessions/sidebar-projects-navigation.tsx:308-399`。
  `:323` `const running = runningSessions[session.id] === true;`；
  `:340-360` waiting / running 徽标（running 是 `role="status"` + `aria-label="任务正在运行"` 的
  旋转环）；`:363-394` 行尾 `DropdownMenu`，删除项是唯一动作。
- 属性下钻：`src/features/chat/agent-workspace.tsx:125-135`（`useShallow` 一次读取
  `backgroundTimelines/localSessionId/runningSessions/timeline`）→ `:603` `runningSessions` →
  `src/features/chat/agent-workspace-view.tsx:56,147` → `src/features/sessions/app-sidebar.tsx:84,409`
  → `sidebar-projects-navigation.tsx:290,323`。
- 会话信息面板：`src/features/chat/session-workspace-content.tsx:410-450`，三个 section：
  `SubagentTray`、`MonitorFeed`、`SessionStatsLine`。`visibleSubagents` 只含活动会话：
  `agent-workspace.tsx:274-277`（按 `runtimeSessionId` 过滤）。
- 监视器数据：`agent-workspace.tsx:281` `useAgentMonitors(cwd)`；`cwd` 变化会重读清单，
  但清单本身没有按会话过滤（见 §5）。
- 组件停止按钮的先例：`monitor-feed.tsx:69-79`（纯文本按钮 + `onClick`），
  行内动作先例：`sidebar-projects-navigation.tsx:363-394`（`stopPropagation` 齐全）。

## 7. 失败路径（`task.cancel` 若被拒会发生什么）

`packages/agent-worker/src/main.ts:158-170`：命令抛错时按命令信封发
`runtime.error { requestId, sessionId }`。`task.cancel` 的 `fail(...,"run")`
（`subagent-runtime.ts:547-551`）保留 `scope: "run"`（`main.ts:44-52` 直接透传 agentError）。

渲染进程 `promptForPiEvent`（`agent-store-pi.ts:40-73`）把 `scope` 为 `run`/`session` 的
`runtime.error` 视为终结事件；`task.cancel` 的 requestId 通常不是数字，于是回退到
`pendingPromptForSession(event.sessionId)`——也就是**该任务所属根会话的挂起 prompt**。
后果 `[未运行验证]`：一次被拒的 `task.cancel` 会被投影成“根会话这一轮失败了”，
清掉 `runningSessions` 并（若该会话是活动会话）把 `chatStatus` 打成 `error`。

这是选项 C 必须先解决的既有缺陷；A/B 不发送 `task.cancel`，不受影响。

## 8. 工程约束

- `scripts/check-architecture.mjs:9-16`：`src/domain/**` 禁止 import
  `@/components|features|stores|lib`、`react`、`@tauri-apps/*`。派生逻辑必须无框架依赖。
- `scripts/check-test-suite-coverage.mjs:1-50`：测试文件必须挂进真实的 `--test` 命令行；
  `package.json` 的 `test:unit` 覆盖 `src/domain/agent/*.test.mjs`、`src/stores/*.test.mjs`，
  新测试放这两处无需改脚本。
- `.trellis/spec/frontend/conventions.md:81-120`：跨会话派生状态 = 一次 `useShallow` 读取 +
  纯 `src/domain` 函数 + 逐层 props；叶子组件不得自行订阅 store。
- 现有 store 测试范式：`src/stores/agent-store-session.test.mjs:1-40`（`mock.module` 打桩
  `@/lib/agent-client.ts` 与 `@/lib/melody-bridge.ts`，直接构造 `{ get, set }`）。

## 9. 未能验证 / 未测项

- 全部 `[未运行验证]` 标记项：空闲会话取消的行为、`task.cancel` 被拒时的投影后果、
  后台 `turn.cancel` 在真实 Pi 进程中端到端生效的时间（都需手工跑一次桌面端）。
- 多工作区下 `list_agent_monitors` 的实际可见范围（代码上是全进程注册表，未实机确认）。
- `pi-terminal-task:*` 是否只由 `run_background_task` 产生（未穷举所有产生方）。

## 10. 终端任务界面证据（新范围）

### 10.1 谁创建 `pi-terminal-task:*`

- **不是** `run_background_task`。它是 worker 侧工具，起的是子 Pi 会话：
  `packages/agent-worker/src/pi/task-tools.ts:129-167`
  （`spawnSubagent({ ..., background: true })`），任务 id 是
  `${rootSessionId}:task:${uuid}`（`subagent-runtime.ts:705`）。
  Host 对同名工具明确返回 “This interaction is resolved by the Pi worker”：
  `src-tauri/src/pi_tool_gateway.rs:318-320`。
- **是** `run_terminal_command` 且 `background: true`：
  `src-tauri/src/pi_tool_gateway/terminal_tasks.rs:343-354`（branch）→
  `:406-441` `start_background_terminal`。worker 侧的工具描述也这么写：
  `packages/agent-worker/src/pi/tool-gateway.ts:582-596`。
- 启动返回 `{"task_id":"pi-terminal-task:…","status":"running","message":…}`：
  `terminal_tasks.rs:503-509`；id 生成在前缀常量 `:34` + `:421-425`。

### 10.2 注册表与状态

- 全局 `HashMap<String, Arc<BackgroundTerminalTask>>`：`:79-85`；上限
  `BACKGROUND_TERMINAL_MAX_TASKS = 64`：`:35`；仅在达到上限时裁剪已结束任务：`:121-144`。
- 结构体字段：`task_id`、`owner_session_id`、`root`、`cancel`、`state{status, output}`、`changed`
  ——**没有 command/description**：`:71-78`。→ 列表若只读注册表，只能显示 id 与状态。
- 状态枚举 `running | completed | failed | cancelled`：`:43-60`。
- 注册表不记录启动时间——要显示“运行时长”就得加字段，本期不做。
- 快照 `{task_id, status, output}`，output 上限 64 KiB：`:87-97`、`:36`、`:99-120`。

### 10.3 归属与取消

- 归属：`authorize_background_task`（`:520-538`）= `task.owner_session_id == owner_session_id`
  且 `canonical(task.root) == canonical(root)`。
- 取消：`resolve_control` 的 kill 分支（`:580-586`）置位 `cancel` 并
  `wait_background_task(&task, 5_000)`（`:542-565`），返回快照字符串。
- 工作区级取消：`cancel_background_tasks_for_workspace`（`:643-657`），调用点
  `src-tauri/src/pi_worker_runtime.rs:316,366,387,471`（worker 停止/切换工作区）。
- 模型工具路径：worker `cancelTaskForSession` 对 Host id 调
  `hostTaskControl.request(parentSessionId, kill_command_or_subagent, { task_id })`
  （`subagent-runtime.ts:499-523`）。

### 10.4 命令面与权限

- `invoke_handler`（`src-tauri/src/lib.rs:93-199`）没有任何终端任务命令；监视器只有
  `list_agent_monitors` / `cancel_agent_monitor`（`:154-155`）。
- 主窗口白名单 `src-tauri/permissions/default.toml:85-87` 同样只有监视器三项。
- 交叉校验：`scripts/tauri-command-permission-check.mjs:9-70` 比对
  `invoke_handler` ↔ `commands.allow` ↔ 渲染进程 `invoke`；由
  `scripts/check-pi-compatibility.mjs:6,24` 调用，属于 `pnpm check`。

### 10.5 渲染进程能看见什么

- `grep -rn "pi-terminal-task\|run_background_task" src/` 只命中
  `src/domain/agent/projection-store-patch.test.mjs:278` 的无关字面量 → 界面完全不知道终端任务存在。
- 时间线工具条目字段：`src/domain/acp.ts:265-280`（`toolCallId?`、`title`、`command`、`output`、
  `status?`、`activity?`）——没有任务 id 字段。
- 工具事件的投影：`title = event.toolName`、`rawInput = event.activity`、
  `rawOutput = event.output`（`src/domain/agent/event-to-session-update.ts:259-271`）。
- 文本化：`projectToolText`（`src/domain/tool-activity.ts:175-206`）给出
  `command = rawInput.command`、`output = contentText || JSON.stringify(rawOutput)`；
  `upsertTool` 把它写进条目的 `command` / `output`（`src/domain/session-projection-updates.ts:350-405`）。
- 结论：**id 可从 `entry.output` 的 JSON 解析出来**（启动结果就是那段 JSON），但条目没有实时状态，
  `status` 在启动返回后即为 `completed`。

### 10.6 worker 无法给终端任务一个可读结果

- `emitTaskCommandResult` 需要 `TaskHandle`（`subagent-runtime.ts:293-317`）；Host 任务没有句柄。
- 即便补发 `task.changed`，缺 `childSessionId` 会被投影判定为不适用并丢弃：
  `src/domain/agent/subagent-projection.ts:186-194`。
- Host 从不发 `task.changed`（`grep -rn "task.changed" src-tauri/src` 仅命中
  `database_agent_recovery.rs:288` 的恢复分支与 `pi_monitor_runtime.rs` 的 Condvar 同名成员）。

### 10.7 错误的 scope

- Host 工具失败统一 `"scope": "tool"`：`src-tauri/src/pi_tool_gateway/request_policy.rs:70-78`。
- worker 透传该 scope：`packages/agent-worker/src/pi/host-task-control.ts:118-124`
  （`resolution.error?.scope ?? "run"`）。
- 渲染进程只把 `run`/`session` 当终结事件：`src/stores/agent-store-pi.ts:41-46`。
  → 走 Host 的错误不会误伤根轮次，但也不会以“停止失败”的形式回到 UI；
  走 Tauri 命令才有请求/响应。

### 10.8 面板与轮询先例

- 信息面板三个 section：`src/features/chat/session-workspace-content.tsx:424-450`。
- 监视器 hook：`src/hooks/use-agent-monitors.ts:12-68`（4s/20s 轮询、读失败保留旧值）；
  bridge：`src/lib/melody-bridge-monitors.ts:29-50`（非 Tauri 返回 `[]`）。
- 最新请求闸门：`src/domain/request-gate.ts:8-26`。
- **行号基线**：`src/features/chat/session-workspace-content.tsx` 与
  `src/features/chat/agent-timeline.tsx` 在规划时已有并行任务的未提交改动
  （前者在 `:377` 插入 `archived={archivedReadOnly}`，后者 +22 行）；本文件与
  `design.md` 中该文件的坐标以**当前工作树**为准（aside `:410`、SubagentTray 小节 `:425-431`、
  MonitorFeed 小节 `:432-438`、统计小节 `:439-449`），与 `f24c81df` 的 HEAD 版本相差 1 行。

### 10.9 可行性判定

| 问题 | 结论 |
| --- | --- |
| 时间线条目暴露任务 id 吗 | 不直接暴露；但 `entry.output` 是启动结果的 JSON，可解析出 `task_id` |
| 条目有实时状态吗 | 没有。工具调用在启动后即 `completed` |
| 能不做 Host 新命令就停吗 | 能（模型工具路径 `kill_command_or_subagent`），但渲染进程发不了工具请求 |
| 列表能从别处得到吗 | 不能；注册表是内存态，唯一真值 |
| 列表能直接复用模型快照吗 | 不能：快照带 64 KiB 上限的 output，轮询会放大；需要轻量条目 |
| 已结束任务取消会报错吗 | 不会；注册表保留已结束任务，kill 返回终态快照 |

### 10.10 未验证

- `[未运行验证]` Host 命令里 ≤2s 的等待对 UI 响应的影响（同步命令线程模型）。
- `[未运行验证]` 模型在一次 `run_terminal_command background` 之后是否会在同一轮里继续产生第二个
  同名工具调用（影响列表去重；按 task_id 去重即可，不依赖此假设）。
- 未穷举 `run_terminal_command` 的 `background` 之外是否还有其他创建终端任务的入口
  （当前只有 `:343-354` 一个分支）。
