# 产品协议、数据迁移与安全

状态（2026-10-05）：协议 v1、Host-owned ToolGateway、Pi 原生会话目录、绑定检查点、幂等事件日志、显式 ACP → Pi 导入与恢复检查均已接入。Pi 是唯一 Agent runtime；ACP 只作为历史会话导入来源，不是 Pi worker/能力缺口的运行时回退。未覆盖的生态能力会报告为不可用，涉及安全边界的配置会阻止 Pi 会话打开。Browser/Explorer 的真实桌面权限与重启/故障注入仍待现场验收。关联：[总设计](./README.md)。

## 1. 协议边界

产品协议称为 `Melody Agent Protocol`（内部名称，非新公共标准）。版本从 1 开始。JSON Schema 为唯一源，生成 TS/Rust 类型并用同一组 fixtures 验证；类型生成不代替运行时输入校验。

React → Tauri 使用类型化 invoke/事件；Host → worker 使用 LF 分隔 JSONL，stdout 只传协议，日志走 stderr。读取器仅按 LF 分帧，不把 Unicode U+2028/U+2029 视为换行。大附件、工具完整输出存为受控资源引用，不塞入无限长 JSON 行。

初始建议帧上限 1 MiB、附件单独配额、待发送队列有界；这些是待基准验证的工程初值。超限返回结构化错误，不能截断 JSON 后继续解析。stderr 同样限速并脱敏。worker 路径、参数、cwd由 Host 验证，renderer 不得指定任意可执行文件。

### 1.1 命令与结果

拟定命令族：

- `runtime.hello/health/shutdown`：协商协议范围、构建版本、Pi版本、能力与限制。
- `session.create/open/fork/close`：产品 session ID 与引擎绑定分离。
- `turn.submit/steer/followUp/cancel`：接受、排队和完成分开表达。
- `session.configure`：模型、effort、模式等版本化设置。
- `session.resources.refresh`：由 Host 重新投影受控 Skill/命令根和禁用名称快照，刷新当前 worker 中的所有 Pi 会话。
- `runtime.models.sync`：由 Host 重新投影模型目录和短生命周期凭据，让运行中的 worker 在不重启会话的情况下应用下一回合的模型配置。
- `interaction.resolve`：审批、问题、计划的定向回复。
- `task.inspect/output/wait/cancel`：后台任务及子代理。Pi worker 通过 `get_command_or_subagent_output`、`wait_commands_or_subagents` 和 `kill_command_or_subagent` 暴露与 Melody-build 相同的控制面；Pi 子代理由 worker 管理，后台终端由 Host 受控注册表管理，两者不能在同一批 wait 中混合。
- `events.resume`：从产品游标恢复，不接受 Pi tree ID 作为游标。

会话模式的 ID 在协议上仍是字符串，以兼容 ACP 的扩展模式；Pi 侧只接受共享契约声明的 `default`、`plan`、`ask`。Pi 没有可直接注入 ACP 模式的上游扩展，因此模式语义落在自定义 ToolGateway：`plan` 允许读取、提问和更新计划，`ask` 只允许读取和提问，写入、补丁、终端、委派和后台任务在权限交互之前即被拒绝。该限制独立于 `ask`/`auto`/`always-approve` 权限模式，不能通过永久授权绕过；未知模式在 `session.configure` 或回合配置校验时失败。

### 1.1 Host-owned MCP bridge

Pi worker 只注册两个通用 MCP 代理：`mcp_list_tools`（只读）和 `mcp_call_tool`（调用前仍经过 Host 权限策略）。Rust Host 从用户/项目配置合并 `mcp_servers`、`mcpServers`、`mcp`、`mcps` 根键，接受带 `command` 的本地 stdio 服务，以及经过 URL、transport、请求头校验的 HTTP/SSE 服务；不执行 shell，不接受 stdio 配置中的任意远程 cwd，子进程只继承最小环境并使用固定 workspace 作为默认 cwd。JSON-RPC 使用有界的 LF JSONL（stdio）或有限 HTTP/SSE 响应，初始化、工具分页、调用超时、取消、工具数量和结果文本均有上限，stderr 只排空不进入产品事件。

Host 维护按 canonical workspace + server name 索引的短生命周期连接；初始化失败、协议错误、超时或调用失败会丢弃连接，下一次请求重新建立。HTTP transport 使用无重定向、固定 User-Agent 的 Host client；SSE 首先读取服务端 endpoint 事件，再把 JSON-RPC POST 发到解析后的受控 URL。endpoint 只允许相对路径或配置 URL 的同源 HTTP(S) 地址，避免服务端把认证请求头引向第三方域名。远程请求头支持显式 `${ENV_VAR}` 引用：只有 Host 读取已命名的环境变量，解析后的值不会进入模型目录、事件、权限规则或错误正文；未设置的变量会作为配置错误报告。对 `text/event-stream` 响应，Host 在收到匹配 request id 的事件后立即结束本次读取，不等待服务端关闭长连接；停止 worker、切换工作区或取消回合也会中止正在读取的远程响应。HTTP 401/403 会分别报告 `mcp.auth_required`/`mcp.access_denied`，不会回显认证响应体，便于 UI 区分“需要凭据”和普通网络故障。工具列表只返回名称和截断描述，调用参数必须是 JSON object；server/tool 名称组成稳定权限身份，完整参数和密钥不会写入权限规则或日志。缺失 command/URL、未知 transport 或格式不完整的 MCP 条目在能力预检中生成不可用诊断，相关服务在本次 Pi 会话中不可用，不能因为发现了配置就宣称 Pi 已覆盖全部 MCP。

每个请求含 `protocolVersion`、`requestId`、`sessionId`（若适用）。运行时健康和模型目录这类全局命令也可在 envelope 与 command 中携带可选的 session affinity；它只用于 renderer 的按会话引擎路由，不会把运行时事件伪装成会话事件。这样 Pi 命令始终按会话身份路由；Pi 启动失败会明确失败，不会改走 ACP。`session.configure` 可带 `expectedRevision`，`turn.submit` 的配置快照带 `configRevision`；执行型请求还含 `idempotencyKey`。Pi worker 现在为每个打开的会话保留有界幂等账本：同一 key 且命令指纹相同的重试直接忽略，不启动第二次模型回合；同一 key 配上不同命令会返回 `pi.idempotency_conflict`。账本只负责阻止重复执行，原始结果仍由产品事件日志重放；会话关闭时清除，避免跨会话复用。配置冲突返回 `revision_conflict`，不悄悄覆盖。回合控制命令会校验 `runId`/`promptId` 与 worker 当前活动目标，`tool.resolve` 会在提供 `runId` 时校验挂起调用所属运行；旧回合的晚到响应会被拒绝而不会取消或恢复新回合。生命周期命令在同一 product session 内串行执行（包括 `open`/`import`/`configure`/`close`），资源刷新命令不携带 renderer 路径，Host 会重新生成根清单并在 worker 内再次核验。刷新不会打断正在进行的 provider 回合：运行中只更新下一回合使用的资源，空闲会话立即 reload。命令进入 worker 前统一通过 `AgentProtocolCapabilities` 门禁，缺少必需能力时返回 `agent.capability_unavailable`，并在错误详情中列出命令类型和缺失能力；这样 UI/Host 不会把 Pi 的“未实现”误当成 provider 运行失败。

对已经打开的会话，Host 还会在写入 worker 前核对三件事：产品会话存在、其 `cwd` 与当前 workspace-scoped worker 的规范化路径一致、`agent_session_bindings` 明确标记为 `pi`。`session.close`、`session.configure`、所有 `turn.*`、交互/工具回复和后台任务命令都经过这条门禁；`session.open`/`session.import` 继续使用各自更严格的预检。包络层的可选 `sessionId` 若存在，也必须与命令中的会话 ID 相同。启动前的 `runtime.health` 和 `runtime.models.list` 不要求已有绑定，因此不会阻塞首次打开会话的握手与模型目录加载。任何不匹配都会在 Host 返回可解释错误，不把请求交给 Pi。

Host先持久化接受记录再确认。接受只是排队成功；完成通过 run 终止事件报告。worker崩溃或网络超时后客户端不得无判断地重新发送有副作用请求。

Host-owned `workspace_list_directory` 对应 Melody-build 的 `list_dir`：只能浏览登记工作区内的相对目录，默认跳过隐藏项和常见生成目录，递归深度、条目数和输出大小均有界，符号链接不被遍历；当资源清单开启 `.gitignore` 策略时，`workspace_search`、`workspace_list_directory` 以及读/编辑/补丁目标会由 Host 使用 `ignore` crate 的同一套 parent/global/exclude 规则过滤或拒绝，避免 Pi worker 绕过项目文件可见性策略。`run_terminal_command` 对 stdout/stderr 采用有界读取；设置 `background=true` 时，Host 会把进程放进带 workspace/session 归属的受控注册表并返回 `pi-terminal-task:*` ID，最多保留 64 个任务，支持有界 wait/get/kill，worker 停止、切换工作区或失败时会请求取消仍运行的进程。前台和后台任务的输出都受上限保护；超过 8 MiB 的预览会写入工作区内 `.melody/pi/tool-output/` 的受控归档，并在工具结果中返回相对路径引用；单文件最多 64 MiB，最多保留 32 个文件且总量最多 512 MiB，目录层级和归档文件均拒绝符号链接。worker 可通过只读的 `workspace_read_tool_output` 按字节范围读取归档，不会放宽普通 `workspace_read_file` 的 2 MiB 项目文件上限。MCP 的本地/远程响应受 1 MiB 网络体上限约束，超过 512 KiB 预览上限的完整结果使用独立 `mcp-output-*` 归档，同样只能通过受控的分段工具读回。

模型配置同步与资源刷新都由 Host 生成载荷。renderer 只能请求刷新，不能携带 provider ID、文件路径、禁用清单或凭据；Host 会基于当前 workspace 重新投影并让 worker 再次校验。同步不会打断正在进行的 provider 回合：运行中只更新下一回合使用的模型/凭据快照，空闲会话立即刷新。

### 1.2 事件信封

Host 持久化结果会明确区分新增、相同内容的重复和未知产品会话三种状态：重复事件不会再次投影到 UI 或触发 ToolGateway，未知会话仍会终止当前 worker；监督器保留有界的 eventId 与 payload 窗口，使同进程即时重试不会在持久化前被误判为乱序。这样既保持跨重启幂等，也不会把未知会话或被篡改的重放吞掉。

下面是当前协议 v1 的结构示例（与 `packages/agent-contract/src/index.ts` 一致）：

```json
{
  "protocolVersion": 1,
  "eventId": "evt-unique",
  "sessionId": "product-session-id",
  "runId": "run-unique",
  "seq": 42,
  "workerEpoch": "worker-generation",
  "replay": false,
  "event": {
    "type": "message.delta",
    "messageId": "message-stable-id",
    "partId": "part-1",
    "offset": 128,
    "text": "新增文本"
  }
}
```

当前 worker 还会提供 `sourceEventId` 和可选 `requestId`；`seq`/`workerEpoch` 由 worker 进程生成。`workerEpoch` 防止旧进程晚到消息污染新运行，Host 会把已接受事件的完整规范信封、Pi native session ID、worker epoch、最后序号和权威会话配置在同一事务中写入 schema v10 的 `agent_event_log` 和 `agent_session_bindings`。配置检查点包含 `sessionModeId`、`permissionMode`、`modelId` 与 `reasoningEffort`，可在 worker 重启后恢复；v6–v10 旧 schema 会在启动时按列/表补齐。相同 `eventId` 且内容相同的重放是幂等的；同一世代的旧序号或不同内容冲突会被拒绝。Host 桥接已实现协议版本、ID、世代、序号和 1 MiB 帧校验；重放标识属于传输投递元数据，不改变事件事实。

终止类事件（尤其 `run.finished`）携带产生它的 `promptId`（旧事件可省略），用于把终止与对应的前端 pending 回合精确关联；健康握手等运行时事件可以不带 `sessionId`，不写入产品会话日志。事件类型至少覆盖：

| 事件族                                        | 语义                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `run.accepted/started/queue_updated/finished` | 排队、执行、steer/follow-up队列快照、唯一终止；finished携带completed/failed/cancelled/interrupted |
| `message.started/delta/completed`             | 文本、思考等part；最终完整内容与增量可校验                                                        |
| `tool.requested/started/progress/finished`    | toolCallId稳定，审批等待不冒充已开始执行                                                          |
| `interaction.requested/resolved/expired`      | 权限、计划、结构化问题共用关联机制，payload分别定义                                               |
| `plan.changed`                                | 计划版本、状态、报告资源和反馈                                                                    |
| `task.changed/subagent.changed`               | 父子关系、阶段、结果、统计                                                                        |
| `usage.updated/context.updated`               | 账单与当前上下文分开，来源与可信度明确                                                            |
| `session.compacting/compacted/configured`     | 压缩、检查点与配置变化                                                                            |
| `runtime.warning/error`                       | 结构化错误，脱敏细节与可恢复性                                                                    |

未知可选事件可记录并忽略；未知必须能力/不兼容主协议版本必须拒绝连接。错误包含稳定 code、retriable、scope、userMessage 和脱敏诊断 ID；不要让 UI 正则解析英文报错决定重试。

### 1.3 排序、背压与重放

产品终态、审批、工具完成必须先持久化再发给 UI。文本增量可按小批次提交以减少写放大，但未提交的增量不能作为已确认游标。保存 message checkpoint 后可压缩过旧增量日志，resume低于保留范围时返回快照+新游标。

同会话事件有全序；跨会话不强求全局顺序。UI去重键使用 eventId，缺seq请求补偿；消息使用 offset/revision校验，不盲目 append。最终 completed内容用于修复最后一批丢失增量。动效只针对首次收到的新增文本，不能因重放或组件重挂载重新播放全部内容。

UI慢消费者不阻塞无限内存：合并可合并的文本批次，保留语义事件；超出队列预算断开订阅并要求恢复。禁止丢掉工具终止/审批事件以维持流畅。Pi worker 对 data URL 附件设置单个 10 MiB、单次 25 MiB 上限，并在发出 `run.accepted` 前完成解码，避免坏附件留下无法结束的假运行。

## 2. 会话执行与取消

每个session actor一次只执行一个主回合；steer/followUp有独立队列和顺序。Pi 的 `queue_update` 会被规范化为 `run.queue_updated` 辅助事件，保留队列快照但不制造时间线消息。Pi的 `agent_end` 等事件不是任何场景下“整个产品任务永久结束”的充分条件，要结合队列、重试、压缩及子任务状态归一。

“停止”默认表示该run不再继续：先冻结/清空该run待发队列，再中止模型、压缩、重试及其拥有的工具任务，撤销未决审批。Pi原生RPC文档明确仅abort可能继续消费队列；SDK适配也必须按相同产品语义显式处理队列，而非假定一次abort足够。[Pi取消语义研究](../../research/pi-harness-capabilities.md#5-事件取消与恢复)

工具取消是尽力而为，不是撤销已完成副作用。Host先请求协作取消，再按平台能力终止拥有的进程树；不能误杀共享MCP服务或用户独立终端。Pi 的 Host-owned MCP bridge 会按 session/run 取消等待中的 `tools/call`，在 worker stop、workspace 切换、协议失败或 stdout 关闭时回收对应工作区的 MCP 连接；已发出的远端媒体/服务任务若不能取消，应报告“本地停止，远端可能继续”，保存远端job ID供后续查询。

切换/导入/fork Pi session可能替换AgentSession实例，适配器需解绑旧订阅、绑定新session与extension UI/context，并增加epoch。相关待决交互全部明确转移或失效，不允许答复旧session的审批。

## 3. 存储模型

### 3.1 拟新增逻辑记录

| 记录                      | 核心字段                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session_engine_bindings` | productSessionId、engine、nativeSessionId/path、activeLeafId、bindingRevision、migrationId             |
| `agent_runs`              | runId、sessionId、idempotencyKey、status、configRevision、workerEpoch、lastCheckpoint                  |
| `agent_events`            | sessionId、seq、eventId、sourceEventId、schemaVersion、payload                                         |
| `agent_interactions`      | interactionId、runId、kind、inputDigest、status、expiresAt、resolution                                 |
| `agent_tasks`             | taskId、parentRunId、childSessionId、owner、state、remoteJobId、outputRef                              |
| `migration_journal`       | migrationId、sourceDigest、targetNativeSessionId、converterVersion、stage、validationReport、backupRef |

这是完整产品能力所需的逻辑 schema；现有项目/会话/统计表保留，避免建立另一套项目数据库。当前已落地的物理表是 schema v10 的 `agent_session_bindings`、`agent_event_log` 与 `migration_journal`：

```sql
agent_session_bindings(
  session_id       TEXT PRIMARY KEY,
  engine           TEXT NOT NULL, -- melody-acp | pi
  native_session_id TEXT,
  worker_epoch     TEXT,
  last_seq         INTEGER,
  session_mode_id  TEXT, -- default | plan | ask
  permission_mode  TEXT, -- ask | auto | always-approve
  model_id         TEXT, -- canonical provider/model or Host alias
  reasoning_effort TEXT, -- off | minimal | low | medium | high | xhigh | max
  updated_at       INTEGER NOT NULL
)
```

它们由 Host 在接受 Pi 事件后自动更新，也可由桌面桥接显式读取；`session_id` 始终是产品会话 ID，`native_session_id` 只作为 Pi 运行时绑定。`agent_session_bindings` 是恢复检查点，`agent_event_log` 保存有界、可分页读取的规范事件信封；两者都不能单独替代 Pi 原生上下文，也不会覆盖旧 ACP 时间线。前端已有有界的 `replayAgentEventLog`/`replayPiAgentEvents` 原语，会校验会话身份、ordinal 严格递增并把投递标记为 `replay`；它会在预算耗尽时返回 `complete: false`，不会假装已经追平。新增的 `AgentEventStream` 为 Pi 订阅提供 live/replay barrier：重放期间到达的 live 事件会暂存，重放成功或失败后都经过同一检查点冲刷；同一会话并发重放共享一次读取。`src/domain/agent/event-to-session-update.ts` 的 `projectAgentEvent` 让 live 与 replay 共用同一时间线投影，按消息偏移去重并把完整消息用于修复尾部增量；交互请求/响应会投影为现有审批、计划和问题工具行，携带子会话的任务/子代理事件会更新现有 Subagent 映射，普通任务仍只作为辅助事件，无法匹配或字段不完整时保留诊断而不伪造完成状态。`AgentEventProjector`、`createPiAgentProjectionStream` 和 `projectAgentEventToStorePatch` 已将这套投影接到 Pi store 入口，未知事件不会静默丢弃，而是返回诊断/辅助事件供上层处理。`getPiMigrationReportForSession` 与 `getPiSessionImportPlanForSession` 提供只读审计，`migrateStoredSessionToPi` 在通过完整性检查后才物化目标 JSONL，并保留可选备份；`resumePiSession` 仅重放安全的终态事件，不自动重发副作用。

`migration_journal` 的物理字段为：

```sql
migration_journal(
  migration_id            TEXT PRIMARY KEY,
  session_id              TEXT NOT NULL,
  source_engine           TEXT NOT NULL, -- melody-acp
  target_engine           TEXT NOT NULL, -- pi
  source_digest           TEXT NOT NULL,
  converter_version       TEXT NOT NULL,
  stage                   TEXT NOT NULL, -- planned | materializing | applied | failed | rolled-back
  validation_report       TEXT NOT NULL,
  plan_json               TEXT NOT NULL,
  backup_requested        INTEGER NOT NULL,
  backup_ref              TEXT,
  target_native_session_id TEXT,
  error                   TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
)
```

`session.import` 必须引用仍处于活动阶段且计划结构完全相同的 `migration_id`，并显式携带 `backup` 布尔值；Host 会把它与 journal 中锁定的备份选择比较，禁止重试时临时改成覆盖或不备份。`session.imported` 写入 event log、切换 Pi binding、记录 native session 和把 journal 标记为 `applied` 共享一个 SQLite 事务。计划变更、旧尝试失败或已应用到另一个 native session 时拒绝完成，避免晚到 worker 事件污染新尝试。

`agent_event_log` 的物理字段为：

```sql
agent_event_log(
  session_id       TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  event_id         TEXT NOT NULL,
  source_event_id  TEXT,
  worker_epoch     TEXT,
  seq              INTEGER,
  event_json       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY(session_id, ordinal),
  UNIQUE(session_id, event_id)
)
```

单个信封不超过 1 MiB；桌面读取接口默认返回 256 条、最多 2048 条，并按 `ordinal` 分页。事件日志删除随产品会话/项目删除显式执行；同时清理对应 Pi 原生 JSONL、导入备份和临时残留，且在产品记录删除前完成 worker 停止与原生文件清理。日志记录、前端有界重放、live/replay barrier、Pi store 投影和只读恢复检查已落地；`events.resume` 仍保留为未来公共协议命令，当前安全恢复由 `resumePiSession` 明确限制为终态重放。

Pi原生JSONL保存在应用管理的独立目录，不直接覆盖 `.melody` 历史，也不自动采用用户系统Pi默认目录。当前 worker 由 Host 注入 `MELODY_PI_SESSION_ROOT`，并以 `sha256(cwd + "\\0" + productSessionId)` 派生 `session-<hash>.jsonl`；产品 ID 不直接进入文件名，跨工作区也不会意外复用同一文件。`session.open` 的 `productSessionId` 是产品稳定身份，`sessionId` 仅是可选的引擎身份；Pi 通过公开 `SessionManager.open` 打开该固定路径。桌面 Host 在转发 `session.open` 前要求稳定产品 session ID，确认产品 session 存在且绑定为空或已经是 Pi；legacy ACP 绑定必须先完成显式迁移，不能靠打开动作隐式接管。Host 同时把凭据和模型目录注入应用数据根的 `pi/auth.json`、`pi/models.json`（显式环境变量可覆盖）；没有 Host 根目录的独立开发调用仍使用内存会话和临时模型数据，避免写入 `~/.pi`。一个原生会话只有一个 writer。Host停止 worker 时先发送 `runtime.shutdown`，worker 关闭活动会话并等待 writer 刷新；超时才强制终止。Host保存规范事件、绑定与检查点，但不拼接私有JSONL字段；通过锁定版本公开API导入/导出，必要时写显式版本化转换器。

### 3.2 双存储崩溃一致性

桌面 Host 现在提供只读恢复检查入口。它按绑定和最多 4096 条最近规范事件扫描 run、工具、交互、任务/子代理、消息和压缩生命周期，只返回可重放、需协调、已阻断或不适用的摘要；不会打开 Pi、重跑工具，也不会返回提示词、参数或工具输出。`resumePiSession` 已消费其中安全的 `replay` 分支并复用 live/replay barrier；副作用结果不确定时仍返回 `manual`，要求人工确认。

Pi原生会话与产品SQLite不能天然跨文件事务提交。每个回合记录native checkpoint/leaf、产品seq与run状态；恢复时对照：

1. 原生已完成、产品未确认：从原生检查点补投影，不再执行工具。
2. 产品已记录工具started，未获可靠result：标记interrupted/unknown outcome，查询可查询的外部job；不能直接重跑。
3. 原生记录损坏/半行：用上游恢复能力或最后验证检查点处理，并保留损坏副本；不要静默删除历史。
4. 两边都有结果但重复：稳定toolCallId/sourceEventId去重，不重复计费。

无法保证任意外部命令exactly-once。对于支持幂等key的远端API传入稳定key；不支持的副作用在结果不确定时需要确认或人工核对。

## 4. 旧数据迁移和回滚

### 4.1 先分级，再转换

| 类别                         | 条件                                               | 行为                                                                |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| 无损可导入                   | 完整原生消息、工具配对、附件、分支与模型信息可验证 | 导入副本，经公开API校验后建立Pi绑定                                 |
| 可保留展示但上下文不完全兼容 | provider opaque thinking、缺失压缩状态或附件等     | 保留完整旧档；明确标注新续聊分支及迁移摘要/原文资源引用，不声称无损 |
| 暂不可续聊迁移               | 必需工具/历史语义无法映射                          | 保持legacy绑定与原始历史，列为最终迁移阻塞                          |

第二类需要用户接受“新分支继续”的语义才能视为满足该会话需求；不能默认以摘要替代全部原上下文，再声称功能不减。没有可接受转换路径时继续保留旧引擎，最终移除计划延期。

当前导入计划（`buildPiSessionImportPlanForSession` / `getPiSessionImportPlanForSession`）把这条边界落实为可核对的数据：无附件的用户消息，以及具有完整 Pi `provider/api/model/usage/cost/stopReason` 元数据的 Pi 助手消息是 `native-message` 候选；其余助手消息、思考、计划和工具生成 `custom-entry` 展示记录，并保留源索引、源条目 ID、目标记录 ID、转换器版本和稳定 `sourceDigest`。助手消息不会因为只有文本就被伪造为 Pi 原生消息；旧 ACP 投影缺少可靠的 Pi 元数据时仍保持展示归档。计划只读且有界，附件内容延迟物化；外部附件、未决交互、运行中副作用或不完整归档会阻断，而不是静默截断。`migrateStoredSessionToPi` 使用 Pi 锁定版本的公开 `SessionManager` API 在 Host 管理的临时/目标文件中写入并验证，成功后才由事件事务切换绑定，并按请求保留备份。

### 4.2 执行步骤

1. 停止目标会话写入，检查是否有运行中工具/子任务/未决审批；不在活动回合中换引擎。
2. 使用SQLite一致性备份机制或关闭写入后checkpoint，备份数据库、原生历史、配置、资源映射。不能只复制正在使用的 `.db` 而漏掉WAL。
3. 创建迁移清单：源版本、文件hash、消息/分支/工具数量、资源存在性、格式异常。备份不提交仓库，凭据按原安全策略保护。
4. 转换到临时新存储，保留原ID映射和来源；未知字段保留在归档，不硬塞Pi消息。
5. 检查toolCall/result配对、错误/取消、模型变化、压缩和分支；脱敏样本可做不调用模型的上下文重建验证。
6. 对指定测试会话做实际续聊验证；测试写操作只在临时工作区，不双跑真实生产副作用。
7. 原子切换产品绑定；记录migration完成检查点，旧源保持只读。
8. 失败则移除未发布目标或隔离为失败副本，恢复旧绑定；保留报告，不覆盖源文件。

重复运行相同sourceDigest+converterVersion应幂等。崩溃后根据journal继续验证或回滚，不能每次重复导入为新会话。

### 4.3 回滚不是数据库降级

首选在新版应用中按会话回切旧引擎。Pi期间新增内容必须保留为独立分支，不能丢弃，也不能把它强行写进旧原生格式。

若需要安装旧应用：先确认旧应用能否读取新schema。当前代码拒绝未来schema，因此不能假设新应用卸载后旧版自然可用。建议迁移初期新增独立引擎存储、保留可用备份；确需恢复旧schema时使用已验证备份，并将迁移后新增数据导出存档。UI告知恢复点和保留位置，不称“无损一键降级”。

删除会话/项目须覆盖Pi绑定、原生历史、附件、任务输出和索引；备份的保留/删除策略明确可见，不能无限保留用户要求删除的数据。

## 5. 权限与信任边界

Pi扩展可在进程内直接执行系统代码，ToolGateway只能约束经它注册的调用，**不能把恶意同进程扩展变成安全代码**。[官方安全事实](../../research/pi-harness-capabilities.md#权限与扩展的关键边界)

因此定义三类资源：

- 声明式资源：skills、prompt、规则；作为不可信内容加载，不授予系统权限。
- 应用内置/经用户明确信任的执行扩展：可运行于worker，但必须提示其拥有进程权限；审计与最小凭据范围仍保留。
- 不可信项目/下载执行插件：不自动in-process import。需要受限子进程/OS隔离与能力RPC，或阻止执行并要求明确授权；不能仅凭Marketplace来源名信任。

其中 prompt template 只通过 Host 显式传递普通 Markdown 文件路径。Pi 的 ambient prompt 扫描保持关闭；Host 只允许已登记 workspace/user 根下的平面 `commands/*.md`，按项目优先级、禁用列表、符号链接和大小上限过滤后注入 `additionalPromptTemplatePaths`，并把受控根清单通过 `MELODY_PI_PROMPT_ROOTS_JSON` 传给 worker 以支持后续刷新。模板可替换 `$1`/`$@` 等参数，但不获得工具或扩展权限；插件内命令和嵌套命令目录在 Pi 中不可用并由能力诊断说明。

标准 Markdown Skill 同样不启用 Pi 的 ambient 扫描。Host 从工作区仓库边界、应用 `MELODY_HOME/skills` 和用户 `.agents/.claude/.cursor/skills` 根目录中枚举具体 Skill 目录，通过 `MELODY_PI_SKILL_PATHS_JSON` 注入 `additionalSkillPaths`，并通过 `MELODY_PI_SKILL_ROOTS_JSON` 传递同一批受控根及禁用名称快照。每个目录必须包含普通 `SKILL.md`，并通过 canonical 路径、符号链接、隐藏/依赖目录、深度 6、最多 256 个路径、单文件 1 MiB、总量 64 MiB 的双端校验；插件目录、可执行扩展、Hook、MCP、LSP 和外链内容不会随 Skill 进入 Pi。

会话建立后，Pi worker 在每个新的顶层回合和子任务回合前重新枚举这些受控根，再调用 Pi `session.reload()` 更新资源快照；因此新增、修改或删除的 Markdown Skill/命令会从下一回合起生效。运行中的 steer/follow-up 不触发 reload，保持当前 provider 回合的运行时稳定。根清单由 Host 产生，worker 会重新校验根路径和资源边界；没有根清单的直接 worker 仍只接受具体路径。

所有模型可调用工具统一经过：schema校验 → canonical工具身份/作用域 → 参数摘要 →策略判断 → 必要审批 → 执行锁 → 操作 → 结果归档/审计。审批绑定session/run/toolCallId、规范参数digest、策略revision和期限；点击允许后如果参数发生变化必须重新批准。

ToolGateway 的工作区根由 Host 绑定到当前 worker generation：worker 报来的可选 `cwd` 必须经过 `WorkspaceRegistry` 规范化，并且与该 generation 的 `worker_cwd` 完全一致；缺省时使用同一根目录。即使另一个项目已经在注册表中，也不能借一条 tool event 把文件或终端请求转到那里。worker 输出的 session event 同样先校验产品会话的 `cwd`，再进入事件日志。

项目权限规则由 Rust Host 权威执行，而不是依赖 renderer 是否及时响应：Host 在 `interaction.requested(kind=permission)` 到达时，按产品 `sessionId` 关联的项目查询精确规则；`allow` 自动回复 Pi 的一次交互，`deny` 自动拒绝，随后 `tool.requested` 仍会再做一次 Host 侧 allow/deny 校验。规则键与现有 ACP 保持同一 `title\\ncommand` 形状，Pi 只发送命令或路径摘要，避免把完整写入内容/补丁落入事件日志。规则查询失败或返回未知决策时不自动批准，交由显式用户交互处理；历史 `replay` 交互不会向已结束的 worker promise 发送响应。

已有永久规则只有在新旧工具身份与参数语义精确等价时迁移；无法证明等价的规则保留源记录并要求重审，尤其是shell、MCP dispatcher和路径规则。deny优先级与作用域遵循基线，不借迁移扩大allow。

plan只读不能靠shell字符串黑名单保障：shell可通过脚本、重定向、网络或子进程写入。应使用受控只读工具集合或真实平台沙箱，允许的plan文件写入走专用工具。路径canonicalization还需考虑symlink和TOCTOU；宿主文件API尽可能在执行时再次验证。Pi 当前只提供 Host 路径/符号链接校验，不等价于 Melody-build 的 kernel sandbox；无法等价执行的隔离配置会阻止打开 Pi；平台没有沙箱实现时会显式警告并按无沙箱模式运行，均不切换 ACP。Windows和macOS分别验证，不能把Linux容器方案当成原生桌面已具备的能力。

凭据不进入React事件、命令行参数、日志、模板与工具输出。worker环境变量只注入需要的条目，不复制整个Host环境；为保留企业代理和私有 CA 的网络可用性，额外显式转发标准 proxy 变量及 `SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`，不放行任意环境变量。MCP/插件所需密钥按各自权限注入，不能自动获得全部模型密钥。插件下载/解包需路径穿越、符号链接、大小限制和原子安装检查。

## 6. 统计与模型目录的特别约定

上下文采用 `{ tokens, limit, confidence, source, observedAt }`；tokens允许null，confidence为unknown/estimated/measured。Pi压缩后可能暂无可靠token，UI显示“待统计”或明确估算，不显示0。账单token与当前上下文分别累计/更新，cache token按provider定义记录，未知成本不等于免费。

ModelCatalog分别维护configured、available、auth-needed、unsupported/error状态。当前 worker 的 `runtime.models` 事件已实现只读 configured + auth-filtered 快照和 revision；Host 启动时会按用户/项目覆盖规则生成应用内 `pi/melody-models.json`，并把 API key/请求头作为仅进程可见的环境引用注入，避免密钥进入模型文件。模型配置中的 `input` 只接受 `text`/`image` 字符串数组，缺省为 `text`，并要求保留 `text`；前端目录和 worker 均保留该模态，worker 在回合边界拒绝发给纯文本模型的图片附件。前端 `projectPiModelCatalog` 将 `available` 转为现有选择器的 `AgentModelOption`（canonical id 为 `provider/model`），其余状态进入 `unavailableModels`，因此不会因 `getAvailable` 过滤而静默丢失诊断信息。`projectAgentEventToStorePatch` 再把模型目录、当前/后台时间线、游标、上下文和 Subagent 映射成最小 UI store 补丁，后台事件不会污染可见会话。Pi 会话在打开前使用同一 canonical 目录，运行中配置通过统一命令边界生效。Pi `getAvailable` 经过鉴权过滤，不可直接作为设置中所有模型或选择器唯一来源。模型可见但未认证时应展示原因/认证入口；配置有效但adapter不支持时保留为诊断项，不默默隐藏。

Host 同时生成独立的 `pi/melody-model-policies.json`，只承载经过校验的 `maxRetries` 与 `inferenceIdleTimeoutMs`；worker 在创建或切换模型时把它们映射为 Pi `SettingsManager` 覆盖。没有策略文件时保持 Pi 默认值，策略文件损坏则阻止静默降级；策略快照的版本、大小、数量和数值上限记录在 [兼容性清单](./pi-compatibility-manifest.json) 中。

首次启动、配置保存、凭据更新、远端目录刷新均发catalog revision事件。远端刷新设置deadline，不能因不可达阻塞所有本地模型。模型切换与会话恢复使用稳定provider+model标识，displayName不作为主键。

规范事件的消息流细节由 `src/domain/agent/message-projection.ts` 持有：它负责 message/thought 增量、按消息与分片校验 offset、用完整 assistant 消息修复流式 timeline row，以及清理完成消息的局部状态。`projectAgentEvent` 仍负责 envelope/session 校验、过滤内部工具、调度其他事件，并将 owner 结果合并到 live/replay 共享的 projection state。

### 6.1 模型配置热同步

设置页保存模型配置时，Host 会原子写入目录/策略快照，然后向当前 worker 发送 `runtime.models.sync`；worker 串行替换生成的 `MELODY_PI_MODEL_*` 环境变量、清理对应 provider 的运行时认证覆盖、替换旧的重试/空闲超时覆盖（不会因 Pi `SettingsManager` 的深度合并而残留）并强制刷新 Pi `ModelRuntime`。同步失败不回滚已经持久化的配置，但会保留可诊断的 worker 错误；没有活动 Pi 会话时不发送命令，下一次启动使用同一快照。正在进行的 provider 回合继续使用原模型，下一次新回合读取新目录、凭据和策略。
