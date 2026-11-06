# 分阶段实施、验证与发布计划

关联：[总设计](./README.md) · [功能矩阵](./feature-parity.md) · [协议与数据](./protocol-and-data.md)。

当前状态（2026-10-11）：本文件以下内容是带日期的实施过程记录，早期段落中的 `opt-in`、默认 ACP 和 ACP 运行时回退方案均已被后续决定取代。Pi 现为唯一 Agent runtime；renderer 根据运行环境固定选择 Desktop Pi 或 browser-preview ACP fixture，不再保留 preference/per-session engine route override；旧 `agentEngine` 设置只用于兼容归一化。旧 ACP 会话只读归档。能力缺口会在 Pi 内诊断为不可用，无法安全保留策略时阻止打开 Pi；不会切换到 ACP。定时任务 renderer 侧栏面板已移除，Host 调度和模型工具保留。当前验收请看[交接文档](./handoff.md)、[功能对照](./feature-parity.md)与[验收报告](./acceptance-report.md)。

## 1. 执行原则

全部产品改动从beta开始。先发布测试版验证，再经用户明确要求晋升main正式版；不把main合回beta。正式版使用对应beta同一基础版本，并同步package.json、Cargo.toml、tauri.conf.json。具体下一个版本号在实际发版时按仓库状态决定，本设计不预占版本号。

采用可独立回滚的小步骤，任何阶段都保持现有引擎可运行。禁止第一步删除vendor、替换全部store或全量导入用户历史。功能迁移与UI美化分开提交。

## 1.1 当前实施进度（2026-09-12，beta）

### 本轮新增（2026-09-12）

- **Host 终端沙箱：平台实现与能力预检已接通，验收范围需区分。** `workspace_sandbox` + `read_workspace_sandbox_plan` 统一通过 Host `sandbox_decision` 与 Workspace 授权：macOS 生成 Seatbelt command，Linux 使用 Landlock child enforcement；网络受限 profile、glob deny、Windows 和无法安全表达的策略 fail closed，不静默放宽或回退 ACP。自定义 profile 的 `read_only`/`read_write` overlap 及其与 Seatbelt 设备写 sink 的冲突在共享决策处拒绝；Seatbelt 只为显式 `read_write` 路径与 device sink 添加写 allow。Rust tests 锁定 Host payload/规则投影，Linux 有真实 Landlock child test；当前检查环境尚未完成真实 macOS Seatbelt child write acceptance。

- **P1.1 调度界面：已完成。** `useAgentSchedules` + `SchedulePanel`（创建/暂停/恢复/取消/删除 + run journal），事件只作刷新信号，调度行仍由 Host 权威持有。
- **P1.2 monitor 运行时、模型工具与 UI 观察面：已完成。** 投影层新增有界 monitor 通知环（200 条，按会话累积、不进时间线），`MonitorFeed` 挂在会话信息面板（状态/事件数/最近行/停止），`useAgentMonitors` 运行中 4 秒、空闲 20 秒轮询。 worker 注册 `monitor` 工具（execute 类能力、plan/ask 模式拒绝、权限身份同终端），Host ToolGateway 启动注册表并投递逐行事件，任务控制工具接受 `pi-monitor:*` id（不混批、跨会话拒绝）；兼容清单记录该工具并防漂移。 新增 `pi_monitor_runtime`：Host-owned 进程注册表（并发上限 16）、stdout+stderr 合并逐行读取、每行 4 KiB 有界后作为 `task.notification` 产品事件写入同一事件日志与渲染通道、滚动窗口 120 行/分钟 + 生命周期 10000 行双重限速并在超限时自动停止、`persistent` 记录、worker 停止/工作区切换/退出/`session.close` 全部回收、结束的 monitor 保留有界最终快照供读取。命令面 `start_agent_monitor`/`list_agent_monitors`/`cancel_agent_monitor`。新增 5 个真实进程测试（含自动停止与取消）。模型侧 `monitor` 工具与 UI 观察面已在同一轮的后续切片接通。

- **工作流能力删除：已完成。** 设置界面的“启用工作流”开关移除，前端能力预检不再因 `workflows.enabled` 回退，worker 诊断目录移除 `pi.workflows_unavailable`，兼容清单把 `workflows` 从 `unsupportedInPi` 移入 `retiredCapabilities`（附删除原因与遗留配置键）。周期任务由 Host schedule 承担。
- **P1.1 调度执行器与接受确认：已完成（第二片）。** Host 为每次派发生成稳定 `promptId` 并在 supervisor 登记有界待确认表（上限 32），`run.accepted` → Accepted、匹配 `requestId` 的 `runtime.error` → Rejected（带 worker 错误码）、15s 超时或世代结束 → Unacknowledged；世代结束清空待确认表。supervisor 同时跟踪每个产品会话的权威 `configRevision`（`turn.submit` 必带，否则被 `pi.config_revision_conflict` 拒绝）。决策与记账为纯函数：worker 未运行/工作区不匹配/会话忙 → 跳过（记录原因），会话已删除 → 取消定时器，ACP 绑定 → 明确失败；busy 拒绝映射为跳过，其余拒绝与超时记 failed。派发身份 = 创建时快照 ∩ 会话当前绑定（取更窄），命令由 Host 从持久化绑定构造。`DispatchRegistry` 保证同一会话不叠两条 Host 回合。新增 7 个测试。**monitor 逐行输出/限速/归档与 Rhai workflow 引擎仍未实现**，`workflows.enabled` 与 monitor 配置继续回退 ACP。

- **P1.1 持久调度基础设施：已完成状态层（第一片）。** 新增 schema v11 `agent_schedules` 与 `agent_schedule_runs`：记录产品 session/project 归属、`once`/`interval`、间隔/期限/maxRuns、`skip`/`run-once` 错过策略、状态（active/paused/completed/expired/cancelled）、下一次触发时间与 run journal；创建时快照 `permissionMode`/`sessionModeId`/`modelId`/`reasoningEffort`，触发阶段不得获得比创建时更大的权限。生命周期是纯函数（`next_fire_after`/`advance_after_fire`/`missed_decision`）：错过的触发按策略跳过或只补一次，永不爆发式重放；`failed` 的派发保留 schedule 且只推进时间槽，不增加 runCount。Host 暴露 create/list/status/runs/delete 命令；契约新增 `schedule.changed`/`schedule.fired` 产品事件与 `AgentScheduleRecord`，前端投影把它们当辅助事件而不是“未知事件”。新增 8 个 Rust 生命周期/持久化测试与 1 个投影契约测试。
- **P1.1 调度清理与迁移回归：已完成。** v11 升级后旧数据不丢、schedule 表可用；`purge_session_agent_rows` 把会话级 Host 数据清理统一到一处（timeline/binding/event log/journal/schedule/runs），项目删除路径同样清理其会话的 schedule 与 run journal，避免出现"用户删了会话但定时器还在响"的孤儿记录。新增 3 个回归测试（v10→v11 升级、删除会话、删除项目）。
- **当时仍属 ACP 的部分：** Melody 的 workflow 是 Rhai 脚本引擎（`melody-workflow`），`/loop` 与 monitor 另有逐行输出事件、限速和归档语义。这一片只做 Host 侧持久状态与触发契约；**workflow 随后按产品决定删除**，执行器/派发与 monitor 语义已在同一轮补齐，**脚本引擎按产品决定删除**（设置项移除、预检不再回退、兼容清单记入 `retiredCapabilities`）。

- **P1.3 声明式插件表面与子代理定义保真：已完成第二片。** 按“Melody 实际会执行什么”重划插件边界：`skills/`、`commands/`、`agents/` 与带 `./` 前缀的多级 manifest 声明路径都按声明式内容投影（声明的 Skill 目录本身含 `SKILL.md` 时直接作为 Skill），而 `hooks/`、`.mcp.json`、`.lsp.json`、manifest `extensions` 和不安全路径继续回退 ACP；`scripts/`、`bin/` 与 Skill 内脚本不再当作动态表面（Melody 只通过 hook 执行脚本，hook 已被单独识别）。插件 agent 现在通过 `agent_roots` 以 `<plugin>:<agent>` 限定名（裸名在原生命名未占用时）进入子代理策略清单，模型可实际选中。Agent frontmatter 规则与 Melody 的 `AgentDefinition` 对齐：只有 engine 会读取的字段算策略面，未知键按惰性元数据处理，多行 flow 列表与块列表都能解析；`tools` 白名单换算为最窄 Pi 能力档，新增 `read-write-execute` 档位（契约 + worker 策略 + 网关工具集 + 父子交集），使“写文件 + 终端”不再需要退化成 `all`。真实配置预检从“插件全被判定为动态”变为“启用插件全部 static、9 个 agent 定义中 8 个可用”。
- **P1.3 子代理 MCP 授权：已完成第三片，后续边界修正已对齐。** 子代理策略新增有界 `mcpTools`（精确 `mcp__<server>__<tool>`，最多 64 条、server ≤ 64 / tool ≤ 96 / 完整名称 ≤ 128 字节），Host 从 `tools` 收集并在 `normalize_agent` 中再校验，worker 策略层 fail-closed 校验、网关在 `mcp_call_tool` 上按调用匹配，子代理授权与父级取交集（父级无 MCP 能力时派生不能获得），`resume` 保留同一集合。先前 Host Markdown/list parser 会把超过通用名称上限的条目静默丢弃，可能让声明的 `tools` 策略被窄化；现在保留条目交由 Host ceiling resolver 判为 `tools` 不可表达，使该 agent 进入既有 unsupported 诊断路径，不放宽 worker 的授权上限。兼容清单新增 `maxNameBytes: 128`；`pi-subagent-policy-compatibility.mjs` fixture owner 交叉检查 Host/worker 的数量、分段和完整名称上限、实际 validator 使用，以及四种能力档与 MCP 调用 gate。真实配置的 10 个 agent 定义全部可用，配置不再触发 `requiresLegacyEngine`。
- **P1.3 `[skills].ignore` 保真：已完成第四片。** Melody 把 `[skills].ignore` 当路径前缀（展开 `~`、相对项按工作区解析、对 canonical Skill 路径做前缀匹配），并且在合并插件 Skill 之前隐藏匹配项。Host 新增 `pi_skill_ignore_paths`（用户/项目合并、上限 64 条 / 单条 4096 字节）并把前缀附着到原生 Skill 根，插件根不受影响；前缀同时进入 `pi_resource_manifest.skillRoots[].ignorePaths`，worker 刷新时按同一套前缀过滤，相对路径与 `..` 会被丢弃。worker 的 root 信任放宽为“等于或位于受信根之内”，以支持插件 manifest 声明的具体 Skill 目录；声明目录自身含 `SKILL.md` 时按 Skill 投影。验证：真实配置的受控 Skill 路径 159 → 100（隐藏 `~/.agents` 下 59 个），投影中不再含忽略前缀下的 Skill。
- **P1.3 插件重名收敛与 `[plugins].paths`：已完成第五片。** 插件按 Melody 的来源优先级（project > user > 配置目录；同 scope 内先发现者）按 name 收敛，避免同一插件从 installed-plugins 与 marketplace cache 各发现一次时重复出现在清单与诊断里（真实配置：发现 49 → 45，启用记录 4 → 2）。`[plugins].paths` 自定义目录现在会被扫描，其插件标记为 `config` scope 并按 Melody 语义自动启用（显式 `disabled` 仍优先），上限 64 条；此前这些目录对 Pi 完全不可见，属“静默缺失”方向。兼容清单新增 `configuredPaths` 与 `nameConflictPrecedence` 事实源并防漂移。
- **仍未消除的回退点：** 无（对当前真实配置）。插件/Skill/子代理三处的声明式投影现已与 Melody 的启用、忽略、优先级语义对齐。

- **P1.1 模型侧调度工具：已完成（第三片）。** worker 新增 `scheduler_create`/`scheduler_list`/`scheduler_delete`（list 只读、create/delete 写入并 `requiresPermission`，plan/ask 模式拒绝，权限身份只取间隔或 task id、不含提示词），Host `scheduler_tool` 从**会话实时绑定**复制 engine/session mode/permission mode/model 身份，模型无法放宽；间隔沿用 Melody 的 `s/m/h/d` 解析与 60s–30d 钳制，`fire_immediately` 只提前 `next_run_at`，同 task id 复用并更新原 schedule；非 Pi 绑定与无绑定分别给出不同拒绝原因。兼容清单新增 `agentSchedules` 事实源并防漂移（已反向扰动验证）。新增 Rust 5 项 + worker 1 项测试。
- **压缩续接任务摘要：已完成。** `todo_write`/`update_goal` 状态是 custom entry，不进上下文，压缩后模型会丢掉"做到第几步"。压缩扩展现在用与工具相同的重建函数生成有界任务摘要（goal + 条目统计 + 逐条 todo，≤4000 字符），写进第一遍提示与第二遍 `compact()` 的 focus（Pi 会作为 `Additional focus` 拼进摘要提示词）；**第一遍失败时改为"仅任务摘要"压缩**，只有连摘要都没有时才回落 Pi 原生压缩，失败路径保持 fail-open。兼容清单新增 `hostBridges.compaction` 并校验摘要来源与兜底路径。
- **类型化暴露并修掉压缩 header 缺陷：已完成。** 去掉扩展里的 `any`（改用 `ModelRegistry["complete"]`/`CompactionResult`/`ExtensionContext["model"]` 等 SDK 类型）后，编译器直接指出 `ResolvedRequestAuth.headers` 的 `null`（表示删除该 header）被原样传给 `compact()`，而 Pi 自己会过滤。现已按 Pi 的语义过滤并补测试。控制字符判定同时收敛为契约里的 `containsControlCharacters`，Host/worker/renderer 共用，替换 8 处重复正则。
- **门禁覆盖 `packages/**`：已完成。** `eslint.config.js` 此前不含 `packages/**`，本轮全部 worker/contract 代码从未被 lint。补上后暴露 18 个错误并全部修掉（`any` → SDK 类型、`prefer-const`、控制字符正则），Prettier 格式化 10 个原型文件，Rust 全量 `cargo fmt`。CI 既有 `pnpm lint`/`format:check`/`cargo fmt --check` 现在真正生效。
- **端到端探测与注入面加固：已完成。** 用打包产物 + 独立探测脚本对抗性测试新代码，发现并修掉：`monitor`/`scheduler_*` 漏在 `PI_GATEWAY_TOOL_NAMES` 之外（导致 provider 级重复工具卡片、运行时只宣告 30 个工具；现由单一名单派生，运行时 34 个与清单一致）、`parse_scheduler_interval` 对非 ASCII 后缀 panic（改按字符切分）、压缩摘要可被 tracker 文本里的 `</task-state>` 逃逸（现中和分隔符并剥离控制字符）。端到端回合夹具（本地假 provider + 扮演 Host）直接抓出第三个缺陷：流式工具事件读的是不存在的顶层 `toolName`（真实字段在 `partial.content[contentIndex]`），导致每次工具调用都多出一条无名空白卡片、扩展工具被画成两行；现从 `partial` 解析名字与 id，解析不到就不发请求，夹具已进 CI。门禁升级为运行时比对：检查器会 `import` worker 的 `PI_CAPABILITIES.tools` 与清单双向比较，事件映射器新增由名单驱动的"每个网关工具都不得产生重复请求"测试；两处均用扰动法验证会失败。另清掉全部 8 条编译警告（测试辅助函数改 `#[cfg(test)]`，`MELODY_SANDBOX` 常量收敛为单一来源），并用真实 dev 库副本验证了 v5 → v11 迁移（8 个会话 / 3 个项目全部保留）。
- **沙箱不再是"Pi 不支持项"：已完成。** 兼容清单 `unsupportedInPi` 移除 `sandbox`，机制、适用面（终端/后台终端/monitor）、fail-closed 条件与未覆盖项（Host 自建进程、MCP/LSP 服务）改由 `hostBridges.sandbox` 记录；文档同步说明 macOS 已实现、Linux/Windows 仍 fail closed。

- **P0.1 真实配置盘点：已完成第一轮。** 用真实桌面配置（脱敏，不提交路径与密钥）跑通 Host 预检：模型只有两个 `chat_completions` provider、基础 Markdown Memory（无 embedding/vector/dream）、`features.lsp_tools = true` 但无 server 定义，没有 Hook/MCP/LSP/OIDC/沙箱/工作流/复杂 goal；启用的插件里 2 个已安装、1 个已不存在。真实 provider、三平台和真实 OAuth 仍是待现场验收项。
- **P1.3 插件启用判定保真：已完成第一片。** 发现并修复 Host 与 Melody 插件启用语义不一致：Melody 只在插件被 `[plugins].enabled` 显式列出且不在 `disabled` 时激活它，而 Host 之前只判断“不在 disabled”，于是把 marketplace clone / install cache 里发现的每个插件都当成已启用。真实配置下预检把 49 个插件判为启用（用户实际只启用 2 个），产生大量 `pi.plugins_unavailable` 阻塞诊断，使该配置的 Pi 会话每次都回退 ACP，并把从未启用插件的 Skill/命令投影给 Pi（实测受控 Skill 路径 122 → 112、命令模板 42 → 35）。修复后 Host 统一使用 `PluginEnablement`（合并用户/项目 `enabled`/`disabled`，项目覆盖用户；支持 `melody plugin add` 写回的 `<scope>/<hex8>/<name>` id；`disabled` 优先），Pi 预检、Skill/命令投影、Settings 扩展列表和已安装插件列表共用同一规则；Skill/Hook 保持 Melody 的 opt-out 语义且类型上不可与插件规则混用。新增 4 个 Rust 契约测试与 1 个前端契约测试，兼容清单新增 `pluginActivation` 事实源并由 `pnpm check:pi-compatibility` 防漂移（已反向验证该检查会失败）。
- **插件兼容面（本轮已全部完成）：** 声明式插件表面、`[skills].ignore` 路径前缀、插件按 name 收敛与 `[plugins].paths` 均已落地，真实配置不再因插件或子代理定义触发回退。

### 2026-09-10 前的进度

- **P0 基线冻结：已完成研究与文档冻结。** 已记录现有 `melody-pager`/ACP 入口、产品功能矩阵、数据与安全边界；Pi 研究固定到正式 `v0.85.0` 的 npm/tag 基线，尚未把上游 `main` 当作依赖。
- **P1 协议抽离：已完成。** 新增引擎无关的命令/事件契约、运行时校验、Melody ACP 命令/事件适配器；会话打开、回合提交、取消、模型/思考强度/会话模式/权限模式设置、认证和计划/权限/问题响应均先经过产品命令边界。默认引擎仍是 `legacy-acp`，Pi 由桌面设置显式 opt-in。
- **P1 事件流边界：已完成。** 规范事件现在有独立 `eventId`/`sourceEventId`、可选 `seq` 与 `workerEpoch` 的检查点内核；重复、旧世代、乱序和超界事件会被拒绝，重放可在显式重置后重新投影。新增 `AgentEventStream`，在同一个检查点中暂存重放期间到达的 live 事件，并在重放完成或失败后按顺序冲刷；同一会话的并发重放共享 Promise，避免两个恢复路径交叉推进游标。`agent-client` 同时提供旧 ACP 到规范事件的订阅 façade，供 Pi worker 复用；Pi opt-in 与现有 ACP 共享这条投影边界。
- **P1 时间线投影：已完成。** 新增纯函数 `projectAgentEvent`，把规范事件适配为现有 `SessionUpdateResult`：文本/思考增量、完整消息修复、工具请求到完成、回合成功/失败/取消、上下文用量和账单用量均复用现有投影逻辑；权限、计划、问题的请求/响应也会分别投影为现有审批、计划和问题工具行。它按 `messageId`/`partId` 校验增量偏移、拒绝跨会话事件；携带子会话的任务/子代理事件会通过 `subagent-projection.ts` 更新现有 `AgentSubagent` 映射，普通后台任务仍作为非时间线辅助事件，不会伪造成子代理。规范 `runtime.models` 事件也会投影为现有模型选择器可消费的 canonical `provider/model` 选项，并保留认证/不可用条目的诊断信息。未知上下文、无法解析的交互和字段缺失作为可诊断结果；`AgentEventProjector` 将该纯函数封装成有状态订阅器，`createPiAgentProjectionStream` 再把它接到同一个 live/replay barrier；新增 `projectAgentEventToStorePatch` 将当前/后台时间线、游标、状态、上下文、模型目录和子代理映射为最小 UI store 补丁。Pi opt-in 使用该 store adapter，ACP 路径继续使用原有消息投影。
- **P1 迁移诊断：已完成只读入口。** `buildPiMigrationReportForSession` 与 `getPiMigrationReportForSession` 优先读取完整时间线归档，对损坏/读取失败、未决审批/问题/计划、运行中副作用工具和超大附件给出阻塞项；已完成但 Pi 只读网关无法重建的工具标为 `display-only`。报告不创建 Pi 会话、不改变引擎绑定，也不会用摘要冒充可续聊上下文。
- **P1 迁移计划：已完成只读演练入口。** `buildPiSessionImportPlanForSession` 与 `getPiSessionImportPlanForSession` 在迁移报告之上生成版本化、可审计的条目映射和稳定 `sourceDigest`。没有附件的用户消息，以及带有完整 Pi `provider/api/model/usage/cost/stopReason` 元数据的 Pi 助手消息，会标为 `native-message` 候选；旧 ACP 投影中缺少这些元数据的助手消息、思考、计划和工具统一标为 `custom-entry` 展示归档，不会伪造模型上下文或重放副作用。计划对条数、文本和附件有界，完整性不足、活动交互、运行中工具或无法物化的附件会阻断演练；生成过程不打开 Pi、不写文件、不切换绑定。
- **P1 验证：已完成本地门禁。** 协议/适配器/事件检查点测试已纳入 `test:unit`；同时通过 TypeScript 检查、架构边界检查、worker 检查和现有单元测试。

2026-10-11 结构维护增补：规范事件 reducer `projectAgentEvent` 继续拥有 envelope/session 校验、内部工具过滤及全事件 dispatch；新增 `src/domain/agent/message-projection.ts` 归拢 message/thought stream 的 offset continuity、assistant 最终消息回填与 message-scoped state cleanup。测试继续通过既有 reducer interface，不新增 runtime 私有测试 seam。

- **P2 worker：核心纵向链路已完成。** `@melody/agent-worker` 锁定 Pi coding-agent/server `0.85.0`，提供有界 JSONL stdio、worker epoch/seq 事件封装、Pi SDK 会话适配、文本/图片输入、模型/思考强度、原生 JSONL 持久化、显式 ACP 导入、取消竞态和有界幂等账本。Host-owned ToolGateway 已覆盖文件读/搜索/目录、有限 tree-sitter 代码库导航、写入/编辑/补丁、前台与后台终端、权限、计划、问题、嵌套 subagent 与后台任务；后台子代理还补齐 `get_command_or_subagent_output`、`wait_commands_or_subagents`、`kill_command_or_subagent`；同一 workspace 的变更工具由 Host 级串行闸门保护，补丁会先完整预检 Add/Delete/Update/Move 再落盘；worker 还会按 product session 串行化 open/import/configure/close，并拒绝旧 run 的 steer/follow-up/cancel 或 tool resolve，避免生命周期和回合竞态；worker 不直接读工作区或 SQLite，Pi 内建文件/终端工具关闭。命令进入 worker 前经过能力门禁，附件、代码库索引和工具输出有界；unsupported Pi ecosystem capabilities remain on ACP and are called out in the matrix。前台/后台终端均通过 Host 任务注册表受控，Melody 专用策略继续由 ACP 兼容路径承接（workflow 已删除）。
- **P2 宿主与打包：已完成。** Rust 负责 worker 资源发现、最小环境注入、显式转发标准网络代理/证书变量、1 MiB 有界帧、协议/世代/序号校验、健康握手、优雅停止/回收和状态/事件转发；Tauri `externalBin`/准备脚本会为目标平台生成并检查静态 Bun worker，缺失产物显式报错，不启动旧 ACP。根项目的 `test:pi-worker-smoke` 会在隔离临时目录中启动源码 worker，或由 `MELODY_PI_WORKER_PATH` 指向待验收产物，核对 `runtime.ready` 的 Pi 版本、协议、能力矩阵并验证优雅关闭；该 smoke 已接入 worker 测试、CI 和 release 矩阵（每个平台在打包前先验收对应静态产物）。规范事件在同一事务中写入 schema v10 的 `agent_event_log` 与 `agent_session_bindings`，重复事件幂等；每个 worker generation 绑定一个 canonical workspace，切换项目时先优雅停止再按新项目配置重启，授权仍由 `WorkspaceRegistry` 决定。
- **P2 配置、store 与恢复：已完成（2026-09-11 增补 Memory lexical sidecar）。** 用户/项目配置会生成隔离的 `pi/melody-models.json`，密钥只按次注入进程环境；重试次数、流式空闲超时和单一自动压缩阈值按同一覆盖优先级写入独立的 `pi/melody-model-policies.json`，worker 在模型创建/切换时通过 `SettingsManager` 应用，其中阈值按模型上下文窗口换算为 Pi 原生 `compaction.reserveTokens`（保留 Melody 的包含边界）。Pi 的 `melody-compaction` 扩展在压缩前生成有界 Memory Flush 记录，再调用公开 `compact()`；认证、取消或第二阶段失败时回落 Pi 原生压缩。`toolset.ask_user_question.timeout_enabled` / `timeout_secs` 同样由 Host 解析为 `questionTimeoutPolicy`，在 worker gateway 设置有界计时；禁用计时会等待用户，资源刷新删除配置时会清除旧快照，不会继续沿用启动时环境变量。策略文件损坏会显式失败而不是静默使用错误默认值；前端模型目录、认证状态、Pi event projection、live/replay barrier、配置 `expectedRevision`/`session.configured` 权威回写、恢复检查与显式 `resumePiSession` 已接通。基础 Memory 现在还会维护工作区级 `index.sqlite` lexical sidecar（摘要未变化跳过、变化清理 stale chunks），并提供 `rebuild_melody_memory_index` 显式修复命令；embedding/vector/dream 仍保持兼容回退。已有 ACP 会话不会隐式接管，必须经过有界、可审计的 import plan；Pi 原生文件、产品事件日志和绑定检查点始终分层保存，删除项目/会话会在产品记录删除前清理对应原生 JSONL、导入备份和临时文件。
- **P2 兼容性门禁与回退：已完成。** Pi 启动前静态检查用户/项目配置和扩展清单，发现当前版本未覆盖的 MCP、非受信任/非 stdio LSP、需要语义索引的 memory、严格语义代码图/未支持语言、复杂 goal 编排、动态 Hook/插件扩展，或无法安全枚举的 Skill 时，仅将受影响会话路由到 Legacy ACP；受信任的 `.melody/lsp.json` stdio 服务器由 Host 以一次性、只读、有界的 JSON-RPC 桥接投影给 Pi。`.melody/skills`、标准外部 `.agents/skills`/`.claude/skills`/`.cursor/skills` 和纯 Markdown 插件 Skill 会由 Host 按路径、深度、大小和符号链接边界显式投影给 Pi。基础 Memory 的 Markdown 检索、首轮注入、session-end 快照、SQLite lexical sidecar 和两阶段 Memory Flush 由 Host/Pi 扩展接管；有限 tree-sitter 代码库导航由 Host 按 `features.codebase_indexing` 布尔值或路径 glob 策略接管。平面 `commands/*.md`（含纯 Markdown 插件命令）也由 Host 以显式 prompt template 路径加载，Pi 的 ambient 资源扫描仍关闭；每个新的顶层/子任务回合前会重新枚举并 reload 受控资源，运行中的 steer/follow-up 不重建运行时。Pi worker 订阅、握手或启动失败也会清理 Pi 资源后自动回退并强制重新初始化 ACP。诊断以结构化 `capabilityDiagnostics` 和持续状态提示暴露，健康/模型命令带会话归属，不依赖全局最后一次引擎选择。该门禁保证“功能不减少”，但不把 ACP 兜底计为 Pi 对等；插件脚本/动态扩展、严格语义代码图、未支持语言、记忆 embedding/vector/dream、复杂 goal 编排和其他生态能力仍需 P3/P4 的真实样本验收。
- **P2 资源配置热刷新：已完成。** Skill/命令启用状态通过设置变更后，Host 会重新生成受控根清单并发送 `session.resources.refresh`；worker 对根路径和符号链接再次校验，只有完整空闲回合才立即 reload，正在 provider 请求或等待工具/权限响应的会话只更新下一回合快照，避免因 SDK 短暂报告 `isStreaming=false` 而重启或打断当前回合。
- **P2 模型目录热同步：已完成。** 模型设置保存后，Host 仅使用当前 workspace 重新生成 provider ID、目录文件、策略快照和短生命周期凭据环境变量，向 worker 发送 `runtime.models.sync`；worker 清理旧生成环境、移除对应 runtime 认证覆盖、替换（而非深度残留合并）重试/空闲超时策略并刷新 `ModelRuntime`，活动回合不被打断，下一回合使用新快照。没有活动 Pi 会话时不发送命令，renderer 不能把自定义模型路径、策略或密钥塞进同步载荷。
- **P2 权限裁决收尾：已完成 Host 侧门禁。** 项目 `allow`/`deny` 规则不再依赖 renderer 的异步查表：Rust Host 为 live Pi permission interaction 自动回复，并在 `tool.requested` 执行前再次按 session→project→canonical tool key 校验。规则查询失败保持显式询问，不自动批准；历史 replay 不会回复已结束交互。worker 的权限摘要只携带命令/路径，避免把完整写入内容或补丁作为规则身份。
- **P2 会话命令归属收尾：已完成 Host 侧门禁。** 除 `session.open`/`session.import` 的专用预检外，关闭、配置、回合、交互、工具和后台任务命令都会核对产品会话存在、规范化 `cwd` 与当前 worker 一致且绑定引擎为 Pi；包络层与命令层的会话 ID 冲突会被拒绝。健康握手和首次模型目录请求仍可在无绑定状态下运行。
- **P2 会话模式收尾：已完成。** Pi 不依赖上游扩展提供 ACP 模式，而是在共享契约中声明 `default`/`plan`/`ask`，前端为 Pi 会话显示同一模式选择器，worker 在 ToolGateway 入口按模式执行最小权限策略。规划模式只允许读取、提问和更新计划；问答模式只允许读取和提问；未知模式拒绝，且权限模式设为 `always-approve` 也不能绕过这些工作流限制。
- **P2 Pi 原生任务列表与基础目标状态：已完成。** 将 Melody-build 的 `todo_write` 合并/替换、部分状态更新、重复 ID 校验和分支恢复语义实现为 first-party Pi inline extension。状态通过 `pi.appendEntry("melody.todo_state", ...)` 写入 Pi 原生会话树，不进入模型上下文；扩展只在 `default`/`plan` 模式执行，`ask` 模式会明确拒绝。新增 `melody-goal` 扩展，以同样的 custom entry 持久化基础目标、`update_goal`、阻塞计数、完成/暂停/恢复/清除和 `/goal` 命令；Host 还投影有界 token budget、停滞检测和 blocked-attempt 上限，复杂分类器、规划/验证器、重试编排和角色模型策略才由能力预检触发 ACP 回退。Pi 原生模型/provider、会话树、分支、压缩、公开扩展工具和 custom entry 的采用边界已整理到[原生能力对照](./native-alternatives.md)。
- **P2 会话配置持久化收尾：已完成。** Pi 绑定在 schema v10 中保存最后一次权威 `sessionModeId`、`permissionMode`、`modelId` 与 `reasoningEffort`。worker 重启或重新打开/导入会话时，Host 先恢复并校验这些值，再发送 `session.open`/`session.import`；缺失、未知或旧数据库值安全回退到当前可用模型、思考强度、默认权限与 `default` 模式。模式、模型和思考强度切换仍以 `session.configured` 事件为提交点，避免 renderer 的临时选择覆盖已持久化配置；旧 schema 会在启动时补齐新增列而不丢已有绑定。
- **P2 迁移 journal 与恢复：已完成第一版。** `migration_journal` 在 schema v10 中记录源摘要、转换器版本、完整计划、备份引用和 `materializing/applied/failed/rolled-back` 阶段；`session.import` 必须携带与 journal 完全匹配的 `migrationId` 和计划。`session.imported` 事件、Pi 绑定、事件日志和 journal 完成状态在一个 SQLite 事务中提交，重试保持计划不可变，失败尝试获得新 ID，晚到旧事件不能污染新尝试；会话/项目删除显式清理 journal。桌面 UI 仍只展示迁移报告/导入结果，不把 journal 当作可执行脚本。
- **P3 MCP bridge：第一阶段已完成实现，待真实 provider/平台验收。** Rust Host 新增受控 MCP stdio/HTTP/SSE 运行时和 `mcp_list_tools`/`mcp_call_tool` 两个 Pi gateway 工具：配置合并、无 shell 子进程、最小环境、固定 HTTP client、显式 `${ENV_VAR}` 请求头引用、401/403 认证诊断、同源 SSE endpoint 校验、JSON-RPC 初始化/列举/调用、匹配 request id 即结束长 SSE 响应、超时、取消、输出上限、schema 白名单和 Host 权限规则均已接通；回归测试覆盖真实子进程/HTTP 列举与调用、跨域 endpoint 拒绝、保持连接的 SSE 响应、Host 取消、停止时中止远程请求、空闲进程失活及失败连接丢弃后重连。超过 512 KiB 的 MCP 结果会归档到受控工作区并可分段读回；无效/不完整配置仍在能力预检阶段回退 ACP，真实 OAuth/provider、三平台样本仍是验收项。
- **P3 生命周期收尾：MCP 进程随 worker 代际回收。** worker 正常停止、切换工作区、协议失败或 stdout 异常关闭时，Host 都会回收对应 workspace 的 MCP 子进程；工作区子目录也会被纳入取消匹配，避免遗留连接。
- **P3 终端大输出归档：已完成 Host 侧实现。** `run_terminal_command` 以有界读取消费 stdout/stderr；超过 8 MiB 的输出保留受控工作区归档（单文件最多 64 MiB，最多 32 个归档、总量最多 512 MiB），返回预览和引用，归档目录拒绝符号链接并按最旧文件回收。MCP 响应使用独立的 1 MiB 网络体上限和 512 KiB 预览；超出预览的完整结果同样归档并可通过 `workspace_read_tool_output` 分段读取。
- **桌面运行时边界：Pi-only。** Desktop agent 使用 Pi；能力预检对未支持或不可安全表达的配置明确阻断，不回退到 ACP。ACP 仅作为历史会话只读归档/导入兼容，以及浏览器预览的确定性 fixture；不应将其描述为默认 Desktop runtime 或 Pi 能力缺口的 fallback。历史 ACP 生态能力超出当前 Pi 支持范围时应标记为未实现/不支持，而非计入 Pi 完成矩阵。

本批新增只读崩溃恢复检查：Host 会基于 Pi 绑定和有界事件扫描返回恢复摘要，区分可重放、需要协调未结束工作、日志不完整而阻断以及非 Pi 会话；它不执行恢复、不重跑工具。完整恢复状态机仍需在真实桌面故障注入与 provider 样本中验收；不支持的生态能力继续走 ACP。

本批同时提供 opt-in 的 `resumePiSession` 安全协调入口：仅对 `replay` 摘要执行有界事件日志重放，并要求调用方共享已经建立的 live/replay barrier；`clean`/`not-applicable` 原样返回，`reconcile`/`blocked` 只返回人工处理结果。它不会自动打开 Pi、重发 prompt、执行工具或回答交互；真实副作用协调仍需人工确认，避免恢复时重复执行。

本次收尾还关闭了几条生命周期边界：回合终止按 `promptId` 关联前端 pending 状态；配置按 `expectedRevision` 串行提交并以 `session.configured` 为权威回写；Host ToolGateway 的阻塞文件/终端调用移出 Tokio 运行线程，事件重复序列在内存窗口之外由 SQLite 再判定；删除项目/会话会清理 Pi 原生 JSONL 及导入/临时残留，并在产品删除前停止 workspace-scoped worker。健康握手等无 session 的运行时事件不会要求 SQLite 状态，因此独立 worker smoke test 与桌面 Host 的语义一致。

最后一轮安全收尾还覆盖了变更型路径和输入边界：workspace 变更锁不保留已关闭工作区的强引用；编辑、删除和补丁拒绝符号链接，避免链接把写入转出授权根；`session.open` 强制核对数据库 `cwd` 与当前 worker workspace；worker 在 `runtime.shutdown` 后停止消费后续帧，等待已排队命令和 writer 刷新后自然退出。上述规则均有 Rust/worker 回归测试，Host 仍以超时强杀兜底。

## 2. 阶段与退出门禁

P2 worker 的 Host ToolGateway 已补齐 Melody-build `list_dir` 的 Pi 映射：`workspace_list_directory` 只接受工作区内相对目录，默认跳过隐藏项和常见生成目录，并限制递归深度、条目数、输出大小和符号链接遍历；请求、Rust 执行器、能力清单和回归测试保持同一工具名。开启旧引擎 `.gitignore` 策略时，Host 通过 `ignore` crate 复用 Pi 原生遍历规则过滤搜索/目录列表，并对读取、编辑和补丁目标执行一致的忽略项拒绝；策略由受信资源清单投影给 worker，不再因为该配置回退 ACP。

| 阶段                | 工作                                                              | 退出条件                                                                |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P0 基线冻结         | 矩阵逐项确认、原生历史格式、工具/插件清单、脱敏fixtures、性能基线 | 所有B项有调查结论；必需能力有可重复测试；关键未知风险列明               |
| P1 协议抽离         | agent-contract、客户端、LegacyAdapter、规范事件和日志             | 仍使用melody-build，全部旧测试与关键回放通过，UI行为不变                |
| P2 Pi最小纵向链路   | SDK worker、启动/握手/模型/流/工具/停止/持久恢复、三平台打包原型  | 不依赖开发机Node/Bun/Pi安装；真实自定义模型可运行；进程取消不泄漏       |
| P3 工作流与生态对等 | 权限、计划、问题、MCP、插件hooks、记忆、媒体、子代理和后台服务    | 功能矩阵必需行全部在Pi执行路径通过，不靠legacy兜底计通过                |
| P4 数据迁移演练     | 原生转换、分级续聊、配置导入、统计、故障注入和回滚                | 源数据保留、转换报告可核对、失败可恢复、无静默丢失                      |
| P5 beta灰度         | 可选择新会话使用Pi、持续观察、逐步默认Pi                          | 约定样本/平台/模型覆盖完成，无数据损失和权限绕过，性能达到预算          |
| P6 正式晋升         | 用户明确授权后main正式发布，完整公告                              | 签名/更新源/产物验证完成，公告包含迁移范围、已知限制和回退方法          |
| P7 清理旧引擎       | 去旧CLI调用、legacy adapter、sidecar/vendor依赖                   | 无必需功能依赖旧引擎；所有旧会话有验收过的保留/继续方式；回滚策略仍可用 |

P3可按服务逐块实施，但不建议同时重写主循环和全部插件服务。P2是是否继续投入的关键节点：打包、公开API或真实模型出现根本障碍时先解决，不把问题拖到发版。

P5不能固定成“运行几天就通过”。应在P0根据使用样本设定覆盖数与观察期；存在重大安全/数据问题直接停止推广，保留已采集诊断。

## 3. 建议提交顺序

1. `test(agent): capture legacy behavior and migration fixtures`：只加测试和脱敏样本。
2. `refactor(agent): introduce engine-neutral contract and legacy adapter`：一次抽一类事件，不改UI。
3. `feat(agent): add runtime supervisor and durable event checkpoints`：先验证legacy恢复与取消。
4. `feat(pi): add pinned SDK worker and packaged smoke test`：Pi入口默认关闭。
5. `feat(pi): integrate model catalog and controlled tool gateway`：验证真实模型及权限。
6. `feat(pi): preserve plans questions and subagent workflows`：每项独立测试，避免单巨型提交。
7. `feat(pi): add marketplace MCP hooks memory and media compatibility`：拆为多个有界提交。
8. `feat(migration): add dry-run reports backups and session conversion`：先测试副本，后开放用户迁移。
9. `feat(pi): enable opt-in beta and diagnostics`：不是宣布稳定默认。
10. `chore(agent): retire legacy engine after parity sign-off`：最终单独可审查清理。

以上是工作包边界，不是要求一次完成全部。第一次实现建议只做P0/P1和P2纵向原型，评审结果后再进入大规模兼容移植。

## 4. 测试体系

### 4.1 自动化层次

| 层次            | 内容                                                              | 目的                               |
| --------------- | ----------------------------------------------------------------- | ---------------------------------- |
| 纯单元          | reducers、ID映射、usage、配置优先级、权限digest、迁移分类         | 不依赖模型，快速发现确定性回归     |
| 协议契约        | TS/Rust相同fixtures、坏帧、未知版本、超限、重放、重复命令         | 不允许两端类型看似一致而实际不兼容 |
| SDK适配         | 固定Pi版本模拟provider事件、工具、队列、压缩、session replacement | 上游升级时直接暴露行为改变         |
| Host/worker集成 | 真实子进程、IPC、SQLite、取消、权限、MCP测试服务                  | 验证进程与持久化边界               |
| UI端到端        | 模型选择器、长流、工具卡、审批、计划、子历史、上下文              | 保留当前用户使用方式与组件行为     |
| live provider   | 授权测试凭据、有限预算、临时工作区                                | 验证真实API兼容；和离线CI分离      |
| 打包验收        | macOS ARM64/x64、Windows x64的最终安装包                          | 本地dev成功不代表可分发            |

所有现有类型检查、lint、单元、Rust测试和架构检查继续保留。新增测试接入根脚本/CI；不通过删除旧测试或放宽断言取得绿色。

### 4.2 必测故障场景

1. 同一submit重复发送、接受确认丢失：只有一个run和一份工具副作用。
2. 流输出一半worker退出；原生已落盘而产品事件未确认：恢复历史不重跑工具。
3. UI断开后继续后台任务，再恢复：消息、子代理、usage与seq一致。
4. 审批期间切会话/取消/改参数/规则撤销：旧allow不可用于新调用。
5. followUp已排队再点击停止：不会自动开始下一轮。
6. 同时两次编辑同文件、Git切换与写文件、worktree删除与子任务运行：无未定义竞态。
7. Pi压缩后context null、provider不返回usage、cache费用缺失：未知不变0，不重复累计。
8. 设置保存自定义模型但缺凭据/目录刷新失败：可见状态和可操作提示正确。
9. MCP断开/超时、hook阻断/崩溃、插件更新中断：状态准确、安装原子性与回滚有效。
10. 旧会话toolResult缺失、附件移动、损坏末行、opaque reasoning签名：转换报告明确而非静默删除。
11. 大输出、长中文、Unicode换行、恶意超大帧：内存有界、协议不断裂。
12. 退出应用/系统重启：拥有的本地进程清理，远端job保留查询，不误报已取消。
13. 不可信扩展直接调用fs/child_process：证明信任/隔离策略真实有效，不能只测tool_call hook。
14. 更新安装新版后回滚：旧schema保护、新增Pi历史保留、更新签名有效。

### 4.3 对照不能双执行真实副作用

“双引擎对照”默认指在独立临时工作区、固定测试工具与脱敏fixtures中运行。生产任务不同时发给两个引擎，不重复发邮件、部署、购买、删除或远端API写入。真实provider对照需预算上限；读取型工具也需考虑数据外传和费用。

## 5. 性能与诊断

P0先记录现有基线：冷启动、首事件/首token、长流UI帧时间、事件落盘吞吐、内存/包体、取消响应、多子代理峰值、恢复耗时。网络模型时间与本地adapter额外开销分开。

建议初始门槛（工程预算，不是已测结果）：同硬件/相同fixtures下首个本地可用状态与恢复P95不比基线慢超过20%；稳定流式UI无持续卡顿；队列/日志内存有上界；取消后1秒内UI收到取消确认，本地受控进程树在配置宽限期内退出。若包体或常驻内存显著增加，必须给出实测和取舍，不用“换成新架构”解释一切。

日志字段：sessionId/runId/toolCallId、worker/Pi版本、协议版本、耗时、重试/压缩原因、错误code。默认不记录prompt全文、密钥、完整工具输出或绝对私人路径。诊断导出让用户预览和脱敏，不能悄悄新增遥测。

## 6. 打包与依赖供应链

生产选择在P2验证后决定：

- 方案A：随应用附带固定Node运行时及worker JS/依赖资源。优点是接近SDK运行环境、动态加载较直接；成本是包体与平台资源管理。
- 方案B：自有Bun编译worker。优点是分发简化；必须验证动态插件、WASM、原生模块、资源路径及SDK兼容，不能拿上游CLI可打包推断自有worker也可。

优先验证A作为可解释的保底，再比较B。用户电脑不要求预装Node/Bun/npm，不允许运行时下载主引擎。当前研究要求Node >=22.19.0，而项目engines宽于此；实施时同步开发/CI约束并锁定已验证受支持运行时，不只改package字段。

锁定Pi正式tag/npm精确版本、lockfile、运行时和构建工具；研究main HEAD与v0.85.0 tag不同，不能混为同一验证基线。产物manifest包含所有版本、hash、平台、协议范围、许可证/SBOM。审查安装脚本与动态下载，不把 `--offline-model-data` 当成完全离线构建保证。

沿用现有安装包和更新签名流程；确认worker及原生附属文件包含在签名/公证所需范围，路径在应用更新后可定位。关闭内置Pi自更新，统一通过MelodyWork的签名更新发布。

## 7. 如何持续跟进Pi并减少维护

维护一个 `PiCompatibilityManifest`：版本、源码tag/hash、公开API清单、协议fixtures版本、原生会话格式支持范围、已知差异和平台构建hash。当前清单落在 [`pi-compatibility-manifest.json`](./pi-compatibility-manifest.json)，`pnpm check:pi-compatibility` 会把依赖、worker 能力声明、会话模式、媒体能力和导入格式一起校验；升级 Pi 时必须先更新清单，再让门禁暴露漏改的适配器。

每次升级流程：阅读上游changelog → 更新独立依赖PR → adapter编译/契约测试 → 原生历史读写与迁移 → 权限/队列/工具并行/压缩回归 → 三平台包测 → beta → 经授权正式发布。补丁版本也执行关键测试；不假定0.x API稳定。

仅在Pi适配目录处理上游变化，不让升级迫使整个UI改字段。上游新增能力先在能力矩阵标注“候选”，验证后再替换自有服务；例如图片生成API可逐provider接入，不必为用它一次性重写视频服务。

出现关键安全或数据回归，固定回上一已验证依赖版本；若新原生会话格式不能被旧版本读取，使用隔离存储和版本化恢复策略，禁止直接降依赖后打开新格式文件。

## 8. 风险、规模与成功标准

| 风险                        | 等级 | 缓解/阻断条件                                        |
| --------------------------- | ---- | ---------------------------------------------------- |
| 权限/插件旁路               | 高   | 所有执行入口实测；未解决不能默认Pi                   |
| 旧会话上下文丢失            | 高   | 分级转换、备份、原文归档、明确续聊分支；不接受伪无损 |
| hooks/MCP/媒体/记忆兼容不足 | 高   | 逐插件/provider矩阵，旧引擎临时兜底但不计通过        |
| SDK快速变化                 | 中高 | 精确pin、公开API隔离、升级契约测试                   |
| 打包和多进程成本            | 中高 | P2提前三平台包测、并发额度、空闲回收                 |
| 重放/取消造成重复副作用     | 高   | 幂等接受、任务日志、未知结果不自动重跑               |
| 大重构影响现有UI            | 中   | 先LegacyAdapter保持行为，功能与样式分开              |

这是跨运行时、协议和数据的重大迁移，不适合承诺几天完成。P0后才能按实际插件/历史覆盖量估算；工作量最大的预计是生态兼容与历史迁移，而不是SDK接线。若需要排期，应分别估算P0–P2原型与P3–P7产品化，不能用原型工时代表全部。

最终成功定义：功能矩阵必需行在Pi路径全部通过；没有遗留旧CLI依赖；用户历史有经过验收的展示与继续方式；权限不退化；三平台签名更新可用；性能达标；可恢复且文档完整。新增Pi会话树/steering等能力可在对等后开放，不作为牺牲旧功能的交换条件。
