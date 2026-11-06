# MelodyWork → Pi 迁移设计

状态：2026-10-11。**Pi 已是唯一 Agent runtime，Tauri Desktop 固定使用 Pi；browser preview 固定使用 deterministic ACP fixture，旧 ACP 会话只读归档，不作为 Pi 失败时的运行时回退。** `agentClientForRuntime()` 是唯一 renderer route selector，旧 `agentEngine` persisted key 只用于兼容归一化。插件市场已迁为 Host 原生实现，旧 `melody-pager` 已退出构建、启动与发布；`vendor/melody-build` 子模块和 `.gitmodules` 已移除。Pi worker、Host ToolGateway、产品事件投影、原生会话持久化、Browser/Explorer 有界交互及迁移导入已接通；Browser/Explorer 的目标平台真实桌面、权限及故障恢复验收仍未完成。版本与公开能力由 [`pi-compatibility-manifest.json`](./pi-compatibility-manifest.json) 维护，并在 `pnpm check` 中防漂移。当前差距、最新本地门禁与交接顺序以[交接文档](./handoff.md)、[功能对照](./feature-parity.md)和[验收报告](./acceptance-report.md)为准。

说明：以下章节保留原始迁移设计与阶段性观察，部分段落记录早期 opt-in/ACP fallback 方案，**不代表当前运行行为或能力状态**；若与上述交接文档、功能对照或兼容清单冲突，以它们为准。不要据旧文档执行引擎回退或 stable release。

## 1. 结论与边界

最新补充：Host ToolGateway 的终端输出已经采用有界流式读取；超过预览上限的结果会保存在工作区内的受控归档，并由 `workspace_read_tool_output` 提供分段只读访问。MCP 本地/远程结果也采用独立的网络体上限与预览上限，超过 512 KiB 的完整结果写入同一受控归档并可分段读回；真实 provider 样本仍需现场验收。

建议迁移，但不要把它做成“替换 sidecar 可执行文件”，也不要让 React 直接依赖 Pi。推荐以 **Pi coding-agent SDK 为推理与工具循环内核，在独立 sidecar 中运行；MelodyWork 保留产品协议、权限、配置、插件兼容、后台任务、持久化与桌面能力**。

这样可以跟进 Pi 的模型供应商适配、流式处理、会话与压缩能力，减少这部分 harness 维护；不会自动免除 Melody 兼容层、产品工作流、安全策略和桌面打包的维护。迁移初期维护量会上升，因为需要双引擎验证。本文追求适合现有项目的清晰边界，不把“换底层”承诺为零维护或无风险。

执行主链路已接通：Pi worker 通过协议 v1 与 Rust Host 通信，Host 负责资源、权限、事件持久化和进程生命周期，React 只消费规范事件。Desktop 固定运行 Pi；browser preview 保留确定性的 ACP fixture，不存在设置切换或能力缺口触发的 ACP Agent runtime fallback。旧 ACP 会话只读展示；ACP→Pi import plan 与 journal 作为显式兼容路径保留。受控的平面 Markdown `/commands`、标准外部 Markdown Skills（`.agents/skills`、`.claude/skills`、`.cursor/skills`）以及纯 Markdown 插件 Skill/命令由 Host 显式投影给 Pi；未支持或不安全表达的能力会诊断或阻断 Pi 会话。当前实现与残余验收边界见[交接文档](./handoff.md)、[功能对照](./feature-parity.md)和[实施计划](./implementation-plan.md)。

### 1.1 “功能不能减少”的定义

不是页面上仍有按钮，而是原有能力的输入、输出、权限、持久化、错误处理和取消语义均通过验收：

- 所有已验证可用的 MelodyWork 功能必须在 Pi 路径下工作；用户启用的 MCP、插件、模型和工具纳入样本。
- UI 已接入、但当前存在缺陷的功能不得以缺陷为理由删除，应记录预期行为和修复目标。
- 仅存在于 vendored CLI 文档、尚未确定桌面是否开放的能力，列为待确认项；不能直接宣布已支持，也不能默默排除。
- 能力缺口必须明确诊断为未实现/不支持；无法安全保留策略时阻断 Pi 会话。ACP 只读归档、browser-preview fixture 与显式导入都不是 Agent runtime fallback。
- 历史消息“能显示”不等于“能准确恢复原生上下文”。迁移不能伪造连续性；无法无损转换的会话必须有明确、可验证的继续方式。

### 1.2 早期桌面 opt-in 接入记录（历史）

以下段落记录迁移早期的 opt-in 方案和当时的能力状态，不是当前入口说明。当前唯一 Agent runtime 是 Pi；ACP 只保留历史会话归档与显式导入来源，不承担运行时回退。请以本文开头的状态摘要、[交接文档](./handoff.md)和[功能对照](./feature-parity.md)为准：

- Rust 注册 `pi_worker_status`、`start_pi_worker`、`send_pi_agent_command`、`stop_pi_worker` 四个 Tauri 命令。启动前由 `WorkspaceRegistry` 校验工作区，Host 只从应用资源目录或 `MELODY_PI_WORKER_PATH` 解析 worker，不接受 renderer 传入任意可执行文件；停止时优先发送受校验的 `runtime.shutdown`，等待 worker 刷新会话，超时才强制回收。
- Host 使用 1 MiB 上限的 LF JSONL，启动后发送 `runtime.health`，只有收到 protocol v1、非空 `eventId`、稳定 `workerEpoch`、严格递增 `seq` 的 `runtime.ready` 才标记为运行；异常帧、世代变化、超时和 stdout 关闭都会进入可解释状态并回收进程。Pi worker 的 `runtime.shutdown` 会先取消/关闭其活动会话并刷新 writer，再退出；正常停止、切换工作区、协议失败和 stdout 意外关闭也会同步回收该工作区的 Host-owned MCP 子进程。执行回合通过产品 `idempotencyKey` 做有界去重，冲突 key 不会静默覆盖；data URL 附件在接受回合前完成解码并受大小上限约束。worker 发送的能力矩阵现在还会在命令分发前做统一门禁：缺少认证、模型目录、权限模式、后台任务或媒体能力时立即返回结构化 `agent.capability_unavailable`，不会先创建会话或调用 provider。
- Desktop Agent 会话固定使用 `createPiAgentEventStream` 与 `receiveAgentEvent`，复用规范事件检查点、重放去重和现有 store 投影；`agentClientForRuntime()` 是唯一 renderer route selector。browser preview 使用 deterministic ACP fixture，不伪装成 Pi worker 已运行；旧 `agentEngine` persisted key 只为兼容归一化，不改变 runtime。
- Host 已提供完整的受控 ToolGateway：worker 只能请求 `workspace_read_file`、`workspace_read_tool_output`、`workspace_search`、`workspace_list_directory`（对应 Melody-build 的 `list_dir`）、`codebase_navigation`、`workspace_write_file`、`workspace_edit`、`workspace_apply_patch`、`run_terminal_command`、`ask_user_question`、`update_plan`、`spawn_subagent`、`run_background_task`、`get_command_or_subagent_output`、`wait_commands_or_subagents`、`kill_command_or_subagent`、`mcp_list_tools` 与 `mcp_call_tool`；Rust 按登记工作区、路径规范化、符号链接、命令/输出/并发上限和权限规则执行，再通过 `tool.resolve` 返回结果。代码库导航桥以 tree-sitter 做有限定义/引用/符号查询，支持 Rust、TypeScript/JavaScript、Python、Go，并按 `features.codebase_indexing` 处理布尔值或路径 glob；索引缓存最多保留 16 个工作区，严格语义代码图和未支持语言继续进入能力诊断。目录浏览默认跳过隐藏项和常见生成目录，递归深度、条目数和输出均有界；当 Melody 的 `.gitignore` 策略开启时，Host 使用与 Pi 原生文件遍历相同的 `ignore` 规则过滤搜索/目录列表，并阻止读取、编辑和删除被忽略文件，策略由受信资源清单投影到 worker。该策略不再触发能力回退。同一 workspace 的写入、编辑、补丁、终端变更和 MCP 工具调用由 Host 级策略保护；`workspace_apply_patch` 会先完整预检 Add/Delete/Update/Move，再落盘，避免并行会话互相覆盖或在校验失败时留下半应用状态。Pi 内置文件/终端工具仍关闭，避免绕过 Host 策略。MCP 进程由 Host 读取用户/项目配置后以无 shell、最小环境启动，远程请求也由 Host 使用固定 HTTP/SSE 客户端发送；JSON-RPC 帧、工具数量和输出均有界，所有请求有超时和回合取消。空闲 stdio 进程失活或调用失败会丢弃连接并在下一次请求时重连；工作区/worker 生命周期结束时会主动回收本地连接。另以 Pi `extensionFactories` 注入 first-party `todo_write`，任务状态写入 Pi custom entry 并可随会话分支恢复，不把原生扩展暴露为可任意加载的用户脚本。后台子代理与后台终端任务均提供 Melody 兼容的输出查询、wait-any/wait-all 和取消工具；后台终端 ID 使用 `pi-terminal-task:*`，由 Host 任务注册表统一负责回收。
- 项目级权限规则由 Rust Host 作为最终裁决者：`allow`/`deny` 会在 Pi 的权限交互发给 renderer 后自动解析，并在真正执行工具时再次校验；权限身份使用“工具标题 + 命令/路径”的稳定摘要，不把完整文件内容或补丁写入规则/事件。数据库查询失败、规则损坏或历史回放不会自动放宽权限，而是保留显式交互或拒绝结果。
- 当前 SQLite schema v10 包含 `agent_session_bindings`、`agent_event_log` 与 `migration_journal`；Pi 绑定保存最后一次权威的会话模式、权限模式、模型和思考强度。Host 在同一事务中幂等保存规范事件、product session ID、Pi native session ID、worker epoch、最后序号及这些配置；绑定用于恢复检查点和配置恢复，事件日志为后续重放/崩溃恢复提供事实源，迁移 journal 记录源摘要、转换计划、备份引用和可重试阶段。旧数据库启动时会按列/表补齐 v6–v10 增量，不会覆盖已有绑定或迁移历史。Pi worker 在 Host 注入的 `MELODY_PI_SESSION_ROOT` 下按 product ID 派生不透明文件名，重新打开同一 product session 时由 Pi `SessionManager.open` 恢复原生 JSONL；这仍不等同于导入旧 ACP 上下文。

- 开发时可设置 `MELODY_PI_WORKER_PATH` 指向已构建的可执行 worker。Host 默认把 Pi 凭据和模型目录放在应用数据根下的 `pi/auth.json`、`pi/models.json`，并通过 `MELODY_PI_AUTH_PATH`/`MELODY_PI_MODELS_PATH` 注入；启动时还会把 Melody 用户/项目配置投影为 `pi/melody-models.json`，只读保留 API、上下文、生成参数和请求头，密钥值仅按次注入 worker 环境。显式环境变量仍可作为受控开发或凭据服务覆盖。Host 不复制完整环境变量集合，只显式转发标准 HTTP/HTTPS/ALL/NO proxy 与 `SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS` 等证书变量，以保留企业代理、私有网关和自定义 CA；worker 直接启动且未提供 `MELODY_HOME` 时只使用临时目录，不触碰用户的 `~/.pi`。

### 1.2.3 本次收尾补齐（2026-09-08）

- 回合终止事件携带 `promptId`，前端按 prompt 精确清理 pending/running 状态；`turn.steer`/`turn.follow_up` 也会复用当前 prompt 关联，避免晚到的子任务事件关闭根会话。
- worker 对 `turn.steer`/`turn.follow_up` 强制校验当前仍在流式运行且 `runId` 一致；`turn.cancel` 与 `tool.resolve` 也校验可选的 run/prompt 身份，晚到的旧请求只返回结构化冲突，不会误操作新回合。
- worker 的 `session.open`、`session.import`、`session.configure`、`session.close` 按 product session 串行化；这与回合/工具解析并行隔离，既不阻塞审批恢复，也不会因重复打开、配置或导入/关闭竞态泄漏第二个 Pi 原生会话。
- `session.configure` 使用 `expectedRevision` 串行化配置变更，权威 `session.configured` 事件回写 revision、模型、思考强度和权限模式；过期配置会返回结构化冲突，不覆盖新设置。模型解析和思考强度会在任何 Pi/本地状态变更前完成校验，非法配置不会留下半应用状态；打开或导入会话也会携带恢复后的模型与思考强度。
- Pi 会话模式现在公开并执行产品统一的 `default`（代理）、`plan`（规划）和 `ask`（问答）三档：模式选择器在 Pi 会话中可用，ToolGateway 在权限询问之前强制拦截规划/问答模式的写入、终端、计划外委派和后台任务，不能通过 `always-approve` 绕过；未知模式会在配置边界拒绝。原生 `todo_write` 扩展也复用同一模式门禁，问答模式不会写入任务状态。
- Rust Host 的 ToolGateway 在 `spawn_blocking` 中执行文件/终端操作，事件日志重复序列在内存窗口之外回退 SQLite 判定；运行时健康事件没有产品 session 时不会触碰应用数据库。
- Pi 原生会话使用应用管理的 opaque 文件名；删除项目或会话时先停止对应 workspace worker（由 workspace store 负责），再移除原生 JSONL、导入备份和临时残留，SQLite 删除失败时不会留下半完成的产品记录。
- worker 关闭会话时先取消子任务、清空队列、尽力中止流并刷新 writer；`runtime.shutdown` 完成后才退出进程。Pi 事件回放与 live 订阅仍通过同一 barrier，避免断线重连时乱序或重复投影。

这组入口用于验证进程边界、受控宿主能力、原生会话持久化和检查点边界。Pi 是 Desktop 唯一 Agent runtime，不再 opt-in，也不因能力缺口、worker 错误或旧偏好回退 ACP；受支持能力经 Host bridge 暴露，缺口通过能力诊断说明或 fail closed。browser preview 独立保留 deterministic ACP fixture；旧 Melody/Claude JS hooks、插件动态扩展/非 stdio LSP、严格语义代码图、记忆 embedding/vector/dream、远端媒体生成和 headless OAuth 等差距见能力矩阵，不属于 ACP runtime fallback。未知工作区路径、绝对路径、路径穿越、符号链接和非 UTF-8 文件会被拒绝；终端超大输出返回有界预览并归档到工作区内的受控路径，MCP/Web/Memory/LSP/代码库导航响应仍遵守独立的大小和深度上限。

本地验证 worker 协议可使用：

```sh
pnpm --filter @melody/agent-worker check
pnpm --filter @melody/agent-worker test
printf '%s\n' '{"protocolVersion":1,"requestId":"health","command":{"type":"runtime.health"}}' \
  | pnpm --filter @melody/agent-worker start
```

要验证桌面 Host 的路径解析和握手，先构建一个可执行 worker 并设置 `MELODY_PI_WORKER_PATH`，再从已登记的工作区调用 `start_pi_worker`；不要把 npm 的 `start` 脚本路径直接当作正式产物。没有设置该变量且资源目录尚未包含 worker 时，Host 应返回 `missing`，而不是偷偷启动旧 ACP。

### 1.2.1 当前已落地的 ToolGateway 与绑定

终端输出补充工具：`workspace_read_tool_output` 只允许按有界字节范围读取 Host 生成的 `.melody/pi/tool-output/pi-output-*.log` 归档；它与普通 `workspace_read_file` 分离，避免放宽项目文件读取上限。

这批实现覆盖文件、终端、交互、计划、子代理和后台任务的受控纵向链路，同时固定安全边界和会话身份关系：

1. Pi worker 注册 Host-owned 的 `workspace_read_file`、`workspace_read_tool_output`、`workspace_search`、`workspace_list_directory`、`workspace_write_file`、`workspace_edit`、`workspace_apply_patch`、`run_terminal_command`、`ask_user_question`、`update_plan`、`spawn_subagent`、`run_background_task`、`get_command_or_subagent_output`、`wait_commands_or_subagents`、`kill_command_or_subagent`、`mcp_list_tools`、`mcp_call_tool` 自定义工具，并通过 `noTools: "builtin"` 明确关闭 Pi 内置文件/终端工具；同时以受控 `extensionFactories` 注入 first-party `todo_write`。worker 不直接读写工作区，也不接触 MelodyWork SQLite。
2. worker 发出 `tool.requested` 后暂停当前回合；Rust Host 校验 `toolCallId`、product `sessionId`、worker 世代和工作区根，在受限范围内执行，再发送带同一调用 ID 的 `tool.resolve`。工具调用、结果和超时不会绕过协议边界。
3. `session.open` 同时携带稳定的 `productSessionId` 与可选的引擎 `sessionId`，并可恢复绑定中的 `sessionModeId`、`permissionMode`、`modelId` 与 `reasoningEffort`；返回本次 Pi 运行的 `nativeSessionId`。Host 将规范事件连同 `nativeSessionId`、`workerEpoch`、`seq` 及权威配置在一个事务中写入 schema v10 的 `agent_event_log` 与 `agent_session_bindings`；ACP→Pi 导入则额外由 `migration_journal` 锁定计划和 `migrationId`。
4. 若 Host 注入 `MELODY_PI_SESSION_ROOT`，worker 根据 product ID 与工作区派生固定的 opaque JSONL 路径，通过 Pi 公开的 `SessionManager.open` 恢复同一 Pi 会话；模型凭据/目录同时使用 Host 注入的应用内 `pi/` 文件。未提供 Host 根目录时使用内存会话和临时模型数据，避免直接写入用户的 `~/.pi`。
5. 产品事件日志、绑定检查点和原生文件是三种不同层次的数据：日志保存规范事实，绑定保存恢复游标，原生文件保存 Pi 上下文。它们不会把旧 ACP 时间线伪装成 Pi 原生上下文。当前旧 `cursor`/ACP 原生 JSONL 导入仍明确拒绝；Desktop 使用 Pi，browser preview 使用隔离的 ACP fixture，旧 ACP 会话仅只读展示或作为显式 Pi 导入来源。

#### 1.2.2 恢复检查

Host 还提供只读的 Pi 会话恢复检查入口。它验证产品会话存在性、引擎绑定和最多 4096 条最近规范事件，汇总未结束的 run、工具、交互、任务/子代理、消息及压缩状态，输出 payload-free 的恢复动作摘要。摘要只用于后续协调器决定重放或人工确认，不会打开 Pi、执行工具或把提示词/参数/工具输出返回给 renderer；浏览器预览明确标记为不适用。

前端 `resumePiSession` 只执行其中安全的一步：当检查结果是完整且终态的 `replay` 时，按有界分页把 Host 事件日志投影给调用方；`clean`/`not-applicable` 不做任何写入，`reconcile`/`blocked` 返回 `manual`，由后续协调器处理未决副作用或人工确认。调用方应先建立 Pi live 订阅并传入同一个 `AgentEventStream`，避免重放期间到达的事件越过历史；该入口不会重新提交 prompt、工具或交互响应。

迁移演练还提供 `getPiSessionImportPlanForSession`。它优先读取完整 Host 时间线归档，输出版本化 `sourceDigest`、源条目到目标条目的映射以及 `native-message`/`custom-entry` 分级。没有附件的用户消息，以及携带完整 Pi `provider/api/model/usage/cost/stopReason` 元数据的 Pi 助手消息，才是原生消息候选；旧 ACP 投影缺少这些元数据的助手消息、思考、计划和工具仍作为展示归档，不会被伪造或重放。计划对条数、文本和附件大小设上限，活动交互、运行中工具、损坏归档或外部附件会明确返回 `blocked`。它是后续转换器的输入和审计凭据，不会自动创建会话、写 Pi JSONL 或改变引擎绑定。

### 1.2.4 能力预检与按会话回退（2026-09-08，历史方案）

> 本节以下段落记录早期按会话 ACP runtime fallback 设计，已被 2026-10-11 的 Pi-only 决定取代。当前能力缺口显示诊断，不支持或无法安全保留策略时阻断 Pi 会话；不会启动 ACP Agent runtime。browser preview fixture、旧 ACP 只读归档与显式导入不是运行时回退。当前边界以本文件开头、[交接文档](./handoff.md)与 `runtimeFallback=none` 的兼容清单为准。

Pi 连接现在会在启动前读取同一套受信任的用户/项目配置和扩展清单，只做静态预检，不加载或执行扩展代码。预检发现配置解析失败，或启用的未知/不完整 MCP、非 stdio/未受信任 LSP、需要语义索引的 Memory、动态 Hook/插件扩展、复杂 goal 编排，或无法安全枚举的 Skill 时，会为当前会话生成结构化阻塞诊断，并只把该会话路由到 Legacy ACP；受信任的 stdio LSP 通过 Host 的一次性只读桥接执行。Host 会将 `.melody/skills`、标准 `.agents/skills`、`.claude/skills`、`.cursor/skills` 以及纯 Markdown 插件 Skill 解析为有界、去符号链接的具体目录，再交给 Pi Host bridge。插件脚本/扩展以及超出路径、深度、文件大小或总量上限的 Skill 仍回退。基础 Memory 的首轮注入、session-end 保存、Markdown 检索和两阶段 Memory Flush 不再触发回退；embedding/vector/dream 等尚未等价的开关仍会纳入检查。基础 goal 状态和 `update_goal` 也由 Pi 扩展提供；有界 token budget、停滞检测和 blocked-attempt 上限由 Host 配置投影执行，只有分类器、规划/验证器、重试编排或角色模型策略会单独触发 ACP 回退。Pi 设置仍保留为用户选择，其他会话不受影响。这样不会因为一个项目的兼容缺口把整个应用切回旧引擎，也不会静默丢掉已启用的生态能力。

Pi worker 的订阅、状态读取、握手或启动失败也会触发同一条回退路径：先停止/清理 Pi 监听和进程，再建立 ACP 订阅并强制重新初始化当前会话。回退原因写入 `capabilityDiagnostics`，并持续附在运行状态提示上；若 ACP 也不可用，才向用户报告失败。运行时健康和模型目录命令携带会话归属，路由不再依赖“最后打开的会话”这种全局状态。

这层机制是“功能不减少”的安全阀，不等于 Pi 已实现所有生态能力。Host-owned stdio/HTTP/SSE MCP、Web、基础 Memory（含 lexical sidecar）、只读 stdio LSP、两阶段 Memory Flush、基础 goal 状态和有界 token/stall/blocked-attempt 护栏已进入 P3 实现，已覆盖安全边界、有界输出和生命周期回归；仍需真实 provider 认证和 Windows/macOS/Linux 样本验收。插件 Hook、非 stdio/不受信任 LSP、记忆 embedding/vector/dream、复杂 goal 编排、远端媒体、Windows 沙箱和 headless OAuth 仍需分别完成矩阵中的 P3/P4 验收；macOS Seatbelt 已完成，Linux workspace/devbox 已接入 Landlock 但需目标内核真实执法测试。在此之前，兼容引擎是明确、可观察、可回滚的实现，而不是隐藏的成功状态。

认证补充：Host-owned 远程 MCP 支持显式 `${ENV_VAR}` 请求头引用；401/403 分别以 `mcp.auth_required`/`mcp.access_denied` 报告且不回显认证响应体。真实 OAuth/provider 和三平台样本仍需现场验收。

大输出补充：终端工具和 MCP 工具现在都把超过预览上限的完整输出写入工作区内 `.melody/pi/tool-output/` 的受控归档，返回有界预览和归档引用，并执行单文件、文件数与总量保留上限；`workspace_read_tool_output` 按字节分段读取，不会放宽普通工作区文件上限。

### 1.2.5 生命周期与变更安全边界（2026-09-08）

- Host 的 workspace 变更锁使用弱引用注册表：同一 canonical workspace 的写入/编辑/补丁仍串行，但已关闭工作区不会把锁对象永久留在进程内；所有变更型路径都会拒绝符号链接，读取型路径才允许在已登记根内解析链接。Pi 只加载受控根下的普通技能目录和普通 `SKILL.md`，技能文件本身的外链也会被拒绝。
- `session.open` 除了检查会话存在和 Pi engine binding，还必须确认数据库中的 `cwd` 与当前 worker generation 的 canonical workspace 一致。工作区切换、项目/会话删除都会先按工作区安全停止 Pi worker，再清理 opaque JSONL、导入备份和临时残留，最后删除 SQLite 绑定、事件和时间线，避免晚到事件写入已删除会话。
- Host 对 persisted Pi session commands 的 workspace registration、active-worker workspace、engine binding、migration journal 和 fork intent checks 由 `src-tauri/src/pi_worker_runtime/session_commands.rs` 统一 preflight；`PiWorkerRuntime` 仍负责 process supervision/dispatch，Tauri command 保留 MCP/monitor 等跨运行时副作用。
- MCP 子进程与 worker generation 绑定：正常 stop、切换 workspace、协议错误、握手后异常退出和 stdout 提前关闭都会触发按 workspace 的取消与回收；活动调用按工作区子路径匹配，避免 MCP 配置使用受控 workspace 子目录时留下孤儿进程。
- worker 收到 `runtime.shutdown` 后停止消费后续 stdin 帧，等待已经排队的命令完成并刷新 JSONL writer，再自然退出；不会用强制 `process.exit` 截断仍在写出的终止事件。Host 仍保留超时强杀作为最后一道回收措施。

### 1.2.6 Prompt template 与 Markdown Skill 资源边界（2026-09-09）

Pi worker 保持 `noPromptTemplates: true`，但 Host 会把已登记工作区、用户目录和纯 Markdown 插件中的平面 `commands/*.md` 解析为显式文件清单，通过 `MELODY_PI_PROMPT_PATHS_JSON` 注入 `additionalPromptTemplatePaths`，并通过 `MELODY_PI_PROMPT_ROOTS_JSON` 传递同一批受控根及禁用名称快照。项目配置按最近仓库目录优先，其次是应用 `.melody`、用户 `.agents`/`.claude`/`.cursor` 与已验证插件；禁用列表、符号链接、嵌套目录、非 Markdown、单文件 1 MiB、总量 64 MiB、数量 512 的限制在 Rust 与 worker 两端同时执行。它只加载声明式文本，不执行插件/扩展代码；动态插件命令、需要目录层级命名的命令和其他未映射 slash command 在 Pi 内保持不可用/诊断，不再保留 Legacy ACP runtime 路径。

Skill 资源也保持 `noSkills: true`，由 Host 先枚举具体目录，再通过 `MELODY_PI_SKILL_PATHS_JSON` 注入 `additionalSkillPaths`，并通过 `MELODY_PI_SKILL_ROOTS_JSON` 注入同一批受控根及禁用名称快照。项目根从当前工作区向上查找到最近的 `.git`，按 `.melody`、`.agents`、`.claude`、`.cursor` 顺序建立优先级；随后才是应用 `MELODY_HOME/skills`、用户外部兼容根和静态插件 Skill 根。每个 Skill 必须是普通目录中的普通 `SKILL.md`，不接受符号链接、隐藏目录、`node_modules`、动态插件目录或外链文件；最多 256 个路径、深度 6、单文件 1 MiB、总量 64 MiB。目录内的其他文件仅作为 Skill 的声明式上下文，不会获得工具、Hook、MCP、LSP 或进程执行权限。该边界使标准外部和纯 Markdown 插件 Skill 在 Pi 下可用；不安全或动态扩展不由 ACP Agent runtime 兜底。

资源路径不是只在 `session.open` 时读取：每个新的顶层回合和后台子任务在调用 Pi `prompt()` 前都会重新枚举受控根，并通过 Pi `session.reload()` 重建系统提示。这样新增、修改和删除的 Markdown Skill/命令会在下一回合生效；正在运行的 steer/follow-up 不会中途重建运行时，避免打断当前 provider 请求。根目录清单只由 Host 生成，worker 会再次校验根路径、符号链接和资源大小，不会因刷新而打开 Pi 的 ambient 扫描。

当用户在设置中启用或停用 Skill/命令时，Host 还会发送 `session.resources.refresh`，更新运行中 worker 的禁用名称快照；该命令只携带 Host 生成的受控根清单，不接受 renderer 自带路径。空闲会话立即 reload，正在运行的会话在下一次新回合前 reload；没有活动 Pi 会话时不发送命令，下一次启动会从配置重新生成清单。

### 1.2.7 迁移 journal 与重试语义（2026-09-09）

ACP → Pi 导入不是一次不可审计的文件复制，而是由 Host 管理的 `migration_journal` 状态机：`materializing` 表示已锁定源摘要、转换器版本和完整计划，`applied` 只在带相同 `migrationId` 的 `session.imported` 事件与绑定更新同一事务提交后出现，`failed` 用于可重试的失败尝试，`rolled-back` 为后续人工回滚预留。相同 session、源摘要、转换器版本且计划结构相同的重试会复用原 ID；计划发生变化或旧尝试已失败时会生成新 ID，晚到的旧事件不能完成新尝试。

`session.import` 现在必须携带 journal 返回的 `migrationId` 和显式 `backup` 选择，Host 会在进 worker 前核对 session、workspace、结构化计划以及不可变的备份策略；导入事件的 event log、Pi 绑定和 journal 完成状态在同一 SQLite 事务中提交，任一校验失败都会整体回滚。会话/项目删除也会显式清理 journal，避免旧数据库未启用外键时遗留包含源摘要的孤儿记录。导入物化前的备份路径仍由 Host 生成和清理，renderer 不能指定任意文件。

### 1.2.8 Pi 原生替代与兼容层边界（2026-09-10）

Pi 原生已经承接模型/provider、流式事件、会话树、分支、压缩、公开扩展工具和 custom entry；MelodyWork 只保留产品级的 Host 权限、工作区、事件日志、任务归属、配置投影和恢复检查。提问超时策略也由 Host 配置投影为 worker gateway 的有界计时，资源刷新会清除旧策略，避免配置删除后继续使用启动时快照。MCP、文件/终端、权限、计划、问题、子代理和任务因此是“Pi 回合 + Host bridge”，不是把 Pi 当作安全沙箱。

第三方插件动态扩展/Hook、插件或非 stdio/不受信任的 LSP、记忆 embedding/vector/dream、远程媒体、Windows sandbox、Linux 上不可表达的 deny/旧内核与外部网络限制 profile、外部/OIDC 认证、复杂 goal 分类/规划/验证状态机仍没有 Pi 原生等价物；能力清单会诊断这些差距，无法安全表达的配置阻断 Pi 会话，不切换到 ACP（持久 scheduler 与 monitor 已由 Host 接管）。纯 Markdown 插件 Skill/命令、受信任 stdio LSP、基础 Markdown memory（含 SQLite lexical sidecar）、两阶段 Memory Flush 和基础 `update_goal` 已由 Host/Pi 扩展接管；Linux workspace/devbox 的 Landlock 仅在 ABI 3+ 内核上执行。每次升级 Pi 先依据[原生能力对照](./native-alternatives.md)确认公开 API 和安全边界，再运行完整门禁，不因接口名称相似而删除兼容层。

### 1.3 阅读顺序

1. 本文：架构、边界、取舍与目录设计。
2. [功能对等矩阵](./feature-parity.md)：迁移清单与逐项验收。
3. [协议、数据与安全](./protocol-and-data.md)：事件、会话转换、权限、回滚。
4. [实施、测试与发布计划](./implementation-plan.md)：阶段门禁、验证场景、升级机制。
5. [原生能力对照](./native-alternatives.md)：Pi 原生与 Host bridge 的边界；旧 ACP 仅为归档/导入来源。
6. [Pi 官方能力研究](../../research/pi-harness-capabilities.md)：固定版本的源码证据与 API 注意事项。

## 2. 研究基线与现状

当前设计基于 MelodyWork `beta`，提交 `ffa542f495ee188a3ccab313ab12b4f2580fafee`（`0.3.3-beta.4`）；vendored melody-build 为 `4b71187f2683a705ad25d523ed2fed1217ffab71`。实施前须重新冻结基线并记录正式版与 beta 的差异，不能直接把今天的行号或依赖版本当成永久事实。

Pi 研究固定到 `9841914c71a74d81abe07f751aefd271fd924e63`，研究发现其包版本为 `0.85.0`；正式 `v0.85.0` tag 则指向 `107d79f11072bbc8a3a757ed7fd69596bee7d68c`，不是同一提交。这是**研究 pin**，不是未经打包和测试就应采用的生产依赖版本；原型优先锁正式 tag/npm 精确版本，重新核对本文涉及的 API 与发布包。官方源码事实以研究文档中固定 commit 链接为准。

### 2.1 真实耦合位置

| 现有位置                                                            | 当前职责/耦合                                                       | 迁移影响                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| `src-tauri/src/agent_runtime.rs`                                    | 启动 `melody-pager agent --no-leader stdio`，收发 ACP，维护进程状态 | 不只改命令名；需要引擎监督器与协议边界                    |
| `scripts/prepare-sidecar.mjs`                                       | 构建/查找 Rust sidecar，处理 target 与备用来源                      | 新增可重现 Pi worker 打包，不可把开发环境回退逻辑带入发布 |
| `src/domain/acp.ts`                                                 | 消息、工具、计划、问题、计费、Subagent 等产品类型                   | 分离产品模型与 Melody ACP wire 类型                       |
| `src/stores/agent-store-runtime.ts`、`agent-store-session.ts`       | 初始化、模型/模式切换、请求 ID、超时、后台会话路由                  | 从直接组装 ACP 改为产品命令；保留现有行为                 |
| `src/domain/session-projection-persistence.ts`                      | `x.ai` 扩展事件、恢复游标、重放与终止事件                           | Melody 与 Pi 分别适配，UI 不再解析两套原始事件            |
| `src-tauri/src/database_core.rs`、`database_sessions.rs`            | SQLite schema 5、时间线归档/快照                                    | 区分产品时间线和引擎原生会话，不能拿快照充当完整上下文    |
| `src-tauri/src/config_*.rs`                                         | 读写 `.melody/config.toml`、调用旧 CLI 管插件、兼容目录             | 配置与插件必须脱离旧 CLI，保留旧格式兼容与未知字段        |
| `src-tauri/src/database_permissions.rs`、`src/domain/permission.ts` | 项目级允许/拒绝规则                                                 | 独立于引擎，保持精确匹配与撤销                            |
| `src-tauri/src/lib.rs` 注册的桌面命令                               | Git、文件、终端、项目、系统集成、研究、更新                         | 原样保留；不为换 Pi 重写这些成熟模块                      |

例如当前投影版本为 3，存在 `eventId`、`isReplay`、`promptId`、`totalTokens` 等 Melody 扩展元数据。现有恢复逻辑不是 Pi 原始事件的直接消费者；简单换流式响应格式会导致旧会话、上下文用量、后台任务和动效回归。

### 2.2 Pi 能替代什么

采用 coding-agent SDK，优先复用其会话、模型调用、工具循环、压缩与扩展生命周期。不要从 `pi-agent-core` 开始重建已经存在的 coding-agent 能力；`pi-ai` 可在确有产品需要时直接用于额外的模型/媒体服务，但不能另建一套竞争的主会话循环。

尤其需要注意：Pi 没有默认的完整权限隔离系统；安装扩展和执行任意 shell 均不能被“用了 Pi”视为安全。当前 API 已采用 `ModelRuntime`；`createAgentSession.tools` 是名称 allowlist，定制工具使用 `customTools`；会话替换通过 `AgentSessionRuntime` 管理。源码还涉及默认工具并行执行，必须评估其与本项目写入顺序、审批的关系。详见[研究文档](../../research/pi-harness-capabilities.md)，不要套用旧包名或旧 SDK 示例。

## 3. 推荐架构

```text
React 界面 / Zustand 产品状态
        │ 产品命令、规范化事件（不含 Pi/ACP 类型）
        ▼
Rust Host：会话路由 + 进程监督 + 产品事件日志 + 权限裁决
        ├── 原有 SQLite / 文件 / Git / PTY / 更新 / 桌面服务
        ├── LegacyAdapter ── melody-pager（仅过渡期）
        └── WorkerTransport ── 独立 Pi Worker
                                 ├── PiAdapter → coding-agent SDK
                                 ├── Tool Gateway → Host 权限/宿主服务
                                 └── 产品服务：计划/问题/子代理/记忆/MCP/兼容插件
```

图中是逻辑职责，不要求每个方框都成为进程或 npm 包。Pi worker 与 React 隔离，避免把密钥、原生模块、文件系统和 Node 依赖带入 WebView。

### 3.1 四个架构决定

**A. 产品协议优先，不长期伪装成完整 ACP 服务。**

先把现有 ACP 映射为产品命令和事件，再接 Pi。短期兼容现有 Tauri 命令可减少改动，但 `x.ai` 事件只允许在 LegacyAdapter 出现。否则每次 Pi 新能力都要先假扮 Melody，旧耦合会永久保留。需要外部 ACP 接入时另加边缘适配器，不把它当内部领域模型。

**B. SDK 优先，RPC 用于有限原型/诊断。**

Pi 现成 RPC 可用于快速验证模型和流式连通性；主产品需要精确权限、定制工具、插件和子代理语义，建议 SDK worker。采用公开导出 API，不深度导入私有源码、不维护 Pi 源码补丁；若关键 API 只存在私有实现，将其记录为阻塞并向上游提出最小接口需求。

**C. Host 管宿主资源，worker 管 agent 工作流。**

Rust 保留数据库、桌面、工作区与进程所有权。TS worker 负责 Pi 适配与模型相关产品服务。已有能力不同时在 Rust/TS 各实现一份。记忆检索等可迁移的服务采用明确端口；先保证语义，再判断实现语言，不把全部 Rust 代码翻译为 TS。

**D. 一个会话一个执行 actor，进程分配可独立优化。**

第一阶段建议每个正在执行的根会话有独立 worker；空闲会话持久化后可退出，避免所有历史会话常驻。子代理拥有独立原生会话与上下文，默认独立 worker 便于取消和故障隔离；不能共享可变 cwd、当前模型或“当前会话”全局变量。Host 统一限流，超过配置上限排队，不无上限启动进程。待基准数据证明成本过高，再评估可信、同工作区会话的进程池；安全隔离不能靠池化假设。

### 3.2 状态所有者

| 数据                                 | 唯一权威所有者                   | 其他层可做什么                          |
| ------------------------------------ | -------------------------------- | --------------------------------------- |
| 项目、UI 会话 ID、归档、标题、工作区 | Rust SQLite                      | React 展示；worker 接收执行快照         |
| 产品事件日志、审批与恢复游标         | Rust                             | worker 报送事件，React 按序投影         |
| 模型调用所需原生消息树/压缩状态      | 对应引擎原生会话存储             | Rust 存绑定/检查点，不手写 Pi 内部结构  |
| 模型目录、配置作用域与版本           | Host 配置服务                    | worker 获取版本化快照，UI 使用同一目录  |
| 密钥与 OAuth 凭据                    | 受控凭据服务/引擎凭据适配        | 最小范围注入 worker，不经过产品事件日志 |
| 任务调度、父子关系、进程生命周期     | Host                             | worker 发请求，不私自创建无追踪后台任务 |
| 计划、结构化问题、工具结果语义       | worker 产品服务 + 持久化产品事件 | UI 不根据自然语言猜测工作流             |
| 输入草稿、面板展开、动画状态         | React                            | 不写回原生模型上下文                    |

关键约束：Pi 原生文件和产品日志是不同数据，不要求两者伪装成一个数据库。通过稳定 ID、检查点和恢复流程协调，不能承诺跨文件/SQLite 的原子事务。

## 4. 目录设计与依赖规则

以下目录表示职责归属，不要求机械搬迁。当前 Agent runtime 为 Pi-only：`packages/agent-contract/` 定义共享协议，`packages/agent-worker/` 适配 Pi SDK 并通过 Host ToolGateway 请求访问产品能力；`src-tauri/src/pi_worker_runtime.rs` 管理 worker 与会话事件，Host 负责持久化、权限裁决、工作区约束和原生工具实现。ACP 仅保留为只读历史归档/导入，不运行，也不是 Pi 的兼容回退（`runtimeFallback=none`）。具体实现状态、平台限制和验收边界以 [`handoff.md`](handoff.md) 与 `pi-compatibility-manifest.json` 为准。先保持这些稳定 seam 清晰，不按每个小函数机械拆包。

```text
packages/
  agent-contract/
    schemas/                 # 唯一协议定义：命令、事件、错误、能力协商
    generated/               # 生成的 TS / Rust 类型，不手工双写
    fixtures/                # 协议兼容、未知字段、事件重放样本
  agent-worker/
    src/main.ts              # stdio 启动、握手、健康检查
    src/transport/           # 帧、校验、背压、Host 服务调用
    src/pi/                  # 唯一允许直接 import Pi 的区域
    src/sessions/            # actor、原生会话绑定、恢复
    src/tools/               # 注册、审批封装、并发/写入冲突策略
    src/services/
      plans/ questions/ subagents/ memory/ mcp/ plugins/ media/
    tests/                   # SDK契约、工具安全、故障恢复测试
src/
  domain/agent/              # 纯产品模型、投影、能力/错误模型
    event-store-adapter.ts   # 每 product session 一个投影器，并输出 UI patch
    projection-store-patch.ts # 规范事件 → 当前/后台 store 的纯适配
  lib/agent-client/          # Tauri客户端、命令与订阅
  stores/                   # 保留现有 store API，逐步清除 wire 协议细节
  features/                 # 现有 UI，原则上不改组件风格
src-tauri/src/agent/
  supervisor.rs             # worker生命周期、退出/取消、并发额度
  router.rs                 # 产品会话 → engine/worker
  transport.rs              # stdio帧与握手
  policy.rs                 # 权限/信任/宿主边界
  event_log.rs              # 产品事件顺序、检查点、重放
  legacy.rs                 # 旧ACP映射，退出迁移后可删除
  migrations.rs             # 引擎绑定与数据迁移协调
scripts/
  prepare-agent-worker.mjs   # 可重现跨平台产物准备
docs/architecture/pi-migration/
```

实施时以代码库现有风格调整文件名；不要为了完全对齐目录树挪动所有文件。现有 `config_runtime.rs`、数据库、终端与研究服务保留入口，逐步拆出职责。

依赖规则用 CI 检查：

1. `src/` 禁止导入 Pi、worker、Node 内建模块。
2. 只有 `agent-worker/src/pi/` 可导入 Pi 主会话 SDK；模型/媒体专用适配也集中于该目录。
3. contract 不依赖 React、Zustand、Tauri、Pi 或文件系统。
4. worker 不直接修改 MelodyWork SQLite；需要宿主服务时走版本化调用。
5. Legacy wire 类型不允许回流到产品 reducer；新代码不增加 `x.ai` 分支。
6. 第三方插件经过注册/信任流程，不允许自动发现后无提示执行代码。

### 4.1 现有文件的渐进迁移

- 将 `domain/acp.ts` 中产品类型抽到 `domain/agent/`；ACP结构留在 legacy 边界，不一次性删除全文件。
- `agent-store-runtime.ts` 与 `agent-store-session.ts` 已由 Pi-only renderer route 使用；活动 store 状态用 `runtimeSessionId`/`runtimePhase`/`eventCursor`，持久化适配器在写入边界映射回 legacy ACP cursor 字段。
- 将 `session-projection-persistence.ts` 的 wire 解析移入适配器，投影只读规范事件；保持历史投影迁移器。
- Desktop Pi 通过 `receiveAgentEvent`/`AgentEventStoreAdapter` 投影规范事件，组件不解析 Pi 事件；browser preview 的 deterministic ACP fixture 独立适配，不是 Desktop 默认 bridge 或 ACP fallback。
- `agent_runtime.rs` 逐步变为兼容入口和 supervisor，不立即改所有 invoke 名称。
- `config_marketplace.rs` 的旧 CLI 调用逐项替换为插件服务，不能等到删除 sidecar 后才发现安装/卸载失效。
- `prepare-sidecar.mjs` 过渡期支持明确的两个产物；生产构建必须声明引擎，不能静默复制用户电脑中旧二进制。

## 5. 功能实现策略

### 5.1 模型、配置和能力协商

模型配置保存后，Host 会重新生成当前 workspace 的模型目录、策略文件和短生命周期凭据引用，并向活动 worker 发送 `runtime.models.sync`。worker 串行更新生成的 `MELODY_PI_MODEL_*` 环境变量、清理对应 provider 的运行时认证覆盖、替换旧的重试/空闲超时覆盖并刷新 `ModelRuntime`；正在进行的回合保持原模型，下一回合读取新快照。同步载荷由 Host 生成并在 worker 内复核，renderer 不能注入自定义路径、provider ID、策略或密钥；没有活动 Pi 会话时不发送命令，下一次启动直接使用最新快照。

建立单一 `ModelCatalog`，设置页、模型选择器、worker 使用同一快照与 revision。当前 Pi worker 已提供 `runtime.models.list`/`runtime.models` 快照：包含 provider/id、API、输入类型、上下文/输出上限、思考能力和 `available`/`auth-needed`/`unavailable`/`unknown` 状态，不含密钥；Host 启动时已把 Melody 用户/项目配置投影到应用内 `pi/melody-models.json`，前端新增 `projectPiModelCatalog`/`requestPiModelOptions` 适配层，把可用模型转换为现有 `AgentModelOption`，并把认证失败或 provider 错误保留在 `unavailableModels` 供设置与诊断使用。Desktop Pi session 在打开前请求同一目录，运行中切换使用 canonical `provider/model` id 和 revision；browser preview 使用独立 ACP fixture，不构成桌面 ACP runtime fallback。保留模型显示名与真实请求 ID、提供商、base URL、API 类型、认证、上下文、思考强度及生成参数。自定义模型的 `input = ["text", "image"]` 会保留图片输入能力；缺省仍为纯文本，提交图片到纯文本模型会在 worker 边界给出明确错误。UI 显示“配置成功”后需等目录更新确认，不能由 worker 启动时的一份缓存决定下拉列表。

当前 `responses`、`messages`、`chat_completions` 逐一与 Pi 模型接口映射；自定义 OpenAI 兼容接口不能只凭名称推断支持 Responses 或推理参数。未知 provider 字段必须保留原配置并标记待支持，不能静默丢弃。无法映射且当前可工作的模型是迁移阻塞，不是删除模型的理由。

Host 模型目录 projection 的实现所有权现拆为三段：`pi_remote_model_catalog.rs` 负责受限 remote catalog acquisition，`pi_model_config/model_projection.rs` 负责 user/project merge、remote model overlay、provider/model schema 与 credential-reference projection，`pi_model_config.rs` 负责读取输入、调用各 owner、写入生成文件和注入 resolved credential values。该拆分保持既有模型目录与 auth 文件格式。

Host 还会按同一覆盖优先级生成独立的 `pi/melody-model-policies.json`，通过 `MELODY_PI_MODEL_POLICIES_PATH` 传给 worker。该快照只承载经过校验的 `maxRetries`、`inferenceIdleTimeoutMs` 与 `autoCompactThresholdPercent`，并限制文件大小、模型数量和数值范围；纯 Host policy projection 位于 `src-tauri/src/pi_model_config/model_policy.rs`，模型目录/credential-reference projection 位于 `pi_model_config/model_projection.rs`，目录读取、remote acquisition、文件写入和 resolved credential injection 仍由 `pi_model_config.rs` 组合。策略快照不进入 Pi 严格模型目录，文件损坏会显式失败而不是静默使用错误默认值。

启动握手返回协议版本、worker版本、Pi版本、支持工具/工作流和限制。能力缺失在开发与 beta 明确报告，稳定版验收不能用隐藏按钮掩盖缺失。

### 5.2 工具、权限、计划与问题

统一 Tool Gateway。默认内建工具若不能被完整策略封装，就关闭对应 allowlist 项，用同名/等价的受控工具替代；避免默认工具与自定义工具重名产生旁路。输入验证、审批、执行、输出截断/归档、审计均走同一路径。

保留 ask/auto/always-approve 的现有语义，但 always-approve 不能绕过 plan mode 的写入禁令、工作区边界或企业/用户显式拒绝。计划是显式状态机，不是 system prompt 里写一句“不要改文件”。结构化问题必须保留多选、补充文字、预览和接受/跳过/取消等分支。

对 shell、第三方扩展、MCP 权限的安全边界另见[安全设计](./protocol-and-data.md#5-权限与信任边界)。进程分离不等于沙箱；隔离由 Host 施加在它派生的命令上（macOS Seatbelt 与 Linux Landlock，见 `workspace_sandbox`），profile 不支持安全执行时（网络受限 profile、glob deny、Linux exact deny/旧 ABI、Windows）会阻断相关 Pi 会话，不会静默降低隔离级别或回退 Legacy ACP。

### 5.3 Subagent 与后台工作

Subagent 是产品能力，不能把官方示例直接当成现有完整实现。保留独立会话、模型/effort、persona/role、工具能力限制、foreground/background、worktree、resume_from、父子状态、取消、统计和头像展示。父代理只获得必要的结果/摘要，不能把所有子会话原始历史全部复制回父上下文。

权限上限取父任务授权、子代理能力与工作区策略的交集；子代理不得通过 persona 增加权限。Host 为任务分配 ID 和生命周期，调度服务负责输出分页、等待、超时、取消、孤儿回收。重启后禁止无判断地重跑可能有副作用的后台命令。

### 5.4 插件、MCP、记忆与媒体

插件 Marketplace 属于 MelodyWork 产品，不随换 Pi 消失。保留来源、版本/同步状态、安装/更新/卸载、组件详情和启用范围。建立兼容层解析 Melody/Claude manifests、skills/commands/agents/hooks/MCP/LSP；当前 P3 已落地 Host-owned 本地 stdio/HTTP/SSE MCP bridge 与受限 JSON command Hook bridge，插件执行仍保守回退。兼容必须落实到执行语义；某 hook 无法映射应给出明确报告并阻止宣称迁移完成。

长期记忆与 Pi 的会话压缩不是同一能力。记忆导入、检索、作用域、回注入、索引和删除仍需独立服务。图片输入也不等于图片/视频生成工具；Pi 已存在图片生成相关底层 API，但需验证本项目 provider 与工具接口，视频等未对等能力继续由产品扩展实现。

## 6. 决策记录与未决项

| 决策        | 选择                        | 不选项/理由                                  |
| ----------- | --------------------------- | -------------------------------------------- |
| 主内核      | coding-agent SDK            | agent-core 太低层，会重新承担会话/压缩等维护 |
| 前后端边界  | 产品协议 + worker           | UI直连SDK会引入平台依赖、密钥和升级耦合      |
| 升级策略    | 固定版本、公开API、契约测试 | 跟随main/运行时拉最新包不可重现              |
| 现有界面    | 保留并适配                  | 迁移时顺带重设计会扩大回归面                 |
| 旧会话      | 保留源数据，分级转换/继续   | 仅导入可见消息会丢隐藏上下文和工具关联       |
| Pi新包/能力 | 按缺口选用                  | 不因存在 Chord 等新包重写整个桌面应用        |
| 安全        | 保留策略并验证所有执行路径  | 无权限扩展/只靠提示词均不满足现有语义        |

必须通过原型解决的事项：三平台 worker 的可靠打包及原生依赖；真实自定义模型兼容；旧原生会话格式转换覆盖率；现有插件 hook 的可实现语义；当前沙箱能力的实际平台覆盖；Pi session replacement 后订阅/扩展生命周期；默认工具并行下的文件冲突与审批顺序。

这些不是需要用户现在填空的问题。实施阶段先做证据采集和小规模原型；只有发现会减少功能、改变信任边界或需要新外部服务费用时，才提请用户选择。
