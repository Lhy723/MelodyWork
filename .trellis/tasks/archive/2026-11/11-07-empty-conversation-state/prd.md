# 空会话首屏提示

## Goal

会话已打开但时间线没有任何条目时，对话区目前是一片空白（`agent-timeline.tsx:290` 只 map `renderEntries`）。
在该状态下复用已有的 `ConversationEmptyState`（`conversation.tsx:45`，当前无任何引用），给出一句标题 + 一句提示，
让用户知道这里将显示回复、并且输入框可用。

## Requirements

### 触发条件（已验证）

| 状态 | `entries` | `turnRunning` | `renderEntries` | 期望 |
|---|---|---|---|---|
| 会话打开、无持久化时间线、引擎就绪（`chatStatus: ready`） | `[]` | false | `[]` | 显示空状态 |
| 归档只读会话、归档投影为空（`agent-store-session.ts:75-77`） | `[]` | false | `[]` | 显示归档变体 |
| 历史回放/首轮提交在途（`chatStatus: submitted/streaming`） | `[]` | true | 1 个 `activity-group`（"正在等待模型响应"，`timeline-groups.ts:125,131`、`turn-activity-group.tsx:132`） | 不显示空状态 |
| 新建任务：`createTaskFromPrompt` 已 `createSession`、`submitPrompt` 尚未落地（`agent-workspace-actions.ts:582-596`） | `[]` | false | `[]` | 显示空状态（瞬时，文案须中立） |
| 打开失败 | 可能 `[]` | false | `[]` | 显示空状态；错误已由顶部 banner 承担（`session-workspace-content.tsx:279-288`），空状态不重复报错 |
| 新建任务面板 / 无会话 | — | — | 未挂载 `AgentTimeline`（`agent-workspace-view.tsx:180-200`） | 不在本任务范围 |

判定条件统一为 `renderEntries.length === 0`（`entries.length === 0 && !turnRunning`），不新增状态派生。

### 文案（简体中文，一标题一提示）

- 普通空会话：标题「这个会话还没有消息」，提示「在下方输入框描述你的任务，回复会显示在这里。」
- 归档只读且无历史：标题「这个归档会话没有历史记录」，提示「该会话由旧引擎创建，只能查看；新工作请新建会话。」
- 不覆盖 `ConversationEmptyState` 的默认文案，仅在调用处传入；不新增图标（保持零依赖布局，避免与 composer 抢占视觉焦点）。

### 位置与布局

- 位于 `Conversation` 滚动区内：作为 `ConversationContent` 的唯一子节点渲染，`ConversationScrollButton` 与 composer 保持不变。
- 垂直居中：空态时给 `ConversationContent` 追加 `min-h-full`（`use-stick-to-bottom` 的内层 content div 以 `flex flex-col` 承载子节点，
  `min-height:100%` 相对滚动视口的确定高度解析），并给 `ConversationEmptyState` 传 `flex-1`；
  视口已用 `padding-bottom: var(--harness-chat-dock-space)` 预留 composer 空间（`harness-layout.css:111-115`），因此居中不会压到输入框。
- 非阻塞：不加遮罩、不拦截指针、不自动聚焦、不改滚动行为；composer 在该状态下照常可用
  （非归档时 `archived=false`，`agent-workspace.tsx:453-471`），首条消息落地后空状态自动消失。

### 实现约束

- 不新增组件、不改 `ConversationEmptyState` 的 props/样式；只在 `AgentTimeline` 内加分支。
- `AgentTimeline` 增加可选 `archived?: boolean`（默认 `false`）用于选择文案；`SessionWorkspaceContent` 已订阅
  `archivedReadOnly`（`session-workspace-content.tsx:97`），直接透传。
- `src/features/workspace/subagent-conversation.tsx:137` 的 `AgentTimeline` 仅在 `timeline.length > 0` 时挂载，行为不变。
- 轨迹视图已有空态（`trajectory-turn-list.tsx:54-56`），不在本任务范围。

## Files (LOC est.)

- `src/features/chat/agent-timeline.tsx`：+12/-2（导入 `ConversationEmptyState`、`archived` prop、空分支、条件 `min-h-full`）
- `src/features/chat/session-workspace-content.tsx`：+1（`archived={archivedReadOnly}`）
- `src/styles/harness-chat.css`：0～6（仅当 `min-h-full` 工具类无法居中时补一条 `.harness-chat-content--empty` 规则）

## Acceptance Criteria

- [ ] 空会话（无条目、非运行）显示标题 + 提示，垂直居中于对话区且位于 composer 上方；有消息后不再出现。
- [ ] 运行中（`turnRunning`）空时间线仍显示「正在等待模型响应」，不出现空态。
- [ ] 归档只读空会话显示归档变体文案，composer 仍为只读。
- [ ] `pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm format:check`、`pnpm check:ui-font` 通过。
- [ ] 真实运行截图：`pnpm dev` 浏览器预览打开一个无时间线条目的会话（否则用 `pnpm tauri dev` 打开归档为空的旧会话）并附截图；
      原生检查：`pnpm tauri dev` 中该状态输入框可聚焦、发送首条消息后空态消失。
