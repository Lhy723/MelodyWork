# 任务计划：MelodyWork 长期可维护性治理

## 目标

识别并逐步消除造成职责混杂、修改扩散和验证困难的结构性问题，在保持产品行为与安全约束的前提下，让核心模块拥有清晰接口、内聚实现和可靠测试。

## 当前阶段

阶段 3

## 各阶段

### 阶段 1：需求与发现

- [x] 确认用户授权进行项目级结构重构，并遵守仅在 beta 开发的规则
- [x] 完成第一轮最大模块、现有架构门禁和相关测试边界扫描
- [x] 将已确认发现和首轮范围记录到 findings.md
- **状态：** complete

### 阶段 2：方案与边界

- [x] 按耦合、变更扩散风险、行为可验证性初步排序
- [x] 为首个重构切片选择 Pi 资源发现内部 seam
- [x] 记录不改变的外部协议、安全裁决点及兼容约束
- **状态：** complete

### 阶段 3：分片重构

- [x] 将共享 Host-trusted resource roots、canonical path validation 与 path restrictions 收敛到 `resource-discovery.ts`；Skill/prompt candidate scanning 分别由 `skill-discovery.ts` / `prompt-discovery.ts` 拥有
- [x] 保持 worker/Host wire protocol、manifest shape 和权限裁决不变
- [x] 将模型策略文件校验和 Pi Settings 投影从 session lifecycle 中提取为 `model-policy.ts`
- [x] 将 Host 工作区文件读写、搜索、目录列举和补丁实现抽为内部 `workspace_tools` 模块
- [x] 保持权限判定、Host gitignore 覆盖、共享 workspace mutation lock 和终端/调度路由留在网关
- [x] 将终端/MCP 输出归档、边界预览和分块读取抽为内部 `tool_output_archive` 模块
- [x] 将 worker 请求解析、工具分类、稳定工具名及权限身份投影抽为 `request_policy` 模块，并保留网关 re-export
- [x] 将路径作用域的 `AGENTS.md`/`CLAUDE.md` 祖先加载与上限抽为 `instruction_scopes`；共同的词法相对路径校验归 `workspace_paths`
- [x] 将 Host 管理的子代理 worktree 路径约束、symlink 防护和 detached git 创建抽为 `subagent_worktrees`，保留 worker runtime 调用路径
- [x] 将 Host memory 首轮注入、根 session transcript 收集/限界/flush 和重置归属为 `PiWorkerRuntime` 的独立 lifecycle component
- [x] 将 Host tool hooks、worker 请求/权限路由和持久化权限查询移入 `pi_worker_runtime/host_tool_routing.rs`，保持 supervisor 与最终权限回退语义
- [x] 将 MCP remote HTTP/SSE JSON-RPC transport、响应边界、取消和 connection protocol 移入 `pi_mcp_runtime/remote_transport.rs`，让统一 runtime 继续持有跨连接缓存和 workspace 生命周期
- [x] 将本地 MCP stdio process lifecycle、safe environment 和 bounded JSON-RPC framing 移入 `pi_mcp_runtime/stdio_transport.rs`，由 runtime 持有统一连接缓存
- [x] 将受信任 user/project MCP config normalization 与有限 spec 解析移入 `pi_mcp_runtime/mcp_config.rs`，维持 `inspect_mcp_config` crate 调用面
- [x] 将 Pi worker 稳定工具名合同与纯 subagent/session-mode access policy 移出 `tool-gateway.ts`，保留旧 gateway re-export 并让兼容检查跟随实现所有者
- [x] 将 Pi worker 全部 TypeBox tool-parameter schemas 与共享 timeout bounds 归入独立合同模块，gateway 只组装 catalog/执行 handler
- [x] 将 background task 输出边界与 Melody task compatibility 文本投影提取为纯 task-results 模块，保留原格式和限长
- [x] 将 Pi worker pending tool/interaction maps、超时、resolution 校验和成对事件提取为 request-lifecycle 所有者，gateway 保留稳定组合入口
- [x] 将 worker permission interaction 的最小身份投影与 Host response envelope 归一化提取为纯合同模块，直接覆盖敏感字段剔除和 allow/reject 形状
- [x] 将 worker subagent spawn/background/legacy task 与 task-control tool definitions 从 gateway 组装类抽到 task-tools owner，沿用既有 session-scoped controller 和权限回调
- [x] 将 task-result、worker permission projection 与 tool-access-policy 的 direct contract tests 移到各自 owner-local test files；保留 ToolGateway export/catalog/dispatch integration tests
- [x] 将 Host 终端前后台进程执行、有限输出收集、后台 registry、取消与 workspace/session 所有权迁入 `terminal_tasks`，由 gateway 保留授权、共享 mutation lock 与 monitor/terminal task 路由
- [x] 将 Host monitor 的启动/event bridge/snapshot/control adapter 从通用 gateway 移到 `monitor_tools`，保留与 terminal task registry 的分离及 task-id dispatch
- [x] 将 scheduler tool 参数映射、session ownership 操作与 bounded snapshot 从通用 gateway 移到 `scheduler_tools`，仍以 Host 数据库为唯一 source of truth
- [x] 将 Pi terminal/question/goal/network/envrc/gitignore/sandbox runtime policy projection 从 extension inventory 移入 `config_pi_policy.rs`；通用 merge helper 和插件 inventory 保留在 `config_extensions.rs`
- [x] 将 marketplace Git URL/ref/SHA 校验、clone/head、cache 锁与刷新协议移入 transport owner；插件扫描、安装和 registry 语义留在 catalog owner
- [x] 将 marketplace index/manifest 扫描、候选与 metadata projection/path validation 归给 catalog owner；用命名 metadata 类型替代位置敏感 tuple
- [x] 将 declarative subagent Markdown frontmatter parser、字段支持合同和 tool allowlist 能力上限映射移到 parser owner；来源优先级与 Host manifest 组装留在配置 owner
- [x] 将 Markdown memory 文件操作与 memory tool handlers 收入 `pi_memory_runtime/store.rs`；父 runtime 保留 enablement/config、first-turn policy 与 transcript lifecycle
- [x] 将 disposable SQLite lexical index schema、path safety、digest/tamper validation、rebuild 与 Markdown fallback 从 store 主模块提取到 `store/search_index.rs`
- [x] 将 Tree-sitter language resolution、AST traversal、definition/reference occurrence extraction 与 parser-specific bounds 收入 `pi_codebase_runtime/parser.rs`；workspace walk、cache、Host request routing 留在 parent
- [x] 将 remote HTTPS/private-network、loopback preview、snapshot URL 与 popup destination policy 集中到 `pi_browser_runtime/browser_policy.rs`；WebView/session lifecycle 留在 parent
- [x] 将 Host/worker NDJSON command/event framing、1 MiB frame limit、epoch/sequence validation 与 ready detection 提取为 `pi_worker_runtime/protocol.rs`；supervisor 继续拥有进程与 dispatch lifecycle
- [x] 将安全 `.envrc` direnv 启动、ambient environment 清除、变量名/value bounds 与 injection-name filtering 收入 `pi_worker_runtime/envrc.rs`；supervisor 传入显式 inherited-env allowlist
- [x] 将 Pi worker packaged executable discovery 和 scrubbed child environment assembly 收入 `pi_worker_runtime/launch.rs`；worker supervisor 保留模型/`.envrc` 准备、进程启动及生命周期决策
- [x] 将 Pi Skill/命令 Markdown 有界扫描、ignore path 处理、Settings 投影与 resource-manifest 部分 projection 收入 `config_pi_resources.rs`；通用扩展命令、插件 enablement/inventory 与共享 config merge 留在 `config_extensions.rs`
- [x] 将完整 Pi resource manifest composition 上移到现有 `config_runtime::pi_resource_manifest`，避免 resource owner 与 subagent owner 形成 sibling dependency cycle，同时保留 manifest fields、求值顺序和 Host/worker 调用 API
- [x] 将 Skill details/delete Tauri commands 归到 `config_extensions` catalog owner，移除其与 `config_plugin_details` 的反向模块依赖；保持 `config_runtime` re-export 与 Host command registration
- [x] 将 Pi command prompt template 扫描、路径上限与运行时 root snapshot 收敛到 `config_prompt_resources.rs`；`config_pi_resources.rs` 保留 Skill owner 与 manifest parts composition，既有 `config_runtime::pi_prompt_paths` 调用接口不变
- [x] 将 marketplace registry JSON persistence、installed plugin projection、稳定安装键、安装 rollback 与 shared-repository uninstall state 收入 `config_marketplace_registry.rs`；Host install/update/uninstall lifecycle 与安全文件删除留在 native command owner
- [x] 将 remote model catalog endpoint policy、HTTPS validation、bounded fetch/parse 与 origin-bound cache/fallback 收入 `pi_remote_model_catalog.rs`；Pi provider projection 与 Host credential environment references 留在 model-config owner
- [x] 将只读 LSP location/symbol/hover 文本 projection 与 UTF-8 安全输出上限收进 `pi_lsp_projection.rs`；进程、配置和 JSON-RPC 生命周期仍归 LSP runtime
- [x] 将子代理恢复 sidecar 的 schema 校验、trusted transcript containment、读取错误分类与原子持久化收进 `subagent-records.ts`；session adapter 只投影运行态数据并映射既有协议错误
- [x] 将只调用 `subagent-records.ts` 的 sidecar schema/path/load/save contract test 移到 owner-local `subagent-records.test.mjs`，worker 与完整 unit manifests 均显式纳入；session adapter suite 保留真实 lifecycle/recovery coverage
- [x] 将 LSP user/project config 合并、字段 bounds、project trust 与 transcript/workspace path policy 收进 `pi_lsp_config.rs`；stdio process 和 JSON-RPC 生命周期留给 runtime
- [x] 将 Marketplace 有界目录复制、staged replace/backup 与安装路径删除约束收进 `config_marketplace_filesystem.rs`；Host install/update/uninstall 与 registry 持久化事务仍由 native command owner 编排
- [x] 将桌面窗口截图、嵌入视口裁剪、JPEG 压缩及 transfer bound 收入 `pi_browser_runtime/screenshot.rs`；session runtime 只提供当前 tab、可见范围与已验证的 origin context
- [x] 将 Browser DOM snapshot protocol、bounded page projection、wait filter 与 snapshot-ref click/type rules 收入 `pi_browser_runtime/page_tools.rs`；session runtime 保留 active-tab 校验和 per-tab ref 生命周期
- [x] 将 Browser tab ID/index、entry ownership 与 open/select/close ordering 收入 `BrowserSessionLifecycle`；Tauri WebView 与 in-memory adapters 通过同一 interface，Host URL/权限策略仍留在 runtime
- [x] 将直接测试 `BrowserTabIndex` 的 tab cap/neighbor selection 与 unknown-ID 行为的两项既有 tests 移入 `session_lifecycle.rs` owner；parent 继续保留 WebView/security integration tests
- [x] 将 session-isolated WebView/profile construction、platform selection 与 navigation/popup callback wiring 收入 `pi_browser_runtime/view_creation.rs`；URL trust policy 与 tab lifecycle 继续由各自 owner 管理
- [x] 将 Pi worker protocol framing、`.envrc` projection 与 launch environment allowlist 的直接行为 tests 移入对应实现 owners；parent supervisor 只保留自身 runtime event test
- [x] 让 Pi goal safety compatibility marker 检查 worker `launch.rs` 的真实 inherited-environment owner，而非 supervisor parent
- [x] 将 browser URL、loopback preview 与 popup trust policy 的直接 tests 移入 `browser_policy.rs`；capability/bounds integration tests 留在 parent
- [x] 将调度时刻推进、错过触发策略、间隔解析及纯输入枚举校验收进无 SQLite 依赖的 `database_agent_schedules/policy.rs`；持久状态 owner 保留事务、行校验编排和 Tauri commands
- [x] 将 Pi 事件 envelope protocol、字段/枚举校验、有界 JSON 与 session identity projection 收进 `database_agent_events/event_contract.rs`；event-log owner 继续独占事务、replay/idempotency 与 binding checkpoint
- [x] 将 worker outbound envelope 与 nested command session affinity 校验归并到现有 `pi_worker_runtime/protocol.rs`；Host 的 session authorization/migration checks 继续留在 supervisor command path
- [x] 将 Pi usage 合并、美元成本换算与计费事件 projection 从统一 session event reducer 中分离到 `billing-usage.ts`；event owner 继续控制 timeline 顺序、context 状态与 lifecycle
- [x] 将子代理 Markdown agent 文件的有界目录扫描、解析和 unsupported-field 分类收敛到共享入口；运行时 manifest 与 capability inventory 不再各自实现扫描/错误回退
- [x] 将 Settings subagent inventory 改为从一次读取的 scope config 直接投影 enable/toggle/inline metadata，避免为了读取 UI 字段重复构建完整 Pi manifest 并重扫所有定义
- [x] 将架构依赖门禁改为 TypeScript AST 扫描，覆盖静态、动态、type、re-export 和 CommonJS import，并为 domain 与 Pi SDK owner 规则增加自测
- [x] 将 Host MCP capability preflight 接到 MCP config owner 的受限 inventory，移除 renderer 的重复 transport/config parser，并验证命令权限与 owner wiring
- [x] 将子代理 built-in capability ceiling 与 parent/request permission-mode intersection 集中在 subagent policy owner，并把 owner tests 纳入 worker test command
- [x] 将 Pi ModelRuntime 缓存、目录刷新队列、认证/模型事件、Host 凭据同步和模型解析移入 `model-catalog-runtime.ts`；session adapter 保留命令边界与 live-session 安全刷新
- [x] 将 `model-policy.ts` 的直接行为测试从 session-adapter suite 移到 owner-local `model-policy.test.mjs`，worker 与完整 unit test manifests 都显式纳入该文件
- [x] 将 Host user/project model scope merge、remote overlay、provider/model schema normalization 与 credential-reference projection 收入 `pi_model_config/model_projection.rs`；parent 继续组合 config/remote fetch/file persistence
- [x] 将 subagent request/resume/parent ceilings 的纯 launch-policy projection 收敛到现有 `subagent-policy.ts`；session adapter 保留 session/worktree/resource I/O 与 task lifecycle
- [x] 将 `config_runtime.rs` 中六项只直接验证 Pi terminal/question/goal policy projection 的既有 tests 原样归回 `config_pi_policy.rs`；复合 Host config/command tests 留在 parent
- [x] 将 Pi report 的配置快照解析与兼容策略分类收敛到 `config-capability-policy.ts`；report composer 继续拥有诊断顺序和 Host inventory 汇总
- [x] 将 worker 启动环境策略解析与 Host resource manifest normalization 收敛到 `resource-policy-snapshot.ts`；session adapter 继续拥有状态应用、生命周期排序和 live session refresh
- [x] 将 Tauri command permission cross-check 从 Pi compatibility script 拆成独立且可 fixture 测试的 owner；保留组合 gate 与现有检查覆盖
- [x] 将 Prompt/Skill 路径、静态插件资源激活与 `skills.ignore` 的 worker/Host cross-check 收敛到可 fixture 测试的 Pi resource contract owner
- [x] 将 model policy、goal safety、codebase index、Hooks 与 resource compatibility 复用的有限 TS/Rust 整数常量解析收敛到一个有 owner fixture tests 的 source parser
- [x] 将 `resource-discovery.ts` 的纯路径筛选/刷新行为测试移至 `resource-discovery.test.mjs`，worker 与完整 unit manifests 显式纳入；live-session refresh integration 仍由 adapter suite 验证
- [x] 将 `agentSchedules` 的 worker 工具名/schema、Host dispatch/字段消费、会话身份与 interval bound cross-check 收入单一可 fixture 测试的 owner
- [x] 将 `modelPolicySnapshot` 的 Host writer、worker parser、实际 byte/timeout/threshold bounds 与 manifest cross-check 收入独立 fixture-tested owner；保持 Host 权限与运行时策略语义
- [x] 将 `subagentPolicy` MCP grant/capability mapping cross-check 收入 fixture-tested owner；统一 Host/worker 的 64/96/128 字节名称边界，并让 Host 将过长 `tools` 项报告为 unsupported 而非静默丢弃
- [x] 将 Host `max_retries` 校验与 worker/manifest 的 10,000 上限对齐；在实际快照生成入口验证 global/model 两种配置的 10,000/10,001 边界
- [x] 将 `terminalPolicy` 与 `backgroundTerminalTasks` 的 Host/worker/manifest drift checks 收入 fixture-tested owner，覆盖实际输出 clamp、任务边界及 worker-stop cleanup wiring
- [x] 将子代理 resume/cwd/worktree response trust-boundary helpers 与既有行为测试迁入 `subagent-session-boundaries.ts`，保留 session adapter 原调用/导出路径
- [x] 将 `webTools` 的 manifest tool name、worker schema/Host route 与 HTTPS/bounded-response marker checks 收入 fixture-tested compatibility owner；聚合 checker 继续负责 source reads 和诊断
- [x] 将 `memoryTools` 的 worker/Host routes、Markdown store/SQLite lexical index ownership 与 memory-lifecycle wiring checks 收入 fixture-tested owner；保留现有运行时和数值策略
- [x] 将 `memoryTools` 六项与 `webTools` 四项 manifest byte/count limits 和真实 Host constants 的数值 cross-check 纳入各自 fixture-tested owner；不把 worker character-count schema 当作 Host byte limit
- [x] 将 `lspBridge` manifest tool mapping、Host runtime/config/projection markers 与 worker routing checks 收入 fixture-tested compatibility owner；聚合 checker 继续负责读取和诊断
- [x] 将 `codebaseIndex` worker/schema、Host Tree-sitter/parser/routing markers 与已有三项 Host 数值 cross-check 收入 fixture-tested owner；聚合 checker 继续负责读取和诊断
- [x] 将 Hooks Host/runtime/config/worker wiring 与既有七项 manifest limit checks 收入 fixture-tested compatibility owner；聚合 checker 继续负责 snapshots 和诊断
- [x] 让 `session-adapter.ts` 的任务/子代理类型直接依赖 `task-tools.ts`、`tool-access-policy.ts` 与 `subagent-policy.ts` 的真实 owner；保留 gateway 的既有兼容 re-export
- [x] 将 Linux Landlock syscall、路径可执行性校验、ruleset 准备和 child `pre_exec` 限制收入私有 owner；继续通过 Host `sandbox_decision`/`sandboxed_shell_command` 承载策略与行为测试
- [x] 刷新 Pi migration handoff 的 worker/Host owner code map，明确已拆子模块的边界与真实路径，避免交接文档继续把实现归给 parent
- [x] 按用户确认保留 Pi Explorer 的 `&session:<id>` 分支引用写回，并将兼容清单对齐到源会话草稿语义；删除未调用的结论文本投影
- [x] 将插件 agent Markdown 的 bounded path enumeration/parse 与 scope/provenance 共享于 Pi manifest 和 Settings projections；保持两端的命名投影差异及逐文件流式处理
- [x] 将只验证 frontmatter/parser/capability ceiling 的直接 tests 移入 `config_subagent_markdown.rs`；manifest/Settings/plugin precedence integration tests 仍属于 `config_subagents.rs`
- [x] 将 MCP config、stdio 与 HTTP/SSE transport 的直接 tests 移回实现 owner；父 runtime 保留结果归档与 workspace-stop behavior tests
- [x] 将 marketplace catalog、registry 与 Git SHA 的直接 tests 移回实现 owner；native install/update transaction tests 留在 orchestration owner
- [x] 将直接验证 sandbox profile precedence、Skill ignore paths 与 Plugin Skill scan roots 的 tests 移至 Pi policy/resource owners；plugin inventory/enablement integration tests 保留在扩展配置 owner
- [x] 将有界附件解码、模型输入模态和附件 byte ceilings 归入独立 `attachment-policy.ts`；保留 PiSessionAdapter 当前导出作为兼容与测试接口
- [x] 将 turn config snapshot、active-run/steer 与 cancel identity guards 集中于纯 `turn-policy.ts`；adapter 继续使用既有 helper exports 作为测试入口
- [x] 将 native session 文件身份与 persisted fork-anchor matching 收入 `session-persistence-policy.ts`；PiSessionAdapter 保留原错误映射和测试导出
- [x] 将 Pi child-session/task hierarchy、durable resume、background controls、event aggregation、live refresh 与 teardown 收入 PiSubagentRuntime；adapter 保留 root lifecycle、Host command/event boundary 与 shared context interface
- [x] 通过 worker command/event protocol 验证 child spawn、错误 owner 的 cancel 拒绝、task.wait 终态及运行中 child shutdown cleanup；移除依赖 adapter 私有 task map 的 lifecycle tests，不新增 runtime-private test seam
- [x] 保持 worker-visible child session/task IDs 和 Host ownership 不变；Pi native SessionManager 使用独立 valid UUID，修复冒号分隔 logical ID 被 Pi 拒绝的问题
- [x] 将 Pi SDK 静态入口/type owner 收入 session-runtime-types.ts，并让 packaging 与 compatibility gates 检查新的职责所有者
- [x] 将 Host Pi session command parsing、workspace authorization、SQLite binding/import/open checks 与 fork intent preflight 收入 `pi_worker_runtime/session_commands.rs`；supervisor 保留进程生命周期与 dispatch
- [x] 通过 preflight owner interface 覆盖 session identity/workspace/engine binding、import journal identity、fork durable intent 与二次 generation/binding validation
- [x] 更新 Pi compatibility gate 与 Host owner map，使检查和交接文档追踪新职责边界
- [x] 将 Host 侧 per-model retry/idle-timeout/auto-compaction policy projection 与数值校验移入 `pi_model_config/model_policy.rs`；目录/凭据/model catalog 写入留在组合 owner
- [x] 通过 policy owner 接口覆盖 user/project/session/default precedence 与 worker 数值边界；保留模型策略序列化与失败前不落盘集成测试
- [x] 更新 Host/worker/manifest compatibility gate 读取新 policy owner，并验证其从模型配置 composer 接入
- [x] 将 macOS Seatbelt executor availability、SBPL rendering 与 wrapper command construction 收入完整平台 adapter；共享 Host fail-closed decision 与 Linux Landlock 保持原 owner/路径
- [x] 通过实际 Seatbelt command interface 验证 writable/deny rules、device sinks、literal escaping，并更新 Pi compatibility owner wiring check
- [x] 将仅调用 `pi_web_runtime/projection.rs` 的 HTML/text 与 citation behavior tests 移到 projection owner；Host web config、URL/SSRF policy 和 network tests 留在 runtime
- [x] 通过 projection interface 固定 UTF-8 安全的 body truncation 与现有 HTML/entity、search citation 输出
- [x] 将 Pi compaction manifest/source-snapshot cross-check 收入 fixture-tested owner；聚合 checker 继续负责读取文件与汇总诊断
- [x] 将 renderer Agent 路由收敛为 Tauri→Pi、browser preview→ACP fixture；移除 persisted engine selector 与 per-session engine override 状态，保留旧设置归一化和 ACP archive/import 语义
- [x] 将 provider failure 消息限界/敏感信息清理与限流归类迁入 `session-errors.ts`；session adapter 继续拥有 run lifecycle 和终态事件顺序，并由公开 worker command/event protocol 测试验证行为
- [x] 将规范化 message/thought stream 的 delta continuity、assistant timeline-row reconciliation 与 message-scoped state cleanup 收入 `message-projection.ts`；保留 `projectAgentEvent` 验证、dispatch 和既有测试接口
- [x] 将 turn-completion billing usage 的 camel/snake wire normalization 收入 `agent/billing-usage.ts`；session projection 保留 `applySessionUpdate` 测试接口并只负责 timeline 放置
- [x] 将 Host gateway 输入解包及 tool command/output 文本投影收敛到 `tool-activity.ts`；session projection 只负责 tool row lifecycle 与 timeline mutation
- [x] 消除 agent-contract barrel 与 validation 的真实 runtime import cycle；把共享 protocol version 放到稳定 owner，并加入类型导入豁免的 production module-cycle gate
- [x] 将 Skill 与 prompt template 候选扫描分离为 `skill-discovery.ts` / `prompt-discovery.ts`；共享 Host root 信任、canonical path 和 environment validation 留在 resource root owner，并由现有联合接口测试覆盖
- [x] 将 `pi_codebase_runtime.rs` 中 per-workspace index/cache、文件 refresh/rebuild 与符号结果查询收进 `pi_codebase_runtime/index.rs`；Host request/config/error-envelope composition 留在 parent
- [ ] 继续按职责簇治理其余热点；不按行数机械拆文件
- [ ] 每片保留清晰调用面，删除被替代实现，不叠加兼容层或重复状态
- **状态：** in_progress

### 阶段 4：验证与复审

- [x] 对已完成切片运行受影响模块测试与相关类型/静态检查
- [x] 运行 Rust、worker、UI 门禁中与变更范围匹配的部分
- [x] 复查依赖方向、重复实现、未使用代码、文档准确性和 diff
- [x] 修复全 Rust 复验发现的 monitor completion/output-reader 竞态，并验证 completed snapshot 包含所有缓冲输出
- **状态：** complete（已完成切片；后续切片新增验证）

### 阶段 5：交付

- [ ] 汇总已治理范围、验证结果与尚未处理的技术债
- [ ] 不发布、不合并或同步到 main
- **状态：** pending

## 关键问题

1. 哪些复杂度集中在单文件/单类中，且跨越了独立变化原因？
2. 哪些接口或状态重复定义，导致一个功能需要多处同步修改？
3. 重构后如何保持 Pi-only、Host 权限裁决、工作区隔离和现有数据/协议语义？

## 已做决策

| 决策                                                                     | 理由                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 以职责内聚、接口深度、依赖局部性和可测试性作为治理标准，不以行数作为目标 | 文件变小本身不能消除耦合，拆薄模块会增加调用知识和跳转成本 |
| 先维持当前 worker/Host 协议与安全裁决位置                                | 避免将结构治理扩大成运行时或授权语义改写                   |
| 分片实施并逐片验证，暂不做全仓机械重写                                   | 保持回归定位能力，避免把旧复杂度搬到新抽象中               |
| 所有产品代码变更只在 beta，当前不发布、不合并 main                       | 遵守仓库发布约束                                           |

## 遇到的错误

| 错误                                                                                                                                                                   | 尝试次数 | 解决方案                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS worker 检查报告抽取后 4 个未使用 import                                                                                                                             | 1        | 已移除 session-adapter.ts 中转移到 resource-discovery.ts 的旧 imports，完整检查通过                                                                                             |
| Pi compatibility checker 假定资源实现仍在 session-adapter.ts                                                                                                           | 1        | 已改为读取 resource-discovery.ts 并验证 adapter wiring，完整检查通过                                                                                                            |
| 格式检查在导入清理后发现 session-adapter.ts 格式变化                                                                                                                   | 1        | 已运行 Prettier 并复验通过                                                                                                                                                      |
| request-policy 抽取后 Rust 可见性/导入失败                                                                                                                             | 1        | 将原 crate 级 `fail_resolution` 从模块 re-export，并删除抽出模块未使用的调度/交互常量导入；Rust 全库测试通过                                                                    |
| 工具名所有权迁入 request-policy 后 Pi compatibility check 仍读取旧网关位置                                                                                             | 1        | 将静态检查改为读取 `request_policy.rs` 并验证模块接线；`pnpm check` 通过                                                                                                        |
| memory store 批量抽取的首次重写使用了已失效的源码偏移，导致父文件语法损坏                                                                                              | 1        | 以该文件抽取前干净的 beta 版本为唯一恢复输入，重新从不可变源码计算所有区间后一次性生成父模块；Rust 专项/全库测试、check 与兼容门禁均通过                                        |
| Browser policy 抽取后首次 `cargo check` 发现两个生产调用点仍需 `validate_local_preview_url`                                                                            | 1        | 将该函数纳入 parent 的正式 policy imports；随后 cargo check 无 warning、全 Rust tests 通过                                                                                      |
| worker protocol 抽取后首轮 `cargo check` 发现 parent 导入了模块接口但未声明 `mod protocol`                                                                             | 1        | 增加显式 module declaration，并由 Pi compatibility checker 校验声明、owner 和 wiring；cargo check 与全 Rust tests 通过                                                          |
| instruction-scope 提取后父网关残留 `io::self` 未用导入                                                                                                                 | 1        | 移除被移动实现独占的 import；最终 Rust check/test 无警告                                                                                                                        |
| `tool-gateway.ts` 策略提取后，首轮 worker 回归发现网关执行路径仍直接依赖 `isAgentSessionModeId`                                                                        | 1        | 将运行时判别留在网关、纯策略 predicate 留在新策略模块；141 项 worker tests 与完整门禁通过                                                                                       |
| Subagent launch-policy 抽取后的首轮 worker check 发现 gateway 只为 re-export 导入 `PiSubagentIsolation`，Pi compatibility gate 仍从旧 gateway 文件检查 capability 常量 | 1        | 删除多余导入，按实际所有者从 `tool-access-policy.ts` 检查 mode marker，并保持 gateway 兼容 re-export；worker typecheck 与 Pi compatibility gate 复验通过                        |
| launch-policy projection 审查发现 resumed request 的非法 isolation 原先仍会被拒绝，而新策略投影只校验持久值                                                            | 1        | 在读取持久边界前恢复请求值校验，并添加 resumed-launch 回归测试；worker 与完整 unit suites 通过                                                                                  |
| compatibility-gate 结构探测命令因 root 未安装 `espree` 且 shell 插值展开报错而失败                                                                                     | 1        | 不安装新依赖；改用仓库已有 TypeScript parser 和源码分段证据继续审计                                                                                                             |
| Prettier 后 progress.md 长表格行对齐导致两次增补 patch 未匹配                                                                                                          | 2        | 不重试整行历史上下文；按稳定标题分块写入，并新增当前状态覆盖摘要                                                                                                                |
| package.json 的长 format 脚本行第一次整行 patch 未匹配                                                                                                                 | 1        | 不重写庞大脚本列表；在 `check:pi-compatibility` owner gate 中明确检查新脚本格式并运行 fixture tests，版本未变                                                                   |
| tool schema 首次移动后，tool catalog 仍有 inline browser schemas，且删掉 TypeBox runtime import 后 `createTools()` 失败                                                | 1        | 把全部 10 个 browser schemas 也归入 `tool-schemas.ts`，gateway 不再构造 TypeBox 对象；定向 30 项、worker 142 项与 full unit 400 项通过                                          |
| memory SQLite 子模块首次编译遇到 re-export 可见性不足及遗漏的 chunk bound import                                                                                       | 1        | 将跨到 memory facade 的接口限定为 `crate::pi_memory_runtime` 可见，`search_chunks` 留在 store 内部调用，并补齐共享 chunk bound；定向/full Rust tests 与 warning-free check 通过 |
| schedule policy 首轮 check 发现 `ScheduleAdvance` crate re-export 在生产代码中未被使用                                                                                 | 1        | 仅保留已有调用路径仍使用的 policy functions/constants re-export；类型留在其 policy owner，随后 warning-free `cargo check` 和完整 Rust suite 通过                                |
| event contract 首轮 check 发现 byte-bound constant 的 crate re-export 无生产消费者                                                                                     | 1        | 将 byte bound 留在 event-contract 实现 owner，不保留无用内部 API；event parser、event-log 集成、全 Rust suite 与 warning-free `cargo check` 通过                                |
| worker launch 子模块首次编译时 inherited-environment 常量未公开到父 supervisor，且旧测试导入变为 unused                                                                | 1        | 将常量设为父模块可见并删除旧 import；Pi worker tests 通过且后续 library check 无 warning                                                                                        |
| 新增 resource owner/test 的首个 apply_patch 因 fixture 多行内容中缺少新增行前缀而被拒绝，未应用任何文件变更                                                            | 1        | 将 owner 与 fixture tests 分开提交为两个完整 add-file patch，再通过 `pnpm check:pi-compatibility` 运行其 owner tests                                                            |
| Pi resource contract 代码迁出后首次组合门禁因 patch 在 span 替换行与保留行之间重复声明 `subagentPolicy` 而产生语法错误                                                 | 1        | 删除重复声明；直接重跑 `pnpm check:pi-compatibility` 和完整门禁，确认原合同组无丢失或重复输出                                                                                   |
| Pi resource owner 的数值常量解析遗漏 TypeScript `export const` 前缀，导致真实 compatibility manifest 将正确 worker 上限判为未同步                                      | 1        | 在共享常量解析器中接受 `export const`，并用真实 worker/Host source fixtures 和 root compatibility gate 复验                                                                     |
| progress.md 摘要 patch 使用上一版 #54 文案而未匹配当前 #55 重启行                                                                                                      | 1        | 先读取当前 summary，再按实际存在的句子更新；失败 patch 未修改计划文件                                                                                                           |
| 版本核对的一次性 Node 命令误将 Rust Cargo.toml 交给 `require()` 解析                                                                                                   | 1        | 改用 `rg` 读取三处版本声明；确认 `package.json`、Cargo.toml、Tauri 配置均为 `0.4.0-beta.2`，并确认当前分支是 `beta`                                                             |

| Pi resource numeric parser 的首次批量替换因源码 regex backslash 与 patch 文本转义不一致而未匹配，未改动文件 | 1 | 改为先按模块 marker 读取精确 source span，再以 apply_patch 生成替换；后续 gate 覆盖真实资源合同 |
| `task_plan.md` 新增 slice 记录后 Prettier 检查发现长表格行未对齐 | 1 | 运行 Prettier 格式化计划文件，再复验三个规划文档 |
| `agentSchedules` owner 首次 gate 的 Prettier 检查发现新增 fixture 未格式化 | 1 | 用 Prettier 格式化 owner tests 并重跑组合 gate |
| `agentSchedules` owner 首轮 fixture 断言误写了 schema replacement 后的 expected keys，且 parser fixture 把另一个顶层 field 留在清单之外 | 1 | 按 checker 的真实顶层字段结果修正 fixture 输入/期望；6 个 owner tests 和真实仓库 gate 通过 |
| 第五十八切片计划/错误摘要新增后 Prettier 再次发现 `task_plan.md` 表格排版差异 | 1 | 格式化计划文件，并重新执行规划文档与变更文件的 Prettier 检查 |
| 从 repository root 执行 `cargo fmt --check` 时未提供 Rust crate manifest path | 1 | 按仓库结构改用 `cargo fmt --manifest-path src-tauri/Cargo.toml --check`，格式验证通过 |
| model-policy owner directory-drift fixture 修改了文件名但没有修改目录，导致新增目录诊断的期望值不成立 | 1 | 让 fixture 同时把 Host 相对目录改为 `other`，重新运行 owner 与真实组合 gate |
| MCP 129-byte Host boundary regression 初次失败，证实 parser 在策略分类前静默丢弃长 tool id | 1 | 不抬高授权边界；保留超长 tool id 到 capability resolver，使整个 agent policy 进入既有 unsupported 诊断路径，再运行 Host/worker 边界测试 |
| 首次 `check:pi-compatibility` 因新 subagent-policy owner 未格式化而提前失败 | 1 | 对 owner 运行 Prettier，再执行六项 fixture tests 与真实 Pi compatibility checker |
| 一次 Prettier 检查误将 Rust `.rs` 源文件作为输入，导致无 parser 错误 | 1 | Prettier 只检查其支持的文档/JS/TS/JSON，Rust 文件单独用 `cargo fmt --check` 验证 |
| 对兼容 checker 的两段重叠 `sed` 输出误判为重复 module guard，随后的 patch 未匹配 | 1 | `apply_patch` 未改动文件；改用不重叠的行号窗口核验，确认源码只有一个 guard，丢弃该误报 |

| 错误                                                                                                            | 尝试次数 | 解决方案                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| 技能读取首轮误用了 MelodyWork 工作区目录，exec 未能启动                                                         | 1        | 统一改用当前 repo 绝对路径后并行读取 TDD、规划指引和 memory registry                           |
| 新增真实 Host retry source marker 后，Pi compatibility gate 两次未匹配 rustfmt 的全局参数换行/尾随逗号          | 2        | 将调用识别改为对合法空白与可选尾随逗号稳健的窄正则，再以真实 Host source 和 fixture tests 验证 |
| 恢复 planning session 时首次把 catchup 脚本路径写成仓库内不存在的 `.agents/skills/...`                          | 1        | 改用已安装的 planning-with-files-zh skill 脚本路径运行；没有未同步上下文报告                   |
| 更新待确认审计记录时 patch 使用了不匹配的 progress.md 旧摘要句                                                  | 1        | 精确读取当前重启摘要，再按实际行更新；失败 patch 未修改文件                                    |
| 待确认审计记录写入后 Prettier 检查发现 task_plan.md 表格排版差异                                                | 2        | 一次格式化后新增错误记录行仍需重排；统一运行 Prettier 后重新检查规划文档                       |
| 恢复 planning session 时将 Python catchup 脚本误交给 Node，产生 Python docstring 语法错误                       | 1        | 改用 Python 解释器运行正确路径；脚本报告无未同步上下文                                         |
| question-timeout owner 首次真实源码门禁未识别 rustfmt 换行的 `command.env` 环境变量调用                         | 1        | 将单一调用识别改为容忍合法空白的窄正则；fixture 与真实 Pi compatibility gate 均通过            |
| 首次 `pnpm check:pi-compatibility` 因新 web-tools fixture 未格式化而停止                                        | 1        | 对新增 owner 与 fixture 运行 Prettier 后重跑组合门禁；46 项 fixtures 与真实 checker 均通过     |
| memoryTools aligned fixture 首轮未提供 manifest 的 `persistentIndex.file`，owner 按预期报告 index filename 缺失 | 1        | 补齐 fixture 中独立于 source snapshot 的 `index.sqlite` manifest 字段，aligned test 通过       |
| 首次 memoryTools 组合门禁因新 owner 与 fixture 未格式化而停止                                                   | 1        | 对新增脚本和 fixture 运行 Prettier 后重跑组合门禁；53 项 fixtures 与真实 checker 均通过        |

### 第六十八切片新增错误记录

| 错误                                                                                    | 尝试次数 | 解决方案                                                                               |
| --------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| 异步确认问题首两次请求格式不符合工具 schema，未创建提问                                 | 2        | 改用受支持的 `questions` 对象格式；用户确认只核对 memory 六项与 web 四项 Host 数值边界 |
| 首次只读 manifest 盘点误取不存在的 `manifest.runtime` 字段                              | 1        | 改按清单真实结构读取 `manifest.hostBridges`，并通过共享数值 parser 核对 Host/manifest  |
| 第六十八切片规划文档组合 patch 两次因 Prettier 表格空格与上下文不一致而未匹配，均未写入 | 2        | 重读当前精确段落后改用更小的稳定标题 patch                                             |
| 第六十八切片新增 owner fixtures 首次组合门禁因格式未整理而停止                          | 1        | 对四个 owner/test 文件运行 Prettier 后重跑，55 项 fixture 与真实 checker 通过          |
| LSP 测试 seam 确认问题首次 async 调用误用 `question` 字段而被工具 schema 拒绝           | 1        | 改为 `title` 与 `options` 字段发送请求；用户确认后按同一 seam 完成 LSP fixtures        |

### 第六十九切片新增错误记录

| 错误                                                                                                          | 尝试次数 | 解决方案                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 首次将 LSP owner 缩回最小占位实现的 patch 因注释文本不匹配而未应用                                            | 1        | 读取实际 owner 后受控删除并重建，再按单测试→实现逐项补回行为                                                           |
| 新增 Host LSP config marker 检查时遗漏 `hostLspConfig` snapshot 解构，owner 测试出现 ReferenceError           | 1        | 补入对应 source snapshot 后重跑 9 个 owner fixtures 与真实组合 gate                                                    |
| LSP owner 初次导出 `{ policy, sources }` options API，与用户确认的双参数 seam 不一致；对应 drift fixture 失败 | 1        | 将 owner、fixture 与 aggregate caller 统一为 `checkPiLspCompatibility(policy, sourceSnapshots)` 后重跑全部 owner tests |
| 第七十切片测试 seam 的首个异步确认请求使用不受支持的 `question` 字段，被工具 schema 拒绝                      | 1        | 改用 `title` 与 `options` 结构重新发送；未进入代码或测试修改                                                           |

### 第七十切片新增错误记录

| 错误                                                                           | 尝试次数 | 解决方案                                                                     |
| ------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------- |
| 首个 TDD aligned fixture 在 owner 尚不存在时以 `ERR_MODULE_NOT_FOUND` 失败     | 1        | 按 red→green 提取原有检查为 owner；aligned fixture 及后续 6 个 fixtures 通过 |
| 规划文档 Prettier check 发现 `progress.md` 本轮新增行未格式化                  | 1        | 运行 Prettier 整理规划文件并在收尾复验                                       |
| Hooks seam 异步确认首次误传旧 `question` 字段，未符合 `title`/`options` schema | 1        | 按当前工具 schema 重发完整问题；问题已提交等待用户选择                       |
| planning table append 首次使用旧格式空格而未匹配                               | 1        | 读取 Prettier 当前对齐后的行，再按精确上下文更新并格式复验                   |

### 第七十二轮审计错误记录

| 错误                                                              | 尝试次数 | 解决方案                                                                |
| ----------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| Marketplace 模块清单用了不存在的 zsh glob 子目录路径              | 1        | 改由 `rg --files` 枚举实际 owner 路径，再读取对应源文件；未修改任何文件 |
| 请求确认 source-resolver 测试 seam 时误用已弃用的 `question` 字段 | 1        | 按当前工具 schema 改用 `title`/`options` 后重新提交，等待用户选择       |
| 本轮计划记录追加后 Prettier 检查发现 `task_plan.md` 表格排版差异  | 1        | 格式化 planning docs 并重跑三份文档的 Prettier check                    |

### 第七十一切片新增错误记录

| 错误                                                                                              | 尝试次数 | 解决方案                                                              |
| ------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| Landlock 移动补丁首次因结尾格式、目标可见性改写和空行上下文三处匹配问题未应用；未覆盖旧实现       | 3        | 以当前原始 source block 生成精确删除 hunk，确认完整移入后再接入父模块 |
| 局部 rustfmt 首次按 Rust 2021 edition 格式化 Rust 2024 crate，导致整 crate fmt check 报告格式差异 | 1        | 使用 edition 2024 仅格式化两个受影响文件，再通过整 crate fmt check    |

## 第六十二切片：终端与后台终端任务合同 owner（已完成）

- `scripts/pi-terminal-compatibility.mjs` 现拥有相邻的前台 terminalPolicy 与后台终端 task-registry 跨端合同检查；主 checker 继续读取实际 source snapshots 并汇总 diagnostics，不复制数值或 runtime logic。
- Owner 将 manifest 上限分别与 Host 绝对 timeout、配置 output bound、归档 preview cap、worker terminal schema timeout 比较，并要求 Host capture 对 output policy 执行 clamp；保留 config keys、environment overrides 与 Host route wiring 检查。
- 后台合同覆盖 Host/worker task ID prefix、Host registry active count 与调用点、Host Duration 和 gateway wait clamp、worker 三个 task-control schemas 的 wait bound、preview bytes、Host-owned process kill、四个 worker stop/failure cleanup call sites。
- 新增 7 个 fixture tests，覆盖 aligned contract 与上述各组漂移/断线。首次 owner test 先以缺失模块失败建立 red；fixture 名称修正后通过。实现过程一次 fixture patch context 未匹配（无写入），一次测试 regex 转义语法错误；均修复并由最终 owner/真实 gate 复验。
- 验证：terminal owner 7 passed；完整 Pi compatibility gate 36 passed；`pnpm check`、`pnpm check:architecture`（3）、`pnpm lint`、`pnpm format:check`、完整 unit 417 passed、`git diff --check` 通过。只改静态 checker/测试/包脚本/planning docs；无 Rust 或 worker runtime 变更，production build 未重跑。
- 本切片所见的 runtime 数值当前一致；修复的是此前没有从全部 owner 读取这些数值的 drift-check coverage gap，不代表观察到实际运行时漂移。

## 第六十三切片：PiWorkerRuntime dispatch acknowledgement ledger（已完成）

- 新增 `pi_worker_runtime/dispatch_ledger.rs`，统一拥有 pending prompt/request correlation、32 项上限、worker acknowledgement/error 投影、session config revision 与 generation cleanup；`PiWorkerRuntime` 继续拥有 process I/O 与 event acceptance，`schedule_dispatch.rs` 外部 outcome 消费接口不变。
- ledger owner tests 直接通过 `begin`、`observe_event`、`session_config_revision` 与 `clear_generation` 覆盖 `run.accepted` promptId 确认、`runtime.error` requestId 拒绝、opened/configured/imported revision 更新及清空、32 项容量和 teardown 的 `Unacknowledged` outcome。
- 实现前逐项以 red 建立测试：缺少 owner、requestId API/匹配、revision/clear API、33rd pending dispatch 分别失败；实现后 owner suite 4 passed。15 秒 ack timeout、write/error cleanup、真实事件持久化后观察的时序未改变。
- 验证：全 Rust library 310 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning；`cargo fmt --check`、Pi compatibility 36、architecture 3、`pnpm check`、`pnpm format:check` 与 `git diff --check` 通过。未改 worker/UI runtime，也未重跑 production build。
- 分支仍为 `beta`、三个 release version 仍是 `0.4.0-beta.2`；未 commit、push、publish 或 merge main。全仓结构债务治理继续进行，本切片不代表总目标完成。

## 第六十四切片：questionTimeoutPolicy 跨端门禁 owner（已完成）

- `scripts/pi-question-timeout-compatibility.mjs` 现拥有 questionTimeoutPolicy 的 Host/worker/manifest 合同核验；`check-pi-compatibility.mjs` 继续读取并传入 Host config/config wiring/resource manifest/worker launch/worker gateway/adapter snapshots，且保留原组合 gate。
- Owner 对比 manifest 上限与真实 Host/worker ToolGateway cap、Host 秒到毫秒 clamp、worker 环境策略与资源清单 parser 上限，并验证 Host projection→manifest→launch env→worker adapter→ToolGateway 的字段/变量接线。
- 新增 5 个 fixture tests，覆盖 aligned contract、Host cap/clamp drift、worker gateway cap/validation drift、worker environment/manifest parser bounds、Host/worker wiring drift。实跑源码初次发现 launch `command.env` 经 rustfmt 换行，checker 从过严字符串改为窄正则以兼容空白；真实仓库 gate 随后通过。
- 验证：Pi compatibility owner fixtures 总计 41 passed，真实 Pi compatibility 检查通过；`pnpm check`、完整 unit 417 passed、architecture 3、lint、format、`git diff --check` 均通过。只改 checker、fixture tests、package gate 与计划文档；runtime policy 行为未改，production build 未重跑。
- 此切片解决的是已有数值一致但 drift coverage 不全的问题，并非发现真实运行时上限不一致。

## 第六十五切片：子代理会话边界 owner（已完成）

- 将 bounded resume ID normalization、cwd canonical path/symlink containment、resume root/parent/status/selector-identity validation、interactive child scope 和 Host worktree response parsing 移至 `subagent-session-boundaries.ts`。`session-adapter.ts` 继续编排子代理启动/恢复时序，并通过原导出路径 re-export helper，保留现有调用面与错误码。
- 这些边界规则决定外部/持久 task identity 与 workspace path 是否能进入子代理 session；不负责 Pi session I/O，也不替代 `subagent-records.ts` 的 durable record schema/storage。
- 用户确认后，将对应行为测试迁至 owner 测试，并补齐 `type`、`role`、`persona`、`agent` selector identity 检查。另加 adapter re-export identity 测试，确认调用方看到的函数对象仍来自唯一 owner；没有改变 Host 授权或运行策略。
- `session-adapter.ts` 从 4,149 行降至 3,460 行；owner 322 行。验证：边界 owner 与 adapter targeted tests 35 passed，worker 164 passed，full unit 420 passed，Pi compatibility fixtures 41 passed 且真实 checker 通过，`pnpm check`、architecture 3、lint、format、production build 和 `git diff --check` 均通过。Build 保留既有 >500 kB chunk warnings。
- 首轮 worker typecheck 暴露移走 task-candidate type 后的未使用 `PiTaskStatus` import；已删除并复验。首次 targeted Prettier check 标记新 owner 文件，格式化后全门禁通过。
- 分支仍为 `beta`，三处 release version 仍为 `0.4.0-beta.2`；没有 commit、push、publish、merge 或同步 main。全仓治理目标仍在进行。

## 第六十六切片：webTools 跨端兼容门禁 owner（已完成）

- 将主 checker 内联的 webTools 合同检查迁入 `scripts/pi-web-tools-compatibility.mjs`；checker 继续读取源文件快照并聚合诊断，owner 不接触文件系统。读取 Host web runtime 也只在 manifest 声明该 bridge 时发生，保留原检查范围。
- Fixture 覆盖 manifest 工具名、worker Search/Fetch 参数 schema、Host `WEB_SEARCH`/`WEB_FETCH` 路由、Host HTTPS URL validator、bounded response body reader 与 search-output formatter marker；保留旧诊断和 no-policy 行为，不增加运行时或数值策略。
- 新增 5 个 owner fixtures。首次 red 因 owner 模块缺失（`ERR_MODULE_NOT_FOUND`）；新增 owner 后 aligned 和四类漂移 fixtures 全部通过。首轮组合 gate 仅因新增测试未格式化而停止，格式化后通过。
- 验证：`pnpm check:pi-compatibility`/`pnpm check` 中 46 项兼容 fixtures 通过且真实源码 checker 通过；完整 unit 420、architecture 3、lint、format、`git diff --check` 均通过。只改静态 checker、fixture tests、package gate 与计划记录；不需要重跑产品构建。
- branch 为 `beta`，`package.json`、Cargo 与 Tauri 版本仍统一为 `0.4.0-beta.2`；无 commit/push/publish/merge/main sync。全仓 structural-debt 目标继续进行。

## 第六十七切片：memoryTools 跨端兼容门禁 owner（已完成）

- 将主 checker 内联的 memoryTools 合同检查迁入 `scripts/pi-memory-tools-compatibility.mjs`。聚合 checker 继续读取 `pi_memory_runtime.rs`、store/search-index owners、config command、worker runtime/lifecycle 与工具 gateway snapshots，并负责聚合诊断。
- 7 项 fixtures 覆盖 manifest tool names、worker parameter schemas/Host routes、Host memory dispatch 与 Markdown store markers、runtime/store/index owner wiring、persistent SQLite index source/filename/rebuild/search route，以及 worker supervisor/lifecycle wiring。
- 首轮 aligned fixture 漏写 manifest 的 `persistentIndex.file`，owner 正确报错；补齐 `index.sqlite` literal 后通过。首轮组合 gate 仅因新增脚本格式失败，Prettier 后复验通过。
- 验证：兼容组合 gate 53 passed 且真实 source checker 通过；`pnpm check`、完整 unit 420、architecture 3、lint、format、planning-doc Prettier 与 `git diff --check` 均通过。只改 checker、fixture tests、package gate 与计划记录；无 runtime 修改，不需要产品构建。
- 当前仍为 `beta` / `0.4.0-beta.2`，没有 commit、push、publish 或 merge main。全仓结构债务治理持续进行。

## 第六十八切片：memoryTools 与 webTools 数值边界 drift checks（已完成）

- 在两个已独立化的 compatibility owners 中读取真实 Host numeric constants，并与同一份 manifest 中的 memory/web byte/count fields 精确比较；不复制运行时常量、不修改 manifest 或 Host/worker 行为。
- Memory 覆盖 `maxQueryBytes=2048`、`maxFileBytes=2097152`、`maxTotalBytes=67108864`、`maxFiles=512`、`maxOutputBytes=524288`、`maxNoteBytes=16384`；web 覆盖 `maxQueryBytes=2000`、`maxUrlBytes=4096`、`maxResponseBytes=10485760`、`maxFetchedTextBytes=524288`。真实 Host 当前值全部对齐。
- 新增两个漂移 fixtures；每个将相应 Host declarations 改为不匹配值并验证按字段产生诊断。worker schemas 中基于字符数的 `maxLength` 与 Host `.len()` 字节 bounds 不作为相同单位 cross-check。
- 验证：memory/web owners 定向 14 passed；`pnpm check:pi-compatibility` 与 `pnpm check` 的 55 项兼容 fixtures 和真实 checker 通过；完整 unit 420、architecture 3、lint、format、`git diff --check` 通过。仅静态 checker/fixtures/计划文档变化，无产品 runtime 修改，不需重跑 build。

## 备注

- 每个阶段完成后更新状态、findings.md 和 progress.md。
- 用户要求“所有”屎山治理；本计划覆盖全仓盘点，但一次性交付只在证据足够和验证完成的切片内宣称完成。

## 第七十三轮实施：Marketplace direct source resolver owner

- 已将 `parse_direct_source`、`detect_plugin_directory`、`resolve_direct_git_plugin_path` 与 `DirectPluginSource` 移入 `config_marketplace_plugin_source.rs` 的私有 `plugin_source` owner；Marketplace 安装/更新事务继续保留在 parent。
- owner-interface tests 覆盖 local path/#subdir、GitHub shorthand/branch/SHA、local 与 Git path traversal 拒绝、唯一 nested plugin 与多 plugin 歧义；不触发 clone，不改变安装事务或授权语义。
- 验证通过：owner 定向测试 8 项；`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`（317 项）、`cargo check --locked`、Rust formatting、`pnpm check:architecture`、`git diff --check`。
- 未覆盖真实 Git clone、桌面 UI 或 direct install command end-to-end；不将此 slice 表述为 Marketplace 全流程验收。

### 第七十三轮实施新增错误记录

| 错误                                                                                                      | 尝试次数 | 解决方案                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 只读枚举命令匹配了尚不存在的 `src-tauri/src/config_marketplace_native/` 子目录，zsh 报 `no matches found` | 1        | 回到实际根级 `config_marketplace_native.rs` 与现有 `config_marketplace_*.rs` 文件读取；新增 owner 目录尚未创建，无文件受影响 |
| 在仓库根目录运行 `cargo fmt --all -- --check`，因根目录无 `Cargo.toml` 而失败                             | 1        | 改用 `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` 指定 crate manifest                                   |
| 版本核验脚本对 `Cargo.toml` 使用 Node `require()`，因 TOML 不是 JavaScript 而失败                         | 1        | 将 Cargo manifest 作为文本读取并提取 `version`，JSON 配置仍按 JSON 解析                                                      |
| 规划文档 Prettier 检查发现新增错误表格未按列宽格式化                                                      | 1        | 运行 Prettier 格式化 `task_plan.md`，然后重跑文档检查                                                                        |

## 第七十四轮审计：Pi worker reader-loop seam 与 fixture gate

- Pi compatibility package gate 当前显式纳入全部 10 个 Pi checker owners/tests 与两个 standalone helper/tests；aggregate checker 导入 owners，CI 另运行 architecture gate。当前无测试漏入，不因名单较长直接替换为 shell glob。
- `PiWorkerRuntime::spawn_readers` 保留 frame→Host acceptance→durable persistence→renderer delivery→memory/dispatch/hooks/tool routing 的有序副作用；parent 仍需在读端故障/EOF 时清理 generation。此处是潜在深 module，但需先定义内部 adapter seam 与副作用顺序测试，禁止仅按 1,512 行规模拆出薄 reader wrapper。
- Marketplace source-resolver seam 已获批并完成为第七十三轮 implementation slice。下一个候选是 `read_prompt_file` 的私有 owner/interface tests；已按精确安全边界询问用户，等待确认前不迁动该安全敏感逻辑。`spawn_readers` 保留为后续候选，但必须先定义副作用顺序和可观察 adapter seam。保持 Pi-only 与 Host 权限裁决，beta-only，不改版本或发布状态。

### 第七十四轮审计新增错误记录

| 错误                                                                                | 尝试次数 | 解决方案                                                                 |
| ----------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `rg --files .agents .codex scripts` 引用了仓库中不存在的 `.agents` 与 `.codex` 目录 | 1        | 改用已安装 skill 的绝对路径及仓库内实际 `scripts` 路径读取；无文件受影响 |

## 2026-10-10：累积 beta 工作树复验

- 当前完整累计工作树通过 `pnpm check`、`pnpm test:unit`（420）、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm check:architecture`（3）、Rust library tests（317）、`cargo check --locked`、crate-wide `cargo fmt --check`、规划文档 Prettier 与 `git diff --check`。
- 当前证据确认静态/单元/前端构建与 Rust 编译门禁，不覆盖真实桌面操作、真实 Git clone、Linux Landlock enforcement 或跨平台 release/signing；这些限制不能作为已完成项目验收。
- 当前 branch 仍为 `beta`，三个版本字段均为 `0.4.0-beta.2`。阶段 3 仍 in progress；没有发布、提交、push 或 main 同步。

## 2026-10-10：Pi runtime 架构记录补充

- 复核 `docs/architecture-improvement-plan.md` 的历史结论后，发现“没有立即架构阻塞项”仅对应 2026-08-23 当时的五项改进，容易被误读为当前 Pi-only runtime 治理已结束。
- 在该文档追加 dated supplement：说明 Pi-only runtime 的 lifecycle/Host permission owners、内部实现 owners、跨端 compatibility owners 和 test seam 要求；将当前详细状态指向 `docs/architecture/pi-migration/README.md`、`handoff.md` 与兼容清单，不把行数/文件数下降当作验收。
- 在 async seam reply 到达前，本轮同步输入请求返回空答案；随后用户 item `584408713` 对先前 `prompt_file` 问题明确选择“按建议执行”，因此只在该获批范围开始 TDD slice。
- 一次版本核验命令把 TOML 误交给 Node `require()`，解析失败；随后直接读取 `package.json`、Cargo 与 Tauri 配置中的 version 行，确认均为 `0.4.0-beta.2`，无文件受影响。

## 第七十五切片：prompt-file owner 与路径策略测试（已完成）

- 用户在 item `584408713` 确认私有 `prompt_file` owner seam：只覆盖相对路径解析、目录 containment、越界/符号链接、文件类型/大小及文本限制；不读真实配置，不改变 inline fallback 或权限语义。
- 按 TDD 先在 owner interface 写相对文件读取/trim 测试，首次 targeted compile 因 owner 函数尚不存在而按预期失败；随后把 `read_prompt_file(base, raw)` 原实现迁入 `config_subagent_prompt_file.rs`，父模块仅改为调用该 owner。将 4096-byte 引用上限命名为 owner 内常量；canonical containment 与原拒绝/允许条件保持不变。
- 12 项定向 tests 覆盖相对文件、trim、base 内 `..` 与 symlink 允许、越界 `..` 与外逃 symlink 拒绝、绝对路径、目录、1 MiB 文件上限、32 KiB 文本上限、无效 UTF-8、非法控制字符和超长 path reference。
- 验证：12 项 owner tests、完整 Rust lib suite 329/329、`cargo check --locked`、crate-wide `cargo fmt --check`、`pnpm check`（71 compatibility fixtures 与真实 checker）、planning/doc Prettier、`git diff --check` 均通过；planning catchup 无未同步报告。未读真实 Melody 配置；`with_file_instructions` 的 fallback/合并和 manifest/permission 逻辑未改。
- 保持 `beta`、版本 trio `0.4.0-beta.2`；无提交、push、发布或 main 同步。全仓结构债务仍进行中。

## 第七十六轮审计：worker event acceptance owner 候选

- 当前 `spawn_readers` 混合 frame/JSON 读取、generation-scoped event acceptance、SQLite persistence-before-delivery、Session Projection 观察、dispatch acknowledgement、Hook observation、权限/tool routing 与 generation 失败清理；不按这段代码长度直接拆 reader wrapper。
- 更窄的可深模块候选是 `PiWorkerRuntime::accept_event` 当前拥有的 event-ID duplicate cache + worker epoch/sequence acceptance：定义 `EventAcceptanceState::accept(&Value) -> Result<AcceptedWorkerEvent, String>`，将 bounded cache/重复 payload 与协议状态放进独立 owner；runtime 仍拥有 generation lookup、`ready`/handshake one-shot、SQLite、renderer 和后续 routing。
- 现有覆盖只有纯 protocol metadata shape/monotonicity 与独立 dispatch ledger tests；未找到 `tauri::test`/MockRuntime/AppHandle test harness，也没有 acceptance+SQLite+emit 顺序测试。拟在纯 in-process acceptance owner 测 duplicate same payload、event ID payload conflict、epoch/sequence error、ready transition 与 bounded-cache eviction；不改 `spawn_readers` 副作用次序，SQLite 仍为超过内存 cache 窗口后的 duplicate authority。
- 新测试 seam 尚待用户确认；本轮只读审计，无新增测试或 runtime source edits。继续保持 Pi-only、Host authority、beta-only 和全目标 active。
- 提交 seam 问题时第一次误用 `question` 字段，工具按 schema 拒绝请求；随后改用 `title`/`options` 正确提交，没有产生状态变更。

## 第七十七轮审计：Browser session lifecycle seam

- 重跑 `pi_browser_runtime::tests` 得到 9/9；修正此前关于 tab/profile state 无测试的笔记。现有 owner tests 已覆盖纯 `BrowserTabIndex` 关键行为和 profile/bounds/security helpers。
- 真正未覆盖的是 `BrowserSession` 的 tabs/entries 与真实 WebView side effects 之间的 error ordering；关闭先更新内存索引再关闭 view，选择先更新 active id 再逐个应用可见性。未通过 adapter 注入复现平台失败，不将源码推断表述为已观察 bug。
- 深化候选需要同一个 session lifecycle interface 下的 Tauri 与 in-memory adapters，测试关闭/选择失败后的 state/effect consistency。尚未确认新测试 seam，本轮不改 runtime/tests；现有 URL/popup security callbacks、tool routing 与 Host authority 保持原 owner。
- 后续用户选择保留既有副作用顺序并测试；已在第九十一切片按获准 interface 实现，历史 failure semantics 与验证见该切片。

## 第七十八轮审计：Pi-only renderer transport

- 复核 app setting、hook/client route、bridge transport 与 Tauri command list：普通 Desktop 配置归一为 Pi，Pi 安全 preflight blocking/inspection error 不回退，Pi worker error 硬失败；browser preview 的 legacy-shaped traffic 是本地 deterministic fixture。
- 仍存在可选 `legacy-acp` client/session override，并保留向 Tauri invoke `send_acp`/ACP events 的 dormant branch；当前 command handler 无对应 ACP runtime commands。Pi compatibility gate 只断言 manifest fallback 声明，不验证 renderer transport route。当前无 agent-client/app-settings tests，尚无证据表明正常 Desktop default 实际进入 ACP。
- 候选测试 seam 是 Desktop route 永远 Pi、Pi failure/block 不降级、browser-preview fixture 保持、archive session 零 runtime transport；实现需先确认 interface，保留历史 ACP archive/import 格式，不碰 Host 权限裁决。

## 第八十轮审计：Host sandbox profile resolver

- macOS `workspace_sandbox::tests` 当前 7/7 通过，覆盖唯一 command path、fail-closed unsupported cases、profile path semantics 与 Seatbelt rule shape。当前只有 `aarch64-apple-darwin` Rust target，Linux Landlock integration 不在本机验证范围。
- Seatbelt renderer 本身过浅，不单拆；`sandbox_decision`、授权前置关系、terminal/monitor 共用 `sandboxed_shell_command` 留在 Host。profile resolution 是两个真实 enforcement adapters 共享的输入规则，可能成为独立深 owner。
- 方案候选 `resolve(SandboxProfileRequest) -> Result<Option<SandboxProfile>>`：显式注入 workspace、user/project config、home/state 与 temp path inputs，让 owner 负责 builtin/custom precedence、path canonicalization、deny/glob/network projection。须先确认 interface 与测试范围，确保不改变 User>Project precedence 和任何 fail-closed policy。

## 第八十一轮审计：macOS Seatbelt `read_only` 写权限偏差（已由第八十六切片处理）

- `SandboxProfile.read_only` 定义为 child 可读不可写；Linux Landlock 对这些路径只授予 `LANDLOCK_READ_ACCESS`。但 `seatbelt_profile` 在全局 `(deny file-write*)` 后，对每个 `read_only` 路径追加 `(allow file-write* (subpath ...))`。macOS 输出与 profile 语义及 Linux 对照实现不一致；这一 loop 在 `HEAD` 中也存在，不是最近 Landlock 移动造成的。
- `sandbox_decision` 在 macOS 将生成的 SBPL 作为 `/usr/bin/sandbox-exec -p` 参数。本轮只有源码证据，尚未声称真实子进程写入已复现。
- 当前环境的最小临时目录 `sandbox-exec` 探针返回 `sandbox_apply: Operation not permitted`，外层执行沙箱不允许嵌套执行 Seatbelt；因此本机不能据此验证平台执法。
- 测试面复核：现有 macOS `workspace_sandbox::tests` 对 Seatbelt 只检查全局 write deny、workspace path 与 device sink；custom `locked` fixture 只设置 `read_write`/`deny`，没有覆盖 `read_only`。主兼容 checker 的 Sandbox block 也只检查 wrapper、canonicalize、profile 拒绝和 preflight registration markers，不锁定具体 SBPL 权限规则，因此此偏差目前无直接回归保护。
- 补充审查发现：仅移除当前 `read_only` 写入 allow 仍不足以保护嵌套情形；若只读目录位于更宽的 `read_write` 子树中，父路径的 allow 仍可覆盖它。Linux 当前会对 read-only/read-write 任意 overlap fail closed。
- 用户明确选择跨平台 fail-closed：共享 Host 校验拒绝 read-only/read-write 的相等及任一方向重叠。第八十六切片通过既有 `sandbox_decision` seam 验证重叠 profile 被拒绝，并验证 Seatbelt 不再为 disjoint `read_only` 路径生成写 allow；真实 Seatbelt child enforcement 仍需具备可执行能力的 macOS acceptance 环境。

### 第八十一轮审计新增错误记录

| 错误                                                                                           | 尝试次数 | 解决方案                                                                                 |
| ---------------------------------------------------------------------------------------------- | -------: | ---------------------------------------------------------------------------------------- |
| 首次异步询问误用不支持的 `question` 字段，第二次重复提交 `title`，两次均未提交                 |        2 | 按工具 schema 仅用一个 `title` 表示问题正文、用 `options` 表示选择后提交成功             |
| 在外层受限环境中执行嵌套 `/usr/bin/sandbox-exec` 返回 `sandbox_apply: Operation not permitted` |        1 | 不将错误误读为规则拒绝；记录本地执法验证限制，提出以 Host 命令 payload 为待确认测试 seam |
| 规划记录补丁沿用了过期的 profile resolver 描述并连续匹配失败，未写入部分文件                   |        3 | 重新读取当前确切文本后分别提交小型补丁，三份规划文件均已追加并复核                       |
| 本轮首个多文件补丁因规划文本的上下文不匹配整体未写入                                           |        1 | 分别读取当前目标段并逐文件使用更窄上下文补丁；最终只新增验证缺口记录，未改 runtime/tests |
| 新增审计 bullet 后首次规划文档 Prettier 检查未通过                                             |        1 | 运行 Prettier 格式化 `task_plan.md`，随后三份计划文档格式检查与 `git diff --check` 通过  |

## 第八十二轮审计：Session Explorer 跨端合同覆盖缺口

- 只读核对 manifest、Pi worker fork handler、Host request/database path、renderer bridge 与现有测试；确认 `check-pi-compatibility.mjs` 没有消费 `hostBridges.sessionExplorer`，而完整桌面/failure-injection 验收仍未完成。
- 已有局部覆盖：`database_agent_forks` lineage/anchor/reference tests 2/2；`session-adapter.test.mjs` adapter suite 28/28，其中 persisted Explorer artifact recovery test 通过。没有把局部结果称为全链路行为验证。
- 记录纯 `checkPiSessionExplorerCompatibility(contract, sourceSnapshots)` fixture owner 候选，范围仅为声明/跨层接线 drift，不能代替真实 desktop E2E。新 seam 尚未确认，暂不新增测试/运行时变更。
- 继续核对发现 `explorer-branch.test.mjs` 已有 6 项纯行为覆盖（draft-only、显式展开、不可信 JSON 上下文和 12,000 codepoint 截断），且纳入 full unit manifest；当前 TS、Rust、兼容 manifest 三处 12,000 值一致，但没有 drift fixture。若获批，owner 应测试跨层声明与 wiring，不重复已有 domain behavior tests。
- 本轮其他异步 seam 仍待答复；继续保留 beta-only、Pi-only、Host 权限裁决及不发布/合并约束。

### 第八十二轮新增错误记录

| 错误                                                                                          | 尝试次数 | 解决方案                                                                 |
| --------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------ |
| 首次为三份规划文档组合追加第八十二轮发现时，task_plan.md 精确上下文不匹配，补丁未写入任何文件 |        1 | 分别核对每份文档实际末尾，再按精确当前内容独立追加并运行格式与 diff 检查 |
| 第八十二轮记录后首次 planning-doc Prettier check 标记 `task_plan.md` 排版差异                 |        1 | 格式化 `task_plan.md`，再检查三份规划文件与 diff                         |

## 第七十九轮审计：Pi child-session lifecycle

- 本机当前 `session-adapter.test.mjs` suite 28/28 通过。测试覆盖 lifecycle queue、`closeAll` child-task cleanup、task ownership/wait 与 persisted records；policy/resume trust owners 另有独立测试；未发现覆盖实际 subagent create/continue effect sequence 的 adapter-level test。
- 审查 `TaskHandle` map 引用后确认它横跨 root/child context、resource/model refresh、close/cancel、nested task tool callbacks、event projection 和 persistence。不能只把约 560 行 `spawnSubagent` 搬走；任何真正 `PiTaskRuntime` 都必须统一接管这些 map reader/writer 并定义 Pi session factory 与 Host tool/emitter/persistence adapters。
- 当前 owner 可能已经是处理 worker Pi protocol/lifecycle 的深模块；在没有小而高 leverage 的 child-session interface 证据前，不按 3,460 行行数再切分，不更改 Host authorization identity。

## 第八十三切片：MCP transport manifest drift owner（完成）

- 只读 crosswalk 显示 manifest 的 `hostBridges.mcpTransports` 列出 `stdio`、`http`、`sse`，但当前 Pi compatibility checker 没有读取该 key；`sessionExplorer` 也没有直接 checker 引用。MCP runtime 当前支持这些 transports，故这是合同 drift 检查缺口，不是已发现的运行时不匹配。
- Host `mcp_config.rs` 将 stdio/local、streamable HTTP aliases 与 SSE aliases 映射到稳定 transport kinds；`stdio_transport.rs` 拥有本地 stdio protocol，`remote_transport.rs` 拥有 HTTP/SSE protocol。Rust 已有 transport parser 和 server behavior tests，但这些局部行为测试不把实现与 compatibility manifest 对齐。
- 用户明确确认纯 source-snapshot owner fixture seam 后，新增 `scripts/pi-mcp-transports-compatibility.mjs` 并由主 Pi compatibility gate 调用；核对 canonical manifest set、Host parser variant mapping、local stdio normalization、runtime/module dispatch wiring、stdio command startup、remote HTTP request execution 与 SSE bootstrap。输入 aliases 仅作为 parser inputs，不扩展成 manifest canonical transport。
- 新增 8 项 source-snapshot fixture tests，覆盖 canonical set/duplicates、HTTP 与 SSE 错配、stdio 漂移、runtime dispatch 漂移、stdio owner 缺失以及 remote HTTP/SSE owner wiring；不改 runtime 或 authorization semantics。最终 `pnpm check:pi-compatibility` 为 79 项 fixtures + 实际 source checker，`pnpm check`、`pnpm format:check` 与 `git diff --check` 均通过。
- **状态：** complete；MCP transport 与 Explorer 是彼此独立的 contract/test gaps，不把它们塞入同一个 owner。

### 第八十三轮新增错误记录

- 首次规划文档 Prettier check 标记新增长表格行未对齐；本轮执行 `prettier --write task_plan.md` 后再做最终格式与 diff 检查。

| 错误                                                                                                 | 尝试次数 | 解决方案                                                    |
| ---------------------------------------------------------------------------------------------------- | -------: | ----------------------------------------------------------- |
| 首次 `request_user_input_async` 将问题正文放在不支持的 `question` 字段，工具拒绝请求且未产生状态变更 |        1 | 将问题正文放入 `title`，用 `options` 承载选择后成功提交     |
| 首次三文件组合 append 引用了旧的 child-session 段落而未匹配，整个 patch 未写入                       |        1 | 重读三份文档的当前末尾并分别按实际内容 append               |
| 首次 progress.md append 复用了 findings.md 末尾文本，因措辞不同而未匹配                              |        1 | 检查 progress.md 原文并按当前 Session Explorer 行追加       |
| 只读 manifest 交叉检索误用了仓库根路径，实际清单位于 `docs/architecture/pi-migration/`               |        1 | 使用 `rg --files` 找到真实路径后重跑，确认检查结果未变      |
| 更新第八十三轮验证计数后，规划文档 Prettier check 发现 `task_plan.md` 表格排版变化                   |        1 | 执行 Prettier 格式化并重验全部规划文档与 `git diff --check` |

## 第八十四切片：Pi-only renderer ACP bridge fail-closed（已完成）

- 当前 Desktop 默认设置为 Pi；加载持久值时旧 `legacy-acp` 会被归一成 Pi；归档会话在订阅 runtime 之前提前返回。正常 Desktop 路由因此是 Pi，但这不意味着遗留 ACP transport 调用面已从代码中消失。
- `melody-bridge-runtime.ts` 的非 Tauri 分支依赖确定性 ACP 预览 fixture，应继续保留；Tauri 分支仍包含 `send_acp` invoke 与 `melody://acp-message` / `melody://acp-stderr` event listeners。当前 Host `lib.rs` 未注册对应 ACP command，Host 当前源码也没有这些事件的 emit path；此为惰性/不可用 transport path，不应误报为默认 Desktop ACP runtime。
- 用户明确批准：仅在现有 bridge send/subscribe seam 收口 Desktop ACP transport；保留 deterministic browser preview fixture、只读 archive/import 和 Host authorization，不删除其余 legacy adapters。
- 按 TDD 新增 `src/lib/melody-bridge-acp.test.mjs`；首条 Desktop send 断言先因 owner 尚不存在而红。随后将 preview ACP fixture 与 send/subscribe 放入 `melody-bridge-acp.ts`，把 `isTauriRuntime` 放入无循环依赖的 runtime-context owner，旧 `melody-bridge-runtime.ts` 继续 re-export 原接口。
- Desktop `sendAcp`/`subscribeToAcp` 现在在任何旧命令或事件监听前以明确错误拒绝；ACP owner 不再依赖 Tauri `invoke`/`listen`。浏览器预览仍使用原确定性 fixture。只读归档、ACP→Pi import、会话路由与 Host permissions 未改。
- 修正 `agent-client.ts`、Pi event projection/store 与 bridge hook 的过时注释：Pi 是唯一 Desktop runtime；legacy ACP adapter 只用于预览，能力缺口由 Host 阻断或降级，不回退 ACP。
- 三项 bridge tests 覆盖 Desktop send fail-closed、subscribe fail-closed/无 invoke side effect、preview initialize fixture 完整响应。验证：定向 bridge tests 3/3、完整 `pnpm test:unit` 423/423、`pnpm check`（含 79 compatibility/permission fixtures）、`pnpm check:architecture` 3/3、`pnpm lint`、`pnpm format:check`、`pnpm build` 与 `git diff --check` 均通过；Vite 保留既有 >500 KiB chunk warnings。
- 当前工作仍在 `beta`，版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。阶段 3 与全仓结构债务目标仍在进行。
- **状态：** slice complete；其余未确认 seam 与全仓剩余热点另行审计，不因本 slice 完成而关闭总目标。

### 第八十四轮新增错误记录

| 错误                                                                            | 尝试次数 | 解决方案                                         |
| ------------------------------------------------------------------------------- | -------: | ------------------------------------------------ |
| `request_user_input_async` 首次提交使用了 schema 不支持的 `question` 字段       |        1 | 将问题完整放入 `title` 并按工具要求提交          |
| 第一版追加第八十四轮记录的补丁引用格式化前表格行，未匹配且没有写入              |        1 | 重读当前精确尾部后再以 section 边界追加          |
| TDD 新测试首次运行因 `melody-bridge-acp.ts` 尚未创建而报 `ERR_MODULE_NOT_FOUND` |        1 | 按预期 red 信号创建 owner 并运行测试             |
| 新 owner 首轮测试因 Node 无法解析 extensionless `preview-fixtures` import 失败  |        1 | 使用显式 `.ts` 相对导入，随后 targeted test 通过 |
| 新测试首次 Prettier check 不通过                                                |        1 | 格式化 test 文件并重验                           |
| ESLint 不认可裸 `setTimeout` 全局                                               |        1 | 改用 `globalThis.setTimeout` 并重跑 lint         |

## 第八十五切片：Pi Explorer workflow owner（完成）

- 只读审计确认 `AgentWorkspace` 虽仍较大，但 actions、layout、view 已有独立 owner，不按行数机械分拆。
- 下一候选是集中 renderer Pi Explorer 的 fork load/create/resume/bring-back 生命周期；`explorer-branch.ts` 继续只拥有纯数据格式，Host fork database 与 worker native replay 不移动。
- 用户批准以 `createPiSessionExplorer` 为公开 interface，依赖通过 production bridge/workspace/draft adapters 注入；测试用同一 interface 和 in-memory adapter。
- `AgentWorkspace` 现只组合 Explorer view callbacks/state；workflow owner 负责 load/create/resume/bring-back，保留持久化创建、fork、workspace 插入/激活、失败恢复与草稿写入顺序，Host fork/auth/replay 不变。
- 7 项 owner behavior tests 纳入 `pnpm test:unit`；最终 `pnpm test:unit` 430/430、`pnpm check`（79 compatibility/permission fixtures）、lint、architecture、build、format 与 diff check 均通过。
- **状态：** complete；全局长期可维护性目标仍处于阶段 3。

## 第八十六切片：sandbox `read_only` 跨平台 fail-closed（完成）

- 用户批准在 Host `sandbox_decision` 既有 command-plan seam 修复该安全偏差，并选择所有支持平台统一拒绝 read-only/read-write overlap。
- 按 TDD 先写 Seatbelt payload test；首轮红测证明生成器曾为只读路径输出 `allow file-write*`。移除该 allow 后，nested-overlap 测试的红测在当前 macOS checkout 中显示仍会返回 `Enforced`，父 read-write 子树覆盖只读子路径。
- `workspace_sandbox.rs` 现在在唯一 Host `sandbox_decision` 平台分派前检查规范化后的读写路径集；相等、只读为可写父目录的子树、可写为只读父目录的子树，以及与隐式设备写 sink (`/dev/null`、`/dev/pts` 等) 重叠的只读路径，都返回既有 `PlatformBroken` unsupported decision。Linux Landlock 删除重复 overlap 判断；Seatbelt 仅为显式 `read_write` 路径和 device sink 生成写 allow，`read_only` 路径依赖全局写 deny。
- 已增 3 项 Host tests：Seatbelt disjoint read-only path 无显式写 allow；`sandbox_decision` 对三种显式 overlap 关系和设备路径冲突 fail closed。TDD red/green 失败分别复现了 read-only allow、macOS nested overlap 和 `/dev` device sink 例外。
- 完整 Rust lib 332/332；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning，Rust fmt check、`pnpm check`（含 79 个 compatibility/permission fixtures）、`pnpm check:architecture`（3）、lint、format check 和 diff check 通过。Full Rust suite 有一条既有 sandbox 子测试打印外层 `sandbox_apply: Operation not permitted`，但整体通过；payload/string tests 不代表真实 Seatbelt 子进程执法验收。Linux Landlock 真实 child acceptance 仍需 Linux target/runner。
- 同步更新 Pi migration implementation-plan 中已过时的 sandbox 状态及 ACP 默认叙述：当前桌面为 Pi-only；不支持的能力 fail closed，不回退 ACP；ACP 保留范围为只读归档/导入与浏览器预览 fixture。
- 当前仍是 beta、三个版本均 `0.4.0-beta.2`；无 commit/push/publish/merge/main release。全仓结构性技术债务目标持续进行。

### 第八十六切片新增错误记录

| 错误                                                                               | 尝试次数 | 解决方案                                                                           |
| ---------------------------------------------------------------------------------- | -------: | ---------------------------------------------------------------------------------- |
| 首次 `request_user_input_async` 将问题正文放入不支持的 `question` 字段，请求未提交 |        1 | 按 schema 仅用 `title` 表示完整问题，再以 `options` 提交并收到明确策略选择         |
| 扩展 nested-overlap fixture 的 `apply_patch` 上下文与 rustfmt 后文本不匹配，未写入 |        1 | 重读实际代码片段后按精确文本重试，fixture 最终覆盖三种 overlap 关系                |
| 追加第八十六切片的组合补丁因 task_plan.md 尾部上下文不匹配而未写入任何文件         |        1 | 读取真实的第八十五切片尾部后使用精确锚点追加，并在结束前运行 Prettier 与 diff 检查 |
| 首次 planning-doc Prettier check 发现新增长表格行排版差异                          |        1 | 格式化 `task_plan.md` 后重验四份文档                                               |

## 第八十七切片：Agent Session delete orchestration 与 SQLite/runtime 依赖方向（完成）

- 调用图确认 `database_sessions.rs`、`database_projects.rs` 只因删除会话/项目而依赖 `PiWorkerRuntime` 和 Pi native artifact cleanup；`PiWorkerRuntime` 同时依赖 `database` 做 session/event persistence，造成 storage owners 向上依赖 runtime。
- 将 Tauri `delete_session` / `delete_project` handlers 移入 `agent_session_lifecycle.rs`，让该 Host use-case owner 组合 worker shutdown、native artifact cleanup 与 database purge；SQL 查询/事务 helper 保留在现有 database owners。`lib.rs` 改为注册新 module 的同名 commands，renderer-facing command names 不变。
- 仅按原代码顺序搬迁两个 handlers：Pi-bound worker shutdown 仍先于 artifact cleanup，cleanup 仍先于 SQLite deletion；project deletion 仍逐一跳过 ACP-only worker shutdown，artifact failure 仍阻止 database deletion。没有新增 tests 或改变 Host permission/data semantics。
- 验证：迁移前后 `database::` 定向 suite 均 55/55，完整 Rust lib 332/332；warning-free Cargo check、Rust fmt、`pnpm check`（79 compatibility/permission fixtures）、lint、`pnpm check:architecture`（3/3）、Prettier 和 `git diff --check` 均通过。
- 保持 `beta`、版本 trio `0.4.0-beta.2`；没有 commit、push、publish、release 或 main sync。该 slice 完成，全仓结构债务目标继续处于阶段 3。

## 第八十八切片：共享 Pi output archive owner（完成）

- 调用图确认 `pi_mcp_runtime` 仅为 `archive_tool_output` 与 `MCP_ARCHIVE_FILE_PREFIX` 反向依赖 `pi_tool_gateway`；该 archive implementation 实际同时服务 MCP 与 ToolGateway 的 terminal capture/workspace output reader，属于共享 Host owner。
- 将原 `pi_tool_gateway/tool_output_archive.rs` 提升为 `pi_tool_output_archive.rs`，并让 gateway、terminal/workspace owners 与 MCP 直接依赖该 shared module。MCP runtime 不再 import ToolGateway，ToolGateway 也不再为 MCP archive re-export 实现；archive path、命名、retention、大小上限、symlink refusal 与输出文本不变。
- Existing gateway/MCP suites 原位置保留、无新增测试：迁移前后定向结果分别 35/35、15/15；最终完整 Rust lib 332/332，Cargo check 无 warning、Rust fmt 通过。Pi terminal compatibility source path 已随 owner 更新；`pnpm check`（79 fixtures）、架构检查（3/3）、lint、format/Prettier 和 diff check 均通过。
- 当前仍为 `beta`，版本三处均 `0.4.0-beta.2`；没有 commit、push、publish、release 或 main sync。该 slice 完成，全仓结构债务目标仍在阶段 3。

### 第八十八切片新增错误记录

| 错误                                                                           | 尝试次数 | 解决方案                                                                            |
| ------------------------------------------------------------------------------ | -------: | ----------------------------------------------------------------------------------- |
| `pnpm check` 仍从旧 `pi_tool_gateway/tool_output_archive.rs` 路径读取 Host cap |        1 | 将已有 Pi terminal checker source path 和诊断路径同步到 `pi_tool_output_archive.rs` |
| 最终 `format:check` 报告 checker 的 Prettier 排版差异                          |        1 | 运行 Prettier 格式化该脚本并重跑完整检查                                            |

## 第八十九切片：Pi web response projection owner（完成）

- `pi_web_runtime.rs` 同处管理 Host config/SSRF policy、HTTP I/O、HTML→text 解析、bounded response text 与 Search citation projection；后两类逻辑是纯内容转换，不需接触凭据、URL 安全策略或网络 client。
- 将 `bounded_text`、HTML entity/text projection 和 Search result/citation projection 移入 `pi_web_runtime/projection.rs`；runtime 仍拥有配置读取、URL 校验、redirect 拒绝、credential/header 处理、HTTP response cap 与请求发送。现有 web tests 改为直接穿过 projection module interface，不增加新的行为 case。
- `MAX_SEARCH_OUTPUT_BYTES` 与 runtime policy clamp 仍由 root runtime 拥有并被 projection module 内部复用；HTML/text 与 citation 顺序、去重、UTF-8 truncation 和响应行为不变。
- 定向 `pi_web_runtime::tests` 5/5 通过；后续完整 Rust lib 336/336，warning-free Cargo check、Rust fmt 与最终规划/代码 map 格式检查通过。slice 完成，全仓结构债务目标仍在阶段 3。

## 第九十切片：PiWorkerEventAcceptance generation-local owner（完成）

- `PiWorkerRuntime::accept_event` 原来同时拥有 generation mutex/匹配、event-ID 精确 payload cache、epoch/sequence 接受状态及 runtime.ready handshake。用户确认了 `PiWorkerEventAcceptance::accept(&Value)` seam 和五类回归语义。
- 按 TDD 新建 `pi_worker_runtime/event_acceptance.rs` 测试；首次 targeted run 因接口尚不存在而红。随后 `PiWorkerEventAcceptance` 拥有 generation-local event ID/payload/epoch/sequence 检查和 4096 项 FIFO cache；重复 ID/相同 payload 在 sequence gate 前返回 Duplicate，重复 ID/不同 payload 拒绝，ephemeral cache 淘汰后的历史重放仍以 sequence error 交由 runtime reader 的 SQLite duplicate 仲裁处理。
- `PiWorkerRuntime` 继续持有 process/generation lock；`ready` 标志和 handshake 发送仍留在 runtime。reader 仍在投递前持久化；cache 不命中的历史重复依然调用 `persist_pi_event`，SQLite duplicate、unknown session、changed-payload 和 database errors 的结果仲裁未移动或弱化。protocol framing/command owner 不再拥有事件生命周期检查。
- 五项新测试覆盖首次接受/ready 标记、相同 payload duplicate、changed-payload rejection、epoch 与 monotonic sequence rejection、4096 项 FIFO 淘汰后把重放交给 sequence/SQLite 决策。Pi compatibility checker 已同步从 `protocol.rs` 改查 `event_acceptance.rs` 与 supervisor→acceptance/SQLite wiring。
- cache 仍按完整 Value 项数而非总字节数限制；此前估算的聚合内存风险没有在本 slice 中扩大到行为/上限变更，需作为独立资源策略审计项保留。
- 验证：`pi_worker_runtime::event_acceptance::tests` 5/5，Pi web 定向 tests 5/5，完整 Rust lib 336/336；warning-free `cargo check --locked`、Rust fmt、`pnpm test:unit` 430/430、`pnpm check`（79 compatibility/permission fixtures）、`pnpm check:architecture`（3/3）、lint 与 format gates 通过。
- 当前仍为 `beta`，三个 release files 保持 `0.4.0-beta.2`；未 commit/push/publish/release/main sync。Slice 89 和 90 完成，总体长期结构性技术债务目标仍持续进行。

### 第九十切片新增错误记录

| 错误                                                                      | 尝试次数 | 解决方案                                                            |
| ------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------- |
| TDD 首次定向测试因 `PiWorkerEventAcceptance` interface 尚不存在而编译失败 |        1 | 按预期 red 信号实现 acceptance module 和其状态拥有者                |
| 首轮实现 `accept_event` 仍返回旧 `EventAcceptance::New` unit variant      |        1 | 返回新 owner 的 `acceptance`（包含 ready-event 结果）并重跑定向测试 |
| `pnpm check` 的静态兼容 checker 仍要求 protocol.rs 中的事件校验函数       |        1 | 更新 checker 改为核对 acceptance owner 和 supervisor/SQLite wiring  |

## 第九十一切片：BrowserSessionLifecycle 与 WebView effect ordering（完成）

- Browser tab index 和 `BrowserEntry` map 原由 runtime 直接编排，WebView 创建/隐藏/显示/关闭副作用散落于三个 command path，无法通过同一 interface 观察失败后的 state/effect 顺序。
- 新增 `pi_browser_runtime/session_lifecycle.rs`：`BrowserSessionLifecycle<Entry>` 集中 tab cap、ID/index、entry ownership、open rollback、select state-first 和 close state-first；抽出的 `BrowserTabAdapter` 是 Tauri 与 in-memory adapters 共用的 interface。Tauri adapter 继续负责实际 WebView 创建/显隐/关闭，Host URL 校验、popup/preview policy、command 注册与 event emission 留在既有 runtime。
- 按用户选择保留当前副作用顺序：open 的创建失败移除 tab reservation（但 ID counter 仍前进）；select 先改变 active id，再按原 HashMap 遍历顺序应用 WebView effect，首个 effect 错误即返回且不回滚；close 先移除 entry/更新邻接 active id，再关闭 view，失败不恢复逻辑 state。`ensure_active_entry` 另保留 `pi_browser_open` 原先创建失败时留下 active reservation 的语义。
- 先添加 3 项 adapter-interface tests，首次 targeted compile 因生命周期 interface 尚不存在而 red；实现后覆盖 open-create rollback、close effect failure 后 memory state 已更新、select effect failure 后新 tab 仍 active。已有 Browser policy/page/screenshot/index tests 继续保留。
- Pi compatibility checker 新增 lifecycle owner marker 与 runtime→Tauri adapter/wiring 检查。验证：浏览器相关 Rust tests 15/15、完整 Rust lib 339/339、warning-free `cargo check --locked`、`cargo fmt --check`、`pnpm test:unit` 430/430、`pnpm check`（79 fixtures）、`pnpm check:architecture`（3/3）、lint、format check、build 与 `git diff --check` 通过。Vite 仍有原有 >500 KiB chunk warnings。
- 保持 `beta` 和版本 trio `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。第九十一切片完成，全仓长期结构债务目标仍在阶段 3。

### 第九十一切片新增错误记录

| 错误                                                                                             | 尝试次数 | 解决方案                                                                      |
| ------------------------------------------------------------------------------------------------ | -------: | ----------------------------------------------------------------------------- |
| TDD 首轮 lifecycle tests 因 `BrowserSessionLifecycle`/`BrowserTabAdapter` interface 不存在而失败 |        1 | 按批准 interface 实现 lifecycle owner 与 adapter                              |
| generic lifecycle 的派生 `Default` 错误要求 `Entry: Default`                                     |        1 | 手写不约束 Entry 的 `Default` implementation 并重跑 tests                     |
| runtime 重构后 snapshot 路径仍直接访问 lifecycle 私有 `entries`                                  |        1 | 改用 lifecycle `entry_mut` interface 并重跑完整 Rust tests                    |
| lifecycle cap owner 调整补丁上下文不匹配                                                         |        1 | 按 rustfmt 后准确 import 顺序重读并移动 `MAX_BROWSER_TABS` 到 lifecycle owner |

## 第九十二切片：Pi resource manifest composition root（完成）

- 调用图确认 `config_extensions.rs` 的 resource child 依赖 `config_extensions` 读取资源，而该 owner 又需要 subagent policy 的 plugin roots；把完整 Pi manifest 放在 resource child 会让扩展资源 owner 反向依赖兄弟 `config_subagents` owner。
- 用户批准将完整组合上移到既有 `config_runtime::pi_resource_manifest`。`config_pi_resources.rs` 现在只生成 skill/prompt roots 与 `respectGitignore` 部分；runtime facade 按原顺序加入 `subagentPolicies`、可选 `questionTimeoutPolicy`、可选 `goalPolicy`。调用方仍经 `config_runtime::pi_resource_manifest`，manifest 字段与 Host/worker contract 不变。
- `check-pi-compatibility.mjs` 现在确认 resource owner 不再依赖 `config_subagents`，且 runtime facade 保有组合责任。Browser lifecycle 的新失败测试在全量运行时暴露了既有的 HashMap iteration-order 假设；仅调整断言以接受原有 map 遍历的合法顺序，同时验证目标 effect 失败及 active id 保留，不改变生产行为或固定 effect 次序。
- 验证：既有 resource/subagent Rust suites 与完整 Rust lib 339/339；warning-free `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib`、Rust fmt、`pnpm check`（79 compatibility/permission fixtures）、`pnpm check:architecture`（3/3）、`pnpm test:unit`（430/430）、lint、format、build 和 `git diff --check` 均通过。Vite 仍显示既有 >500 KiB chunk warnings。
- 当前为 `beta`、release version trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。第九十二切片完成，但全仓结构治理仍继续。

### 第九十二切片新增错误记录

| 错误                                                                                       | 尝试次数 | 解决方案                                                                  |
| ------------------------------------------------------------------------------------------ | -------: | ------------------------------------------------------------------------- |
| `request_user_input_async` 两次参数分别含不支持的 `question` 字段和重复 `title`            |        2 | 将单一完整问题放入 `title`，schema 符合后获得用户对精确 seam 的批准       |
| 首版兼容 checker 补丁命中 context failure 后已有 hunk 留下，后续修复引入重复 path/变量声明 |        1 | 检查实际文件，删除重复声明与重复读取，格式化后重跑完整兼容 gate           |
| 全 Rust 首轮运行因 Browser lifecycle test 固定了 `HashMap` 未承诺的迭代顺序而 338/339      |        1 | 保持生产 map 遍历，只让 test 校验失败目标、active id 和允许的 effect 集合 |
| Browser test 断言修改后首次 `cargo fmt --check` 发现 rustfmt 排版差异                      |        1 | 运行 `cargo fmt` 后重跑完整 Rust suite 和最终格式检查                     |

## 第九十三切片：Hooks compatibility contract owner（完成）

- 用户确认纯 `checkPiHooksCompatibility(policy, sourceSnapshots)` seam 后，抽取总检查器原有 Hooks cross-end contract；主 checker 继续拥有文件读取与错误汇总，Hook runtime、执行、安全/权限裁决均未改变。
- 新 owner 保留原有 Host runtime markers、config 清单预检、Host worker routing/lifecycle wiring、诊断文本，以及 manifest 对 `MAX_HOOK_FILES`、`MAX_HOOKS_TOTAL`、`MAX_HOOK_FILE_BYTES`、`MAX_HOOK_COMMAND_BYTES`、`MAX_HOOK_INPUT_BYTES`、`MAX_HOOK_OUTPUT_BYTES`、`MAX_HOOK_TIMEOUT_MS` 的七项比较；manifest 不含 hooks 时保持 no-op。
- 新增 7 项纯 source-snapshot fixtures，覆盖 aligned contract、Host marker/config/worker routing 缺失、七项上限 drift、unsupported numeric expression fail-closed 与 no-policy no-op。首轮测试在 owner 文件尚不存在时按预期报 `ERR_MODULE_NOT_FOUND`；随后实现后转绿。
- `package.json` 的 `check:pi-compatibility` 已纳入新 owner/测试的 Prettier 与 Node test 命令。验证：Hooks 定向 tests 7/7、聚合 compatibility/permission tests 86/86、`pnpm check`、`pnpm check:architecture` 3/3、`pnpm test:unit` 430/430、lint、format check、production build、完整 Rust lib 339/339、warning-free Cargo check、Rust fmt 与 `git diff --check` 全通过。Vite 仍提示既有 >500 KiB chunks。
- 保持 `beta` 和 release version trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。此 slice 完成，全仓结构治理仍在阶段 3。

### 第九十三切片新增错误记录

| 错误/预期信号                                                                   | 尝试次数 | 解决方案                                                                                   |
| ------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------ |
| 首轮 Hooks owner fixture 因目标 module 尚不存在而报 `ERR_MODULE_NOT_FOUND`      |        1 | 按 TDD 预期 red 实现 owner，再重跑全部 fixtures                                            |
| 版本核对的一次性 Node 命令误将 `Cargo.toml` 交给 `require()` 当 JavaScript 解析 |        1 | 改为 `readFileSync` 读取 TOML 文本后提取版本；branch、版本 trio 和 diff check 随后核验通过 |
| `request_user_input_async` 首次把完整问题放入不支持的 `question` 字段           |        1 | 按工具 schema 将问题放入 `title` 重发；Session Explorer 语义选择已提交                     |

## 第九十四切片：SessionAdapter 使用任务合同的真实 owners（完成）

- `session-adapter.ts` 原从 `tool-gateway.ts` aggregator import `PiTaskController`、`PiTaskSnapshot`、`PiSubagentCapabilityMode` 与 `PiSubagentIsolation`。这些 type-only contracts 实际分别归 `task-tools.ts`、`tool-access-policy.ts` 和 `subagent-policy.ts`；从聚合入口导入使内部实现依赖方向掩盖了定义所有权。
- 将内部 type imports 直接改到定义者；`tool-gateway.ts` 的现有 re-export 保持不变，供既有 consumer/public paths 使用。无 runtime code、wire contract、security decision 或执行顺序变化；无需新增行为测试。
- 验证：worker suite 164/164、`pnpm test:unit` 430/430、`pnpm check`（86 compatibility/permission fixtures）、lint、format check、build 与 `git diff --check` 全通过。Vite 仍有既有 >500 KiB chunk warnings。
- 保持 beta-only 与 Pi-only/Host authority 边界；第九十四切片完成，全仓结构治理仍在阶段 3。

## 第九十五切片：Subagent resume boundary 直接依赖 task status owner（完成）

- `subagent-session-boundaries.ts` 仅为 `PiTaskStatus` 从 `tool-gateway.ts` 聚合入口导入 type；类型的实际定义 owner 是 `task-tools.ts`。
- 将 type-only import 改为直接引用 `task-tools.ts`。未改变类型、runtime imports、gateway 的兼容 re-export、task continuation policy 或 Host authority；没有新增行为测试。
- 验证：worker tests 164/164、worker TypeScript build、architecture gate 3/3、Prettier 与 `git diff --check` 通过。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。此小切片完成，全仓结构目标仍在阶段 3。

## 第九十六切片：Config write core 与 Pi refresh orchestration 解耦（完成）

- `config_core.rs::update_melody_config` 为配置写入后的 best-effort model/resource refresh 直接依赖 `PiWorkerRuntime`，把 TOML/storage owner 与运行时编排耦合在同一模块。
- 将 Tauri command 的 Host workspace authorization、model-change detection 与 Pi refresh orchestration 上移到现有 `config_runtime.rs` facade；`config_core.rs::update_melody_config_inner` 继续拥有配置解析/写入。保持 renderer command 名、permission、写入后 model refresh（仅模型字段变化时）、resource refresh、错误忽略和结果返回顺序。
- 验证：完整 Rust lib tests 339/339、warning-free Cargo check、`cargo fmt --check`、`pnpm check:pi-compatibility` 86/86 与 `git diff --check` 通过。未新增测试或更改运行时策略。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。此 slice 完成，全仓结构目标继续。

## 第九十七切片：Pi Explorer bring-back 语义与兼容清单对齐（完成）

- 用户选择保留分支引用语义：`PiSessionExplorer.bringBack` 仍在 ready 分支存在锚点后 assistant 结果时，将显式 `&session:<branch-id>` 引用追加到 source-session-keyed 草稿；写入失败不切换源会话，也不自动提交。
- 将 manifest 的 `bringBackMode` 更新为 `explicit-branch-session-reference-appended-to-session-keyed-local-draft`，删除仅适用于结论正文投影的 `bringBackMaxCodepoints`。
- `appendExplorerConclusionToDraft` 与其 codepoint cap 没有产品调用点，删除该死代码及三项仅测试它的用例；Explorer owner integration test 继续验证实际分支引用、草稿写入失败和源会话选择顺序。
- 验证：Explorer 定向 tests 10/10、完整 `pnpm test:unit` 427/427、`pnpm check`（86 compatibility/permission fixtures）、lint、format check、production build、完整 Rust lib 339/339、warning-free Cargo check、Rust fmt 与 `git diff --check` 通过。Vite 保留既有 >500 KiB chunk warnings。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；没有 commit/push/publish/release/main sync。全仓结构治理仍在阶段 3。

### 第九十七切片新增错误记录

| 错误                                                           | 尝试次数 | 解决方案                                                                  |
| -------------------------------------------------------------- | -------: | ------------------------------------------------------------------------- |
| 删除死代码后 Prettier 检查发现两个 Explorer 源文件尾部多余空行 |        1 | 对两个目标文件运行 Prettier，再重跑 format check 与 diff whitespace check |

## 第九十八切片：共享插件 agent 文件扫描（完成）

- `load_plugin_agent_definitions` 与 `collect_plugin_agent_definition_inventory` 原分别遍历 enabled plugin agent roots、执行有界 Markdown path scan 并解析 definition，可能让 worker manifest 和 Settings 将同一文件归为不同 scope/path/support 状态。
- 新增私有 `visit_plugin_agent_definitions` 流式内部接口，共享 bounded path enumeration、解析和 scope/plugin/path provenance；Pi manifest 仍输出 qualified name 并仅在 bare name 空闲时添加别名，Settings inventory 仍只暴露 qualified plugin name。处理逐文件消费，不把所有 parsed prompt bodies 聚合进临时 `Vec`；不加新 standalone module 或 Tauri/manifest 行为。
- 新增测试覆盖确定性路径顺序、scope/plugin/path provenance 和 supported/unsupported 分类；既有 plugin manifest alias 测试继续验证 Pi-facing shadowing semantics。
- 验证：新 targeted test 1/1、完整 Rust lib 340/340、warning-free Cargo check、Rust fmt、`pnpm check`（86 compatibility/permission fixtures）、lint、format check、`git diff --check` 通过。Rust-only 改动，未重跑前一切片的 TypeScript unit/build。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。阶段 3 与全仓结构目标继续。

### 第九十八切片新增错误记录

| 错误                                                                                              | 尝试次数 | 解决方案                                                                        |
| ------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------- |
| plugin scan fixture 将 `tools: [Bash]` 预期为 unsupported，但 Bash tool list 已有精确能力上限映射 |        1 | 改用动态 `hooks` 字段验证 unsupported parse status，并重跑 targeted test        |
| 改用 `hooks` 后 targeted test 暴露旧 expected 仍为 `tools`                                        |        1 | 将期望值同步到 parser 输出的 `hooks` unsupported field，随后重跑 targeted test  |
| 一次只读检查误填 workspace 路径，进程未启动                                                       |        1 | 改用环境提供的准确 `/Users/lhy/Project/Client/grok/MelodyWork` 路径继续只读审计 |

## 第九十九切片：Subagent Markdown parser tests 回归实现 owner（完成）

- `parses_safe_markdown_agent_definitions_and_rejects_dynamic_fields` 与 `tolerates_real_world_frontmatter_and_maps_tool_lists` 只调用 parser，原先留在承担来源优先级/manifest/Settings orchestration 的 `config_subagents.rs` 测试模块。
- 将两项 parser contract tests 移入 `config_subagent_markdown.rs::tests`；parent 继续拥有 TOML/Markdown/plugin inventory、scope precedence、manifest 与 plugin-name integration tests，避免为了测试移动而改变生产接口。
- `config_subagents.rs` 从 1,212 行降至 1,128 行；`config_subagent_markdown.rs` 为 687 行，新增的测试与解析/能力上限实现同一 owner 就近维护。
- 验证：parser owner tests 2/2，完整 Rust lib 340/340、warning-free Cargo check、Rust fmt、`pnpm check`（86 compatibility/permission fixtures）、lint、format check、`git diff --check` 通过。Rust-only 测试移动，无需重跑前一切片的 TS unit/build。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。整体阶段 3 持续进行。

## 第一百切片：Subagent record tests 回归持久化 owner（完成）

- `validates durable subagent records before reopening a transcript` 虽位于 `session-adapter.test.mjs`，实际只调用 `subagent-records.ts` 的 path/parser/save/load 接口，不创建或驱动 `PiSessionAdapter`。将原 test 原样移至 `subagent-records.test.mjs`，没有增删断言或扩大 seam。
- 在 worker suite 与 root `test:unit` manifest 中显式登记 owner-local test；session adapter suite 继续覆盖它实际拥有的 runtime/lifecycle behavior。`handoff.md` 同步描述测试 owner。
- 验证：owner 定向测试 1/1、`pnpm test:agent-worker` 164/164、`pnpm test:unit` 427/427、`pnpm check`（86 compatibility/permission fixtures）、lint、format check 与 `git diff --check` 通过。只移动现存测试和更新 test manifests，未改 runtime/产品行为，无需 production build。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。阶段 3 与全仓治理目标仍继续。

## 第一百零一切片：ToolGateway direct owner tests 回归职责模块（完成）

- `tool-gateway.test.mjs` 中五个用例直接调用 `task-results.ts`、`tool-permission.ts` 与 `tool-access-policy.ts`，不经过 `PiToolGateway`。分别迁入 `task-results.test.mjs`、`tool-permission.test.mjs` 与 `tool-access-policy.test.mjs`，原 assertions 保持不变。
- gateway suite 继续保留 alias/re-export characterization、schema/catalog、createTools、pending request lifecycle、Host interaction dispatch、browser/scheduler/monitor integration；没有移走 Gateway 组合路径或 Host authorization boundary tests。
- 两个执行入口均显式登记三个 owner-local suites。验证：新 owners + gateway 定向 32/32，`pnpm test:agent-worker` 164/164、`pnpm test:unit` 427/427、`pnpm check`（86 compatibility/permission fixtures）、lint、format check 通过。只移动现存测试/更新清单，无 runtime code change，因此没有重跑 production build。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。阶段 3 与全仓目标仍继续。

## 第一百零二切片：MCP 解析与传输测试回归实现 owner（完成）

- 将只直接验证 `mcp_config.rs` 的 2 项解析测试、`stdio_transport.rs` 的 2 项 stdio connection 测试，以及 `remote_transport.rs` 的 8 项 HTTP/SSE policy/connection 测试从 `pi_mcp_runtime.rs` 父 test module 移入对应 owner；既有断言语义不变。
- 父模块只保留结果文本 projection、MCP output archive 与 `PiMcpRuntime::stop_workspace` 取消测试；后者实际覆盖跨 connection 的 Host workspace 生命周期。
- 验证：MCP owner/runtime 定向 16/16，完整 Rust lib 340/340，warning-free Cargo check，Rust fmt，`pnpm check`（86 compatibility/permission fixtures）、lint、format check 和 `git diff --check` 全通过。只改 Rust test ownership/文档，未改产品运行时代码。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。全仓结构治理继续处于阶段 3。

### 第 102 切片工具调用错误记录

| 错误                                                                                     | 尝试次数 | 解决方案                                                      |
| ---------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------- |
| 首次将 patch 文本直接放入 JavaScript 执行体，导致 wrapper 解析失败；尚未应用任何文件修改 |        1 | 通过 `tools.apply_patch` 以字符串参数提交补丁，随后执行和验证 |

## 第一百零三切片：Marketplace 直接测试回归职责 owner（完成）

- 将只调用 `marketplace_catalog` 的 2 项相对路径/插件扫描测试、只调用 `marketplace_registry` 的 2 项 provenance/path-containment 测试，以及只调用 Git transport SHA validator 的 1 项测试移入对应 owner test modules。现有测试断言保持不变；catalog test 仅改用 owner-local `super::` 路径。
- Native install/update compatibility、local candidate install/refresh 与 update-message projection tests 仍留在 command/orchestration parent。
- 验证：marketplace 定向 22/22，完整 Rust lib 340/340，warning-free Cargo check，Rust fmt，`pnpm check`（86 compatibility/permission fixtures）、lint、format check 与 `git diff --check` 全通过。仅调整已有 Rust tests/文档，未改产品运行时代码。
- 保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。全仓结构治理继续处于阶段 3。

### 第 103 切片新增错误记录

| 错误                                                                                                        | 尝试次数 | 解决方案                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | -------: | ----------------------------------------------------------------------------------------------------- |
| catalog owner 测试以 `use super as ...` 导入模块时编译失败；同一编译还报告 registry test 中未使用的 `Value` |        1 | 改为 `super::validate_relative_path` 直接访问 owner，并移除未使用导入后重跑 targeted/full Rust suites |

## 第一百零四切片：Pi extension policy/resource 测试回归 owner（完成）

- 将 `sandbox_profile_precedence_is_process_override_then_config` 移入 `config_pi_policy.rs`；将 Skill ignore prefix/native scan 和 Plugin Skill root ignore behavior 两项测试移入 `config_pi_resources.rs`。断言与既有行为保持不变。
- 移除 `config_extensions.rs` 中不再使用的 policy test import 和 `pi_skill_ignore_paths`/`pi_skill_scan_roots` test-only re-exports；保留 config runtime 及其余扩展测试所需的 resource exports。
- 保留 PluginEnablement、插件目录扫描/优先级、声明式组件与 extension opt-out tests 在 `config_extensions.rs`，因为它们覆盖该模块拥有的 inventory/enablement 组合语义。
- 验证：config extension 相关 tests 11/11，完整 Rust lib 340/340，warning-free Cargo check，Rust fmt，`pnpm check`（86 compatibility/permission fixtures）、lint、format check 和 `git diff --check` 全通过。仅调整 Rust tests 与 test-only exports，未改产品运行时行为。
- 保持 `beta` 和 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。全仓治理继续处于阶段 3。

### 第 104 切片新增错误记录

| 错误                                                                                                                             | 尝试次数 | 解决方案                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------- |
| 资源 owner 测试依赖 parent-only `make_plugin` fixture helper，targeted compile 未能解析；并报告两个测试专用 re-export 已无调用方 |        1 | 在 resource owner test module 内增加本地 fixture helper，移除不再使用的 parent test-only re-exports 后重跑 targeted/full suites |

## 第一百零五切片：附件解码与模态策略 owner（完成）

- 候选 seam 仅拥有纯附件规则：模型输入模态判断、单项/批量 byte ceilings 和有界 data URL 解码；turn snapshot 校验、幂等声明和消息构造继续留在 `PiSessionAdapter`。
- 用户已选择保留 `session-adapter.ts` 的既有导出作为测试接口，因此不新建 owner-local test seam；现有 helper 测试断言不变，通过 adapter compatibility exports 覆盖 owner behavior。
- 将 model input modality policy、单附件有界 data URL decode 和对应 byte ceiling 搬到 `attachment-policy.ts`；session adapter 只 import 运行时所需 helper 并保留兼容 re-exports。原有 adapter helper tests 不变并继续穿过旧调用面；turn total-byte accumulation/order、idempotency 与消息拼接仍归 runtime。
- 验证：adapter tests 27/27、worker 164/164、完整 unit 427/427、`pnpm check`（86 compatibility/permission fixtures）、lint、format check、production build 和 `git diff --check` 全通过。生产构建仅报告既有 >500 kB chunk warnings。
- 保持 `beta` 与 release version trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。阶段 3 继续。

### 第 105 切片与后续候选审计工具错误记录

- 后续 turn-policy patch 字符串未转义 JS 模板语法，执行体解析失败，未触碰仓库文件；本轮只完成已验证的 attachment owner slice。
- 追加工具错误表格行时格式上下文未匹配；改为在该表前记录说明，不影响已有记录或源文件。

| 错误                                                       | 尝试次数 | 解决方案                                                  |
| ---------------------------------------------------------- | -------: | --------------------------------------------------------- |
| 首次 append findings patch 的末尾上下文与实际文件行不匹配  |        1 | 读取真实尾部并改用唯一 section heading 作为补丁锚点       |
| 第二次 findings patch 仍误抄 validation 行内容，未应用修改 |        1 | 停止重复猜测整行，改为围绕短且唯一的 section heading 插入 |
| 异步用户澄清工具调用字段误用，问题未发送                   |        2 | 按工具 schema 提交 title/options 后成功收到用户选择       |

## 第一百零六切片：Pi turn policy owner（完成）

- 将 reasoning/session-mode normalization、turn config snapshot validation、active-run/steer guard 和 cancel identity guard 移至无 session dependency 的 turn-policy owner。
- session adapter 只 import 其实际使用的 policy functions，并 re-export 既有测试/调用入口；session opening/config application/refresh ordering 与 lifecycle state unchanged。未新增或修改 assertions/tests。
- 验证：adapter tests 27/27、worker 164/164、full unit 427/427、pnpm check（86 compatibility/permission fixtures）、lint、format check、production build 和 git diff --check 全通过。构建只有既有 >500 kB chunk warnings。
- 仍在 beta，release version trio 0.4.0-beta.2；无 commit/push/publish/release/main sync。全仓治理阶段 3 继续。

### 第 106 切片工具错误记录

| 错误                                                                                          | 尝试次数 | 解决方案                                         |
| --------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------ |
| 首次版本核验命令因 zsh unmatched quote 失败，未修改文件                                       |        1 | 改用独立 shell-safe 查询重验三份 release version |
| 首轮多文件文档 patch 因 JavaScript 模板字符串中的 Markdown 反引号未转义而解析失败，未修改文件 |        1 | 对模板字面量中的反引号显式转义后重试             |

## 第一百零七切片：Pi 原生会话持久化策略 owner（完成）

- `session-persistence-policy.ts` 拥有确定性、opaque 的 native-session filename derivation，以及持久化 fork 与来源路径/leaf anchor/entry 三项匹配规则。
- `PiSessionAdapter` 仍保留 `piSessionFileFor` 的兼容导出与 `assertPiForkTargetMatches` 的 `pi.fork_target_mismatch` 错误映射；两项既有行为测试继续穿过 adapter seam。没有新增测试入口或调整断言。
- 没有改变 session root 选择、文件名输入、JSONL 生命周期、fork 创建/恢复时序或错误 code/message/scope；Host authorization 与 Pi-only runtime 不变。
- 验证：两项相关行为测试 baseline 2/2、adapter 27/27、worker 164/164、full unit 427/427、`pnpm check`（86 compatibility/permission fixtures）、architecture gate（3/3）、lint、production build 与 `git diff --check` 通过。Build 保留既有 >500 kB chunk warnings。
- 当前仍为 `beta`，版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。阶段 3 和全仓治理继续。

### 第 107 切片工具错误记录

| 错误                                                                       | 尝试次数 | 解决方案                                  |
| -------------------------------------------------------------------------- | -------: | ----------------------------------------- |
| 首次补丁字符串在 JS 模板语法处解析失败，未修改文件                         |        1 | 改用逐行字符串数组构造 patch              |
| 完整注释锚点与源码 apostrophe 不匹配，组合补丁未应用                       |        1 | 核对原文并采用独立文件新增/精确函数替换   |
| 合并 hunk 将未修改的导出声明误作 patch 行，补丁未应用                      |        1 | 校正 hunk 标记并拆分编辑                  |
| 首轮局部 Prettier check 检出 adapter import 排版问题                       |        1 | 格式化受影响 TS 文件并重验                |
| handoff 文档同步补丁的中文句末标点未匹配原文，整组文档更新未应用           |        1 | 重新读取精确段落并把文档逐个拆开修改      |
| architecture plan patch 把 Markdown 列表符当作 hunk 前缀，文档组补丁未应用 |        1 | 将列表符写入 context 内容并分文件精确更新 |

### 后续 Pi subagent lifecycle characterization 工具错误记录

| 错误                                                                  | 尝试次数 | 解决方案                                                                              |
| --------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------- |
| provider test helper 补丁的 JavaScript 字符串字面量语法不正确，未应用 |        1 | 把修改拆为不含模板字符串分隔符的精确 patch                                            |
| helper 大段 patch 因 response.write 模板字符串上下文不匹配而未应用    |        1 | 限缩 hunk，不包含模板字符串行后成功应用                                               |
| 新增的公开命令路径测试等待子任务启动超时                              |        2 | 第二次附加精简帧/provider 诊断，定位到子任务 logical ID 被误用为 Pi native session ID |

## 第一百一十四切片：Pi-only renderer routing convergence（完成）

- `agentClientForRuntime()` 是唯一 renderer client route：Tauri Desktop 固定 Pi，browser preview 使用 deterministic ACP fixture；旧 `agentEngine` 只保留兼容归一化，不参与 route、session 或 Pi Explorer 选择。
- `beginAgentSession` 对 Pi 使用 product session ID，对 preview 保留 ACP fixture session ID。归档只读检查、ACP→Pi import journal、Host 权限与 worker protocol 不变。
- 用户确认的实际测试 seam 为 `agentClientForRuntime()` 与 `beginAgentSession()`；Vite SSR integration tests 4/4，full unit 431/431，`pnpm check`、architecture 3/3、lint、format、build 通过。Build 仍有既有 >500 KiB 按需 chunk warnings。
- 首轮测试发现前一轮 partial edit 令 Hook/Session Store 仍调用已删除的 override exports；完成消费者收敛后真实入口 tests 及完整 TypeScript/check 均通过。
- 保持 beta-only 与 `0.4.0-beta.2` release version trio；无 commit、push、publish、release 或 main sync。阶段 3 和全仓治理继续。

## 第一百一十五切片：renderer Agent store runtime vocabulary boundary（完成）

- Zustand `AgentStore` 的活动 runtime session identity、生命周期阶段与规范事件 cursor 原先命名为 ACP-only 字段，和 `SessionRecord.acpSessionId/acpCursor` 的持久化兼容字段混淆；将内存态收敛为 `runtimeSessionId`、`runtimePhase`、`eventCursor`。
- `beginAgentSession` 明确区分传入的 `sourceAcpSessionId/sourceAcpCursor` 与 runtime key：Desktop Pi 仍用 product session ID，browser preview fixture 使用源 ACP ID；归档、迁移计划、wire/storage contract 仍使用原 ACP 名称。
- `use-session-persistence` 在写入边界将 `eventCursor` 映射回持久字段 `acpCursor`。没有数据库 schema 或既有归档字段迁移。
- 用户已确认的 `beginAgentSession()` 与 projection-owner seams 继续沿用；Desktop route integration test 直至真实 `session.open` command envelope 断言 product session ID，不新增 runtime 私有 seam。
- 验证：routing integration 4/4；`pnpm check`（93 Pi compatibility/permission fixtures + source gate）、`pnpm test:unit`（431）、architecture 3/3、lint、format、production build 与 `git diff --check` 通过。Build 仍有既有 >500 KiB 按需 chunk warnings。
- 保持 `beta` 和 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。阶段 3 与全仓治理继续。

## 第一百一十六切片：Pi provider error projection owner（完成）

- 将 provider error message 的 bounds、control-character 清理、credential redaction、rate-limit 分类和 `AgentError` projection 收入 `session-errors.ts`；`PiSessionAdapter` 继续控制 run error state、恢复清除及 `run.finished` 的发出顺序。
- 删除两个直接访问 `adapter.sessions` / `onPiEvent` 的 provider-error tests，改由真实 worker command/event protocol 集成测试覆盖：503 之后可观察到 assistant `stopReason=error`，同一 run 随后有成功 assistant response 且终态无 error；持续 400 rate-limit 响应最终映射为既有 `pi.provider_rate_limited`、`rate_limit` stop reason，并清除 Bearer/API-key 示例秘密。
- 保持既有 error code、中文提示、retriable/scope/details 形状与 redaction 规则；未改变 Host 授权、worker wire protocol 或 provider retry policy。首次测试 fixture 只提供一次 400，Pi SDK 按既有 retry 行为继续请求后命中默认成功响应；改为提供足够的连续错误响应以测试最终失败语义。
- 验证：worker suite 163/163，full unit 430/430，`pnpm check`（93 compatibility/permission fixtures + source gate）、architecture gate 3/3、lint、format check、production build 与 `git diff --check` 通过。Build 保留既有 >500 KiB chunk warnings。
- 保持 beta-only 与 `0.4.0-beta.2` release version trio；无 commit/push/publish/release/main sync。全仓治理仍处于阶段 3。

### 第 116 切片新增错误记录

| 错误                                                                                        | 尝试次数 | 解决方案                                                                            |
| ------------------------------------------------------------------------------------------- | -------: | ----------------------------------------------------------------------------------- |
| 单个 HTTP 400 fixture 被 Pi SDK retry 后命中默认成功响应，未触发终态错误                    |        1 | 按 SDK 既有 retry 语义提供连续 400 响应，再通过真实 worker protocol 验证失败映射    |
| 并行运行 worker/full unit 时命令非零；可见 unit 失败为 23 ms 实际值低于 25 ms interval 断言 |        1 | 串行运行 worker suite 163/163 与 full unit 430/430 均通过；未改动该无关 timing test |

## 第一百一十七切片：MCP inventory cross-layer compatibility owner（完成）

- 用户已确认纯静态 owner seam：`checkPiMcpInventoryCompatibility({ inventory, sources }) -> diagnostics`。总检查器继续读取源码并汇总诊断；owner 负责 MCP 清单字段与实际 Host/Tauri/renderer/capability source snapshots 的一致性判断。
- Fixture 覆盖 Host command authorization/registration/permission、renderer bridge 与 preflight 调用、capability report 复用 Host-validated 结果；不得让 renderer 重新解析/裁决 MCP，且不改任何 runtime 行为。
- 按 TDD 先建 fixture；首次运行因新 owner 文件尚不存在而按预期红灯（`ERR_MODULE_NOT_FOUND`），实现纯函数后 6/6 通过。
- 加强 Host 授权 fixture：让无关函数保留 `registry.authorize` 与 MCP owner call 后，新检查首先错误通过，暴露全文件 marker 会产生 false positive；将检查限制到目标 command body 并验证授权先于 owner call，fixture 先红后绿（6/6）。初次 body matcher 只接受显式返回类型，导致三个 fixture 的附带失败；将 return annotation 设为可选并保持 production 形状，后续 6/6 通过。
- 已接入 aggregate checker 与 `check:pi-compatibility` Prettier/Node test list；真实源码 gate 通过，兼容/权限 fixtures 99/99（之前 93）。
- 完整 `pnpm check` 通过；首轮 `pnpm test:unit` 为 429/430，唯一失败 `research-source-adapter.test.mjs` 的 interval 在 24 ms 实测、25 ms 预期。隔离运行该文件 6/6，通过；串行重跑完整 unit 430/430，通过，未修改无关测试/代码。
- 同步架构/handoff 文档；最终复核确认 owner 只检查静态 authority chain，不改变 MCP runtime 行为或替代 Host 最终授权。文档同步后 `pnpm format:check`、规划文档 Prettier、`pnpm check:architecture`（3/3）、`cargo fmt --all --check`、`pnpm build` 和 `git diff --check` 通过；build 仍有既有大 chunk warnings。
- 第 118 切片（Pi model projection owner）已完成；起始基线为 17/17，抽取后 focused tests 与完整 Rust suite 均通过，详情见下节。

## 第一百一十八切片：Pi model configuration projection owner（完成）

- 将 user/project scope merge、remote model overlay、provider/model schema normalization、sampling/input/auth reference projection 与 per-model policy composition 移入 `src-tauri/src/pi_model_config/model_projection.rs`。`pi_model_config.rs` 保留配置读取、remote catalog 调用、投影调用与 generated-file persistence；`pi_remote_model_catalog.rs` 继续拥有远端 endpoint/fetch/cache，`model_policy.rs` 继续拥有纯策略校验。
- 保持 `prepare_pi_models_with_remote`、`PreparedPiModels`、生成文件形状、稳定 provider IDs、scope precedence、错误文本、retry bounds 与短生命周期 Host credential injection 不变。现存 model-config tests 仍通过 parent 的兼容 import 调用 projection helpers，没有新增或改变 test seam。
- Pi compatibility owner 已改为分别验证 parent module wiring 与 `model_projection.rs` 到 `model_policy.rs` 的真实调用；aggregate checker source snapshot 跟随新的 implementation owner。
- 验证：focused `pi_model_config::tests` 17/17、完整 Rust lib 350/350、warning-free `cargo check --lib`、`pnpm check`/Pi compatibility gate、lint、format check、Rust fmt check 与 `git diff --check` 通过。该切片只涉及 Rust 与静态 gate；完整 JS unit/build 未重跑。
- 一次机械抽取先因重复 BTreeMap import 锚点匹配多个位置而安全中止，未写文件；改为匹配完整 production import block 后再实施。仍在 `beta`、版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。阶段 3 及全仓治理继续。

### 第 118 切片工具错误记录

| 错误                                                                                 | 尝试次数 | 解决方案                                             |
| ------------------------------------------------------------------------------------ | -------: | ---------------------------------------------------- |
| 初次机械抽取的 BTreeMap import 锚点匹配到 production/test 两处，脚本中止             |        1 | 改为匹配完整 production import block；中止前没有写入 |
| 首轮文档 patch wrapper 因 JS template literal 中未转义 Markdown backticks 而解析失败 |        1 | 改用普通字符串数组构造 patch                         |
| 第二轮 patch context 漏掉 checklist literal dash，导致 patch context 不匹配          |        1 | 读取当前行并拆成精确、较小的 owner/doc hunks         |
| 组合文档 patch 中 README 新增行漏了 context prefix，整组 patch 被拒绝                |        1 | 拆分为单文档、小 hunk 并补齐 patch marker            |
| 错误记录表最初以不在 task_plan 的 heading 为锚点；修正 prefix 后仍指向错误文件       |        2 | 核实 task_plan 实际尾部，并以 slice 118 最后一行追加 |

## 第一百一十九切片：Browser tab-index tests 归回 lifecycle owner（完成）

- 将 `browser_tabs_are_bounded_and_closing_active_tab_selects_a_neighbor` 与 `browser_tab_selection_rejects_unknown_ids_without_changing_active_tab` 两项既有 test 原样从 `pi_browser_runtime.rs` 测试模块移到 `pi_browser_runtime/session_lifecycle.rs`。Owner 已经持有 `BrowserTabIndex` 与 `BrowserSessionLifecycle`，只调整测试归属与 test-only import。
- 保留 assertions、行为和接口不变，没有新增/修改测试、没有新增 test seam 或产品 runtime 代码。Parent 仍持有 URL trust、browser profile、bounds、Tauri WebView 和安全能力 integration tests。
- 验证：浏览器相关定向 Rust tests 15/15（迁移前后）、完整 Rust lib 350/350、Rust fmt 与 `git diff --check` 通过。仍在 `beta`、版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync，全仓治理继续。

## 第一百二十切片：Session-isolated WebView creation owner（完成）

- 将 `BrowserProfileMode`、平台 profile availability、hashed session profile directory/store identity、WebView label、desktop/non-desktop view creation、navigation callback、constrained sign-in popup creation、page-load notification、child insertion 与初始 hide behavior 移入 `pi_browser_runtime/view_creation.rs`。
- `TauriBrowserTabAdapter` 仍创建 `BrowserEntry` 与 per-tab local-origin/popup state；parent 保留 session/command orchestration、active view actions、bounds、tool dispatch。`browser_policy.rs` 继续裁决 URL/popup destination，`session_lifecycle.rs` 继续拥有 tab state/order；没有改变 remote WebView IPC capability。
- 将原有 `browser_profile_labels_do_not_embed_session_ids` 与 `browser_profile_policy_uses_isolation_supported_by_the_platform` assertions 原样迁到新 owner。无新增测试或测试 seam；浏览器定向 Rust tests 15/15、完整 Rust lib 350/350、`cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` 与 `pnpm check`（99 compatibility/permission fixtures + source gate）通过。
- 保持 profile fail-closed 平台选择、profile ID/hash、callback URL rules、popup allow switch/destination check、title sanitization、main event 与 child view hide 的原行为。仍在 `beta` 和版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。阶段 3 继续。

### 第 120 切片工具错误记录

| 错误                                                                                   | 尝试次数 | 解决方案                                                     |
| -------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------ |
| 新 module 文档注释中的 Markdown backtick 使 JS template patch wrapper 解析失败，未应用 |        1 | 改成不含 backtick 的说明后再次创建文件                       |
| parent wiring patch 使用了上一切片已移除的 cfg(test) import 作为匹配上下文             |        1 | 读取当前头部并只匹配现有 module declarations 与 adapter call |
| Slice 120 task-plan 追加 patch 锚点抄错上一节最终 bullet，整组 patch 未应用            |        1 | 读取实际 task_plan 尾部并用现有最终验证 bullet 追加          |

## 第一百二十一切片：Pi worker 直接行为测试归回实现 owner（完成）

- 将 `command_frames_are_bounded_and_protocol_checked` 与 `frames_preserve_crlf_and_reject_oversized_payloads` 原样移入 `pi_worker_runtime/protocol.rs`；将两项 `.envrc` projection tests 移入 `envrc.rs`；将 worker inherited-environment allowlist test 移入 `launch.rs`。
- 移除 parent 中对应 `cfg(test)` imports 与 `BufReader` import；parent 保留 `unscoped_runtime_events_do_not_require_a_product_session`，因为它直接验证 supervisor 对未绑定 product session 的 runtime event 分类。
- 未改变任何 assertions、生产代码、接口或测试 seam。定向 Pi worker runtime tests 迁移前后均为 22/22，完整 Rust lib 350/350；Rust fmt 与 `git diff --check` 通过。
- Pi compatibility gate 初次因 goal-safety 环境变量仍检查 parent source snapshot 而失败；改为检查现有 `workerLaunch` snapshot 后，`pnpm check` 的 99 个 compatibility/permission fixtures 与真实 source gate 均通过。
- 仍在 `beta` 与版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。阶段 3 继续。

### 第 121 切片工具错误记录

| 错误                                                                         | 尝试次数 | 解决方案                                   |
| ---------------------------------------------------------------------------- | -------: | ------------------------------------------ |
| 首轮移动 parent test 时保留了一行现有 `#[test]` marker，静态检查在测试前发现 |        1 | 删除多余 marker 后再格式化与运行原测试套件 |

## 第一百二十二切片：Browser URL policy tests 归回安全 owner（完成）

- 将 `browser_urls_are_https_and_not_local_or_private`、`browser_local_preview_only_allows_loopback_http_or_https` 与 `browser_login_popups_only_allow_blank_or_public_https_destinations` 原样从 `pi_browser_runtime.rs` 移入 `pi_browser_runtime/browser_policy.rs`。
- Parent 继续持有 Tauri remote-capability 与 bounds tests。新增兼容 gate source snapshots，确保 `page_tools.rs` 与 `screenshot.rs` 继续经同一个 URL-policy owner 校验 snapshot URL；runtime 仍通过 policy owner 验证 navigation/local preview。
- Browser-scoped Rust tests 迁移前后均为 15/15，完整 Rust lib 350/350；`pnpm check`（99 compatibility/permission fixtures + source gate）、Rust fmt 与 `git diff --check` 通过。无 runtime/security policy、接口或 test assertion 变化。
- 保持 `beta` 和 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。阶段 3 继续。

### 第 122 切片工具错误记录

| 错误                                                                               | 尝试次数 | 解决方案                                                                |
| ---------------------------------------------------------------------------------- | -------: | ----------------------------------------------------------------------- |
| 多文件 test relocation patch 的 hunk boundary 被拒绝，未应用                       |        1 | 按 parent 与 policy owner 拆成两个精确 patch                            |
| Pi Browser compatibility predicate 仍在 parent 搜索 snapshot validator 调用 marker |        1 | 让 gate 读取 `page_tools.rs`、`screenshot.rs` 并验证两处实际 owner 调用 |

## 第一百二十三切片：规范化 message stream projection owner（完成）

- 将 `message.delta` / `thought.delta` / `message.started` / `message.completed` 的时间线投影、message/part offset continuity、assistant streaming-row reconciliation 与完成后的 message-scoped state 清理收敛到 `src/domain/agent/message-projection.ts`。
- `projectAgentEvent` 继续验证 event/session envelope、过滤内部工具并负责所有非消息 event dispatch；它把现有 timeline/maps 传给新 owner，再将 owner 的 projection/state patch 归并到原结果。没有新增外部 API 或测试 seam。
- 保持重复 delta 不变更状态、offset gap diagnostic、assistant 完整消息回填、native metadata 合并、完成时间与用户消息 settle/cleanup 的既有行为。现有 `projectAgentEvent` 接口测试覆盖 owner 行为，不改 assertions。
- 定向 reducer tests 24/24、完整 unit tests 430/430、`pnpm check`（99 compatibility/permission fixtures + real source gate）通过；首次 `pnpm check` 仅提示已搬移后未再使用的 `AgentAssistantMetadata` import，移除后重跑通过。其他 final gates 结果见 progress.md。
- 仍在 `beta` 与版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。阶段 3 及全仓治理继续。

### 第 123 切片工具错误记录

| 错误                                                                                       | 尝试次数 | 解决方案                                |
| ------------------------------------------------------------------------------------------ | -------: | --------------------------------------- |
| 首轮 `pnpm check` 报告搬移 message projection 后未再使用的 `AgentAssistantMetadata` import |        1 | 删除过期 import 并重跑完整 `pnpm check` |

## 第一百二十四切片：Pi config policy direct tests 归回 owner（完成）

- 将 `config_runtime.rs` 中六项只直接调用 `config_pi_policy.rs` 的 terminal、question-timeout 与 goal-safety projection tests 原样移入 `config_pi_policy.rs::direct_policy_tests`；此前已属 policy owner 的 sandbox-profile test 保持原位。
- Parent 保留 config command、manifest assembly、marketplace 与 plugin/extension integration tests；没有修改 production code、assertions、Host authority 或 test seam。
- 迁移前 config-runtime 定向 suite 为 27/27；迁移后 `config_` 过滤 suite 为 85/85、完整 Rust lib suite 为 350/350，`cargo fmt --all --check` 通过。首轮 fmt check 提示两处机械换行差异，运行 `cargo fmt` 后复查通过。
- 仍在 `beta`，版本 trio `0.4.0-beta.2`；未 commit/push/publish/release/main sync。阶段 3 继续。

## 第一百二十五切片：Pi 配置兼容策略 owner（完成）

- 将 Pi config snapshot 的有界对象/path 读取与 sandbox、codebase indexing glob、external auth/OIDC、declarative subagent、terminal/question timeout、LSP presence、semantic memory 与 advanced goal policy 分类收敛到纯 `inspectPiConfigCapabilityPolicies` owner。
- `inspectPiCapabilityReport` 保留唯一既有调用/测试 seam、所有诊断文案与原顺序，继续结合 Host-projected MCP/LSP/Hook/plugin/Skill inventories 并负责最终 block/degradation 合成；没有修改 assertions、config schema、Host authorization 或 runtime behavior。
- `capability-report.ts` 从 852 行降到 483 行；现有 capability-report tests 42/42、完整 unit tests 430/430、`pnpm check`（99 fixtures + Pi source gate）、lint、architecture tests 3/3、format check 与 Vite production build 通过。构建保留既有 >500 kB chunk warnings。
- 仍在 `beta`，版本 trio `0.4.0-beta.2`；未 commit/push/publish/release/main sync。阶段 3 继续。

## 第一百二十六切片：Worker resource/policy snapshot owner（完成）

- 将 worker 启动环境中的 gitignore、question-timeout、goal-safety、subagent-policy 解析，与 Host resource manifest 的 cwd/root 校验、policy validation/normalization，移入 `resource-policy-snapshot.ts`。资源 root 的实际发现/路径策略仍归 `resource-discovery.ts`；goal/subagent normalization 仍复用对应既有 owner。
- `PiSessionAdapter` 保留 worker-visible policy 状态、Host refresh 赋值、生命周期队列、root/child session refresh 和下一轮 resource reload；Host omission 清除旧 optional snapshot、错误码/错误文案、错误时机和行为不变。
- compatibility checker 改为检查新 snapshot owner 的环境/上限逻辑并仍验证 adapter 接线；原 session adapter/resource discovery tests 29/29、question-timeout fixtures 5/5、worker suite 163/163、full unit 430/430、`pnpm check`（99 fixtures + real Pi source gate）、lint、architecture gate 3/3、format check、Vite build 与 `git diff --check` 通过。构建保留既有 >500 kB chunk warnings。
- `session-adapter.ts` 从 1,928 行降至 1,753 行。仍在 `beta`，版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。

### 第一百二十六切片后续审计工具错误记录

| 错误                                                              | 尝试次数 | 解决方案                                        |
| ----------------------------------------------------------------- | -------: | ----------------------------------------------- |
| findings 追加 patch 使用了错误标题/长行匹配，未应用               |        1 | 读取当前实际尾部并改为追加式小 hunk             |
| apply_patch 使用不受支持的 `*** End of File` 标记，未应用         |        1 | 使用该工具要求的 `*** End Patch` 结尾后成功更新 |
| 首轮 Prettier 检查发现 `resource-discovery.ts` 新参数换行格式差异 |        1 | 运行 Prettier 后重复格式检查通过                |

## 第一百二十七切片：Resource policy snapshot 环境输入与 owner tests（已完成）

- [x] 证实 root-trust helper 隐式读取进程环境，确定由 snapshot owner 注入显式环境而非另造 wrapper
- [x] 为 `normalizePiResourceRoots` 增加默认兼容的环境输入，并由 resource policy snapshot 传入既有环境记录
- [x] 新增 owner-local tests 覆盖 bounded startup parsing、Host roots、omitted optional policy 和拒绝路径
- [x] 将 owner test 纳入 worker 与完整 unit manifests
- [x] 运行新的 owner-local tests（4/4）
- [x] 跑 owner/adapter、worker/full unit、check、lint、format、diff gates 并修复问题
- [x] 更新静态 compatibility gate 验证环境贯穿，并复跑兼容检查
- [x] 更新计划/发现/进度完整记录
- [x] 复核 branch/version 与最终差异：`beta...origin/beta`，三项版本均为 `0.4.0-beta.2`，`git diff --check` clean
- **状态：** complete（本切片）；阶段 3 与全仓目标继续 in_progress

## 第一百二十八切片：剩余 Host/worker 所有者审计（已完成）

- [x] 复核 `beta` 工作树和既有规划记录；保留全部累计未提交变更
- [x] 检查 `pi_tool_gateway.rs` 的实现/测试分布与现有子 owner，拒绝以测试搬迁或浅层转发作为主要重构
- [x] 检查 `config_subagents.rs` 的来源加载与投影职责；确认已有 Markdown parser、prompt-file 和共享 agent-file scan owners
- [x] 继续检查 renderer store 候选：识别 `resolvePlan` / `resolvePermission` / `resolveQuestion` 为具备既有 `AgentStoreAccess` seam 的交互收尾簇
- [x] 核对当前 store 测试与调用契约；以现有 `AgentStoreAccess`（同 session/submit owners 的生产接口）作为行为测试面，不新增 test-only seam
- [x] 选择交互 resolution 行为簇：保留 `AgentStore` 公共 action signatures，提取 `resolvePlan` / `resolvePermission` / `resolveQuestion` 实现
- [x] 精确移动三项流程到 `agent-store-interactions.ts` 并新增经 `AgentStoreAccess` 的 owner 行为 tests，保持 Host 命令顺序、权限持久化、root/background identity 和失败恢复
- [x] 定向 owner tests 通过（4/4）
- [x] 通过 `pnpm test:unit`（438/438，无 warning）、`pnpm check`（99 compatibility/permission fixtures + source gate）、lint、architecture（3/3）、format、build 与 `git diff --check`
- [x] 复核 branch/version/diff：`beta...origin/beta`，package/Cargo/Tauri 均为 `0.4.0-beta.2`；未 commit/push/publish/release/main sync
- **状态：** complete（本切片）；阶段 3 与全仓治理继续 in_progress

### 第 128 切片工具错误记录

| 错误                                                                                                                                                                              | 尝试次数 | 解决方案                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------- |
| `rg` 检索引用了不存在的 `src-tauri/src/config_subagents/` 目录                                                                                                                    |        1 | 改为在现有 `config_subagents.rs` 文件和有效调用者文件中查询                                                         |
| 对 `updateQuestionEntry` / `settlePlanApproval` 的初次 `rg` 声明样式假设没有命中，且链式检索未继续                                                                                |        1 | 按符号名跨 `src/stores` 与 `src/domain` 检索，确认真实定义位置                                                      |
| 新增独立 Vite SSR owner test 与既有 SSR test 并行时，完整 suite 打印 `24678` WebSocket 端口冲突 warning（用例仍 438/438 通过）；单独端口配置仅使两文件对照通过，完整 suite 仍复现 |        1 | 将四项交互 tests 并入既有 `agent-session-routing.test.mjs`，复用已启动的 Vite SSR server；完整 suite 复跑无 warning |

## 第一百二十九切片：Renderer 会话配置选择 owner（完成）

- [x] 复核 `beta` 累计工作树、当前计划/发现/进度，清除第 128 切片重复的孤立状态标记
- [x] 审计 `agent-store.ts` 中模型、推理强度、会话模式、权限模式四项选择 action 与 ACP/Pi 独立响应路径
- [x] 选择已有 `AgentStoreAccess` 作为生产接口；不引入 test-only seam，不合并协议响应解析
- [x] 将四项会话配置选择实现迁入 `agent-store-configuration.ts`；保留 `AgentStore` action signatures 与所有 preview/live/command/error 行为
- [x] 在现有 Vite SSR test harness 经 `AgentStoreAccess` 验证状态分支、命令 revision/identity/request ID、pending 与错误恢复
- [x] 将新 owner 纳入 `format` / `format:check` manifests；通过 `pnpm check`（含 TypeScript 与 Pi compatibility/permission source gate）及 `pnpm check:architecture`（3/3）
- [x] 通过 owner 定向 tests（11/11）、`pnpm test:unit`（441/441）、`pnpm lint`、`pnpm format:check` 和 `pnpm build`；production build 仍只有既有 >500 kB chunk warnings
- [x] `git diff --check` 后复核 branch/version/diff：`beta...origin/beta`，package/Cargo/Tauri 均为 `0.4.0-beta.2`；保持 beta-only 且不 commit/push/publish/release/main sync
- [x] 更新规划/发现/进度的最终结果；全仓目标继续 in_progress
- **状态：** complete（本切片）；阶段 3 与全仓目标继续 in_progress

### 第 129 切片工具错误记录

| 错误                                                                                                                                                                             | 尝试次数 | 解决方案                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | --------------------------------------------------------------------------------- |
| 首轮 live configuration tests 用了不属于 `AgentPermissionMode` 的 `allow`，导致 Host command envelope validation 在调用 bridge 前拒绝请求；后续断言因此拿不到 permission command |        1 | 按实际 enum 使用 `auto`，并将稳定的 ACP IDs 与动态 permission request ID 分开断言 |

## 第一百三十切片：Pi 子代理生命周期 owner 的显式 SDK seam（已完成）

- [x] 重核 `beta` 当前工作树与上一切片结果；保留全部累计修改并确认无 catch-up report
- [x] 审计 `PiSubagentRuntime` 的 constructor/interface、唯一生产 caller、任务控制合同与现有 worker-smoke 覆盖
- [x] 判定 Host background task wrapper 是浅层单路径 adapter，暂不拆出；确认子代理 owner 缺少唯一隐式 Pi SDK 依赖，阻碍 owner-level lifecycle tests
- [x] 将 Pi SDK loader 作为 `PiSubagentRuntime` 显式 dependency，由 `PiSessionAdapter` 传入既有静态 production loader
- [x] 新建 Node owner tests，通过 `PiSubagentRuntime` / `PiTaskController` seam 与最小 Pi SDK fake adapter 覆盖 child lifecycle、terminal state 和 session-scope access，不检查 private map
- [x] 将 owner suite 纳入 agent-worker 与根 unit manifests，保留现有 worker smoke lifecycle integration tests
- [x] 运行 owner/worker/full unit/check/lint/architecture/format/build/diff gates，确认 Host authority、Pi-only routing 与 task wire events 不变
- [x] 更新规划/发现/进度并复核 branch/version/diff；保持 beta-only，不 commit/push/publish/release/main sync
- **状态：** complete（本切片）；阶段 3 与全仓目标继续 in_progress

### 第 130 切片工具错误记录

| 错误                                                                                                                    | 尝试次数 | 解决方案                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | -------: | --------------------------------------------------------------- |
| 首轮 owner test 的 `assert.rejects` validator 未识别跨 root wait 的错误对象形状；`fail()` 把合同放在 `error.agentError` |        1 | 按实际 `AgentError` wrapper 读取 `error.agentError.code` 后重跑 |
| 首轮 Prettier 检查发现新 owner test 与计划文件格式差异                                                                  |        1 | 运行 Prettier 格式化测试和计划文件，再复查通过                  |
| 首次追加第 130 切片错误记录时整行表格上下文未匹配，补丁未应用                                                           |        1 | 读取精确段落后使用当前 owner test 错误行作为唯一 patch 锚点     |
| 进度日志追加 patch 使用了 slice 129 的尾行，而不是文件实际末行，未应用                                                  |        1 | 按实际进度日志末行作为精确锚点追加 slice 130 记录               |
| 全部规划文档的 Prettier 复查发现 task_plan.md 表格列未对齐                                                              |        1 | 格式化 task_plan.md 并在新增记录后再次检查                      |
| slice 130 的进度追加命中重复的 slice 128 锚点，导致 #130 记录暂时排在 #129 前                                           |        1 | 删除错位段并按实际 EOF 锚点移到 #129 后，复核标题顺序           |

## 第一百三十一切片：Pi codebase request contract owner（完成）

### 第 131 切片工具错误记录

| 错误                                                                                                                    | 尝试次数 | 解决方案                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------ |
| 首次批量移除 CodebaseOperation 与参数解析 helper 时源码中的 format! 文本不同，补丁未应用                                |        1 | 按当前源码实文将删除拆成两个窄补丁                                             |
| 首轮 request owner 定向 Cargo test 编译失败：位置错误分支 format! 语法不合法，且索引刷新仍需 canonical workspace helper |        1 | 修正 format 表达式，并由 request owner 提供 crate 内可见 helper 给 parent 复用 |
| 向 task_plan.md 添加错误表时 JS 模板字符串遇到未转义反引号而解析失败，未修改文件                                        |        1 | 改用普通字符串构造 patch                                                       |
| 首轮追加 slice 131 错误表的尾部上下文未匹配，补丁未应用                                                                 |        1 | 使用 slice 标题作为唯一插入锚点                                                |
| Prettier 复查发现新增 compatibility test 未格式化，且检查命令把 Rust 文件交给 Prettier 导致无 parser error              |        1 | 格式化 JS test；将 Prettier 仅用于 JS/Markdown，Rust 使用 cargo fmt            |
| 最终规划文档 Prettier check 发现 task_plan.md 表格列未格式化                                                            |        1 | 仅对 Markdown 计划文件运行 Prettier，并重新执行格式检查                        |

- [x] 按当前 beta 工作树重核计划、发现、进度和 catch-up；确认 #129/#130 顺序已修复且既有累计修改保留
- [x] 审计 `pi_codebase_runtime.rs` 的索引状态/cache 与 inbound worker request parsing；核实既有 request/Host envelope test coverage
- [x] 选定单一 request projection seam：将 workspace containment 与 bounded operation arguments 解析为 validated request；Host envelope parse、Host authorization、index lifecycle 和 error-envelope composition留在各自现有 owners
- [x] 实现 `pi_codebase_runtime/request.rs` 并接入 runtime，保留精确 validation order、error codes/messages、path/symlink checks 与 query/position limits
- [x] 为 request owner interface 增加 bounded inputs、operation aliases、required fields 和 workspace/path containment tests；保留 parent end-to-end index/error tests
- [x] 更新 codebase compatibility source snapshots/checks，使请求合同 marker 跟随 owner 并验证 parent wiring；request owner tests 4/4、source fixtures 8/8
- [x] 跑定向与完整 Rust library tests、Cargo check/fmt、Pi compatibility/check/lint/format、diff gates；审查安全/协议不变量（Rust 353/353、TypeScript unit 442/442、compatibility/permission fixtures 100）
- [x] 更新计划/发现/进度并最终复核 branch/version/diff；仍在 beta，不 commit/push/publish/release/main sync
- **状态：** slice 131 completed；阶段 3 与全仓目标继续 in_progress

## 第一百三十二切片：Pi codebase index/cache owner（完成）

### 第 132 切片工具错误记录

| 错误                                                                                                   | 尝试次数 | 解决方案                                                |
| ------------------------------------------------------------------------------------------------------ | -------: | ------------------------------------------------------- |
| 自动删除 index implementation 的首轮 hunk 未包含相邻空行上下文，补丁未应用                             |        1 | 精确保留 `bounded_text` 前的空行上下文后应用            |
| 首次组装 index owner 时复制到边界处的 `bounded_text` 声明/doc comment，并漏掉 `FileFingerprint` derive |        1 | 源码复核后删除边界残留、恢复 derive，再运行 Cargo tests |
| index owner 首轮 focused test 使用非 canonical fixture path，symbol lookup 未匹配 canonical cache key  |        1 | fixture 创建后 canonicalize root，并以同一绝对路径查询  |
| 第二轮 focused test 对 document symbols 预期为 1，但 fixture 同时定义 `greet` 与 `main`                |        1 | 按实际 parser contract 将数量断言修为 2                 |
| 首次多文档状态更新的 JS patch 字符串因 Markdown backtick 解析失败，后续组合 hunk 锚点也不匹配          |        2 | 将文档状态改为单文件、精确行 patch 后成功应用           |
| 更新 Slice 132 后最终 Prettier check 再次发现 task_plan.md 表格格式需规范化                            |        1 | 运行 Prettier 并在最终检查中复验                        |

- [x] 基于当前工作树审计剩余 codebase runtime；确认请求 projection 已有 `request.rs`，parser 已有 `parser.rs`
- [x] 选择 owner seam：index bounds、file walk/fingerprint/cache、refresh/rebuild 和 bounded symbol/location queries 归新 index owner；project policy、Host request envelope 与 output/error composition 留在 parent
- [x] 抽取 `pi_codebase_runtime/index.rs` 并提供持锁 refresh/query 接口，不创建第二份 workspace cache 或公开新协议
- [x] 在 owner tests 覆盖增量 refresh、definition/reference、document/workspace symbols、单文件大小与结果上限及 Unix symlink 不跟随；保留 parent request/error integration tests
- [x] 更新 Pi compatibility source snapshots/fixtures，要求 bounds 属于 index owner 且 parent 仍接线 request/index/parser；source fixtures 9/9 通过
- [x] 跑 focused/full Rust 与 TS/compatibility/check/lint/format/diff gates，审查索引界限、缓存锁和 Host 权限不变量（Rust library 356/356、TypeScript unit 442/442、compatibility/permission fixtures 101）
- [x] 更新计划/发现/进度并复核 branch/version/diff；保持 beta-only，不 commit/push/publish/release/main sync
- **状态：** slice 132 completed；阶段 3 与全仓目标继续 in_progress

## 第一百三十三切片：Agent contract runtime cycle 与依赖图门禁（完成）

- [x] 用 TypeScript compiler module resolution 审计当前 `src` / `packages` / `scripts` source graph，排除 test-only 与 type-only imports；发现唯一 runtime SCC 在 `agent-contract/src/index.ts` ↔ `validation.ts`
- [x] 确认环由 `validation.ts` 从 barrel 同时引入 `AGENT_PROTOCOL_VERSION` value 与三个 type，而 `index.ts` 再 re-export validator 形成；Research workspace SCC 是 type-only，不是 runtime cycle
- [x] 将 `AGENT_PROTOCOL_VERSION` 迁入 canonical `protocol-version.ts`，`index.ts` re-export，`validation.ts` 分开导入 value owner 与 `import type` contract shapes
- [x] 扩展 `check-architecture.mjs` 为 `src`/`packages` production TS/JS runtime import graph cycle gate，使用 TypeScript resolver 并排除 test-only/type-only edges
- [x] 为直接/间接、自环和动态 import edges 增加 architecture owner tests；保留 domain/worker boundary checks
- [x] 运行 package contract、全仓 architecture/check/unit/lint/format/build 与 diff gates；确认无剩余 runtime cycles、Pi-only 与 Host authority 不变
- [x] 更新计划/发现/进度并复核 beta/version/worktree；不 commit/push/publish/release/main sync
- **状态：** slice 133 completed；阶段 3 与全仓目标继续 in_progress

### 第 133 切片工具错误记录

| 错误                                                                                          | 尝试次数 | 解决方案                                                   |
| --------------------------------------------------------------------------------------------- | -------: | ---------------------------------------------------------- |
| 首次将协议版本改为 barrel re-export 后，契约类型引用无法从本模块解析 `AGENT_PROTOCOL_VERSION` |        1 | 同时在 barrel 本地 import 并 export 常量，保留既有公共导出 |
| 首轮 SCC 测试把 adjacency `Set` 当作数组调用 `includes`                                       |        1 | 改用 `Set.has` 检查自环，并用直接/三节点间接循环夹具复验   |
| 最终 SCC fixture 预期次序与稳定排序的 `localeCompare` 结果不一致                              |        1 | 调整测试期望顺序，复跑架构单测、项目模块图和文档格式检查   |

## 第一百三十四切片：Pi Skill / prompt discovery owners（完成）

- [x] 按当前代码盘点确认 `resource-discovery.ts` 同时拥有 Host root authority/normalization、递归 Skill scanner 与 flat Markdown prompt scanner；两类 scanner limits、disable/ignore semantics 与 traversal rules 不同
- [x] 确认根信任和路径规范化是二者的真实共享策略：`normalizePiResourceRoots`、trusted roots、symlink checks 与显式 environment 快照继续留在共享 resource root owner，不复制到扫描器
- [x] 将 Skill path enumeration 与递归/ignore/bounds 归 `skill-discovery.ts`；将 flat command Markdown enumeration 与 direct-child/disable/bounds 归 `prompt-discovery.ts`
- [x] 更新 session adapter 与 policy snapshot 接线，继续将 Host root validation 留在共享 owner；不改变 Pi-only runtime 或具体路径权限
- [x] 为各 scanner owner 保留直接接口测试；拆分 Pi compatibility gate 的实际 source owner 输入，分别锁定 limits、环境字段和安全规则
- [x] 运行 worker/resource compatibility、全量 unit/check/lint/format/build 与 diff gates；确认行为、Host 权限和 beta 工作树不变
- [x] 更新计划/发现/进度并复核 beta/version/worktree；不 commit/push/publish/release/main sync
- **状态：** slice 134 completed；阶段 3 与全仓目标继续 in_progress

### 第 134 切片工具错误记录

| 错误                                                                                           | 尝试次数 | 解决方案                                                                   |
| ---------------------------------------------------------------------------------------------- | -------: | -------------------------------------------------------------------------- |
| 首轮 worker type check 发现 prompt owner 有未使用 import，resource root 有未定义的 environment |        1 | 移除多余 import 并恢复 root helper 的默认 process environment              |
| Pi compatibility fixture 未同步新的 Skill scanner `realpathSync` owner marker                  |        1 | 将 symlink boundary marker 加入 Skill owner fixture 并复跑 source fixtures |

## 第一百三十五切片：Pi goal state domain 与 extension adapter 分离（完成）

- [x] 复核当前 `beta` 工作树、阶段 3 计划和恢复报告；确认 goal extension 是下一项候选且无需覆盖已有改动
- [x] 基于实际调用者与测试界面确认当前单模块包含纯 goal policy/state/guard logic 与 Pi extension registration 两种职责
- [x] 将持久化 goal state、policy normalization、objective parsing、reconstruction、transitions 与 summary 移至 `goal-state.ts`
- [x] 将 token/stall accounting 与 deterministic pause enforcement 移至 `goal-guards.ts`，保持输入输出合同与判定顺序
- [x] 收窄 `goal-extension.ts` 为 Pi lifecycle/command registration adapter；将 compaction、policy snapshot 调用改为真实 state owner
- [x] 将现有纯 state 与 guard tests 移至各 owner 文件，通过 owner 接口测试；保留 Pi extension event integration tests
- [x] 更新 worker/root test manifests 和 Pi compatibility owner markers，锁住 goal safety bridge 与真实实现位置
- [x] 运行 owner、worker、compatibility、architecture、unit、check、lint、format、build 与 diff gates，复核 Host authority、Pi-only 与状态行为
- [x] 更新计划/发现/进度，复核 beta/version/worktree；不 commit/push/publish/release/main sync
- **状态：** slice 135 completed；阶段 3 与全仓目标继续 in_progress

### 第 135 切片工具错误记录

| 错误                                                                                            | 尝试次数 | 解决方案                                                            |
| ----------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------- |
| 首轮跨文档补记 patch 使用的 `findings.md` 末尾锚点不匹配，安全失败且未写入                      |        1 | 逐文件读取实际尾部并改用真实内容锚点后重试                          |
| Root unit manifest 首次加入的 owner test 路径缺少 `packages/agent-worker/` 前缀                 |        1 | 检查命令实际工作目录并在测试前更正为仓库相对路径                    |
| 首轮 Pi compaction compatibility 测试仍按旧 `goal-extension.ts` owner 检查 state reconstruction |        1 | 将 goal source owner 映射改为 `goal-state.ts` 并复跑 fixtures       |
| 首次更新 compaction checker 的 patch 锚点与真实源码不符，安全失败且未写入                       |        1 | 读取 checker 的实际 owner loop 后按精确上下文重试                   |
| 首轮 format checks 发现 plan、compatibility checker、goal state 和 guard tests 样式不一致       |        1 | 仅对上述触及文件运行 Prettier，再复跑 worker 与 touched-file checks |

## 第一百三十六切片：PiSessionAdapter SDK seam 与公开生命周期测试（已完成）

- [x] 审计 `session-adapter.test.mjs` 直接写入 `adapter.sessions` / `handle.runFinished` 的场景，并确认 `PiSessionAdapter` 当前没有 SDK loader seam
- [x] 确认 `PiSubagentRuntime` 已注入相同的 `loadPiSdk` 依赖，Pi SDK 属于可替换的外部 adapter；`open()` 可经临时模型路径与 fake session 覆盖生命周期，无需暴露 session map
- [x] 为 `PiSessionAdapter` 增加可选 `loadPiSdk` constructor dependency，生产默认仍用静态 bundle loader，并将其一致传递给 child runtime
- [x] 将资源刷新、活动 run、configure transaction、stale steer 与 cancel/replacement 测试改为 `open/submit/steer/cancel/configure` 可观察行为；不为测试新增 session-map setter
- [x] 保留 model-catalog runtime stub 为其独立的 Host credential synchronization integration test；不为单个测试扩大 `PiSessionAdapter` constructor interface
- [x] 运行 worker、unit、architecture、Pi compatibility、check、lint、format、build 与 diff gates；更新文档并复核 beta/version/worktree
- **状态：** slice 136 completed；阶段 3 与全仓目标继续 in_progress

### 第 136 切片工具错误记录

| 错误                                                                                                  | 尝试次数 | 解决方案                                                          |
| ----------------------------------------------------------------------------------------------------- | -------: | ----------------------------------------------------------------- |
| 直接执行 session-catchup.py 因文件无执行权限失败                                                      |        1 | 按技能说明改为 `python3 <script> <repo>` 调用，成功且无待同步报告 |
| 首次追加规划记录时使用未读取的猜测行作为 patch 锚点，安全失败且未写入                                 |        1 | 读取准确尾部后使用真实上下文重新应用                              |
| constructor patch 的 loader call-site 上下文与真实源码不匹配，安全失败且未写入                        |        1 | 读取确切 import/call sites 后拆成两个窄补丁应用                   |
| 首轮完整 session-adapter suite 的三项断言把 `session.opened`/`runtime.warning` 与 run events 混合比较 |        1 | 仅过滤 run lifecycle 事件后重跑 24 项 adapter tests               |

## 第一百三十七切片：Pi ModelRuntime factory seam 与 owner-interface tests（已完成）

- [x] 审计 `PiModelCatalogRuntime` 的 Pi `ModelRuntime.create` 构造点和四处测试对 `getModelRuntime()` 的覆盖
- [x] 确认仅需一个窄 external-runtime factory adapter：生产走 Pi factory，owner/integration tests 走确定性本地 fake
- [x] 为 catalog constructor 增加可选 factory dependency，并通过 `PiSessionAdapter` 的既有 dependencies option 传递
- [x] 把三个 catalog tests 与 Host credential synchronization integration test 改为注入 factory、调用真实 owner interface
- [x] 验证生产 Pi 默认 factory、注入 options/runtime cache、model snapshot/alias/auth 与 Host credential/live-session refresh behavior
- [x] 运行 worker、unit、architecture、Pi compatibility、check、lint、format、build 与 diff gates，复核安全/协议不变量
- [x] 更新计划/发现/进度并复核 beta/version/worktree；不 commit/push/publish/release/main sync
- **状态：** slice 137 completed；阶段 3 与全仓目标继续 in_progress

### 第 137 切片工具错误记录

| 错误                                                                                 | 尝试次数 | 解决方案                                                                                                             |
| ------------------------------------------------------------------------------------ | -------: | -------------------------------------------------------------------------------------------------------------------- |
| 首轮跨文档 patch 对 `findings.md` 使用的尾部锚点不匹配，安全失败且未写入             |        1 | 检查真实尾部后拆分补记，并改用实际上下文                                                                             |
| 新增 factory seam 红测显示 catalog constructor 忽略了注入并启动真实默认 ModelRuntime |        1 | 将可选工厂保存为 owner 内部 dependency，生产默认包一层 `ModelRuntime.create`，确认 fake adapter 被缓存并通过参数断言 |

## 第一百三十八切片：Host sandbox profile resolution owner（已完成）

- [x] 复核上轮后当前分支、工作树和规划状态；比对历史候选与当前实际源码，排除已完成的交互、Pi web projection、worker event acceptance seams
- [x] 审计 sandbox profile normalization、Host `sandbox_decision`、Tauri preflight 与 Seatbelt/Landlock consumers，确认职责 seam 与安全不变量
- [x] 将 profile/file/environment/path normalization 和 `SandboxProfile` 搬到 `workspace_sandbox/profile.rs`，父模块保留唯一 fail-closed 决策、授权预检与命令构造
- [x] 为 profile owner 增加显式、临时路径限定的环境/source tests；保留 parent decision/integration coverage，不读取或写入真实 user config
- [x] 将 Pi compatibility checker 的 profile owner marker 更新为真实实现 source，同时保留 Host preflight/command wiring checks
- [x] 运行 sandbox owner/Host/Rust tests、Pi compatibility/check/architecture/lint/format/build gates 与 diff check；标清 macOS/Linux enforcement 限制
- [x] 更新计划/发现/进度并复核 beta/version/worktree；不 commit/push/publish/release/main sync
- **状态：** slice 138 completed；阶段 3 与全仓目标继续 in_progress

### 第 138 切片工具错误记录

| 错误                                                                                  | 尝试次数 | 解决方案                                                     |
| ------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------ |
| 首轮 planning patch 的 JavaScript 字符串被未转义双引号终止，安全失败且未写入          |        1 | 改用逐行字符串数组构造补丁并重新应用                         |
| 第二次 planning patch 的 context 行缺少 apply_patch 前导空格，安全失败且未写入        |        1 | 按补丁语法明确标记 context 行后重试                          |
| 首轮批量删除 profile source 时模板转义和手工区块边界未命中，安全失败且未写入          |        3 | 从已核对的源文件行动态生成删除补丁后成功迁移                 |
| profile owner 注释补丁错误地把双引号 match arm 写成反引号，安全失败且未写入           |        1 | 对照真实源码修正锚点后应用                                   |
| 两项显式 profile fixture 以未 canonicalize 的 /tmp 别名比较非既存子路径，预期断言失败 |        1 | 创建 fixture 后 canonicalize workspace，定向测试转绿         |
| 状态/复核 checklist patch 把列表内容符误当 diff 操作符，安全失败或多加前缀            |        3 | 逐行检查真实文件后用双前缀删除与单前缀添加恢复 Markdown 列表 |
| 最终 Rust 编译发现 normalized `&str` 转交 `Option<&str>` helper 的类型不匹配          |        1 | 显式包装 `Some(requested)` 后重跑全量 Rust tests 与 check    |

## 第一百三十九切片：worker stdout 事件入口 owner 审计（只读审计完成）

- [x] 复核当前 beta 工作树、三处版本、阶段计划与 session catch-up；保留所有累计修改
- [x] 精读 `PiWorkerRuntime::spawn_readers`、既有 protocol/event-acceptance/Host-tool owners 与副作用排序
- [x] 判断是否存在可由小接口封装的事件流 owner；若只会搬移宽耦合的 supervisor coordinator，则拒绝抽取
- [x] 继续核对兼容性 manifest、Marketplace lifecycle 与 Host monitor owner 的生产职责/测试边界
- [x] 更新 findings/progress 记录候选优先级与“不拆”决定；复核 Pi-only、Host authority、beta 与版本不变量
- **状态：** slice 139 read-only audit complete；implementation deferred per user direction；阶段 3 与全仓目标继续 in_progress

### 第 139 切片审计决定

- `spawn_readers` 在 stdout 上维持关键顺序：generation accept/dedupe → 持久化 → memory/dispatch 观察 → 异步生命周期 Hook → Host persisted permission/tool request 路由 → renderer emit → generation fail/finish；stderr reader 负责独立诊断输出。
- 不把该流程搬进新 owner：它必须同时了解 supervisor、SQLite event sink、memory lifecycle、dispatch ledger、Host hooks、permission store、Pi ToolGateway、Tauri emitter 与 generation teardown。把它抽成单一 helper 只会把 supervisor 类型及其所有 collaborators 一起移过去；要建立新 interface 又会形成宽 callback/facade 并重复现有 owners。顺序目前已直接写在真正的 process reader，测试也缺乏可跨窄 interface 断言的独立实现。
- 暂不改源代码；下一步检查 Pi compatibility aggregator 是否仍在同一实现文件承载多个已有 owner contracts，以及能否把 fixture-only checks 测试跨界收敛，而不把 checker 拆成 pass-through 文件。

### 第 139 切片最终候选排序

- 优先候选：纯 Pi runtime/manifest capability policy checker。真实 `PI_CAPABILITIES` Node subprocess 继续留在总闸；source/package/manifest/runtime-result 之间的纯漂移诊断可考虑 fixture seam。
- 次级候选：generic worker/Host ToolGateway ownership wiring checks。它们可 fixture 测试，但主要是模块接线 marker，语义 leverage 低于 Pi-only capability contract。
- 不拆 `config_marketplace_native.rs`：其剩余逻辑是扫描、安装、更新、卸载的 Host command orchestration，依赖已抽出的 catalog/transport/registry/filesystem/plugin-source owners；`install_snapshot` 是有临时目录 integration tests 覆盖的 registry+filesystem transaction，暂未发现值得额外引入的更窄且更深 owner。
- 不拆 `pi_monitor_runtime.rs`：当前模块作为一个完整 Host monitor lifecycle owner，内聚地管理 process、line/rate/total bounds、event sequence、session/workspace ownership、cancel/finish 和有界 finished snapshots；现有 owner-local tests 已覆盖 sandbox/cancel/bounded-output 核心行为。
- 本轮只审计并更新规划记录；用户明确要求继续 audit only，因此不新增测试或源码。全仓治理继续阶段 3。

### 第 139 切片工具错误记录

| 错误                                                                                       | 尝试次数 | 解决方案                                               |
| ------------------------------------------------------------------------------------------ | -------: | ------------------------------------------------------ |
| 首次追加审计记录时 Markdown 反引号被转义为字面反斜杠，apply_patch 锚点匹配失败且未修改文件 |        1 | 用无冲突占位符构造补丁，再在应用前恢复 Markdown 反引号 |
| 第二次跨文档 patch 的 progress 锚点未命中，apply_patch 安全失败且未改文件                  |        1 | 直接从当前文件读取尾行作为补丁锚点，并分文件依次追加   |

### 第 139 切片最终验证

- Planning documents were formatted with Prettier; `pnpm exec prettier --check task_plan.md findings.md progress.md` and `git diff --check` passed.
- A `rg '^+'` scan returned no matches, confirming the earlier accidental diff-prefix text was fully removed.
- Final repository recheck remains `beta...origin/beta`, HEAD `4eddef67`; package/Cargo/Tauri versions are aligned at `0.4.0-beta.2`. No source/tests were modified, and no commit/push/publish/release/main sync occurred.

## 2026-10-12：第 139 切片审计决策更新

- 只读审计将纯 Pi runtime/manifest capability policy 列为当前最高优先候选；实际 `PI_CAPABILITIES` Node probe 必须保留在聚合 gate。Generic ToolGateway wiring 是次级候选。
- `config_marketplace_native.rs` 与 `pi_monitor_runtime.rs` 暂无值得拆出的更窄 owner；`spawn_readers` 是多 owner 事件顺序协调器，不形成窄 interface。
- 用户要求继续只审计：不新增源码或测试。下一步核查聚合 compatibility gate 的调用、输入和 fixture 覆盖，保持 beta/Pi-only/Host authority 约束。

## 2026-10-12：第 139 切片审计续记

- 当前只读审计完成：`scripts/check-pi-compatibility.mjs` 为 1,924 行，兼容 gate 在 CI 的 `pnpm check` 链路执行，且没有 checker 自身的 fixture suite。纯结构化输入的 Pi capability/manifest 一致性策略是当前首选后续 owner；保留真实 `PI_CAPABILITIES` 子进程探针和顶层聚合/失败处理。
- 该 gate 证明的是声明一致性，不证明工具实际注册、Host 授权或 OS sandbox enforcement。按用户审计-only方向不实施，不新增测试。
- 下一步继续只读扫描仍由聚合脚本内联持有的相邻合同，比较其调用者范围与更窄 interface；不从行数推导拆分，不触及 beta 之外的发布流程。

### 第 139 切片审计验证补记

- `pnpm check:pi-compatibility` passed on the current beta tree: 101/101 fixture tests passed and the real aggregate Pi compatibility/Tauri permission gate passed. Its fixtures cover extracted owners, not the checker’s own inline manifest/capability diagnostics.

## 2026-10-12：第 139 切片候选优先级修订

- 新证据显示：root 形态的 `createTools` 运行时构造返回 42 个唯一 gateway 工具名，与 `PI_GATEWAY_TOOL_NAMES` 精确相等；todo/goal extension 各自已有注册测试，三者合计 44 个名字，与 `PI_CAPABILITIES.tools` 相等。
- 当前更有结构价值的后续边界是“root 实际注册工具集合 == capability announcement”的组合级行为测试，不是先抽一个更容易 fixture 化的 manifest checker。纯策略 checker 留作次级候选。
- 用户仍要求只审计。下一步评估现有 `PiSessionAdapter` fake-SDK/resource-loader harness 能否通过公开接口验证该组合；在授权变化前不新增测试/源码。

### 第 139 切片：组合级测试 seam 可行

- 本地 Pi SDK 的 `ResourceLoader.getExtensions()` 返回带公开 `Extension.tools` map 的结果；现有 session-adapter 测试 harness 保留真实 `DefaultResourceLoader`，并通过现有 `loadPiSdk` seam 包装 `createAgentSession(options)`。可在测试中捕获 `options.customTools` 与资源加载器实际扩展工具，再比较 `options.tools`/`PI_CAPABILITIES.tools`，无需新增生产依赖端口。
- 该测试只适用于 root 会话的完整能力集合；child 的 capabilityMode 是过滤策略，不能与全局能力声明直接作相等比较。按当前审计-only要求暂不添加测试。

### 第 139 切片组合覆盖范围

- 源码扫描确认 root 注入的 extension factories 中只有 todo 与 goal 注册模型工具；instruction-scope 与 compaction 不新增工具，且 root session 将 `noTools` 设为 `builtin`。完整集合测试可比较 gateway definitions 与真实 loaded extension tool maps。

## 第一百四十切片：root Pi 工具声明与 allowlist 组合测试（完成）

- [x] 在当前 beta 工作树基于现有 `PiSessionAdapter`/真实 `DefaultResourceLoader` harness 测试 root 工具组合，不新增生产依赖端口
- [x] 捕获传给 Pi SDK 的 options，将 `customTools` 与加载扩展的 `tools` 合并并比较 `options.tools` 和 `PI_CAPABILITIES.tools`
- [x] 检查重复名称与扩展加载错误；限定断言于 root/all capability，不将 child 过滤集与全局能力声明比较
- [x] 运行 worker、全量 unit、type/check、Pi/Tauri compatibility、architecture、lint、format、build 与 diff gates
- [x] 更新计划/发现/进度，复核 beta 与三处版本；不 commit/push/publish/release/main sync
- **状态：** slice 140 completed；阶段 3 与全仓目标继续 in_progress

### 第 140 切片工具错误记录

| 错误                                                                             | 尝试次数 | 解决方案                                 |
| -------------------------------------------------------------------------------- | -------: | ---------------------------------------- |
| 首轮规划补丁漏加新增行的 `+` 前缀，apply_patch 拒绝且未修改文件                  |        1 | 按 unified diff 格式重建补丁             |
| 第二轮跨文件补丁将 progress 尾行误作 findings 锚点，apply_patch 拒绝且未修改文件 |        1 | 读取三个文件的真实尾行并分别使用准确锚点 |

## 第一百四十一切片：Pi compatibility JSON 根节点 fail-closed（完成）

- [x] 在用户确认的 CLI 集成 seam 上复现 worker package JSON 根为 `null`/`false` 时跳过整段 Pi 检查并误报成功
- [x] 让共享 JSON 读取器明确拒绝 null、primitive 与 array 根节点；保留文件/语法错误诊断
- [x] 保护 manifest 读取失败后的可选桥接扫描，避免原始解析错误被后续 `TypeError` 遮蔽
- [x] 为 package null/false、manifest array/null、manifest 语法错误增加通过真实 CLI 子进程运行的回归覆盖；只注入单个文件读取结果，真实 `PI_CAPABILITIES` probe 保持启用
- [x] 将入口测试接入 Pi compatibility 专项格式与测试门禁
- [x] 验证 Pi compatibility 106 项、`pnpm check`、`pnpm test:unit` 450 项、lint、format、architecture 5 项及 diff check
- [x] 复核仍在 `beta`、三处版本一致；不 commit/push/publish/release/main sync
- **状态：** slice 141 completed；阶段 3 与全仓治理目标继续 in_progress

### 第 141 切片工具错误记录

| 错误                                                       | 尝试次数 | 解决方案                                               |
| ---------------------------------------------------------- | -------: | ------------------------------------------------------ |
| progress 追加 patch 使用了旧尾部文案锚点，安全失败且未写入 |        1 | 重新读取真实文件尾部，并用现有最后一行作为精确追加锚点 |

## 第 142 轮候选审计：subagent 配置投影 owner

- [x] 基于当前工作树复核 branch、三处 release version 和 planning session catch-up；保持现有 beta dirty tree
- [x] 审计 `config_subagents.rs` 的职责群、跨层调用、已提取 parser owners、source precedence 及现有测试
- [x] 判断 inventory/manifest 之间是否存在能减少重复复杂度且不扩展接口的深模块 seam
- [x] 记录不改代码的审计结论，并转向下一候选 owner
- **状态：** candidate audit complete；阶段 3 与全仓治理目标继续 in_progress

### 第 142 轮工具错误记录

| 错误                                                                           | 尝试次数 | 解决方案                                                                               |
| ------------------------------------------------------------------------------ | -------: | -------------------------------------------------------------------------------------- |
| 一次性 Node 版本核验命令因 zsh 引号不匹配而未执行                              |        1 | 改为分别读取 package、Cargo 与 Tauri 的版本行；三处均确认是 `0.4.0-beta.2`             |
| worker reader 测试支持扫描首次把不存在的 `src-tauri/tests` 传给 `rg`           |        1 | 改为以现存的 `src-tauri` 树为范围枚举测试文件与 Tauri harness；没有文件变更            |
| reader-loop seam 问题前两次调用使用了旧的 `question` 字段和重复的 `title` 字段 |        2 | 按 `request_user_input_async` 的实际 schema，将说明并入 `title` 并作为一个问题发送成功 |

## 第 143 轮候选审计：Pi worker reader loop

- [x] 检视 stdout/stderr framing、事件验收、持久化、dispatch acknowledgement、memory/hooks/tool routing 与 generation teardown 顺序
- [x] 区分已有纯事件验收测试与实际 reader orchestration 测试
- [x] 检查当前 Tauri app 测试 harness 和可控 worker fixture 的可用性
- [x] 用户确认采用 narrow event coordinator + fake port；先写接口合同测试再实现
- **状态：** candidate audit complete；实现由 slice 144 完成，阶段 3 与全仓治理继续 in_progress

## 第 144 切片：Pi worker event pipeline coordinator

- [x] 新增内部 event pipeline owner 和最小 `EventPort` interface；保留 stdout framing、JSON 解码、workspace lookup 与 generation teardown 在 runtime
- [x] 将 acceptance、旧 replay 的 SQLite arbitration、持久化错误映射与 post-commit Host side effects 收入 coordinator/live adapter
- [x] 用 fake port 覆盖 insert-before-publish、内存/持久层 duplicate、淘汰 replay arbitration、sequence violation、unknown session、存储失败与非法协议错误
- [x] 保持 Host workspace/session authorization 在既有 `persist_pi_event`，不改变 Host 权限或 Pi-only worker 路由
- [x] 运行 9 项 owner tests、全 Rust lib 366 项、`cargo check --lib`、Rust format、planning-doc Prettier 与 diff check
- [x] 复核仍在 `beta`、三处版本统一；不 commit/push/publish/release/main sync
- **状态：** slice 144 completed；阶段 3 与全仓治理目标继续 in_progress

### 第 144 切片工具错误记录

| 错误                                                                                 | 尝试次数 | 解决方案                                                              |
| ------------------------------------------------------------------------------------ | -------: | --------------------------------------------------------------------- |
| reader coordinator 首次测试编译时从父模块查找未 re-export 的 `is_sequence_violation` |        1 | 直接从既有 `event_acceptance` owner 导入该 helper；focused tests 通过 |
| 首次 Rust format check 发现 `event_pipeline` module 声明未按 rustfmt 顺序排列        |        1 | 按 rustfmt 输出重排 module declarations，format check 通过            |

## 第 145 切片：session/project agent-row cleanup owner

- [x] 对照 `database_sessions.rs` 与 `database_projects.rs` 的事务清理 SQL、直接调用方和现有删除测试
- [x] 识别共享的 Host agent/session artifact 清理职责与项目/会话事务边界
- [x] 记录不移动 worker 停止、Pi 文件清理、permission rules 或 session/project 主记录删除的约束
- [x] 用户选择抽取 shared cleanup owner；owner 只接收调用方已有 SQLite transaction 与目标 id
- [x] 先在新 owner 的 interface tests 中锁定 session/project scope、所有共享子表和 transaction rollback 行为；四项测试在 no-op 实现上按预期失败
- [x] 将重复 cleanup SQL 移入 `database_agent_cleanup`；session/project 调用方继续拥有事务、主记录和 project-only permission cleanup
- [x] 删除旧 session owner 内被新 interface tests 覆盖的重复测试，并保留 project deletion integration coverage
- [x] 定向 owner tests 4/4 passed，覆盖七类子表、双向 fork 关联、foreign keys off 与 caller rollback
- [x] Rust library suite 369/369 passed（包含 owner tests 与 project deletion integration test）
- [x] `cargo check --locked --lib` 通过
- [x] `cargo fmt --all -- --check`、planning-doc Prettier 与 `git diff --check` 通过
- [x] 复核仍在 `beta`，三个版本均为 `0.4.0-beta.2`；不 commit/push/publish/release/main sync
- **状态：** slice 145 complete；阶段 3 与全仓治理目标继续 in_progress

### 第 145 切片错误与基线记录

| 结果/错误                                                                                                         | 次数 | 处理                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------ |
| 初始 Rust 测试编译提示 cleanup owner 的 glob re-export 不能以 `pub` 可见性导出 crate-private 项                   |    1 | 改为显式 `pub(crate) use`，保留 lifecycle 的 crate 内调用路径      |
| no-op owner 的四项合同测试均因遗留子表未删除而失败                                                                |    1 | 这是预期 red baseline；实现后定向 4/4、Rust library 369/369 均通过 |
| 最终 Rust format check、planning-doc Prettier check 与 diff check 分别发现新 owner 格式、计划表格格式及文件尾空行 |    1 | 对受影响 Rust 文件和计划文件定向格式化后重跑，三项检查均通过       |
| 最终计划更新 patch 的表格上下文与 Prettier 格式化后的实际文本不匹配                                               |    1 | 读取当前计划末尾后按已格式化的上下文精确更新                       |

## 第 146 轮候选审计：核心 runtime owners

- [x] 恢复全仓结构治理计划、发现、进度与 session catch-up；catch-up 无新增报告
- [x] 以当前 checkout 复核 `beta...origin/beta` 和三个 `0.4.0-beta.2` 版本声明
- [x] 按源码行数定位仍较大的 runtime owners，仅将其作为候选发现信号
- [x] 检查 `PiSubagentRuntime` 的职责群、调用方、已有 owners 与测试 seam
- [x] 复核 Host task-control parser 的直接测试与所有导出/调用点；worker 与 unit manifests 使用显式 test lists
- [x] 选定窄 seam：把 Host terminal task bridge/response parser 从 Pi child lifecycle 分离；保留 Pi/Host task routing 与 mixed-scope 拒绝
- [x] 为新 Host task-control owner 写 fake ToolGateway/context 合同测试；no-op owner 上 4/4 按预期失败，覆盖身份透传、缺失 session 拒绝、Host error 映射和 parser
- [x] 实现 owner，保留 `session-adapter.ts` 的 parser compatibility export，迁移 parser assertions 到 owner；Pi/Host task routing 和 mixed-scope 拒绝仍在 subagent runtime
- [x] 将新 owner test 纳入 worker 与 root unit test manifests
- [x] 运行完整验证：worker tests 180/180、root unit tests 454/454、`pnpm check`、lint、format、`pnpm build` 与 `git diff --check` 均通过；Pi compatibility tests 107/107
- [x] 复核仍在 `beta...origin/beta`，package/Cargo/Tauri 版本均为 `0.4.0-beta.2`；不 commit/push/publish/release/main sync
- **状态：** slice 146 complete；阶段 3 与全仓治理目标继续 in_progress
- **已完成（Slice 149）：** 将 `session-projection-updates.ts` 的 legacy billing snapshot parser 合并到已有 `domain/agent/billing-usage.ts` owner；保持 timeline mutation 与 context-usage parsing 原位，并沿用 `applySessionUpdate` 测试接口。

### 第 146 切片集成修复记录

| 错误                                                                                                                 | 次数 | 解决方案                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ---: | ----------------------------------------------------------------------------------------------- |
| Worker TypeScript check 发现 `PI_GET_COMMAND_OR_SUBAGENT_OUTPUT` 在 parent 成为 unused import                        |    1 | 从 parent 移除已迁移到 owner 的 import                                                          |
| 首次完整 `pnpm check` 发现 compatibility checker 仍要求 event acceptance/SQLite arbitration 在旧 supervisor owner 中 |    1 | checker 改为读取 `event_pipeline.rs` 并检查 parent wiring；新增 CLI 回归用例覆盖错误 owner 定位 |

### 第 146 切片工具错误记录

- 一次 planning-doc patch 将 `progress.md` 路径拼错为不存在的位置，未应用文件改动；改用 workspace 中的正确路径重试。

| 错误                                                                                                       | 次数 | 解决方案                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------- |
| 一次包含新模块、两份测试 manifest 与 facade test 的大 patch 未匹配 root `package.json` 的长 `test:unit` 行 |    1 | 该 patch 未应用任何文件；改为分文件、小 patch，先写 owner tests，再独立更新 manifest 并核对现有 dirty 内容 |
| 第一次集成运行的 owner test 把合法空快照 `[]` 当作 malformed response                                      |    1 | 保留 parser 既有的空数组语义；测试显式断言 `[]` 返回空列表，只对无效 JSON/对象/status 断言响应错误         |
| 两次试图将上述测试假设修正追加到 `progress.md` 的 patch 因长行上下文匹配失败                               |    2 | 未应用文件改动；改用该 slice 标题作为短锚点写入进度记录                                                    |
| 一次候选审计记录的长 patch 未匹配 `findings.md` 末尾锚点，未应用任何文件                                   |    1 | 按文件分别使用短锚点更新，避免跨文档长 patch                                                               |
| 一次 store LOC 命令使用了未匹配的 `*.tsx` zsh glob                                                         |    1 | 不重复失败命令；改用 `rg` 文件与导入图完成只读审计                                                         |

### 后续候选复核：Composer 与 agent store

- [x] 复核 `agent-composer.tsx` 的职责、直接消费者及可抽取的行为边界
- [x] 复核 `agent-store.ts` facade 与现有按 session/receive/submit/configuration/interactions 拆分的 owner 图
- [x] 复核 `use-agent-bridge.ts` 的运行顺序、失败语义、单点消费者与当前测试边界
- [x] 复核 `agent-workspace-actions.ts` 的跨面板状态转换与调用者 interface 宽度
- [x] 对照各 transition action 与 `primaryViewKey` 优先级，确认不能假设所有 surface 严格互斥
- [x] 确认 `primaryViewKey` 与 `AgentWorkspaceView` 存在重复 screen priority 投影，记录 Settings/WorkspacePanel/NewTask 的渲染层级
- [x] 判断是否存在可减少调用者知识、又不增加浅层 UI/状态包装的深模块 seam
- **结论：** Composer/store 暂不拆分；workspace actions 中的跨 surface 状态转换比机械拆 hook 更有结构治理价值。billing parser seam 在该审计时仍待回复，后续已通过现有 `applySessionUpdate` interface 于第 149 切片解决；workspace/store 与 Host router 的未决测试 seam 仍不推定为已获选择。
- **工具错误：** 首次异步 seam 问题调用使用了不支持的 `question` 字段，被参数校验拒绝；改为 `title`+`options` 后已成功提交。

### 2026-10-12：累积 beta 工作树全量复验

- [x] 前端 root unit tests：454/454；worker tests：180/180
- [x] `pnpm check`、`pnpm check:architecture`（5/5）、lint、format 与 production build
- [x] Rust library tests：369/369；`cargo check --lib`、`cargo fmt --all -- --check`
- [x] `git diff --check`；branch `beta`；package/Cargo/Tauri versions all `0.4.0-beta.2`
- **结果边界：** build 仍显示既有 Monaco/editor 与 language chunk 大于 500 KB 警告；未执行桌面 UI/平台验收；全仓目标仍未完成。

## Workspace store 候选审计

- [x] 审查 `workspace-store.ts` 的项目/session 状态、持久化调用、删除前 engine stop 顺序及直接调用方
- [x] 确认它是跨 project/session 当前选择与 session 列表维护的聚合；拆分 CRUD 可能扩大接口并分散状态不变量
- [x] 记录无 owner-local store tests 的可验证性缺口，并发现 `selectProject` 的异步完成没有 stale-selection guard
- **结论：** 暂不按项目/session 名义拆 store。若将此处作为后续切片，应先确认以 store 外部接口测试选择顺序及 stale completion 的测试 seam；当前不新增测试或实现。

## Pi session bridge 候选审计

- [x] 复查 `use-agent-bridge.ts` 的 archive/preflight/subscription/start/open/cleanup 顺序与所有 async 回边
- [x] 对照 `CONTEXT.md` 的 latest-request 规则，检查 capability preflight 的 stale failure 路径
- [x] 核验测试基础设施：root unit 使用 Node `--experimental-strip-types` 与显式 manifest；没有 React hook renderer/DOM test library，也没有 `useAgentBridge` lifecycle tests
- [x] 识别最窄可能 seam 为完整 session-connect coordinator + production/fake adapters；不把 React cleanup 或 Host authorization 从现有所有者转移
- **结论：** hook 仍是一个内聚生命周期 owner；但 Pi capability preflight 的 reject catch 缺少 `disposed` guard，可能让旧 session 的错误覆盖当前 status。比单纯拆分 hook 更值得先固定该生命周期合同；测试 seam 尚未确认。
- **工具错误记录：** 一次 `request_user_input_async` 使用了不存在的 `question` 字段，被 schema 拒绝；将完整问题并入 `title` 后成功提交。workspace-store latest-request seam 选择仍待用户回复。

## Host/Pi tool routing 结构审计

- [x] 沿 worker event pipeline、Host tool routing 与 ToolGateway 追踪 WorkspaceRegistry authorization、persisted permission、hooks 和工具 dispatch
- [x] 复核 Host-root/path binding、Persisted deny precedence、memory/browser/MCP-specific permission gates 与 gateway terminal/file policy
- [x] 检查 owner-local verification：ToolGateway 有直接 Rust tests，event pipeline 有 fake persistence/ordering tests；683 行 Host router 无直接 test module
- **结论：** 当前源码仍将最终 workspace/session/permission routing 留在 Host；未发现 extraction 让 worker 越过 Host。但 Host router 的跨 owner authorization path 是真实验证缺口，优先级高于再拆纯 helper。尚未定义或确认可测试的 router interface，不添加测试或改变 dispatch。
- **Code-review workflow 限制：** `code-review` skill 需要用户指定固定基线并检查 commit diff；当前 ref 是 `beta` HEAD 等于 `origin/beta` 且改动为未提交/未跟踪工作树，因此没有任意指定基线或把此限制说成完整独立 review。

## 第 147 切片：Pi ToolGateway request-policy 测试归属

- [x] 将 8 个只验证 request-policy 纯函数的测试迁移到 request_policy.rs 的 owner-local 测试模块
- [x] 保持测试语义与断言不变；Gateway dispatch、Host 授权、文件/终端/monitor/scheduler 集成用例留在 parent
- [x] 验证 request-policy 8/8、Pi ToolGateway 37/37、Rust library 369/369、cargo check 和 cargo fmt --check
- **状态：** slice 147 complete；只调整测试边界，没有 production behavior 或 Host authorization 变化；整体治理目标仍 in_progress
- **工具错误记录：** 首次删除测试的补丁基于未格式化代码，未匹配到 parent 实际源文本；一份 findings 补丁误把 progress 文档的 review 说明作为锚点，也未应用。重读对应文件后按单文件实际短锚点更新；先在 owner 添加并运行 8 项用例，再精确删除原副本。

## 下一高价值候选：Host 路由协调器接口

- [x] 复核当前 worker root / WorkspaceRegistry 后代授权、instruction preflight、PreToolUse、持久权限、工具路由和 resolution/post-hook 顺序
- [x] 确认 request-policy 纯函数测试与 event-pipeline fake port 均不能证明上述完整 Host 顺序
- [x] 草拟 production Tauri/Host adapter 与 recording test adapter 共用的协调器 seam；Host 仍是唯一授权权威
- [ ] 写测试前请用户确认：是否以完整 Host 路由协调器作为下一测试接口
- **状态：** 高价值测试缺口已定位，尚无新实现或测试；等待此接口选择，同时全仓治理目标保持 in_progress。

## PiSessionAdapter residual owner audit

- [x] 复核剩余类的 owners、command/event consumers、resource refresh sequence 与现有 interface-level tests
- [x] 核对 root/child resource factory 和 Host policy snapshot 的共享约束
- [x] 判断进一步拆分是否能提供小而深的接口，还是会新增宽 callback facade
- **结论：** 保留 PiSessionAdapter public command/event interface 及 root/child refresh、event/run-state orchestration；不按 LOC 拆分。per-session resource binding 创建是更窄的独立 owner，见第 148 切片。

## 第 148 切片：Pi session resource-loader owner

- [x] 将 per-session Pi ResourceLoader、受控 Skill/prompt 路径刷新和 scoped instruction 初始化移入 `session-resource-loader.ts`
- [x] 保持 `PiSessionAdapter` 为 root/child 共享工厂与 Host policy 状态 owner，保留现有 command/event 测试接口
- [x] 更新 Pi compatibility checker，使其同时核验 loader owner 与 adapter 接线，并添加两项 owner-wiring 回归测试
- [x] 验证 adapter 25/25、worker 180/180、root unit 454/454、Pi compatibility 109/109、`pnpm check`、lint、format、build、`git diff --check`
- **状态：** slice 148 complete；Pi-only runtime、Host policy authority、资源刷新次序与既有行为未变；全仓结构治理目标继续 in_progress
- **验证记录：** 首次聚合 check 揭示静态 checker 仍依赖旧 import 位置；迁移 checker 约束至新 owner 并加入回归后，聚合 check 全绿。

## 第 149 切片：billing usage normalization owner

- [x] 将 camel/snake-case `AgentBillingUsage` 解码与校验移到既有 `billing-usage.ts` owner
- [x] 保持 `session-projection-updates.ts` 对 turn-completion 时序、timeline 写入与 context-token 状态的所有权
- [x] 沿用现有 `applySessionUpdate` 测试 interface，不新增 parser-private seam
- [x] 基线 focused tests 27/27；改动后 root unit tests 454/454，`pnpm check`、architecture 5/5、lint、format、build 与 diff check 通过
- **状态：** slice 149 complete；只收敛 billing parsing ownership，不改变事件顺序或 Host/Pi routing

## 第 150 切片：tool activity input/text projection

- [x] 在 `tool-activity.ts` owner 统一解包 Host gateway input，并 projection command/output text
- [x] 让 `session-projection-updates.ts` 继续拥有 tool-row 生命周期、状态/时间戳、permission 与 timeline mutation
- [x] 通过既有 `applySessionUpdate` / `projectAgentEvent` 集成界面保留生命周期行为覆盖；新增 owner-interface test 覆盖嵌套 Host args 和 content-block 文本优先级
- [x] 基线 focused tests 54/54；新增测试先在缺少 export 时失败，完成后 focused suite 55/55
- [x] root unit tests 455/455，`pnpm check`、architecture 5/5、lint、format、production build 与 `git diff --check` 通过
- **状态：** slice 150 complete；Host tool payload parsing 归属一致，Host authorization 与 runtime routing 未变

## 当前持续审计状态

- [x] 对 Slice 150 之后的累积工作树重跑规划文档 Prettier 与 `git diff --check`；两项通过
- [x] 复核当前仍为 `beta...origin/beta`，`package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 版本均为 `0.4.0-beta.2`
- [x] 统一 `AgentGoalPolicy`、subagent inventory 与 Pi memory source comments 的 Pi-only 语义；为保留的 2026-10-05 验收快照补充 10-11 的 ACP fallback supersession note，并通过 root `pnpm check` 与格式检查
- [ ] 继续审计尚未确认的 Workspace store / Host router 测试 seam；不把新的用户消息误当成对特定接口的选择
- [ ] 窄视图投影候选：等待用户确认是否让 Workspace 动画 key 与主内容分支共用优先级投影；不改变状态转换
- [x] 审计 context-usage 所有权：确认 parser 仅是小型 wire-shape normalization；抽成单函数 owner 会过浅，且持久化/model fallback 属于相邻但不同职责，暂保留在现有 projection owner
- [x] 审计 Pi ToolGateway workspace-tools 测试归属：现有用例经 `resolve_request` 验证 Host root/gitignore/permission policy、tool-resolution envelopes、patch atomicity 与 user-facing listing/search behavior；保留这些 gateway contract tests，不降低为 private child-function tests，也不改变授权路径
- [x] 复核 Pi-only runtime routing 已有测试接口：Desktop legacy preference 仍路由 Pi，浏览器预览保留确定性 ACP fixture，session ID 语义分开覆盖；不重复造测试 seam
- **状态：** 全仓结构治理仍 in_progress；未 commit/push/publish/release 或同步 `main`
- **工具错误记录：** 首次向 `progress.md` 追加本轮核对记录时使用了已过期的尾行文本作为锚点；补丁未应用。读取真实文件尾部后按当前内容重试成功。
- **工具错误记录：** 本轮 `findings.md` 追加审计项的首个补丁误用了 `progress.md` 的尾行作为锚点，未应用；读取 findings 实际尾部后改用对应内容重试成功。

## 第 151 切片：Pi 持久分支 owner

- [x] 将 Pi 原生持久分支校验、锚点验证、独占复制与临时文件清理从 `PiSessionAdapter` 收敛到 `session-fork-runtime.ts`
- [x] 保留 `PiSessionAdapter.fork()` 命令接口和源会话 lifecycle queue；目标会话仍通过原 `openInternal` 路径创建
- [x] 通过既有公开命令接口覆盖真实持久分支、目标独立性、源叶节点稳定性与 `session.opened` 事件
- [x] 验证 adapter focused tests 26/26、worker tests 181/181、root unit tests 456/456、`pnpm check`（Pi compatibility 109/109）、architecture 5/5、lint、format、build 与 `git diff --check`
- **状态：** slice 151 complete；Pi-only runtime、Host 授权裁决与既有 fork 校验/错误语义保持不变；全仓结构治理继续 in_progress
- **工具错误记录：** 首个提取补丁因源码上下文不匹配未应用；拆分为 import、构造接线和方法替换后完成。Node strip-only 首跑不支持参数属性，改为显式依赖赋值后通过；Prettier 自动整理了 adapter import。

## 第 152 切片：Pi session import transaction owner

- [x] 将 Host-to-Pi 导入的校验、备份选择、session 替换和生命周期事件握手从 adapter 移入 `session-import-runtime.ts`
- [x] 保留 `PiSessionAdapter.importSession()` 命令接口、源 session lifecycle queue、Host journal 权威性与原有 `closeInternal` / `openInternal` 路径
- [x] 在原公开命令接口验证已有 session 替换：显式备份、native ID 更新、不发 `session.closed`，并按 `session.imported` -> `session.opened` -> warning 排序
- [x] 验证 adapter focused tests 27/27、worker tests 182/182、root unit tests 457/457、`pnpm check`（Pi compatibility 109/109）、architecture 5/5、lint、format、build 与 `git diff --check`
- **状态：** slice 152 complete；Host binding journal 在 import event 处提交的协议次序保持不变；全仓结构治理继续 in_progress
- **工具错误记录：** characterization test 首次运行因 fixture 没有先落盘 native 文件而未产生 backupPath；向 fixture 写入一条 user message 后基线通过。Adapter import 格式检查提示需运行 Prettier，格式化后门禁通过。首次汇总文档补丁因旧 task-plan 行文本不匹配未应用，拆成独立文件补丁后重试。

## 第 153 切片：Pi session configuration transaction owner（已完成）

- [x] 将 `PiSessionAdapter.configureInternal()` 中完整的会话配置事务交给 `session-configuration-runtime.ts`；保留 `configure()` 的公开命令接口和 per-session lifecycle queue。
- [x] 使用已选定的 `PiSessionAdapter` 命令/事件 seam；保留现有 atomic-validation、revision、模型/思考强度/权限/模式投影及 `session.configured` 事件合同，不新增测试 seam。
- [x] 保持 Host 授权、Pi-only routing、模型目录 ownership 与 lifecycle 串行化归属；handoff code map 已同步。
- [x] 验证 adapter 27/27、worker 182/182、root unit 457/457、`pnpm check`（Pi compatibility 109/109）、architecture 5/5、lint、format、production build 与 `git diff --check`。
- **状态：** slice 153 complete；配置验证/提交/acknowledgement 归属更集中，Host authority 与 Pi-only runtime 不变；全仓结构治理继续 in_progress。
- **工具错误记录：** 首次聚合规划补丁的 findings 锚点与真实文本不匹配，未应用；首次聚合实现补丁的 adapter 上下文也未匹配，未应用代码。重读尾部及当前方法后，拆分规划补丁并按源码精确范围完成提取。
- **工具错误记录：** 并发命令回收时误传了未取得的 session IDs，出现 `Unknown process id`；随后同步重跑 `pnpm check`、架构、lint 和格式门禁，均明确 exit 0。

## 第 154 切片：Pi attachment turn-input preparation owner（已完成）

- [x] 在已选定的 `PiSessionAdapter.submit()` seam 增加 aggregate attachment ceiling characterization，并在原实现上先验证超限时无 `run.accepted`/Pi prompt 副作用。
- [x] 将模型 modality 检查、逐项 decode、总字节 ceiling 和 text/image prompt projection 收敛至现有 `attachment-policy.ts` owner，保留 adapter 的兼容 exports 与 submit 后续命令排序。
- [x] 在公开 submit seam 覆盖 text attachment inline placement 与 image block delivery。
- [x] 验证附件格式/大小/model capability 与 submit 可观察行为；Host authorization、Pi-only routing、run admission 与幂等逻辑不变。
- [x] 验证 adapter 29/29、worker 184/184、root unit 459/459、`pnpm check`（Pi compatibility 109/109）、architecture 5/5、lint、format、production build 与 `git diff --check`。
- **状态：** slice 154 complete；附件校验与输入投影 ownership 集中到既有 policy owner，Host authority、Pi-only routing 和 run acceptance 顺序不变；全仓结构治理继续 in_progress。
- **工具错误记录：** 与门禁并行时 root `pnpm test:unit` 的 Research source-adapter timing assertion 观测到 24ms 而期望 25ms；相同断言单独运行通过，随后完整 root suite 单独运行 459/459 通过。未改 Research 实现。

## 第 155 切片：Pi session close lifecycle owner（已完成）

- [x] 使用既有 `PiSessionAdapter.close()` 命令/事件 seam 增加活动 Pi run 关闭特征测试；在原实现上先验证 `abort`、单一 cancellation terminal event 与 `session.closed` 顺序。
- [x] 将 session lookup、subagent cancellation、Pi queue/stream disposal、handle/idempotency removal 和 ordered lifecycle emission 收敛至 `session-close-runtime.ts`；adapter 继续保留 per-session lifecycle queue。
- [x] 让 Host-to-Pi import 复用 close owner 并继续以 `emitLifecycle=false` 抑制中间关闭事件，保持 binding journal 握手顺序。
- [x] 验证 adapter 30/30、worker 185/185、root unit 460/460、`pnpm check`（Pi compatibility 109/109）、architecture 5/5、lint、format、production build 与 `git diff --check`。
- **状态：** slice 155 complete；Pi-only runtime、Host authorization、import 事件合同与已有关闭行为保持不变；全仓结构治理继续 in_progress。
- **工具错误记录：** 无实现/验证门禁错误；production build 仍有既有 >500 kB chunk warning。

## 第 156 切片：Pi persisted subagent resume interface coverage（已完成）

- [x] 复核 `PiSubagentRuntime` 现有直接 interface tests、record-parser tests 与 worker-smoke lifecycle coverage，确认尚无 owner-level persisted `resume_from` 流程用例。
- [x] 在已选定的 `PiSubagentRuntime.spawnSubagent()` / injected Pi SDK adapter seam 覆盖 sidecar load、现有 transcript reopen、saved model/reasoning continuity、continuation prompt 与 terminal task projection；不访问 private task map、不新增接口。
- [x] 验证 focused resume test、worker 186/186、root unit 461/461、`pnpm check`（Pi compatibility 109/109）、lint、format 与 `git diff --check`。
- **状态：** slice 156 complete；仅加强既有 runtime owner 的持久恢复验证，不改生产行为、Pi-only routing 或 Host authorization。
- **工具错误记录：** 初始 fixture 使用不存在的 `/workspace/root` 被 cwd 校验正确拒绝；改为真实 canonical 临时 workspace 后，下一次断言暴露 macOS `/var` 与 `/private/var` 路径别名；统一使用 `realpath` 后通过，均未改生产代码。

## 第 157 切片：Config facade tests 回归职责 owners（已完成）

- [x] 审查 `config_runtime.rs` 的 21 项测试及各被测函数实际定义，确认它们直接调用 child-owner helper，不覆盖 facade 命令或 `pi_resource_manifest` 组合行为。
- [x] 将扩展扫描 2 项、marketplace source 3 项、plugin/skill details 7 项、Pi resource inventory/scanning 4 项、config patch 2 项、marketplace catalog/message projection 3 项测试迁回六个对应 owner-local test modules；保持测试内容和断言不变。
- [x] 保留 `config_runtime.rs` 的 Tauri command/composition 实现不变；没有更改 Host workspace authorization、Pi policy、运行时路由或 wire contract；没有新增测试 seam。
- [x] Rust 全 library tests 369/369、`cargo check --locked --lib` 无 warning、`cargo fmt --check` 与 `git diff --check` 通过。
- **验证边界：** 本切片只确认迁移测试与 Rust 库状态；不声称覆盖 `config_runtime` 命令授权/组合顺序。全仓治理仍 in_progress，先前未确认的 Workspace-store、Host-router 和 view-projection seams 继续保持未选择。
- **状态：** slice 157 complete；21 项行为断言回到其函数实际 owner，facade 与实现测试职责更清楚；全仓结构治理继续 in_progress。
- **工具错误记录：** 首轮全测揭示旧测试专用 Pi-resource re-export 在新归属下变为 unused；收窄为仍由 `config_extensions` 测试使用的 `scan_pi_skill_root` 后，全量 Rust 测试与检查无 warning 通过。

## 第 158 切片：Pi Hook 配置与 Host 执行 owners（已完成）

- [x] 按调用图拆分 `pi_hook_runtime.rs`：`hook_config.rs` 拥有有界文件发现、definition parsing、unsupported-field inventory 与 capability snapshot；`hook_execution.rs` 拥有 event payload、matcher、受限命令进程及 PreToolUse decision。
- [x] 根 `pi_hook_runtime.rs` 收窄为 crate compatibility facade，并通过原 `pi_hook_runtime::*` paths re-export 清单/执行接口，保持 `config_runtime`、`host_tool_routing` 与 Tauri handler 的既有调用路径。
- [x] 将直接 Hook matcher/config tests 移到对应 owners；保留 facade 处的 command denial integration test。Host 路由的 workspace authorization -> PreToolUse -> persisted permission -> gateway 顺序、resolution-before-observational-post-hook 顺序均未修改。
- [x] 更新 Hook compatibility checker，使其分别读取 config/execution owner，检查 facade imports/re-exports、execution 对 config parser 的 wiring，并按真实 owner 比对七项限额；原 Tauri command/workspace hook route checks 保持。
- [x] 验证 Hook 定向 tests 3/3、Hook source-compatibility fixtures 8/8、Rust library tests 369/369、warning-free `cargo check --lib`、Rust fmt、`pnpm check`（Pi/Tauri fixtures 109/109）、root unit tests 461/461、lint、format 与 `git diff --check`。
- **证据边界：** 本切片验证现有 Host bridge 的结构 wiring 和既有行为合同，不证明所有外部 Hook 命令语义等价于其他 runtime；没有修改 Host authorization、Pi-only route 或 hook failure semantics。
- **状态：** slice 158 complete；配置资格/preflight 与 Host hook execution 各自有单一 owner，兼容门禁也按 owner 验证；全仓治理继续 in_progress。
- **工具错误记录：** 首版 Hook fixture 把配置/执行标记仍放在 facade snapshot，导致 7 项测试识别到新所有权后失败；按真实 owner 划分 fixture 输入与 marker 后，Hook fixtures 8/8 通过，聚合 `pnpm check` 全绿。

## 第 159 切片：Pi monitor 有界输出策略 owner（已完成）

- [x] 将每行 UTF-8 截断、滚动窗口与生命周期事件预算、200 行尾部缓存收敛到 `pi_monitor_runtime/output.rs` 的 `MonitorOutput`。
- [x] `pi_monitor_runtime.rs` 继续持有任务/会话身份、注册表、沙箱进程、取消与 stdout/stderr reader/waiter 生命周期；输出限流触发后的 `AutoStopped` 状态、事件顺序及停止提示留在运行时协调器。
- [x] 保留既有 `start_monitor`/snapshot 进程级 seam；将原有 2 项纯限流/截断断言移到输出策略 owner 的测试模块，没有新增运行时接口或改变测试语义。
- [x] 预提取 monitor tests 6/6；提取后运行时集成 4/4、输出策略 2/2、Rust library tests 369/369、无 warning `cargo check --lib`、Rust fmt、`pnpm check`（110 fixtures）、lint、format 与 `git diff --check` 通过。
- **证据边界：** 本切片验证现有行预算、截断、任务输出快照及进程集成；不改变或替代 workspace authorization、Host permission、sandbox 决策和 monitor task ownership。
- **状态：** slice 159 complete；输出资源预算与尾部缓存有单一 owner，进程/事件生命周期仍由 Host monitor runtime 持有；全仓结构治理继续 in_progress。
- **工具错误记录：** 移除原输出策略测试时留下的 `#[test]` 一度附着到 cleanup helper，编译器明确报错后删除了 stray attribute；首轮普通 `cargo check` 提示限流常量只在测试用，改为 `cfg(test)` 导入后最终 check 无 warning。一次 patch 使用了 rustfmt 前的导入顺序锚点而未应用，按实际格式重试。

## 第 160 切片：Pi subagent policy 输入规范化 owner（已完成）

- [x] 将 Host policy manifest 的有界解析、类型/isolation/capability mode alias 规范化及共享的结构化 policy error 移入 `subagent-policy-normalization.ts`；`subagent-policy.ts` 保留 default/resolution、parent-child 权限与 capability 取交集、launch projection 和 prompt composition。
- [x] 在旧 `subagent-policy.ts` 保留原规范化函数、built-in type guard 与类型 exports；resource snapshot、ToolGateway、record/resume/task 类型调用方改为依赖实际 normalization owner。
- [x] 更新 Pi compatibility gate，分别检查 normalization 与 policy owners、旧路径重导出/导入 wiring；MCP Host-worker bound 校验从两个 owner 的合并 source snapshot 读取实际常量。
- [x] 既有 policy suite 预提取 13/13，compatibility fixture 6/6；提取后 `pnpm test:agent-worker` 186/186、`pnpm test:unit` 461/461、`pnpm check`（Pi/Tauri fixtures 110/110）、`pnpm check:architecture`、lint、format、production build 与 `git diff --check` 通过；build 保留既有 >500 kB chunk warnings。
- **证据边界：** 这是 worker 内纯输入归一化和策略 projection 的归属重整；Host 仍是最终安全/授权裁决者，Pi-only route、MCP grant/parent ceiling、错误形状与 launch/resume 行为不变。全仓目标继续 in_progress；Workspace store、Host router 与共享 Workspace view-projection seams 仍未选择。
- **状态：** slice 160 complete；untrusted snapshot/alias bounds 与策略选择、launch projection 有清晰 owner，旧 import path 兼容。
- **工具错误记录：** 首轮 Prettier 检查发现新 normalization owner 的格式需统一；仅格式化该新文件后，最终完整 format gate 通过。

## 第 161 切片：Pi subagent task-command event projection（已完成）

- [x] 在既有 `PiSubagentRuntime` 命令/event seam 增加 wait 与 cancel 命令的响应特征测试；先对原实现运行，精确锁定 request/session envelope 与 `task.changed` payload。
- [x] 让 `waitTask` 和 `cancelTask` 共用同一 task-command response projection；两条路径仍各自负责 wait/cancel、完成等待和当前 task 状态读取。
- [x] 保留请求身份、status、child session、output、subagent type、role/persona/agent、capability/permission mode、isolation 字段及事件发送次序。
- [x] 验证 targeted runtime tests 3/3、worker tests 187/187、root unit tests 462/462、`pnpm check`（110 Pi/Tauri fixtures）、architecture 5/5、lint、format、production build、Rust library tests 369/369、warning-free Cargo check、Rust fmt 与 `git diff --check`。
- **状态：** slice 161 complete；消除 wait/cancel 两份响应 payload 的漂移点；没有改变 task lifecycle、Host authorization、Pi-only routing 或 worker wire behavior。

## 第 162 切片：Workspace patch owner tests 回归实现模块（已完成）

- [x] 按用户确认的 owner-only 范围，把两项直接调用 `apply_patch` 的既有行为测试迁入 `pi_tool_gateway/workspace_tools.rs`；测试断言/patch 输入/文件结果不变。
- [x] `reads_only_authorized_relative_files`、search/list/gitignore 和 symlink 等经 `resolve_request` 或 Host permission policy 的集成测试仍留在 `pi_tool_gateway.rs`，继续覆盖 Host policy 与 dispatch，不改 production routing。
- [x] Workspace owner focused tests 2/2、Pi ToolGateway parent tests 与完整 Rust library tests 369/369 通过；`cargo check` 无 warning、`cargo fmt --check`、`pnpm check`（110 fixtures）、root unit 462/462、worker 187/187、architecture 5/5、lint、format、build 与 `git diff --check` 通过。
- **状态：** slice 162 complete；owner-local tests 与 Host integration coverage 分工明确；未新增测试 seam、未改变 Host 授权或文件运行逻辑。
- **工具错误记录：** 首次 `cargo fmt --check` 只报告新 fixture helper 的行格式；运行 Rust formatter 后重验。

**总体状态：** 全仓结构治理仍 in_progress；Workspace store latest-request、Host router coordinator 和共享 Workspace view-projection 等尚未选择的测试 seams 继续等待明确选择。

## 第 163 切片：Pi Session event lifecycle owner（已完成）

- [x] 在既有 `PiSessionAdapter.open()` / `submit()` command-event seam 增加 `agent_settled` 投影特征测试，先通过公开命令验证 run terminal envelope 与去重。
- [x] 将 `message_end` 错误投影、Pi event mapping/anchor enrichment、subagent observation、settled/context events、event-tail 串行化与失败终结收敛到 `session-event-runtime.ts`。
- [x] adapter 保留 session creation/subscription 注册、command lifecycle queue、公开兼容 command 与 Host/worker 路由；事件 owner 只依赖 session context resolver、subagent observer 和 emitter。
- [x] 不改变 Pi-only runtime、Host 安全/权限裁决、session/run/stream 身份、事件次序、error code、native leaf anchor 规则或 worker wire shape；未触碰尚未选择的 Workspace store、Host router、Workspace view-projection seams。
- [x] 验证 session adapter、worker/root tests、`pnpm check`、architecture、lint、format、production build 与 `git diff --check`；同步 handoff/治理文档。本 slice 未改 Rust，因此未重跑 Cargo。
- **状态：** slice 163 complete；事件桥接责任归属收敛，完整全仓治理目标仍 in_progress。

## 第 164 切片：Marketplace atomic install transaction owner（已完成）

- [x] 恢复 task plan/findings/progress 并执行 session catch-up；catch-up exit 0，无未同步报告
- [x] 复核当前 `beta...origin/beta`、累积 dirty worktree 与 `0.4.0-beta.2` 三处版本声明；保留现有状态
- [x] 沿 install/update 调用图确认共享的 `install_snapshot` 事务有五处生产调用；Tauri authorization、source resolution 与 clone lifecycle 保持在命令 owner
- [x] 在既有 module-level transaction test interface 增加 registry commit failure rollback characterization；在提取前 Rust focused test 1/1 通过
- [x] 把 staging/copy、target replacement、registry commit/rollback 和 backup cleanup 收敛到 `config_marketplace_install_transaction.rs` 的有命名请求接口；transaction behavior tests 已移入 owner，candidate/source orchestration tests 留在 parent
- [x] 保持 Marketplace identity、registry unknown fields、safe path/size bounds、install/update result/error behavior 与 Host workspace authorization 不变；focused and full Rust gates pass
- [x] 验证 transaction owner tests 2/2、Marketplace candidate install/refresh integration 1/1、全 Rust library 370/370、warning-free Cargo check、Rust fmt、`pnpm check`（110 compatibility fixtures）、architecture 5/5、lint、format/Prettier 与 `git diff --check`
- [x] 将 owner map 同步到 Pi migration handoff；最终复核 `beta...origin/beta`、三处 `0.4.0-beta.2` 版本一致，累积 dirty worktree 保持原样
- **验证边界：** 本切片仅改 Rust 与架构/规划文档，因此没有重跑前端 unit suite 或 production build；没有更改 Host authorization、runtime selection、Marketplace source policy、install/update command output 或 release state。
- **状态：** slice 164 complete；staged filesystem+registry install/update transaction 有单一 owner，整体全仓治理目标仍 in_progress。
- **工具错误记录：** 首次 `functions.exec` 的 JavaScript orchestration 语法错误在 shell 命令执行前被拒绝，未改工作树；一次 Cargo test filter 编译成功但匹配 0 tests，随后改用三个唯一测试名确认 3/3；根目录 `cargo fmt --all -- --check` 找不到 `Cargo.toml`，改为传入 `src-tauri/Cargo.toml` 后发现新文件格式差异，运行 formatter 并重新检查通过。

## 第 165 轮候选审计：PiSubagentRuntime residual lifecycle owners（进行中）

- [x] 复核 `beta...origin/beta`、三处 `0.4.0-beta.2` 版本声明和累积 dirty worktree；session catch-up exit 0，无恢复报告
- [x] 确认上一 goal turn 的 Slice 164 有真实代码/测试进展，并修复规划文件中遗留的 Slice 164 stale `(进行中)` heading
- [x] 复查 `subagent-runtime.ts` 既有拆分记录、当前源文件/测试体量、依赖与公开运行时接口；避免重复 Slice 130、policy/records/boundaries/host-task-control/task-response owners
- [x] 审阅事件观察、模型/资源刷新、root cancel/shutdown、持久记录与 `PiTaskController` 的 wait/cancel 运行顺序
- [x] 审阅 `spawnSubagent()` 的 setup 与 post-open run lifecycle 顺序，确认 cancellation race、event-tail failure cleanup、terminal event、resume persistence 与 foreground/background 返回的耦合点
- [x] 核对生产调用路径和现有 `spawnSubagent()` public behavior tests；采用既有 injected Pi SDK runtime seam，不增加 owner-local test port
- [x] 确认 prepared `TaskHandle` 已含 run/session 状态及刷新回调，可用小型内部接口承接 post-open run lifecycle，不需重造 runtime-wide dependency port
- [x] 通过公开 `spawnSubagent()`/`cancelTask()` 行为 seam 覆盖 running-status emission 期间取消；提取前 runtime tests 4/4 通过
- [x] 将 post-open child task run/terminal lifecycle 收敛为 `subagent-task-lifecycle.ts`；保持 parent setup/Host worktree authorization 与公共 `spawnSubagent()` 接口，Pi runtime 负责 task-map admission 后激活 owner
- [x] 新增 running-status emission 期间取消的公开行为 characterization；提取后 runtime tests 4/4 通过
- [x] 删除失去职责的 parent `onPiEvent()` 转发方法；`pnpm check` 通过（包含 TypeScript、packaging、110 个 static compatibility/permission tests 和 Pi compatibility gate）
- [x] `pnpm test:agent-worker` 通过 189/189；原有 child cancel/shutdown worker smoke 保持通过
- [x] 将 child-task lifecycle owner map 更新到 Pi migration handoff，保留原 `spawnSubagent()` behavior seam 描述
- [x] Root `pnpm test:unit` 通过 464/464；本 slice 仅涉及 worker TypeScript 和文档，不触及 Rust runtime
- [x] `pnpm check:architecture` 5/5、`pnpm lint`、`pnpm format:check`、`git diff --check` 通过
- [x] `pnpm build` 通过；记录既有 Vite >500 kB chunk warnings，不将其归因于本 slice
- [x] Review moved lifecycle block and caller ordering: map admission precedes activation; Host worktree request/authorization and foreground/background selection remain in parent; event/cleanup ordering preserved
- [x] Planning and handoff Markdown Prettier pass (all unchanged)
- **工具错误记录：** 首次 `pnpm check` 因新 owner 接管后 parent `onPiEvent()` wrapper 未清理，报 unused TS6133；删除 dead wrapper 后重跑通过。
- [x] 验证 direct runtime tests 4/4、worker 189/189、root unit 464/464、`pnpm check`（110 fixtures）、architecture 5/5、lint、format、build 与 `git diff --check`
- [x] 复核 `beta...origin/beta` 与三处 `0.4.0-beta.2` 一致；保留累积 dirty worktree，不 commit/push/publish/release 或同步 main
- **状态：** Slice 165 complete；child task post-open execution/terminal lifecycle 有独立 owner，全仓治理目标继续 in_progress。
- **工具错误记录：** 首轮将 Slice 165 characterization 结果同步到 progress 时引用了过期锚点，补丁未应用；按当前行精确替换后完成，未影响测试或源码。
- **工具错误记录：** 首次合并 Slice 165 审计笔记的补丁使用了与实际 `findings.md` 不完全一致的锚点，未应用；读取准确尾行后重试成功，未改动源码。

## 第 166 轮候选审计：subagent definition source inventory（已完成）

- [x] 上一轮 Slice 165 为真实进展；重验 beta 分支、版本一致、工作树、diff check 与 session catch-up
- [x] 生成当前大型生产 owner inventory，并排除受 Host 安全职责约束的 `pi_tool_gateway.rs` 作为移动授权代码的候选
- [x] 审阅 `config_subagents.rs` 入口、源扫描/合并、规范化和输出 projection 的职责；确认两个 `config_runtime` facade callers
- [x] 审阅既有 precedence、unsupported-definition、plugin qualification、inline override tests 及 Host authorization 的真实调用顺序；确认 shared file parser/path visitor 已存在，剩余 projections 仍各自构造不同结果
- [x] 用户批准通过现有 manifest/list behavior seams characterization；新增 nested-project 与 inline-precedence manifest test，在 extraction 前通过 1/1
- [x] 通过已批准的授权 Settings command seam 覆盖文件/inline precedence、scope/path、supported/unsupported、enablement 和 qualified plugin inventory；通过真实 Tauri mock app harness，不增 production test port
- [x] 将有序 native Markdown 与 enabled plugin Markdown 的扫描/解析/来源元数据收敛为 `AgentDefinitionCatalog`；Pi policy 和 Settings 保留独立 projection/conflict 规则及原有调用/授权顺序
- [x] 将 inventory 行为断言留在授权 Settings command seam，并保留 manifest/plugin precedence behavior tests；移除已由公开输出 seam 覆盖的 private scanner projection tests
- [x] 把 discovery/catalog 移入 `config_subagent_catalog.rs`，让 source inventory 成为实际模块 owner；保持 `config_runtime` 调用次序和 registry authorization 不变
- [x] 通过全 Rust library 370/370、warning-free Cargo check、Rust fmt、`pnpm check`（110 fixtures）、architecture 5/5、lint/format/diff gates；复核 owner 与 call order
- [x] 复核当前分支 `beta`、`package.json`/`Cargo.toml`/Tauri config 三处版本均为 `0.4.0-beta.2`；保留累积 dirty worktree，不 commit/push/publish/release 或同步 main
- **状态：** Slice 166 complete；catalog 是独立 source-discovery module，Policy/Settings 保留有意不同的 projections，整体全仓治理目标仍 in_progress。
- **工具错误记录：** authorized Settings characterization 初次发现临时路径 `/var` 与 registry canonical `/private/var` 不同，改为比较 canonical path 后测试通过；首次 catalog 编译缺少 `Clone` derive 且 destructuring 未忽略新增 `path` 字段，修复后 module tests 7/7 通过；移动 catalog 后首轮 `cargo fmt --check` 发现模块/import 排序，执行 formatter 后全 Rust fmt 通过。完整 Rust tests 全部通过，但一个现有 sandbox fixture 输出 `sandbox_apply: Operation not permitted` 后继续并成功；不把它解读为目标平台沙箱执行证明。
- **工具错误记录：** 初始 symbol-search regex 过度转义而无法解析，改用简单模式后完成只读检查；首个 Tauri test 尝试因 `tauri::test` feature 未启用而编译失败。随后仅在 dev-dependency 启用该 feature，未改变 runtime dependency 或 release version。
- **工具错误记录：** 一次 `rg` 同时指向仓库根 `Cargo.toml` 和不存在的 `src-tauri/src/manager.rs` 路径；随后改用 `src-tauri/Cargo.toml` 和 Cargo registry 中实际的 Tauri `state.rs`/`test/mod.rs` 路径确认配置，未影响工作树。

## 第 167 切片：Pi plugin catalog owner（进行中）

- [x] 按本轮仓库规则复核 beta-only 范围、版本 trio 与累积 dirty worktree；planning catch-up exit 0，无未同步报告
- [x] 完成 `config_extensions.rs` 插件 enablement、root discovery、bounded traversal、dedupe/conflict resolution 的职责与生产调用审计
- [x] 用户批准通过现有 `list_melody_plugin_capabilities` 与 `list_installed_melody_plugins` Tauri command seams 写 characterization；不增加 test-only production interface
- [x] 在两个获批 command seams 上先建立并运行现状测试，覆盖插件发现/启用投影与 Marketplace 共用启用规则；提取前 `config_extensions::tests` 12/12 通过
- [x] 将 plugin enablement/discovery inventory 收敛到 `config_plugin_catalog.rs`，保持 `config_extensions` facade/re-export、调用顺序和 `config_plugin_details` parser owner
- [x] 更新 Pi resource compatibility fixtures/source snapshot，使 bounds/activation checks 跟随新 owner；保留 facade wiring checks 并加入模块接线防漂移测试
- [x] focused/full Rust tests、warning-free Cargo check、Rust fmt、`pnpm check`（含兼容/权限 fixtures）、architecture/lint/format 与 diff checks
- [x] 更新 Pi handoff owner map、findings/progress；复核 beta/version/worktree
- **状态：** Slice 167 complete；插件源 inventory/enablement 已有独立 owner，旧授权 command seams 和调用/投影顺序保留。全仓治理目标仍 in_progress。
- **工具错误记录：** 提取后首次 Pi resource fixture 格式检查未通过，执行 Prettier 后 `pnpm check:pi-compatibility` 通过（111 fixtures）；首次聚焦 cargo test 报告已移除的 `scan_pi_skill_root` 测试 re-export 未使用，删除 stale re-export 后聚焦测试 5/5 且无警告。全 Rust library 为 365/365（原 370 中的 5 个私有 scanner-loop 测试已由批准的 command-level behavior assertions 替代）。
- **工具错误记录：** 上一轮直接执行 `session-catchup.py` 因脚本不可执行而 permission denied；改由 `python3` 调用后 exit 0、无恢复报告。一次只读 `rg` 查询误传不存在的 `src-tauri/tests` 路径；改为检索现存的 `src-tauri/src`，没有文件改动。此前 seam 确认请求首次使用旧 `question` 字段被工具拒绝，随后按当前 `title`/`options` schema 成功提交并获用户批准。
- **工具错误记录：** 首次编译 command fixtures 遗漏 `tauri::Manager` 导入，修正后能力 command 测试通过；Marketplace 子进程第一次使用不匹配的 exact test name，child runner 显示 0 tests，改为唯一测试名的 substring filter 并增加 `running 1 test` 断言，确保子测试真实执行。
- **工具错误记录：** 首次大测试删除 patch 锚定了旧的多行函数头，匹配失败且没有写入；按当前单行格式读取源文件后用精确范围重试成功，未覆盖既有内容。

## 第 168 切片：Skill detail 与 path-policy owner（进行中）

- [x] 对较大 Rust/worker/domain owners 做新一轮体量与职责盘点；排除此前明确未选择的 Workspace store latest-request、Host router coordinator 与 shared Workspace view-projection
- [x] 审阅 `config_plugin_details.rs` 的生产职责与调用方，确认 Skill frontmatter/details/files 以及 Skill root path policy 与 plugin manifest/detail parser 可分离；Host 授权和 catalog membership 留在 `config_extensions` commands
- [x] 用户选择通过既有授权 `get_melody_skill_details` 命令 characterization；另针对路径安全使用现有授权 `delete_melody_skill` 命令覆盖 direct-child、nested 与 symlink 行为，不增加 test-only production port
- [x] 重构前新增两项 command-level behavior tests，运行前基线 2/2 通过
- [x] 将 Skill Markdown details、bounded file enumeration 与 allowed-root path policy 移至 `config_skill_details.rs`；调整 sibling-module wiring 和既有 callers，保持 command authorization/catalog membership、error text 与 traversal bounds
- [x] 移除由授权 command seams 覆盖的旧 private helper tests；plugin parser/capability tests 留在 `config_plugin_details.rs`
- [x] 全 Rust library 365/365、warning-free Cargo check、Rust fmt、`pnpm check`（111 compatibility/permission fixtures）、architecture 5/5、lint/format 与 `git diff --check`
- [x] 更新 findings/progress/handoff ownership，最终复核 beta、版本 trio 与累积 dirty worktree
- **状态：** Slice 168 complete；Skill detail 与 path-policy 已拆成独立 owner，授权 command seam 和文件/路径约束保持。总体结构维护目标仍 in_progress。
- **工具错误记录：** 首次 async delete command characterization 先因缺少 `.await`，再因使用 `#[test]` 而不能编译；改为 `#[tokio::test]` 并 await 后，pre-extraction characterization 2/2 通过。初次新模块编译因为 `pub use` re-export 只含 `pub(crate)` items 产生 unused warnings；移除不需要的 facade re-export，保留 sibling-module callers 后，聚焦 `cargo check --lib` 无警告。
- **工具错误记录：** handoff owner map 更新后首轮 `pnpm format:check` 发现表格行需重新 Prettier 排版；文档格式化后仓库格式门禁、planning 文档格式门禁和最终 diff check 均通过。
- 最终复核：当前分支仍为 `beta`，package/Cargo/Tauri 版本均为 `0.4.0-beta.2`；累积 dirty worktree 原样保留。不 commit/push/publish/release、不改版本或同步 main。

## 第 169 切片：Pi prompt resource owner（进行中）

- [x] 在 `config_extensions::pi_prompt_paths` 与 `config_runtime::pi_resource_manifest` 现有行为 seam 上先增加有界扫描/root-policy characterization，提取前基线通过 1/1；不增加 test-only production interface
- [x] 将 command Markdown bounded scanner、project/user/plugin command-root discovery、disabled-name snapshot 与 prompt bounds 移至 `config_prompt_resources.rs`；保持 `config_runtime::pi_prompt_paths` re-export 和 `pi_resource_manifest` 组合求值顺序
- [x] 移除已由 facade behavior seam 覆盖的两个 private prompt-scanner tests；保留 Skill resource owner tests
- [x] 扩展 Pi resource compatibility checker，使 Host prompt path/file/aggregate bounds 跟随 `config_prompt_resources.rs` 并与 manifest 对齐；保留 worker bounds 检查并添加 Host owner wiring regression test
- [x] warning-free `cargo check --locked --lib`；Rust library 364/364；`pnpm check`（113 compatibility/permission fixtures）；architecture 5/5；lint、format、planning Markdown format 与 `git diff --check`
- [x] 更新 findings/progress/handoff owner map，并复核 beta/version trio 与累积 dirty worktree
- **状态：** Slice 169 complete；prompt resources 有独立 owner、调用 facade 与行为上限兼容不变。整体结构维护目标仍 in_progress。
- **工具错误记录：** 首次 Rust fmt check 发现删除 prompt private tests 后残留一个 `#[test]` attribute，清理后 formatter 通过；随后 formatter 按 Rust module ordering 重排 sibling declaration/re-export。全量 Rust test 364/364，无失败。
- 最终复核：分支仍为 `beta`，package/Cargo/Tauri 版本均为 `0.4.0-beta.2`；累积 dirty worktree 保持原样，不 commit/push/publish/release、不改版本或同步 main。

## 第 170 切片：workspace patch owner（已完成）

- [x] 审计 `workspace_tools.rs` 内 patch grammar、操作规划和文件应用集群，确认它有独立变更原因且既有 `apply_patch(root, arguments)` 接口可保留
- [x] 将 patch parser、全文件预检、路径安全检查、变更计划与 add/update/delete/move 执行移至 `workspace_tools/patch.rs`；`workspace_tools::apply_patch` facade 保持不变
- [x] 将原有两项直接行为测试原样迁至 patch owner；gateway 仍保留 Host permission、gitignore 覆盖与 symlink 集成测试，无新增测试接口
- [x] 保持 Host authorization、配置策略覆盖、共享 workspace mutation lock 和 dispatcher 在 `pi_tool_gateway.rs`；patch 继续使用同一相对路径、symlink 和 gitignore helper
- [x] 验证 patch tests 2/2、gateway tests 25/25、Rust library 364/364、warning-free Cargo check、Rust fmt、兼容/架构/lint/format 与 diff gates
- [x] 更新 handoff/findings/progress，复核 `beta` 与三处 `0.4.0-beta.2` 版本一致；保留累积 dirty worktree
- **状态：** Slice 170 complete；patch 语法与文件事务有单独 owner，外部调用路径和 Host authority 顺序不变。整体结构维护目标仍 in_progress。

## 第 171 切片：agent-contract resource manifest validator owner（已完成）

- [x] 复核 beta 分支、三处版本声明、累积 dirty worktree 与既有 validator 行为测试；保留当前未提交工作
- [x] 确认 resource manifest roots、question timeout、subagent policy 与 goal policy 共享一套有界校验规则，并通过现有 validateAgentCommandEnvelope 接口可观察；提取前测试 4/4
- [x] 将 manifest schema 与 bounds 收敛到 validation/resource-manifest.ts；将 shared record/string/permission/control-character 校验留在 validation/shared.ts；validation.ts 保留 command dispatch 和原导出 façade
- [x] 保持 session.resources.refresh Host-projected manifest、Pi-only runtime 与 package-level exports 不变；不增加 test-only 接口或测试
- [x] 将 nested contract validator modules 加入 format、format:check 和 format:agent-worker 文件集，避免新 owner 落在格式门禁之外
- [x] 验证 agent-contract tests 4/4、pnpm check（含 113 compatibility/permission fixtures）、pnpm test:unit 464/464、architecture 5/5、lint、format 与 git diff --check
- [x] 更新 owner handoff/findings/progress，并复核 beta、版本 trio 与累积 dirty worktree；不 commit/push/publish/release 或同步 main
- **状态：** Slice 171 complete；Host resource manifest validation 有独立内部 owner，现有 command-envelope seam 与 Host/runtime authority 均未改变。全仓结构维护目标仍 in_progress。

## 第 172 切片：Agent session binding Host preflight owner（已完成）

- [x] 确认 database binding CRUD 与 Pi session admission checks 是不同但共享 session-ID policy 的职责；通过既有 binding/open/import/command 与 fork 测试观察，不新增 test-only production interface
- [x] 提取前现有 `database_agent_bindings::tests` 7/7、`database_agent_forks::tests` 2/2 通过；复核 worker command 与 fork 的真实 Host 调用路径
- [x] 将 persisted-session workspace/engine/open/import/fork validation、bounded migration plan checks 与共享 ID bounds 移至 `database_agent_bindings/preflight.rs`
- [x] `database_agent_bindings.rs` 保留 Tauri binding CRUD 与 `validate_pi_session_*` crate-level re-export；`session_commands.rs`、fork/event callers 与 Host authorization order 不变
- [x] 提取后原测试 seam 仍为 7/7、2/2；全 Rust library 364/364、warning-free Cargo check、Rust fmt、`pnpm check`（113 compatibility/permission fixtures）、architecture 5/5、lint、format 与 `git diff --check` 通过
- [x] 更新 Pi migration handoff、findings 与 progress；复核 beta 分支、aligned version trio 与累积 dirty worktree，不 commit/push/publish/release 或同步 main
- **状态：** Slice 172 complete；database binding facade 与 persisted Pi session admission policy 有清晰 owner，Host 仍是 session/workspace/engine admission 的最终裁决方。全仓结构治理目标仍 in_progress。

## 第 173 切片候选审计：Pi runtime capability/fallback policy（待 seam 确认）

- [x] 按当前 beta-only 约束复核工作树、三处版本与 diff whitespace；保留累积的 221 项 dirty worktree
- [x] 审阅 compatibility aggregator 的职责：领域合同已有多个 fixture-tested owners，但 package/file reads、real runtime probe、diagnostic aggregation 仍由入口负责
- [x] 定位 Pi capability/fallback policy 的结构化输出检查：声明工具集与实际 `PI_CAPABILITIES` 工具集比对、ACP fallback claims、diagnostic fallback fields、Browser limitation accuracy；与源 marker/依赖版本和真实子进程 probe 的 I/O 分离
- [x] 基线 `node --test scripts/check-pi-compatibility.test.mjs` 10/10，`node scripts/check-pi-compatibility.mjs` 通过；当前入口测试未直接覆盖该 policy 的负例
- [ ] 用户确认是否通过纯 `checkPiRuntimeCapabilityPolicy({ declared, observed })` seam 为该 policy 建立行为测试
- **状态：** 仅完成候选审计；未更改源代码或测试。真实 worker capability 子进程 probe 必须继续留在 aggregate gate；等待 seam 选择后再开始 TDD。

## 第 174 轮审计：Agent migration journal cohesive state owner（不拆）

- [x] 重验当前 `beta`、版本 trio、221 项累积工作树与 `git diff --check`；保留所有既有状态
- [x] 追踪 `begin_pi_migration`/list/fail 命令、worker import preflight 与 `session.imported` 事务回调，确认其共同维护同一 migration journal state machine
- [x] 运行现有 `database_agent_migrations::tests`：6/6 通过，覆盖 retry/idempotency、plan/backup identity、failed late completion 与 applied native-session/backup identity
- [x] 依据共享 stage/plan/fingerprint/backup/transaction invariants，决定不按函数或 SQL CRUD 机械拆分；这会扩散状态机知识或形成浅 facade
- [x] 记录现有测试直接调用私有 inner/transaction helpers；没有把这些测试重标成 public behavior seam
- **状态：** migration journal 保留单一 state owner；本轮只读审计，无产品代码/测试改动。若后续要深化行为测试，须先确认具体 command/event seam。全仓目标仍 in_progress。

## 第 175 轮审计：workspace sandbox 已有明确 owner（不再拆）

- [x] 重验当前 `beta`、三处版本声明、221 项累积工作树与 `git diff --check`；保留所有既有状态
- [x] 核对 sandbox 实际 owner：共享 profile resolution 已在 `workspace_sandbox/profile.rs`，macOS Seatbelt 与 Linux Landlock enforcement 各有平台 adapter
- [x] 确认 parent `workspace_sandbox.rs` 负责 Host 唯一 fail-closed decision、Tauri workspace authorization/preflight，以及 terminal/monitor 共用 command seam
- [x] 依据真实调用图与跨平台安全不变量，拒绝继续按平台分割 Host decision 或抽浅层 renderer；保留既有 `sandbox_decision`/`sandboxed_shell_command` seams
- [x] 记录验证限制：本机只安装 macOS Rust target，嵌套 Seatbelt 执行受外层沙箱限制；不得将静态/字符串测试描述为跨平台执法验收
- **状态：** sandbox policy/profile/executor responsibilities 已按真实 seams 分离；本轮只读审计，无产品代码或测试改动。全仓目标仍 in_progress。

## 第 176 轮审计：恢复、调度与投影 owner（候选收敛）

- [x] 复核 `database_agent_recovery.rs`：事件日志安全检查、Pi binding 与只读恢复计划属于同一个 Host snapshot；拆出 event accumulator 会让 action/reason 决策离开其输入状态
- [x] 复核 `schedule_dispatch.rs`：due claim、live-session/permission affinity、单会话 dispatch claim、worker acknowledgement 与 journal 更新共同构成一个 dispatcher lifecycle；纯 schedule advancement 已独立归 `database_agent_schedules/policy.rs`
- [x] 复核 `pi-session-import.ts`：两个导出入口共享同一有界转换计划；Host 持久身份 admission 已由 Rust binding preflight 管理，单独抽 parsing helpers 会成为额外薄 facade
- [x] 复核 `session-projection-updates.ts`：仍保留 `applySessionUpdate` timeline/lifecycle owner；message、tool activity 与 billing projection 已由各自 owner 承担
- [x] 记录恢复 summary 跨层边界差异：Rust 用 UTF-8 byte cap 256，TypeScript parser 用 JS 字符串长度 256；它表现为 renderer 接受域更宽，不证明 Host 当前会发出超限数据
- [ ] 若继续该候选，先由用户确认是否以既有 `parsePiRecoveryPlan` 行为 seam 验证 Rust byte/TS UTF-8 boundary，并确认是否建立 recovery source-contract drift check；不把其它待定 seam 的静默视作批准
- **状态：** 本轮得到的是收敛证据和一个明确的跨层契约候选；未改运行时代码或测试，整体目标保持 in_progress。

## 第 177 轮候选审计：workspace bridge 与 AgentStore migration owner（已收敛）

- [x] 恢复任务计划/发现/进度并核验当前仓库状态；确认仍在 `beta`、三处版本为 `0.4.0-beta.2`，`git diff --check` 无输出；保留累积工作树
- [x] 将 `src/lib/melody-bridge-workspace.ts` 列为后续审计候选：混合项目/session workspace bridge、Pi fork、migration helpers 和文件/terminal wrappers；不按文件长度机械拆分薄 `invoke` wrappers
- [x] 继承并记录上一轮 call-site 审计提出的风险：migration bridge helper 与 `agent-store-session.ts` legacy import path 有重叠，但 acknowledgement/event ordering 不同；尚未证明可安全合并
- [x] 基于当前 source 重新核对 migration 调用图、`agent-store-session` 生命周期顺序和已有行为测试；确认两条 migration lifecycle 不可机械合并
- [x] 在同一混合桥接模块中选出更深的 `forkPiSession()` 生命周期及用户确认的既有行为测试 seam，移交下一切片实现
- **状态：** 候选审计已收敛到独立 Pi fork lifecycle；AgentStore migration 与 workspace wrappers 保留现有 owner。全仓目标仍 in_progress。
- **工具错误记录：** 首次规划文档补丁对 `findings.md` 使用了错误尾部锚点，补丁未应用；重新读取真实文件尾部后重试。
- [x] 重开当前 source 确认 store 端 import 会检查 archive/snapshot completeness、按 Host binding 投影模型/permission/session mode，提交 bounded import plan，再设置 setup timeout 并依赖事件 lifecycle；bridge helper 则只直接发送命令并返回 plan
- [x] 确认已有 `agent-session-routing.test.mjs` 只覆盖 Pi-vs-preview 与 product-ID-vs-ACP-ID 路由；它不验证 migration journal/command ordering 或 `session.imported` acknowledgement
- [x] 搜索历史 user approval：先前对 `beginAgentSession()` 的确认仅针对 runtime routing/ID 语义，不构成 migration-lifecycle 测试范围批准
- [x] 继续审阅现有 store 与 PiSessionAdapter import tests；确认 worker import seam 已覆盖其 command/event lifecycle，但不授权或要求合并 renderer migration path
- [x] 确认 worker import lifecycle 已在 `session-adapter.test.mjs` 通过既有 `PiSessionAdapter.importSession()` seam 覆盖 `session.imported` → `session.opened` 顺序；该测试不覆盖 renderer store orchestration
- [x] 确认 Explorer UI 已有 `pi-session-explorer.test.mjs` 的 injected dependency behavior coverage；fork-reference/bring-back seam 与 migration candidate 分开处理，保留未回答的既有 seam 请求
- [x] 避免在 migration contract 未覆盖时强行合并两条 lifecycle；改选已有稳定生产 seam 的 Pi fork orchestration
- **工具错误记录：** 首次测试搜索引用不存在的 `session-import-runtime.test.mjs`，`rg` 返回路径错误；改查现有 `session-adapter.test.mjs` 后成功定位既有 import coverage。
- [x] 评估 `forkPiSession()`：其公开三参数接口背后包含 Host durable-intent preflight、worker 启动、source open 与 fork 双阶段 ack、timeout/error propagation 和 listener cleanup，属于比薄 Tauri wrappers 更深的独立 lifecycle
- [x] 确认当前 UI suite 只 mock `forkPiSession`，没有直接观察 bridge 实现；无现成实现级行为测试可替代
- [x] 按 TDD seam discipline 先征求用户确认；用户现已同意通过现有 `forkPiSession()` 生产接口测试并提取该 owner
- [x] 用户已明确确认：先通过现有 `forkPiSession(source, target, nativeEntryId)` 生产接口补行为测试，再提取 lifecycle owner；不新增 test-only production port，不移动 Host 授权
- [x] 单独运行 planning session catch-up，exit 0 且无恢复报告
- [x] 先经既有接口增加成功路径 characterization test；实现前 baseline 1/1，覆盖 intent/start/binding/event subscription/source open/fork 与 listener cleanup
- **工具错误记录：** 更新 catch-up 记录的第一次补丁使用了与 Slice 177 实际行文不符的锚点，未应用；读取准确范围后再补。
- **工具错误记录：** 两次后续补丁因计划/progress 中的锚点与实际行文不匹配而未应用；重读当前内容后按精确锚点重试。

## 第 178 切片：Pi Explorer fork lifecycle owner（已完成）

- [x] 按用户确认，只通过既有 `forkPiSession(source, target, nativeEntryId)` seam 测试与提取；不新增 test-only production port，不移动 Host 授权
- [x] 在原实现上先运行成功路径 characterization baseline 1/1，断言 Host fork intent、source `session.open` 后 target `session.fork` 的命令顺序/身份/参数，以及两个 event listener 的完整清理；提取后同一行为 suite 增补 runtime error 和 open-ack timeout rejection/cleanup，定向 suite 3/3
- [x] 将 fork worker/ack/timeout/error 生命周期移至 `melody-bridge-pi-fork.ts`；`melody-bridge-workspace.ts` 继续 re-export 原函数供现有 consumers 使用
- [x] 将 owner 纳入 root format/format-check manifests；三项行为测试复用已有 `agent-session-routing.test.mjs` 的 Vite SSR server，该测试已在 unit/format manifests 中；Host intent/preflight 与授权位置、Pi-only runtime 和对外接口不变
- [x] 验证 `pnpm check`（113 compatibility/permission fixtures）、`pnpm test:unit` 467/467（无 WebSocket 端口 warning）、architecture 5/5、ESLint、完整 `pnpm format:check`、production build 与 `git diff --check`
- **状态：** lifecycle 有独立 owner 且原有 facade/API 保持不变。分支 `beta`、版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。全仓目标仍 in_progress。
- **工具错误记录：** 首次 manifest patch 未匹配当前长脚本行；按读取到的实际 package.json 行重新生成精确 patch。初次 unit manifest 更新将 `.ts` source file 误加到 Node test list，导致该轮 1 项测试加载错误；从 test list 移除 source file 后完整 unit suite 465/465 通过。首次 Prettier check 发现独立测试文件格式不符，经 Prettier 修复。一次版本核验命令尝试将 Cargo TOML 当作 JSON 读取而失败，随后改用 TOML version 行解析，确认三处版本一致。独立 SSR behavior file 与 route suite 并行启动时引发 `24678` WebSocket 端口 warning；将三条测试并入已有 SSR suite 并删除冗余 server 后，全量 467/467 无此 warning。
- **已授权 seam 后续覆盖：** 增加 source-open `runtime.error` rejection 与未 ack timeout 用例，均验证不发送 target fork 命令且清理两路监听器；定向 suite 3/3、完整 unit suite 467/467；只改测试，不改生产代码。

## 第 179 轮候选审计：Host Pi LSP bridge（待 seam 确认）

- [x] 重验当前 branch/version/diff whitespace：`beta`、`0.4.0-beta.2` trio、`git diff --check` clean；保留既有 224 项 status worktree
- [x] 对比大文件候选：schedule state module 已将 policy 分离，剩余 schema/CRUD/claim/run journal/Host commands 共用同一持久 state owner；Marketplace native module 已拆 catalog/transport/filesystem/registry/install transaction 等子 owners，剩余部分是命令 orchestration
- [x] 审阅 `pi_lsp_runtime.rs`：配置与结果 projection 已有 owners；父模块混合 LSP request validation/Host tool envelope routing 与短生命周期 server JSON-RPC process、frame IO、response matching、shutdown cleanup
- [x] 现有 LSP tests 仅覆盖 operation aliases、disabled server selection 和 position bounds；未直接覆盖 subprocess framing、ack matching、timeout 与 child cleanup
- [ ] 用户确认是否通过现有 `resolve_request(root, value)` 生产 seam，以 fixture-backed fake language server 建立进程/协议行为测试，再评估抽出 session lifecycle owner
- **状态：** 只读审计发现一个可能的深 owner 候选，但 process fixture 的可移植性和测试范围需先确认；没有新增测试或产品源码。

## 第 180 切片：WorkspaceStore 并发选择与初始化重试（已完成）

- [x] 用户确认通过现有 WorkspaceStore 的 selectProject() 与 initialize() 验证乱序选择和初始化失败重试；不新增测试专用生产接口
- [x] 在现有 Vite SSR 测试套件中先复现旧项目选择覆盖新选择：A 的 session 请求较晚返回时，旧实现最终把活动项目从 B 改回 A
- [x] selectProject 复用 RequestGate，在 session 读取、fallback 创建之后以及错误路径上忽略过期结果；保留立即展示最新所选项目的原行为
- [x] 初始化加载失败时将 initialized 恢复为 false，使后续 initialize() 可重试；测试也确认旧 catch 会错误地留下 true
- [x] 定向 store suite 16/16、pnpm test:unit 469/469、pnpm check（113 compatibility/permission fixtures）、pnpm lint、pnpm format:check 与 git diff --check 通过
- [x] 复核 beta 与 package/Cargo/Tauri 均为 0.4.0-beta.2；保留累积 dirty worktree，不 commit/push/publish/release 或同步 main
- **状态：** 两条公开 store action 的异步状态边界已有回归覆盖；Pi-only runtime 与 Host 授权路径未动。全仓结构维护目标仍 in_progress。

## 第 181 切片：Pi turn run-transition owner（已完成）

- [x] 复核 `PiSessionAdapter.submit/steer/cancel` 的共同状态：run admission/identity、幂等、runTransition cancel ordering、Pi prompt 调用与 terminal settlement；此前单独迁移 `spawnSubagent` 或只按文件长度拆分都不足以形成 owner
- [x] 沿既有公开 `PiSessionAdapter` command/event seam 使用 `session-adapter.test.mjs`；提取前行为基线 31/31 通过，不新增 test-only production port，不移动 Host authorization
- [x] 将 turn command transitions 移至 `session-turn-runtime.ts`；adapter 保留 `submit/steer/cancel`、配置与其它 session commands 的既有入口，注入共享 session map、Pi subagent runtime 和 emitter
- [x] `turn-policy.ts` 继续拥有配置快照与 run/cancel identity policy；`attachment-policy.ts` 继续拥有附件约束/解码。Host ToolGateway 仍是权限裁决方，Pi-only runtime 和产品事件/error/ordering 未变
- [x] 提取后 `session-adapter.test.mjs` 31/31、`pnpm test:unit` 469/469、`pnpm check`（113 compatibility/permission fixtures）、`pnpm lint`、完整 `pnpm format:check` 与 `pnpm check:architecture`（5/5）通过
- [x] 核实 `config_subagents.rs` 已有 `AgentDefinitionCatalog` 共用有界 discovery/parsing；Settings inventory 与 Pi policy manifest 的冲突优先级/投影有意不同，额外 source inventory facade 会是浅层 owner，故本候选不再拆
- [x] 复核 `beta` 和 package/Cargo/Tauri `0.4.0-beta.2`；保留累积 dirty worktree，不 commit/push/publish/release 或同步 main
- **状态：** Pi turn command state transitions 有独立 owner；公开 adapter command/event 测试边界及 Host/Pi runtime policies 不变。全仓结构维护目标仍 in_progress。下一候选继续经当前调用图审计；未回答的 LSP process seam 仍待用户明确选择。

## 第 182 轮候选审计：Host Pi worker 工具路由（待确认测试 seam）

- [x] 重验当前 `beta`、对齐版本 trio 和累积 dirty worktree；不清理、不重置
- [x] 复核 `PiWorkerRuntime` 与已有 children：binary/env setup、protocol framing、event acceptance/persistence pipeline、Host session preflight、dispatch ledger、memory lifecycle、Host tool routing 均已有 owners；剩余 process/generation start-stop-handshake-EOF supervision 是一个共同状态机，不按文件大小再拆
- [x] 沿当前 production path 确认 `event_pipeline` 在 durable acceptance/persistence 后发出 renderer event，再分派 persisted interaction、tool request 和 observational hooks；`host_tool_routing::resolve_tool_request` 内按 workspace authorization → internal instruction preflight → enforceable PreToolUse → persisted deny → Host domain/tool dispatch → worker resolution → observational PostToolUse ordering执行
- [x] 发现该 router 683 行且无直接行为测试；现有 event pipeline fake port 只验证 acceptance/persistence/publication，pi_tool_gateway tests 覆盖较低层工具政策，均不能证明 workspace/hook/persisted-permission 路由次序
- [x] 候选 deep module 应只拥有 ordered Host request-routing workflow；生产 adapter 通过现有 WorkspaceRegistry、database、Hook 与 Pi ToolGateway 调用，测试 adapter/fixture 需能观测授权拒绝、dispatch 与 completion。Host 必须保持唯一授权权威；不能以测试 fake 绕开真实生产 preflight
- [ ] 用户确认是否通过当前 `PiWorkerRuntime` accepted-event/tool-resolution command path，为完整路由顺序建立行为测试并将 coordinator 提取到独立 owner
- **状态：** 当前只读 audit；没有新增 runtime source/test。TDD skill 要求未确认 seam 不写测试。通用 compatibility checker 的 ToolGateway wiring seam与此 runtime Host router 候选不同，之前待定选择不视为本候选批准。

## 第 183 轮候选审计：Marketplace settings owner（暂不拆）

- [x] 复核 `MarketplaceSettings` 的 source CRUD、目录扫描、分组搜索、分页与 plugin install/update 调用顺序，以及已存在的 `MarketplaceSourceDialog` / `MarketplacePluginRow` owners
- [x] 确认它们共同组合一个“配置来源并扫描/管理插件”的页面状态：save/remove 会触发重新扫描，source metadata 同时构成 catalog group 与删除/编辑入口；目前抽成更小的 hooks/components 会把 loading/error/activity 与来源刷新顺序扩散到一组宽 props
- [x] 核实 parent `AgentWorkspaceView` 以稳定 settings key 挂载页面，但用户通过 sidebar 选择项目时会先关闭 Settings；当前 source 未证明正常 UI flow 能让旧 cwd 请求在新项目同一 Settings mount 内回写，不能把条件性 stale-result risk 写成已复现 bug
- [x] 查明没有 MarketplaceSettings/row/dialog 的直接 behavior suite；未确认新的 React lifecycle/test seam。本轮不按 688 行规模拆分，不新增测试或生产接口
- **状态：** 现有 page composition 暂时保留；已有 dialog/row 子模块边界符合调用图。若后续需要处理跨 cwd 请求语义，先确认可观察行为和测试 seam。

## 第 184 切片：Pi 子代理取消的 adapter 级生命周期覆盖

- [x] 沿已确认的 `PiSessionAdapter` command/event seam，使用真实 root session 注册的 `run_background_task` tool 启动 child，再通过 adapter `task.cancel` command 触发取消；没有直读 task/session map 或新增 production test port
- [x] 让初始 `subagent.changed(running)` emitter 暂停，在此期间取消 child；断言 provider prompt 未开始、只发出一次 `run.finished(cancelled, parent_cancelled)`，且 cancel acknowledgement 投影为终态 cancelled task
- [x] 定向 `session-adapter.test.mjs` 32/32、`pnpm test:agent-worker` 190/190、`pnpm test:unit` 470/470、`pnpm check`（113 compatibility/permission fixtures）、`pnpm lint`、完整 `pnpm format:check` 与 `git diff --check` 通过；同一续接先前 Rust library 364/364
- [x] 复核当前仍在 `beta`，package/Cargo/Tauri 版本均为 `0.4.0-beta.2`；只增加集成特征测试，无运行时、Host 授权或 wire behavior 改动
- **状态：** 子任务生命周期除 owner/worker-smoke 覆盖外，现也有一条通过既有 PiSessionAdapter seam 验证 root-tool wiring、取消事件和终态投影的回归；全仓治理继续 in_progress。

## 第 185 切片：Pi 子代理取消回归测试边界去重

- [x] 复核 Slice 184 adapter 集成特征已覆盖 `PiSubagentRuntime` 直测中的同一 initial-running-event cancellation race，且额外经过 root tool 注册与 adapter 命令路由
- [x] 删除重复的 runtime race test 与仅服务该测试的 `onEmit` helper hook；保留三项不同职责的 owner-interface 测试
- [x] 定向 adapter/runtime suites 35/35、`pnpm test:agent-worker` 189/189、`pnpm test:unit` 469/469 通过
- [x] `pnpm check`（113 compatibility/permission fixtures）、`pnpm lint`、完整 `pnpm format:check`、`pnpm check:architecture` 5/5、planning/handoff Prettier 与 `git diff --check` 通过
- [x] 最终复核仍在 `beta...origin/beta`，package/Cargo/Tauri 仍均为 `0.4.0-beta.2`；保留累积 dirty worktree，不 commit/push/publish/release 或同步 `main`
- **状态：** 取消竞态只在用户选定的 adapter command/event seam 保留一条更完整回归；不改 runtime、Host authorization 或 wire behavior。全仓结构维护继续 in_progress。

## 第 186 切片：PiSessionAdapter 测试 seam 清理

- [x] 将 question timeout refresh 从私有字段断言替换为公开 adapter turn / ask-user interaction timeout 与 resolve 行为
- [x] 将 open 生命周期队列的 `openInternal` monkey patch 替换为并发公开 `session.open` 命令与单 native-session / 相同 acknowledgement 断言
- [x] `pnpm test:agent-worker` 189/189、`pnpm test:unit` 469/469 通过；仅移动测试覆盖位置，无生产行为改动
- [x] `pnpm check`（113 compatibility/permission fixtures）、`pnpm lint`、完整 `pnpm format:check`、`pnpm check:architecture` 5/5、planning/handoff Prettier 与 `git diff --check` 通过
- [x] 最终复核仍在 `beta...origin/beta`，package/Cargo/Tauri 仍均为 `0.4.0-beta.2`；保留累积 dirty worktree，不 commit/push/publish/release 或同步 `main`
- **状态：** 两项行为现在在现有 PiSessionAdapter command/event seam 可验证；goal policy 私有字段测试保留待独立确认其外部可观察语义。全仓结构维护继续 in_progress。

## 第 187 切片：Pi session resource-refresh owner

- [x] 复核 `PiSessionAdapter.refreshResources` 的共同职责：Host snapshot normalization/application、root lifecycle queue、child refresh、active-run defer、error aggregation 与 completion warning；提取前 refresh tests 4/4 通过
- [x] 将协调流程移至 `session-resource-refresh-runtime.ts`；adapter 保留既有 `refreshResources(command, requestId)` 公开入口并委派 owner，未改变 Host 授权、资源 policy、事件/wire 合同或 Pi-only runtime
- [x] 增加 adapter 可观察失败回归：root reload failure 投影 `pi.resource_refresh_failed`，且不发出成功事件；不新增 production test port
- [x] 对齐兼容静态门禁：aggregate checker 与 question-timeout checker 从新 owner 验证 policy normalization/application，并从 adapter 验证 state wiring/delegation；checker fixtures 覆盖 owner 未接入的漂移
- [x] 定向 refresh suite 5/5、`pnpm test:agent-worker` 190/190、`pnpm test:unit` 470/470、`pnpm check`（113 compatibility/permission fixtures）、`pnpm lint`、完整 `pnpm format:check`、`pnpm check:architecture` 5/5 与 `git diff --check` 通过
- [x] 最终复核 branch/version 保持 `beta` / package-Cargo-Tauri `0.4.0-beta.2`；保存累积 dirty worktree，不 commit/push/publish/release 或同步 `main`
- **状态：** root/child resource-refresh orchestration 有独立 owner，原有 adapter seam 与职责不变。`goalPolicy` 私有字段测试仍待对 downstream observable semantics 单独分析；全仓结构治理目标继续 in_progress。

## 第 188 切片：Pi session-open lifecycle owner

- [x] 沿已确认的 `PiSessionAdapter` command/event seam 复核会话打开流程；提取前公开 `session.open`、root tool allowlist、Explorer fork、session import 与并发幂等打开测试 5/5
- [x] 将 model/resource setup、受限 Pi session 创建、handle 注册、事件订阅、idempotent reopen acknowledgement 与生命周期事件移至 `session-open-runtime.ts`
- [x] adapter 保留公开 `open()` 与每会话 lifecycle queue；fork/import 继续复用同一个 open workflow，Host authorization、ToolGateway authority、Pi-only runtime、session IDs、事件次序与错误语义不变
- [x] 更新 compatibility aggregate 追踪 adapter → open owner delegation 与 owner 内 model-policy application；增加两项 owner-wiring drift fixture
- [x] 同一公开 seam 提取后 5/5；`pnpm test:agent-worker` 190/190、`pnpm test:unit` 470/470、`pnpm check`（115 fixtures）、`pnpm lint`、完整 `pnpm format:check`、`pnpm check:architecture` 5/5、规划文档 Prettier 与 `git diff --check` 通过
- [x] 最终复核继续在 `beta`，package/Cargo/Tauri 均为 `0.4.0-beta.2`；保留累积 dirty worktree，不 commit/push/publish/release 或同步 `main`
- **状态：** session-open creation/registration workflow 有单一 owner，现有 adapter command seam 与生命周期队列保持稳定；全仓治理继续 in_progress。

## 第 189 切片：Agent Session 激活的 latest-generation 状态提交

- [x] 按用户确认，通过现有 `beginAgentSession` / `beginSession` seam 表征 A/B 重叠激活；不增加 test-only production port
- [x] 在预先确认的 Host binding 阻塞点先复现 A 的迟到错误把当前 B 的 `runtimePhase/chatStatus/status` 覆盖为 A error
- [x] 以每个 store getter 为键维护 `RequestGate` generation；旧激活只失去提交共享 renderer 状态的资格，session identity 与 archived 状态也必须仍匹配
- [x] 将 binding 配置投影、异步错误/phase/status 和 setup timeout 的 renderer 写入置于当前 generation guard 下；不提前 return、不取消或改写 Host/Pi session 命令
- [x] 配置回归先复现旧 A 覆盖 B 的模型，再验证 A/B 各自的 `session.open` 仍按原参数发出；保留既有同 session、进行中幂等短路，不让 no-op 使 owner generation 失效
- [x] 定向 `agent-session-routing.test.mjs` 18/18、root `pnpm test:unit` 472/472、`pnpm check`（115 compatibility fixtures）、architecture 5/5、lint、format、production build 与 `git diff --check` 通过
- [x] 复核仍在 `beta`，package/Cargo/Tauri 版本均为 `0.4.0-beta.2`；保留累积 dirty worktree，不 commit/push/publish/release 或同步 `main`
- **状态：** 已完成一项 renderer latest-activation race 修复；现有 Host/Pi command behavior 与权限权威不变。`use-agent-bridge` 中独立的迟到 capability-report catch 未纳入此 seam；全仓治理继续 in_progress。
- **工具/测试错误记录：** 红测首次确认 A 的错误写入会把 B 状态变为 error；临时移除配置 commit guard 的红测确认 A 会把 B 的 `model-b` 覆盖为 `model-a`。新增命令断言首轮读取了 envelope 的外层错误层级（字段均为 `undefined`），按实际嵌套 `envelope.command` 修正后通过。所有临时变更均已恢复到最终 guard 版本。

## 第 190 轮候选审计：Pi capability preflight 的迟到失败提交

- [x] 重验 `beta`、dirty worktree、版本 trio 与 `git diff --check`；保留所有既有变更
- [x] 追踪 `useAgentBridge` effect cleanup 的 `disposed` 生命周期及 `getPiCapabilityReport` 成功/失败分支
- [x] 确认成功分支和其他连接失败路径在共享状态写入前检查 `disposed`，但 capability-report `catch` 会在异步失败后直接写 Zustand `capabilityDiagnostics` 与全局 `setStatus`
- [x] 确认当前没有 `useAgentBridge` lifecycle/hook test renderer；项目中未发现 `renderHook` / `react-test-renderer` test harness
- [ ] 等待用户确认是否引入窄的 capability-preflight coordinator seam 与受控 Promise 行为测试；不改 Hook/Host policy 前先确认 interface
- **状态：** 只读审计。潜在 stale failure 是源码可证的缺失 `disposed` commit guard；尚无运行时复现。测试/owner seam 需用户确认后再实施；Pi 兼容裁决、diagnostic 内容、Host/Pi 路由均不应改变。
- **错误记录：** 两次组合式 apply_patch 均因 `findings.md` 锚点与当前文件不符而失败，未修改任何文件；重新读取文档尾部后改用精确锚点。首次异步提问误用了 `question` 字段（工具只接受 `title/options`），未提交；按 schema 修正后已发送。

## 第 191 轮审计：session persistence queue ownership

- [x] 复核 `useSessionPersistence` 的唯一 production caller、snapshot generation、per-session coalescing、serialized flush/retry 与 cleanup/visibility flush
- [x] 确认 per-session revision prevents stale `replaceSession`，failed write 仅 requeue 仍是最新的同一 revision；snapshot serialization 和 archive-entry diff 都位于 write boundary
- [x] 对照 domain projection tests；确认没有 hook/persistence write lifecycle suite
- [x] 决定不按 198 行或 map 数量拆分：queue/retry/signature/archive-delta 属于同一 persistence state machine，拆分会新增 writer/scheduler/session projection interface
- **状态：** 只读 owner audit。当前 hook 是内聚的单一 persistence owner；若未来为验证 retry/order 行为增加可替换 adapter，应先确认其生产/test seam 与可观察合同。无 source/test 变更。

## 第 192 切片：同一 session 重新激活后的旧 setup timeout

- [x] 在既有 `beginAgentSession` store seam 增加 A → B → A 重新激活回归；不读私有 generation/timer map，也不增加生产 test port
- [x] 捕获旧 A 的 20 秒 setup callback 并在最新 A 仍为 `creating` 时触发；验证旧 timer 不会将当前 session 投影为 error
- [x] 暂时绕过旧 timeout 的 `setIfCurrent` 再跑测试，观察到 `runtimePhase` 从 `creating` 变成 `error`；恢复 guard 后通过
- [x] 定向 `agent-session-routing.test.mjs` 19/19、完整 `pnpm test:unit` 473/473、`pnpm check`（115 compatibility/permission fixtures）、architecture 5/5、lint、format 与 `git diff --check` 通过

- **状态：** 为 #189 已实现的 latest-generation renderer commit guard 补上可区分旧/当前同 session 激活的行为覆盖；本切片只改测试，不改变生产行为、Host/Pi 命令或授权。
- **错误记录：** `codebase-design` 的旧 skill 路径已不存在，改由已安装插件缓存路径完整读取；文档 patch 初次上下文未匹配，随后多一个 `+` 前缀被格式检查发现；按最新尾部精确修正。刻意绕过 generation guard 的一次失败是预期 red mutation，随后恢复源实现并验证绿。

## 第 193 切片：WorkspaceStore Host 清理归属与最新选择提交

- [x] Tauri 删除 session/project 时移除 renderer 全局 `stopPiWorker()`；桌面运行时清理由现有 Host 删除命令按 session binding/workspace 管理，Browser preview 的 `stopAgent()` 路径保留
- [x] 通过既有 WorkspaceStore public actions 先复现最后一个活动 session 删除期间的 stale replacement commit 和失败后的 deleted-session 残留；加入 Host command delegation 与 latest-project-selection 回归，不新增 test-only production port
- [x] 补充“项目 A 的 session 查询未完成时，用户选择项目 B 已有 Agent Session”行为：旧 A 结果不能夺回 active project/session，完成后 loading 解除
- [x] 按操作所有权聚合 WorkspaceStore `loading`：取消过期项目选择不清除仍 pending 的删除等操作；以 deferred delete + session selection regression 固定这一点
- [x] Host 删除代理、fallback success/failure、selectProject/selectSession interleavings 均由 `agent-session-routing.test.mjs` 覆盖（25/25）；全量 root unit 479/479
- [x] `pnpm check`（115 compatibility/permission fixtures）、lint、完整 format check、architecture 5/5、production build 与 `git diff --check` 通过
- [x] 复核仍为 `beta`、package/Cargo/Tauri 均 `0.4.0-beta.2`；保留 226 条累积 dirty paths，不 commit/push/publish/release 或同步 `main`
- **状态：** 删除清理与活动选择提交更接近各自的 Host / WorkspaceStore owner；未改变 Pi-only runtime 或 Host 授权权威。Host tool-routing 组合测试 seam 仍在 Slice 182 待选择；全仓结构治理继续 in_progress。
- **验证边界：** renderer tests 证明命令委派与 store projection，不声称本地 Rust Host runtime 已重现；Rust router 未改动。

## 第 194 切片：初始化期间保留最新 Agent Session 选择

- [x] 通过用户已确认的 `initialize()` WorkspaceStore action seam 延迟 `list_projects`，并在响应前选择现有 Agent Session B；红测观察到初始化将活动项目改回初始项目 A
- [x] 延迟无项目时的目录选择并选择已有 Agent Session；红测观察到 picker 返回取消后初始化直接清除该 session；两条初始化写入路径现都尊重较新的 selection intent
- [x] 初始化以既有 project-selection `RequestGate` 登记自己的选择意图；只有该意图仍最新时才激活初始项目，较新的 `selectSession` / `selectProject` 继续胜出
- [x] 继续用现有 pending-action 与 project-selection loading 汇总，不加 test-only production port，不改变 Host/Pi 命令、授权或 runtime
- [x] `agent-session-routing.test.mjs` 27/27、全量 `pnpm test:unit` 481/481、`pnpm check`（115 compatibility/permission fixtures）、lint、完整 format check、architecture 5/5、build 与 `git diff --check` 通过
- [x] 复核仍在 `beta` 且 package/Cargo/Tauri 均为 `0.4.0-beta.2`；保留累积 dirty worktree，不 commit/push/publish/release 或同步 `main`
- [x] `chooseProject()` delayed-upsert interleaving 的既有 public action seam 已由用户确认并在 Slice 197 覆盖；Host router 组合 seam 仍未选择
- **状态：** 初始化回退不再覆盖较新的 session 选择；全仓结构治理目标继续 in_progress。

## 第 195 切片：Host goal policy 的 Pi 行为验证

- [x] 将 `session-adapter.test.mjs` 中对私有 `adapter.goalPolicy` 的三处断言改为 goal policy 的实际消费者行为，不新增 production test port
- [x] 通过现有 adapter harness 打开 Pi session，沿 `session.resources.refresh` 投影 Host manifest；用生产 `DefaultResourceLoader` 与已注册的 `/goal`、`update_goal` 扩展接口验证环境策略、Host 新阈值以及省略策略后的默认行为
- [x] 在该测试的 fake session adapter 中补齐 SDK `reload()` 所需的 resource-loader reload 行为；生产 adapter/Host policy ownership 不变
- [x] `session-adapter.test.mjs` 和 agent-worker/root suites、`pnpm check`（115 fixtures）、lint、format、architecture、build 与 `git diff --check` 通过
- [x] 复核仍在 `beta`，package/Cargo/Tauri 均 `0.4.0-beta.2`；未 commit/push/publish/release 或同步 `main`
- **状态：** goal policy 的 Adapter refresh 到 Pi 扩展执行链现由行为结果验证，私有状态不再是该测试的长期接口；全仓结构治理继续 in_progress。

## 第 196 切片：初始化重试保留已有 Agent Session 选择

- [x] 通过用户已确认的 `initialize()` / `selectProject()` WorkspaceStore action seam 表征“初始化失败 → 用户选择 Agent Session 或 project B → 重试”；不新增 test-only production port
- [x] 两条红测确认重试会激活默认项目 A，覆盖仍存在的 Agent Session B，以及仍存在但尚无 session 的 project B
- [x] 初始化重试开始时记录已有 project/session；只有 selection intent 期间仍有效且目标仍存在于新加载目录时才保留它；session 仍有效时合并当前 session projection，否则重新激活选定 project；失效选择仍回退到正常初始项目
- [x] 保留同一 `projectSelectionGate` 对初始化期间新发生的 `selectSession` / `selectProject` 的优先权；不改变 Host/Pi command、授权、runtime 或 wire behavior
- [x] `agent-session-routing.test.mjs` 29/29、全量 `pnpm test:unit` 483/483、`pnpm check`（115 compatibility/permission fixtures）、lint、完整 format check、architecture 5/5、build 与 `git diff --check` 通过
- [x] 复核仍在 `beta`，package/Cargo/Tauri 均为 `0.4.0-beta.2`；保留累积 dirty worktree，不 commit/push/publish/release 或同步 `main`
- **状态：** WorkspaceStore 在可重试初始化后不再仅因 retry generation 较新而覆盖仍有效的用户 session 选择；全仓治理继续 in_progress。Host router 组合 seam 仍未选择。

## 第 197 切片：`chooseProject()` 登记期间保留最新会话选择

- [x] 按用户确认，通过现有 `chooseProject()` public action 覆盖延迟 `upsert_project`；不增加 test-only production port
- [x] 红测复现登记返回后新项目会夺回活动项目，并触发不必要的新 session 加载/创建
- [x] 登记期间开始 latest project-selection intent；目录登记始终提交，但仅当该 intent 仍最新时才激活新项目
- [x] 回归同时验证较新的 `selectSession()` 保持活动投影，以及无竞争时 `chooseProject()` 仍正常创建并激活新项目 session
- [x] `agent-session-routing.test.mjs` 31/31、root unit 485/485、`pnpm check`（115 fixtures）、lint、完整 format check、architecture 5/5、build 与 `git diff --check` 通过
- **状态：** 修复 `chooseProject()` 的迟到选择覆盖；未改变 Host/Pi 命令、授权、runtime 或 wire behavior。全仓结构治理继续 in_progress，Host router 组合 seam 仍待选择。

## 第 198 切片：初始化保留已在途的项目激活

- [x] 通过已确认的 `initialize()` / `selectProject()` WorkspaceStore action seam，延迟 B 项目的首个 session 创建后再启动初始化；不新增 test-only production port
- [x] 红测复现初始化取消原项目选择，并对同一空项目重复调用 `create_session`
- [x] 初始化只有在启动时不存在项目选择时才认领 selection intent；若选择已在途，初始化仅刷新 catalog/session projection，不再次激活或结束他方的 selection loading
- [x] 回归确认首个 session creation 仍由原来的 `selectProject(B)` 提交，初始化结束期间 loading 保持 true，完成后释放
- [x] `agent-session-routing.test.mjs` 32/32、root unit 486/486、`pnpm check`（115 fixtures）、lint、完整 format check、architecture 5/5、build 与 `git diff --check` 通过
- **状态：** 移除 initialization 与 pending project activation 的重复 session 创建/竞态；未改变 Host/Pi 命令、授权、runtime 或 wire behavior。全仓结构治理继续 in_progress，Host router 组合 seam 仍待选择。
