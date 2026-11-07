# Design — 方案 B：信息面板的后台终端任务列表

## 1. 位置与可见性

会话信息面板内，紧跟“监视器”小节之后（`src/features/chat/session-workspace-content.tsx:432-438` 之后、
`:439-449` 的统计小节之前）。理由：监视器与后台终端任务都是 Host 拥有的后台进程，停止语义相同。

- 没有任何任务时整个小节返回 `null`（与 `monitor-feed.tsx:42-44` 一致）。
- 非 Tauri 预览：bridge 按 `isTauriRuntime()` 短路返回 `[]`，hook 不轮询
  （同 `melody-bridge-monitors.ts:29-31`）。

## 2. 数据流（一次读取 / 纯派生 / props 下钻）

```
agent-workspace.tsx:281 附近     useBackgroundTerminalTasks(activeSession?.id)
agent-workspace.tsx:638-640      新增 backgroundTasks / stoppingTaskIds / taskErrors / onCancelBackgroundTask
agent-workspace-view-types.ts:174-177   类型（挨着 monitors / onCancelMonitor）
agent-workspace-view.tsx:56,147  原样转交
session-workspace-content.tsx:88, 438 后   新 <section className="harness-session-info-section">
background-task-list.tsx         纯渲染，不订阅 store、不发请求
```

派生在 `src/domain/agent/background-task-list.ts`（无框架依赖，满足
`scripts/check-architecture.mjs:9-16`）：

- `backgroundTaskRows(tasks)` → 运行中优先，其次按 id；已结束最多保留 5 条；每行
  `{ taskId, label, status, statusLabel, running }`，`label` 为单行截断后的命令。
- `applyCancelResult(rows, taskId, result)` → 用 Host 返回的快照替换该行；返回
  `{ rows, error? }`。**状态转换放在纯函数里**，因为 `test:unit` 的套件只覆盖
  `src/domain/**`、`src/stores/**` 等（`package.json` 的 `test:unit`），hook 本身不进测试套件。

## 3. Host 侧

**`src-tauri/src/pi_tool_gateway/terminal_tasks.rs`**
- `BackgroundTerminalTask` 增加 `command: String`（`start_background_terminal` 在 `:412-418`
  已经解析出 `command`，`:426-436` 构造结构体时存入）。
- `background_task_snapshot`（`:87-97`）增加 `"command"`；`output` 仍走 `bound_task_output`（64 KiB）。
  worker 的 `parseHostTaskSnapshots`（`host-task-control.ts:38-77`）只读取已知字段，新增字段向后兼容。

**`src-tauri/src/pi_tool_gateway.rs`**（与 `cancel_background_tasks_for_workspace:150-152`
同一位置，供命令模块调用）：
```rust
pub(crate) fn list_background_terminal_tasks(root: &Path, owner: &str) -> Vec<Value>;
pub(crate) fn cancel_background_terminal_task(root: &Path, owner: &str, task_id: &str) -> Result<Value, String>;
```
- 列表：遍历注册表，保留 `task.owner_session_id == owner` 且规范化根相等（复用
  `authorize_background_task:520-538` 的同一比较规则，抽成 `owns(task, root, owner)`）。
- **列表返回轻量条目 `{task_id, command, status}`，不带 `output`**：模型侧快照的 output 上限是
  64 KiB（`:36`、`:99-120`），64 个任务 × 4s 轮询会把 IPC 打成几 MB。输出仍由模型工具
  `get_command_or_subagent_output` 读取，界面不做输出面板。
- 取消：`authorize_background_task` → `task.cancel.store(true, Ordering::Release)` →
  `wait_background_task(task, 2_000)`（复用 `:542-565`）→ 返回同一个轻量条目。已结束的任务
  命中注册表后只是返回终态条目，**不报错**（结束任务保留到容量裁剪，`:121-144`）。

**新 `src-tauri/src/background_task_runtime.rs`**
```rust
#[tauri::command]
pub async fn list_background_terminal_tasks(database: State<'_, AppDatabase>, session_id: String)
    -> Result<Vec<Value>, String>;
#[tauri::command]
pub async fn cancel_background_terminal_task(database: State<'_, AppDatabase>, session_id: String, task_id: String)
    -> Result<Value, String>;
```
- 用 `SELECT cwd FROM sessions WHERE id = ?1` 解析 root（与
  `src-tauri/src/database_agent_bindings/preflight.rs:278-286` 同款），未知会话直接返回
  `Cannot operate on unknown session …`；渲染进程不能自带路径。
- 归属仍在 Rust：`session_id` 只决定 owner，任务自身的 `owner_session_id` 必须等于它。
- 两个命令都是 `async`：先取 cwd 并释放 DB 锁，再把「置位 + `wait_background_task`」放进
  `tauri::async_runtime::spawn_blocking`（仓库已有先例：`pi_worker_runtime/host_tool_routing.rs:249`）。
  不照搬 `cancel_agent_monitor`（`pi_monitor_runtime.rs:609-616`）的同步命令写法——同步命令在主线程
  执行，最长 2s 的等待会卡住 webview。

## 4. 渲染进程模块

| 文件 | 职责 |
| --- | --- |
| `src/lib/melody-bridge-background-tasks.ts`（~40） | `BackgroundTerminalTaskSnapshot { taskId, command, status }`；`listBackgroundTerminalTasks(sessionId)` / `cancelBackgroundTerminalTask(sessionId, taskId)`；非 Tauri 返回 `[]` |
| `src/hooks/use-background-terminal-tasks.ts`（~75） | 轮询（有运行中 4s，否则 20s，同 `use-agent-monitors.ts:6-8`）；`sessionId` 变化立即刷新；`RequestGate` 丢弃过期响应；`stoppingTaskIds` 防重复点击；`errors` 保存行内文案 |
| `src/features/chat/background-task-list.tsx`（~110） | 行渲染（命令 + 状态）+ 停止按钮；接 `rows`、`stoppingTaskIds`、`errors`、`onCancel` |
| `src/domain/agent/background-task-list.ts`（~35） | 上述两个纯函数 |

取消流程（**不乐观改状态**，Host 快照是唯一真值）：点击 → 加入 `stoppingTaskIds` →
`await cancel(...)` → `applyCancelResult` 用返回快照替换该行 → 触发一次刷新 → 移除
`stoppingTaskIds`；抛错则写 `errors[taskId]`，行保持运行中并可重试。

## 5. 已结束 / 竞态 / 裁剪

| 场景 | 行为 |
| --- | --- |
| 任务已结束 | 行按钮不渲染（`status !== "running"`），状态显示 `已结束` / `已停止` |
| 点击与结束竞态 | Host 返回终态快照 → 行变 `已结束`，不写错误 |
| 任务已被容量裁剪 / 会话切换 | 前者 `停止失败：Background task not found: …`；后者 `gate.invalidate()` + 立即刷新，旧行不残留 |
| 列表读取失败 | 保留上一次快照，不清空正在看的列表（同 `use-agent-monitors.ts:28-32`） |

## 6. 归属

Host 是唯一裁决者。渲染进程只传 `sessionId`（用于选行来源）与 `taskId`；root 由 SQLite 解析，
owner 由任务自身字段比对。伪造 `sessionId` 会因 root/owner 不匹配被拒；他人的任务永远不会进入列表。

## 7. 可访问性

- 按钮：`aria-label={`停止后台任务：${command}`}`；停止中 `disabled` + `aria-busy="true"`。
- 命令过长时视觉截断（`truncate` + `title`），但 `aria-label` 用完整命令。
- 错误行 `aria-describedby` 挂在按钮上，不使用 live region——沿用 `f24c81df` 的“状态只播报一次”
  约定，避免与列表刷新重复播报。
- 行内状态是可见文本，不依赖颜色。

## 8. 测试锚点

- `src/domain/agent/background-task-list.test.mjs`：排序（running 优先）、已结束上限 5、命令截断、
  `applyCancelResult` 的成功/失败/竞态三分支。
- Rust：`terminal_tasks.rs` 内 `#[cfg(test)] mod tests` 覆盖 owner/root 过滤与快照字段（不 spawn 进程，
  直接构造 `BackgroundTerminalTask`）。
- 不新增 hook 测试（不在 `test:unit` 套件内），hook 只做取数与转发。

## 9. 与协议方案的取舍（为何不加 worker `task.cancel` 分支）

worker 的 `emitTaskCommandResult` 需要 `TaskHandle`（`subagent-runtime.ts:293-317`），Host 任务没有；
补发 `task.changed` 也会因缺 `childSessionId` 被投影丢弃（`subagent-projection.ts:186-194`）。
Host 命令一次请求/响应即可拿到条目与错误，且不写 agent 事件流（不会有 `runtime.error` 落进时间线）。
