# Implement — 方案 B：后台终端任务列表与停止

前置：`prd.md` 的 Q1 选 B；协议选 (b) 新 Tauri 命令。**不改** `src-tauri/src/pi_monitor_runtime.rs`、
`packages/agent-contract`、`packages/agent-worker`。

## 步骤（每步独立可验证）

**S1 Host 数据面**（先让快照自解释）
- `src-tauri/src/pi_tool_gateway/terminal_tasks.rs`：`BackgroundTerminalTask` 加
  `command: String`（构造处 `:426-436`，值来自 `:412-418`）；`background_task_snapshot`（`:87-97`）
  增加 `"command"`。
- 同文件 `#[cfg(test)] mod tests`：直接构造任务，断言 owner/root 过滤、轻量条目字段、以及
  `background_task_snapshot` 新增的 `command`（不 spawn 进程）。
- 门禁：`cargo test --manifest-path src-tauri/Cargo.toml --lib`、`cargo fmt --check`
  （先跑一次 `pnpm prepare:agent-worker`，否则构建脚本因 gitignored sidecar 失败）。

**S2 Host 命令面**
- `src-tauri/src/pi_tool_gateway.rs`：两个 `pub(crate)` wrapper（放在
  `cancel_background_tasks_for_workspace:150-152` 旁）：`list_background_terminal_tasks(root, owner)`
  （按 `owner_session_id` + 规范化 root 过滤）、`cancel_background_terminal_task(root, owner, task_id)`
  （`authorize_background_task` → 置位 `cancel` → `wait_background_task(task, 2_000)` → 条目）。
  两者都返回**轻量条目** `{task_id, command, status}`（不带 `output`，避免轮询 IPC 放大）。
  归属比较抽成 `owns(task, root, owner)` 供列表复用。
- 新 `src-tauri/src/background_task_runtime.rs`：两个 `#[tauri::command] pub async fn`，
  `State<'_, AppDatabase>` 查 `sessions.cwd`（同 `preflight.rs:278-286`）后**释放 DB 锁**，
  取消的等待放进 `tauri::async_runtime::spawn_blocking`（先例 `host_tool_routing.rs:249`），
  未知会话报错。
- `src-tauri/src/lib.rs`：`invoke_handler` 注册两个命令（`:93-199` 列表内，与 monitor 命令相邻）。
- `src-tauri/permissions/default.toml`：`commands.allow` 增加两个名字（monitor 三项附近 `:85-87`）。
- 门禁：`pnpm check:pi-compatibility`（含命令权限交叉校验）、`cargo test --lib`、`cargo fmt --check`。

**S3 渲染进程桥与纯派生**
- 新 `src/lib/melody-bridge-background-tasks.ts`：`BackgroundTerminalTaskSnapshot`
  （camelCase，对齐 `#[serde(rename_all = "camelCase")]`）、`listBackgroundTerminalTasks`、
  `cancelBackgroundTerminalTask`；`isTauriRuntime()` 为假时列表返回 `[]`、取消抛错。
- 新 `src/domain/agent/background-task-list.ts`：`backgroundTaskRows`、`applyCancelResult`。
- 新 `src/domain/agent/background-task-list.test.mjs`：排序、已结束上限 5、命令截断、
  取消成功/失败/竞态。
- 门禁：`pnpm test:unit`、`pnpm check`、`pnpm check:architecture`。

**S4 Hook**
- 新 `src/hooks/use-background-terminal-tasks.ts`：轮询（运行中 4s / 空闲 20s，参照
  `use-agent-monitors.ts:9-12` 与 `:48-66` 的 `setTimeout` 链）；`sessionId` 变化
  `gate.invalidate()` + 立即刷新（`src/domain/request-gate.ts`）；`stoppingTaskIds` 防重复；
  `errors` 行内文案；读取失败保留上次快照。
- 门禁：`pnpm check`、`pnpm lint`。

**S5 面板与下钻**
- 新 `src/features/chat/background-task-list.tsx`：行（命令截断 + 状态）、停止按钮、
  停止中禁用 + `aria-busy`、错误行 + `aria-describedby`；空列表返回 `null`。
- `src/features/chat/session-workspace-content.tsx`：props（`:88` 旁）与在
  MonitorFeed 小节之后（`:438`）新增 `<section>`。
- `src/features/chat/agent-workspace.tsx`：hook 调用（`:281` 旁）、props（`:638-640` 旁）。
- `src/features/chat/agent-workspace-view-types.ts`：`:174-177` 旁加类型；
  `agent-workspace-view.tsx:56,147` 转交。
- 门禁：`pnpm check`、`pnpm lint`。

**S6 全量门禁**
```bash
pnpm check && pnpm test:unit && pnpm lint && pnpm check:architecture && pnpm format:check
pnpm prepare:agent-worker
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## 风险点与回滚

| 文件 | 风险 | 回滚 |
| --- | --- | --- |
| `src-tauri/src/pi_tool_gateway/terminal_tasks.rs` | 改结构体与快照影响模型侧 `kill_command_or_subagent` 的返回 | 单独提交；快照只加字段不改既有键 |
| `src-tauri/src/background_task_runtime.rs` | root 解析错误会拒绝所有请求 | 单测覆盖未知会话与跨会话 id |
| `src/hooks/use-background-terminal-tasks.ts` | 轮询泄漏/竞态覆盖新结果 | `RequestGate` + 卸载清理 |

## 原生验证脚本

V1 起一个后台终端任务：
1. `pnpm tauri dev`，新建一个临时项目（或任一项目）。
2. 让模型执行 `run_terminal_command`，参数 `{"command":"sleep 300","background":true}`
   （提示词写明 background=true）。记录返回的 `pi-terminal-task:…` id。
3. 打开会话信息面板：# 后台终端任务 小节应出现一行，命令为 `sleep 300`，状态“运行中”。

V2 停止：
4. 点“停止”：按钮变“停止中”且禁用；≤2s 内状态变“已停止”，按钮消失。
5. 终端确认进程已消失：`pgrep -fl "sleep 300"` 应无输出。
6. 模型侧再调 `wait_commands_or_subagents`，应看到 `cancelled`。

V3 已结束与竞态：
7. 起 `{"command":"sleep 2","background":true}`，等它自然结束：行显示“已结束”，无按钮。
8. 在它即将结束时点停止（或直接对已结束 id 调命令）：显示“已结束/已停止”，不出现错误文案。

V4 归属：
9. 在会话 A 起任务，切到会话 B：B 的面板里没有该行。
10. 用 B 的 sessionId + A 的 taskId 直接调 `cancel_background_terminal_task`（devtools
    `window.__TAURI__` 或临时脚本）：应返回归属错误，且 A 的任务仍在运行。

V5 生命周期：
11. 切换项目：列表立即刷新，旧项目行不残留；切回原项目仍能看到仍运行的任务。
12. 停 worker（设置内）：该工作区的后台终端任务被 Host 取消（`cancel_background_tasks_for_workspace`），
    面板在下一轮轮询显示“已停止”。

V6 可访问性：
13. VoiceOver Tab 到停止按钮，读出“停止后台任务：sleep 300”；Space 触发；无重复播报。

## 明确不做

- 时间线工具卡上的停止按钮（方案 A，见 `prd.md` Open Questions Q3）。
- worker `run_background_task` 子任务的独立停止 UI。
- 监视器清单的归属修复与 `stop_pi_worker` 的爆炸半径。

## 执行结果（2026-11-07，commit 775bb8d6）

**task.py start 输出（degraded 原样）**
```
ℹ Session identity not available; active-task pointer not persisted this session (degraded mode). AI continues based on conversation context.
Hint: run inside an AI IDE/session that exposes session identity, or set TRELLIS_CONTEXT_ID before running task.py start.
✓ Status: planning → in_progress (degraded)
✓ Branch recorded: beta (degraded)
```

**实现偏差（相对 S1-S5）**
- 注册表额外记录 `started_at`（unix ms）并进入轻量条目：Q2 要求“最近 5 条已结束”，没有时间戳无法定义“最近”。
- `agent-workspace-view.tsx` 无需改动：它已用 `<SessionWorkspaceContent {...props} />` 透传（`:225`）。
- 取消命令的等待放进 `tauri::async_runtime::spawn_blocking`，两个命令均为 `pub async fn`。

**门禁**
| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过（含命令权限交叉校验；format-coverage uncovered=0；test-coverage covered=57） |
| `pnpm test:unit` | 291 passed |
| `pnpm lint` | 无输出（通过） |
| `pnpm check:architecture` | Architecture boundaries and runtime module graph are intact. |
| `pnpm format:check` | All matched files use Prettier code style! |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 38 passed（含新增 8 个：6 个 terminal_tasks + 2 个 background_task_runtime） |
| `cargo fmt --check` | 通过 |
| `pnpm test:agent-worker` | 143 passed（确认快照新增 `command` 不破坏 worker 解析） |

**原生验证：未完成**
- 阻断：规划机屏幕锁定（`computer.capabilities().screenLocked === true`），锁屏下 AX 窗口不可见、键盘输入不可用；`pnpm tauri dev` 已成功编译并启动（`Running target/debug/melody-work`，窗口 id 1460），但无法操作。
- 替代证据：
  - `terminal_tasks::tests::owner_lists_and_cancels_a_real_background_task` 真实 spawn `sleep 30`、按会话列出、取消并断言状态 `cancelled`（收集线程 kill 后才置位，故等价于进程已退出）。
  - `background_task_runtime::tests` 用内存 SQLite 验证 `sessions.cwd` 解析与未知会话拒绝。
  - 面板标记用 `react-dom/server` 渲染存证：`/tmp/terminal-tasks/panel-markup.html`（运行中按钮、停止中 disabled+aria-busy+describedby、已结束无按钮）。
- 待人工验证项：V1-V6（真实模型调用 `run_terminal_command background:true`、面板出现行、点击停止后 `pgrep` 空、跨会话不可见、截图）。
