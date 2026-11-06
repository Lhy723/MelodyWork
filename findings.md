# 发现与决策

## 需求

- 以软件长期开发为目标，主动治理项目中的结构性技术债；用户明确允许大改，不接受单纯缝补或堆叠新层。
- 仅在 beta 开发；不将 beta 合入/同步到 main，不创建正式发布。
- 保持 Pi 为唯一 Agent runtime，ACP 只读归档；Host 保留最终权限和工作区隔离裁决。

## 研究发现

- 当前工作区在 `beta`，起始时与 `origin/beta` 同步且干净。
- 静态行数扫描显示最大热点：`packages/agent-worker/src/pi/session-adapter.ts` 5,543 行；`src-tauri/src/pi_tool_gateway.rs` 4,617 行；`src-tauri/src/pi_worker_runtime.rs` 3,218 行；`src-tauri/src/pi_mcp_runtime.rs` 2,841 行；`packages/agent-worker/src/pi/tool-gateway.ts` 2,654 行。
- `session-adapter.ts` 同时包含子代理路径/恢复校验、附件解码、模型策略、插件/技能/提示词发现及 Pi 会话生命周期实现；资源发现与会话生命周期至少是可审查的内部职责簇。
- `pi_tool_gateway.rs` 同时包含工作区文件读写/搜索/补丁、终端和后台任务、monitor/scheduler、子代理 worktree、指令范围与权限解析。安全策略由 Host 执行这一点必须保留，但各工具簇可考虑成为内部模块。
- 对应 TS 测试文件存在；前序静态盘点见到 `session-adapter.test.mjs` 与 `tool-gateway.test.mjs`。这仅证明存在测试，尚未运行，也未评估覆盖质量。
- 文档漂移：当前交接文档称 Pi 为唯一 runtime；Pi migration README 的目录设计段仍描述 opt-in Pi、默认 ACP，应核对并修正陈旧架构叙述。
- `docs/architecture-improvement-plan.md` 已明确采用深模块和业务不变量归属原则，并反对 controller/service/repository 式机械分层；本轮应继承该原则，不另造一套目录哲学。
- `scripts/check-architecture.mjs` 约束 `src/domain` 的反向依赖以及 Pi SDK import 位置；旧正则只看部分 import 写法并可能误扫注释。它仍不检查核心模块之间的依赖环、职责簇或重复契约，因此边界保护不是完整的结构质量门禁。
- `session-adapter.ts` 约 1,000 行的技能/提示词/插件资源发现逻辑有有限入口（`piSkillPathsFor`、`piPromptPathsFor`，及会话更新所需的资源 manifest 归一化），是候选内部 seam；生产代码和测试都直接依赖当前模块路径，提取时要保留薄 facade 或一次性迁移测试导入，不可产生两套实现。
- 已完成首个切片：资源发现实现移动至 `packages/agent-worker/src/pi/resource-discovery.ts`；会话生命周期保留 manifest 级策略编排，资源模块独自拥有路径扫描、静态插件发现和路径上限。测试改为从该职责模块导入路径发现接口；Host/worker 协议、manifest、不可信路径的二次校验均未改。
- `scripts/check-pi-compatibility.mjs` 原先把资源实现位置写死为 `session-adapter.ts`。现改为读取 `resource-discovery.ts` 并断言 session adapter 接线，结构门禁检验职责所有者而非固定大文件位置。
- 第二个切片已完成：约 300 行模型策略解析/校验与 Pi Settings 投影移至 `model-policy.ts`。模块只依赖结构化 `PiModelIdentity`，不依赖 `PiSessionAdapter` 或 Pi SDK；adapter 仍负责 Host 快照缓存、实时会话同步与生命周期编排。策略行为测试直接导入职责模块。`session-adapter.ts` 从 5,543 行降至 4,420 行；资源发现和模型策略共同承接约 1,100 行实现，没有增加 facade 或重复状态。
- 架构文档漂移已修正：Pi migration README 现在与 handoff 一致，明确 Pi-only 和 ACP 只读归档/导入。
- 重构后门禁：`pnpm check`、`pnpm test:unit`（398）、`pnpm test:agent-worker`（140）、`pnpm lint`、`pnpm format:check`、`pnpm build` 和 `git diff --check` 均通过；Vite 仍有既有大 chunk 警告。Rust Pi ToolGateway 35 项定向基线也通过（Rust 源未改）。
- `scripts/check-pi-compatibility.mjs` 现在从职责模块读取 model-policy/resource-discovery 的兼容常量，并检查 `session-adapter.ts` 接线，避免兼容规则与旧大文件位置耦合。
- 第三个切片已完成：`pi_tool_gateway.rs` 中工作区文件读/搜/列目录/写/编辑/patch 实现移入 `pi_tool_gateway/workspace_tools.rs`（1,091 行）。Host 权限决策、配置策略覆盖、跨工具 mutation lock 和请求路由仍由 gateway 持有；`.gitignore` 的 Host 覆盖仍在 resolver 注入，再由新模块应用。
- Host gateway 在 workspace-tools 切片后从 4,617 行降至 3,546 行。workspace-tools 使用共享路径参数校验，并接收 Host gitignore 结果标记；归档读取已由后续切片直接交给 archive 模块。授权逻辑和 worker 协议仍在 Host；没有新增转发 facade。
- 当前复验：`cargo test --locked --lib` 283 passed（包括 35 个 ToolGateway 测试）；`cargo fmt --check`、`pnpm check`、`pnpm lint`、`pnpm format:check` 和 `git diff --check` 全部通过。全 Rust 单测输出一个沙箱环境诊断，但测试最终通过。
- 第四个切片已完成：终端/MCP 归档文件的上限、预览、归档保留/分块读取逻辑移入 `tool_output_archive.rs`（365 行）。`workspace_tools` 直接依赖归档模块，不再经网关父模块转发；Host 仍在终端策略边界控制预览上限和归档权限。
- 第五个切片已完成：worker 请求 envelope 解析、工具类型分类、权限身份/交互投影、权限需求判定、resolution 构造和稳定工具名称移入 `request_policy.rs`（约 480 行）。常用 crate 内 API 经 `pi_tool_gateway` 显式 re-export 以维持现有调用面；Host 解析器仍保有最终授权和执行决定，request-policy 不执行文件或进程操作。
- `scripts/check-pi-compatibility.mjs` 的 monitor/scheduler 契约检查已改读工具名的新所有者 `request_policy.rs`，并验证 gateway 模块接线。曾因脚本把常量位置写死在父模块而失败；按职责所有者更新后通过。清理多余 re-export 后 `cargo check --locked --lib` 无警告。
- 第四切片完成时，Host gateway 主文件约 2,791 行，职责模块分别为 `workspace_tools.rs` 1,092 行、`tool_output_archive.rs` 365 行、`request_policy.rs` 约 480 行；这是阶段快照，行数只作迁移证据，后续仍以职责与依赖边界为选择标准。
- 第六个切片已完成：按 worker 请求路径加载祖先 `AGENTS.md`/`CLAUDE.md` 的 Host 预检逻辑及其路径/总量边界移至 `instruction_scopes.rs`（191 行）；共享词法相对路径验证抽为 `workspace_paths.rs`（25 行），供 instruction scope 与 workspace tools 共同使用。网关原 `resolve_instruction_scope_request` 路径保留为 re-export，Host 文件路径 canonicalization、symlink 拒绝和字节/数量上限未改。
- 第七个切片已完成：Host 管理的子代理 worktree 路径约束、managed root 每层 symlink 检查、task ID 哈希和 detached `git worktree add` 移至 `subagent_worktrees.rs`（189 行）。worker runtime 原 `resolve_subagent_worktree_request` 调用路径由网关 re-export 维持，git 分支/路径选择权仍在 Host。
- 为该安全边界新增 2 个模块测试，验证 managed worktree 路径受限且不暴露原 task ID、managed root symlink 被拒绝；现有 gateway internal-request 测试仍通过。
- 第八个切片已完成：`pi_worker_runtime.rs` 的 Host memory 首轮注入、根 session transcript 收集/去重和大小上限、关闭/退出时保存及清理状态移入 `pi_worker_runtime/memory_lifecycle.rs`（289 行）。`PiWorkerRuntime` 仍决定进程/事件的生命周期时机，只委托 memory component 管理自己的 session state；worker/Host event contract 与注入时机未变。
- 归属 `bound_session_text` 的 UTF-8 与字节上限测试随 helper 移至 memory lifecycle module。当前 `pi_worker_runtime.rs` 从 3,218 降至 2,939 行，模块新建清晰地拥有 transcript/injection state，没有建立旁路 API。
- 当前 gateway 主文件约 2,428 行；`workspace_tools.rs` 1,092 行、`request_policy.rs` 470 行、`tool_output_archive.rs` 365 行、`instruction_scopes.rs` 191 行、`subagent_worktrees.rs` 189 行、`workspace_paths.rs` 25 行。行数仅记录迁移结果，后续仍按职责与依赖边界选择。
- 最新复验：Rust 全库 `cargo test --locked --lib` 285 passed；其中 `pi_worker_runtime::tests` 8 passed，memory lifecycle bounds 测试 1 passed；`cargo check --locked --lib` 无 warning、`cargo fmt --check` 通过。第八片仅改 Rust，前一轮已对第七片后的累积状态完整通过 `pnpm check`、398 项 `pnpm test:unit`、lint、format、build 和 diff check；当前执行链仍待重跑静态门禁。
- 第九个切片已完成：Host tool hooks、worker tool request/resolution、permission routing 和持久化权限查询移至 `pi_worker_runtime/host_tool_routing.rs`。`PiWorkerRuntime` 保留 child/process supervision 与事件入口；数据库 lookup 失败或存储值非法仍保持 ask 交互，不扩大权限；Host 最终授权仍由 ToolGateway 决定。
- 事件读取器只通过 `host_tool_routing::persisted_permission_for_interaction` 请求已保存的决策；其余 persistence helpers 不再散落在大 runtime 父模块。兼容门禁对 LSP/codebase bridge 现检查 Host routing 模块实现，并要求父模块声明该模块，避免 owner 变更后误报。
- 第九切片验证：`cargo test --locked --lib pi_worker_runtime::tests` 8 passed，Rust 全库 285 passed，`cargo check --locked --lib` 无 warning，`cargo fmt --check`、`pnpm check`、`pnpm lint`、`pnpm format:check` 和 `git diff --check` 通过。`pnpm test:unit`/build 未在第九片后重跑；本片只改 Rust runtime、静态 checker 和治理文档，前序累积 TS 单测/build 已通过。
- 第十个切片已完成：remote HTTP/SSE response bounds、认证/HTTP/SSE error classification、JSON-RPC/SSE parsing、SSE endpoint origin validation、request timeout/cancellation 与 `RemoteMcpConnection` 状态机移至 `pi_mcp_runtime/remote_transport.rs`（685 行）。
- `PiMcpRuntime` 仍拥有 active call/session/run cancellation、local/remote connection registry 和 workspace shutdown；父模块只根据规范化 config 选择 connection，不接触 remote endpoint/session internals。connection 的 spec equality 与 workspace containment 通过深接口完成。
- 第十切片验证：`pi_mcp_runtime::tests` 15 passed（覆盖 local stdio/remote HTTP/SSE 和 cancellation），全 Rust library 285 passed，`cargo check --locked --lib` 无 warning，`cargo fmt --check` 通过；`git diff --check` 通过。该切片未改 TS/静态 checker，因此 `pnpm check`、398 个 unit tests 与 build 使用第九切片前已通过的累积验证。
- 第十一切片已完成：本地 stdio MCP process lifecycle、safe environment、bounded framing、pending request/response routing 和 capability projection 移至 `stdio_transport.rs`（448 行）。连接 spec match 与 workspace containment 收为内部查询，runtime 不再依赖连接内部字段。
- 第十二切片已完成：trusted user/project MCP config merge、server descriptor collection、stdio/HTTP/SSE entry validation、bounded header/environment projection 和 config status inspection 移至 `mcp_config.rs`（523 行）；原 `pi_mcp_runtime::inspect_mcp_config` crate 路径 re-export 保留。
- 当前 MCP 结构：`mcp_config.rs` 规范化配置，`stdio_transport.rs` 拥有本地 child protocol，`remote_transport.rs` 拥有远端 HTTP/SSE protocol，`PiMcpRuntime` 管理统一 active calls、session/run cancellation、连接缓存、cross-transport replacement 和 workspace shutdown。parent runtime file 为 1,288 行，含集成测试；没有新增协议、权限决策或重复连接缓存。
- 十二切片后验证：MCP 定向测试 15 passed，Rust library 285 passed，`cargo check --locked --lib` 无 warning，`cargo fmt --check` 和 `git diff --check` 通过；完整 `pnpm check`、`pnpm test:unit` 398 passed、`pnpm lint`、`pnpm format:check` 和 `pnpm build` 通过。build 仍发出既有 >500 kB chunk warnings。Pi compatibility checker 未改。
- 第十二切片后，余下重点是 worker `tool-gateway.ts`（当时 2,654 行，需判断解析/桥接/审批投影的真实职责边界），以及更广的依赖/重复契约分析；MCP runtime 剩余主要是统一 registry/call lifecycle 和 result presentation，需先查调用与测试再决定是否继续细分。第十三切片已将稳定工具合同与纯访问策略提取；当前运行时网关仍待继续审计。
- 尚未完成：全仓依赖图/重复逻辑分析；候选热点的接口扇出、测试替换性和职责变化频率；未触及 Rust 全量/跨平台门禁。
- 基线门禁（重构前）：`pnpm test:agent-worker` 140/140 通过；`cargo test --locked --lib pi_tool_gateway::tests` 35/35 通过。未运行完整 TS/Rust 全量门禁。

## 技术决策

| 决策                                                                                                     | 理由                                                                             |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 不按文件行数直接拆分；先画职责与调用面                                                                   | 避免把大模块拆成薄转发层                                                         |
| 先进行行为保持型内部重构，协议变化另行评估                                                               | 降低安全和兼容性风险                                                             |
| 测试先建/补齐 seam 上的行为测试，再移动或改实现                                                          | 确保局部化验证而非仅靠全量回归                                                   |
| 第一个候选切片是从 Pi 会话 lifecycle 中提取资源发现，但须先确认测试基线和 resource-manifest 调用面       | 资源发现集中、入口窄，可在不改变 worker/Host wire protocol 的情况下提高 locality |
| 该切片只移动实现并从实际 seam 测试；旧 `session-adapter.ts` 继续 re-export 已有测试/内部调用会使用的函数 | 保持用户/worker 运行行为和调用路径稳定，避免临时双实现或迁移兼容层               |

## 遇到的问题

| 问题                                                                      | 解决方案                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 首次类型检查因抽取后的 4 个未使用 import 失败                             | 删除已不再使用的 imports；重跑完整检查确认                                |
| Pi compatibility checker 将技能/提示词路径规则硬绑定在 session-adapter.ts | 改为检查职责拥有者 resource-discovery.ts，并增加 adapter wiring assertion |

## 资源

- `docs/architecture/pi-migration/handoff.md`
- `docs/architecture/pi-migration/README.md`
- `packages/agent-worker/src/pi/session-adapter.test.mjs`
- `packages/agent-worker/src/pi/tool-gateway.test.mjs`

## 视觉/浏览器发现

- 不适用；当前为源码结构治理。

## 第十三切片：Pi worker 工具合同与纯访问策略

- `packages/agent-worker/src/pi/tool-gateway.ts` 原先将稳定协议工具名、gateway tools 列表和纯 subagent/session-mode allow policy 与运行时请求/交互流程共置；其中工具名同时服务事件映射与 session capability announcement，访问策略则是无网关状态的纯逻辑。
- 稳定名与 `PI_GATEWAY_TOOL_NAMES` 已归 `tool-names.ts` 所有。网关使用它们执行原有 tool-definition/dispatch，`export *` 维持 `tool-gateway.ts` 对下游的既有导入路径。
- capability-mode intersection、按 capability 的 tool allowlists 和 plan/ask session-mode predicate 已归 `tool-access-policy.ts`。网关仍持有输入错误归一化和执行前 session-mode 校验调用；任何 tool 的最终权限/执行仍由 Host gateway 裁决。
- 策略行为测试直接导入新的 owner；新增 façade identity test 检查旧 gateway export 与新 policy export 指向相同函数。Pi compatibility checker 同时读协议名与策略 owner，并要求 gateway wiring。
- 第十三切片后 `tool-gateway.ts` 从 2,654 行降至 2,416 行。其 worker tests 141 passed、full unit 399 passed，`pnpm check`/lint/format/build/diff check 通过；build 继续给出既有 >500 kB chunk warnings。
- 首轮 worker 测试发现网关本身的 `ensureToolAllowed` 仍直接使用 `isAgentSessionModeId`；把依赖保留在运行时网关而不是勉强把含错误与交互的 `ensureToolAllowed` 搬入纯策略模块，完成后回归通过。

## 后续审计候选

- 第十四切片已把全部 tool parameter schemas 从 gateway catalog 抽离；第十五切片迁出纯 task-result projection；第十六切片再将 pending request 状态机与成对事件流程集中到 `tool-request-lifecycle.ts`；第十七切片将 permission identity projection / response-envelope normalization 放入 `tool-permission.ts`；第十八切片将 subagent/background task tool definitions 移入 `task-tools.ts`，并把共同结果 projection 放入 `tool-results.ts`。当前 `tool-gateway.ts` 为 1,008 行，主要保留授权/交互调用时机、通用工具执行路由和其余 tool catalog assembly。
- lifecycle 组件持有 maps、超时和请求结束语义；`PiToolGateway` 组合它并保留现有请求入口，不在 Host 外新增授权决策。原测试经 façade 继续覆盖行为，因此这次移动没有复制状态或增加公开协议。
- permission contract 仅生成脱敏身份和解释 Host 交互响应，不负责产生 permission grant；Gateway 与 Host 仍对同一受限 identity 进行彼此独立的校验/派生，不能以共用函数绕过信任边界。
- Pi worker gateway 的 task-tool catalog 已通过 `sessionId`、有限 controller 和权限检查回调接入，不读取 Host registry、不改变 capability filter。原 gateway 类行数下降不是目标本身，现应把审计转向更大剩余 Host gateway。
- 最新 Rust hotspot scan 中，`pi_tool_gateway.rs` 约 1,533 行；workspace file operation、output archive、request policy、instruction scopes、workspace path、subagent worktree、terminal process lifecycle、monitor tool adapter 与 scheduler tool adapter 已有独立所有者。终端模块仍不拥有共享 workspace mutation lock，也不处理 monitor id：前者同时串行化文件写与前台 terminal，后者由父 gateway 在 monitor/terminal 两个 Host task owner 间路由。剩余重点转为 dispatcher 边界及更广的配置模块依赖/重复合同审计。
- 更广的全仓依赖/重复合同审计仍未完成；不要仅按子目录或工具名机械切分。
- 更广的全仓依赖/重复逻辑分析仍未完成；本轮只逐步减轻已确认的混合职责热点，没有声称“全项目无技术债”。

## 第十九切片：Host terminal process/task lifecycle

- 前台 terminal 执行、输出管线、timeout/kill 监督、后台进程 registry/pruning、任务结果/状态、session 与 workspace 所有权验证及 Pi worker shutdown cancellation 原本与文件工具、Host dispatcher 和 monitor/scheduler bridge 共置。它们共享一个进程与后台任务状态生命周期，因此迁入 `src-tauri/src/pi_tool_gateway/terminal_tasks.rs`。
- gateway 继续在权限确认之后调用 `run_terminal_with_policy`，仍持有与文件写操作共享的 workspace mutation lock；monitor 仍使用独立 `pi_monitor_runtime` registry。gateway 只负责判断控制请求所指 task kind，并将 terminal 请求交给 terminal owner，不合并两种状态机。
- 输出边界和 sandboxed command builder 均保留原实现，task id prefix、失败文本、等待/取消上限和 JSON snapshots 不变。`cancel_background_tasks_for_workspace` 仍通过原 crate 内 gateway 函数调用，使 `PiWorkerRuntime` 调用点无需重排。
- 终端 policy 静态门禁现在读取 `terminal_tasks.rs`，并验证 gateway module wiring。第十九切片后 gateway 约 1,815 行，新 terminal lifecycle 模块 660 行。
- 全 Rust lib tests 285 passed，gateway 定向 35 passed，`cargo check --locked --lib` 无 warnings，Rust fmt、`pnpm check`、lint/format 和 diff check 通过；本片仅触及 Rust 与兼容静态检查，未重跑 unit suite/build。

## 第二十与第二十一切片：Host monitor 与 scheduler adapters

- Monitor start/event bridge、snapshot projection 和 monitor-specific wait/get/kill control 迁至 `monitor_tools.rs`；`pi_monitor_runtime` 仍拥有实际运行进程及 event stream。父 gateway 保留跨 terminal/monitor 的 ID routing，避免把两套状态 registry 折叠成通用 task manager。
- Scheduler create/list/delete 参数映射、数据库 access/session filtering 与 model-facing snapshot 移至 `scheduler_tools.rs`；数据库及 scheduler runtime 仍为 source of truth，Host authorization 仍先于 adapter dispatch。
- Pi compatibility checker 改读取两个新 owner，scheduler argument contract 检查直接定位 `scheduler_tools.rs`，并验证 parent wiring，不再要求实现内联在 dispatcher。
- 当前 `pi_tool_gateway.rs` 约 1,533 行；`terminal_tasks.rs` 660、`monitor_tools.rs` 207、`scheduler_tools.rs` 112 行。全 Rust lib tests 285 passed、gateway 定向 35 passed、`cargo check --lib` 无 warnings，`pnpm check`/lint/format、Rust fmt 和 diff check 通过；此两片未改 TS runtime。

## 第二十二切片：Pi runtime policy configuration projections

- `config_extensions.rs` 原先同时实现 plugin/skill/prompt inventory scans 与一组独立的 Pi runtime policy projections。terminal、question、goal、gitignore、envrc、model network/catalog 和 sandbox policy 都把用户/project config 和显式 process override 归一成受限 worker projection，可作为单一变化原因的 policy module。
- 新 `config_pi_policy.rs` 仅依赖 config core 文档、parent shared merge helper 与标准化类型；通用 extension commands/plugin inventory 留在 `config_extensions.rs`，Pi skill/prompt discovery 和 manifest assembly 后续归入 `config_pi_resources.rs`。既有调用路径经显式 `pub(crate)` re-export 保持稳定。
- 发现并修正 `merged_config_array` 上方历史残留的资源 manifest 注释，把它放回实际 `pi_resource_manifest` 函数，减少职责解释漂移。
- `config_extensions.rs` 从约 2,162 行降到 1,737 行，policy owner 450 行。config runtime tests 27 passed，全 Rust lib tests 285 passed，`cargo check --lib` 无 warnings，`pnpm check`/lint/format、Rust fmt 与 diff check 通过；未改 TS runtime，未在此片后重复 unit/build。

## 第二十三切片：Marketplace Git transport 与 cache lifecycle

- `config_marketplace_native.rs` 同时持有插件目录/manifest/registry/install 领域逻辑和 Git subprocess/cache refresh 机制。后者共享 URL/ref/SHA 校验、source identity、clone/head、cache 锁和 refresh/fallback 生命周期，因此归入 `config_marketplace_transport.rs`；插件候选扫描、来源解析、安装/更新/卸载与 registry 仍由 marketplace catalog owner 持有。
- Marketplace parent 只通过少量 transport 函数调用同步与 clone；不存在第二套 cache state。原 Git 参数边界、clone/fetch/checkout 顺序、缓存 freshness、临时目录 replace/backup 和错误语义保持不变；SHA validator 与其它 transport 验证一并归入新 owner。
- 第一次编译暴露抽取后 `std::fs` 与 SHA validator 作用域不完整；已把 SHA 校验归并到 transport owner、保留 parent 内部调用别名并补入独立文件系统 import，再验证通过。
- 全 Rust lib tests 285 passed，marketplace/config_runtime 定向 27 passed，`cargo check --locked --lib` 无 warning；`cargo fmt --check`、`pnpm check`、lint、format 与 `git diff --check` 通过。仅改 Rust 实现和规划记录，未重跑 TS unit/build。
- Registry state ownership 已由第三十一切片处理；后续从当前热点与调用图转向模型配置中的远程 catalog lifecycle，并继续检查其它未审计边界。

## 第二十四切片：Marketplace catalog owner 与 metadata contract

- 清单 index 解析、plugin manifest 读取、受限资源路径解析、skill/component inventory、候选构造和目录 fallback scan 共属“从一个 Marketplace source 发现可安装 plugin”这条变化路径，已归入 `config_marketplace_catalog.rs`。`config_marketplace_native.rs` 保留 workspace-authorized commands、registry/安装/更新/卸载和跨 catalog/transport 协调；候选发现接口只在 crate 内使用。
- 将原来 7 元素 `plugin_metadata` tuple 改成命名 `PluginMetadata` 字段（name/version/description/skill/component flags），消除 `.1`、`.2` 与截断 tuple destructuring 对返回顺序的隐式耦合。
- marketplace path validator 与 containment helper 一并放在 catalog owner，registry subdirectory validation 和安装过程复用同一 source-relative lexical contract；`config_plugin_details.rs` 的 path scanner 保持独立，因为它拒绝内部 symlinks 并对 malformed manifest 作 ACP compatibility classification，Marketplace scanner 的现有投影语义不同，强行统一会改变安全/兼容行为。
- parent 保持约 1,812 行，catalog owner 386 行，transport owner 268 行；源码移动不改 index fallback、manifest field handling、扫描上限、symlink treatment、candidate ordering 或 install/update data shape。
- 完整 Rust lib tests 285 passed；`cargo check --locked --lib` 无 warnings、`cargo fmt --check`、`pnpm check`、lint、format 和 diff check 通过。TS UI/worker/runtime 无变化，未重跑 unit/build。

## 第二十五切片：Declarative subagent Markdown parser

- `config_subagents.rs` 将 agent 定义文件来源、目录优先级与 Host policy-manifest 组装，同 Markdown frontmatter/YAML-ish scalar/list parser 以及工具 allowlist-to-capability mapping 共置。解析字段合同、malformed field 降级和工具 allowlist 上限映射是单独的受限输入解析责任，现由 `config_subagent_markdown.rs` 拥有。
- parent 保留 roots/precedence、TOML/native/plugin definition loading、roles/personas normalization、unsupported-field aggregation 和 Host manifest assembly；共用 bounded name/text/file/MCP limits 从 parser owner 显式导入，没有复制常量。
- Pi compatibility checker 改为直接读取 parser owner 校验 `MAX_MCP_TOOL_GRANTS`、MCP tool validator 和 allowlist ceiling mapping，同时确认 parent module declaration/wiring，避免合同跟旧父文件路径耦合。
- `config_subagents.rs` 从 1,619 行降至 1,117 行，parser owner 523 行；frontmatter formats、field classification、MCP tool grants、read-write-execute mapping 和 parser failure behavior 未变。
- Subagent config 专项 6 passed，全 Rust lib tests 285 passed；`cargo check --locked --lib` 无 warnings，`cargo fmt --check`、`pnpm check`、lint、format、diff check 通过。没有运行 TS unit/build，因为产品运行时代码只改 Rust。

## 第二十六切片：Pi memory store 与 SQLite index

- `pi_memory_runtime.rs` 原来同时拥有 Host memory enablement/config、tool request routing、首轮搜索上下文、session transcript lifecycle、Markdown scope/path safety、memory tool handlers 和 SQLite lexical index。后面几项共享 memory file/index 不变量，现集中在 `pi_memory_runtime/store.rs`；父 runtime 仅准备/授权 memory config、选择首轮 query、保存有界 transcript，并将 index rebuild command 委托给 store。
- store owner 承载 bounded Markdown reads/writes、symlink/path preflight、原子 durable-note append、workspace identity、Markdown chunking/ranking 和 memory handlers；SQLite sidecar schema/digest/tamper validation 已在第三十九切片进一步归属 `store/search_index.rs`。父 session lifecycle 与 durable remember 共享同一 store 写锁/路径 preflight，不复制边界逻辑。
- `MemoryIndexSummary` 与显式 `rebuild_memory_index` 的 crate 调用面保持不变。memory tool enablement 留在父 Host facade；worker 仍不能选择任意路径或绕开 Host 路由。Pi compatibility checker 分别读取父 runtime/store owner，并断言 delegating/wiring，索引 marker 跟随真正实现。
- 父文件从 2,054 行降至 728 行，持久化 store/index owner 为 1,372 行；剩余测试仍在父文件并通过受限 `pub(super)` test seam 验证 store internals。
- 首次机械重写使用过时 offset 导致父文件语法损坏。由于该文件在尝试前未被修改，恢复输入取自 `HEAD` 的干净 beta 文件；重做时先从同一不可变源计算所有区间、全部断言成功后才写出文件。未触及其他已完成工作树更改。
- memory runtime 专项 15 passed、全 Rust lib tests 285 passed；`cargo check --locked --lib` 无 warnings、`cargo fmt --check`、`pnpm check`（Pi compatibility）、lint、format 和 diff check 通过。仅 Rust/静态 checker 受影响，未重复 TS unit/build。

## 第三十九切片：Memory search-index owner

- `pi_memory_runtime/store.rs` 原先仍把 authoritative Markdown/tool operations 与 disposable SQLite index persistence 放在同一模块。SQLite 的 schema migration、sidecar path preflight、source digest、row scope/tamper validation、rebuild 和 cache-read fallback 现在归 `store/search_index.rs`；主 store 保留 Markdown filesystem/path operations、chunking/ranking 与 tool handlers。
- Markdown 是唯一 source of truth。Search index owner 在 sidecar 不可用或行被篡改时返回刚加载的 Markdown chunks；memory facade 原 `MemoryIndexSummary` 和 rebuild 命令接口仍由 store 显式 re-export，其他读写接口只向 memory runtime 暴露受限可见性。
- Pi compatibility checker 分别读取 store 与 search-index owner，核验模块接线、真实实现 marker 和 `index.sqlite` 所有权。
- 新增两项 owner-level regression tests：SQLite sidecar 不可用与 sidecar 行 tampering 均回退到 Markdown；既有 schema mismatch、stale digest、scope、row tamper 与 incremental sync tests 继续覆盖持久化合同。
- Memory runtime tests 15 passed，search-index owner tests 2 passed，全 Rust lib 295 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning，`cargo fmt --check`、`pnpm check`、lint、format 和 `git diff --check` 通过。仅 Rust/compatibility checker 变化，未重跑 JS unit/build；未改权限、wire protocol、版本或发布状态。

## 第四十切片：Host Tree-sitter parser owner

- `pi_codebase_runtime.rs` 把 Tree-sitter language selection、AST node walk、语言特有 definition classification、occurrence validation 与 dedup 同工作区扫描、cache refresh/query 和 worker request/response 混在一起。前者完全依赖 source bytes/path extension，现归入 `pi_codebase_runtime/parser.rs`，通过“源文件 -> definitions/references”边界交回 index owner。
- Parent 保持文件 walk、gitignore/workspace bounds、incremental fingerprint cache、index/query state、indexing config policy、canonical path validation、Host tool request authorization/response。Parser 仅暴露 occurrence result 与受限 source-extension predicate，不持有 workspace/Host request state。
- AST depth 与 symbol byte bounds 随 parser owner 移动；compatibility checker 分别检查 parser 与 index owner，并确认 parser wire-in 与 Host worker route 不变。新增 tests 覆盖受支持语言映射、Rust definition/reference extraction 与 unsupported extension rejection。
- `pi_codebase_runtime.rs` 从 1,322 行降至 1,020 行，parser owner 为 363 行。Codebase 定向 tests 8 passed，全 Rust lib 298 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning，Rust fmt、`pnpm check`、lint、format 和 diff check 通过。只改 Rust 与 static compatibility checker；未改索引边界/路径授权/wire protocol/版本或发布状态。

## 第四十一切片：Pi worker launch owner

- `pi_worker_runtime.rs` 同时持有 supervisor lifecycle 与 packaged worker discovery / child process environment assembly。Exact platform binary names/target triples/candidate resolution、`MELODY_PI_WORKER_PATH` development override、ambient env allowlist、`.env_clear()` 后的 Host projection 和 managed model/resource environment 现归 `pi_worker_runtime/launch.rs`。
- Supervisor 仍决定启动时机、取模型/网络策略、执行受限 `.envrc` loader、生成 child、handshake、restart 与 shutdown；launch owner 只 resolve executable 并把已有 policy/model/resource inputs 投影到 `Command`，不接管 Pi session/process state。
- 保持既有 child environment allowlist、resource order、credential precedence、managed-path override 和 exact executable-name match；新增测试确认类似 `melody-agent-worker-*` 的任意文件名不会成为 candidate。Pi compatibility checker 按 launch 实现 owner 检查 `env_clear`、binary search 和 inherited environment，并检查 supervisor module wiring。
- `pi_worker_runtime.rs` 从 2,053 行降至 1,735 行，launch owner 367 行。Pi worker 定向 tests 10 passed（含 launch discovery），全 Rust lib 299 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning，Rust fmt、`pnpm check`、lint、format 和 diff check 通过。只改 Rust 与 compatibility checker；未改变 Pi-only runtime、授权/安全边界、版本或发布状态。

## 第四十二切片：Schedule policy owner

- `database_agent_schedules.rs` 同时包含 durable row/transaction lifecycle 与无 SQLite 状态的 schedule policy。时刻推进（once/interval/cron）、run-limit/expiry transition、错过触发决策、compact interval parsing 与 schedule ID/kind/status/missed-policy allowlists 现归 `database_agent_schedules/policy.rs`。
- Schedule state owner 继续负责请求持久化、Pi session binding identity snapshot、SQL schema/migration、CRUD、run journal/事务与 Tauri command wrappers；dispatcher 和 Host scheduler tool 保持原 `crate::database` 调用面，通过 state module re-export 使用共享 policy。
- 将 recurrence/validation tests 移至 policy owner，数据库行为 tests 仍在 state owner。`database_agent_schedules.rs` 从 1,324 行降至 1,022 行，pure policy owner 317 行。定向 schedule tests 12 passed；全 Rust lib 299 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning、Rust fmt、`pnpm check`（含 compatibility gate）、lint、format 与 diff check 通过。未改 schedule schema/wire behavior、Pi-only runtime、Host authorization 或版本发布状态。

## 第四十三切片：Pi event ingress contract

- `database_agent_events.rs` 原本既验证 worker envelope/协议字段与枚举、限制 1 MiB serialized event，又执行 SQLite 插入、duplicate replay 比较、epoch sequence guard、migration journal update 和 session binding checkpoint。前一组纯入口合同与 persisted-field projection 现移至 `database_agent_events/event_contract.rs`。
- Event-log parent 继续控制单事务的 event journal、migration/fork side effects、idempotency、session-binding 更新与 renderer read command；事件合同不连接数据库。迁移/backup metadata extraction 也随对应事件字段解析归 event contract，移除 parser 对 migration-state owner 的反向依赖。
- 新 owner direct tests 覆盖 persisted identity projection、协议/enum/sequence rejection 和 oversized payload；现有 parent tests 继续覆盖 duplicate replay、sequence monotonicity、migration atomicity、legacy binding guard 与查询顺序。`database_agent_events.rs` 从 843 行降至 677 行，contract owner 260 行。事件专项 15 passed；全 Rust lib 302 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning、Rust fmt、`pnpm check`、lint、format 与 diff check 通过。未改变事件协议、数据库事务或 binding authority。

## 第四十四切片：Pi command affinity validation

- Worker protocol owner 已拥有 outbound frame validation、event envelope/sequence contract 与 bounded NDJSON framing；renderer-provided envelope `sessionId` 与 nested command `sessionId` 的 lockstep check 原先落在 1,735 行 supervisor 中，现移动到既有 `pi_worker_runtime/protocol.rs`。
- Supervisor 继续读取命令类别、校验 session/workspace/database authority、migration/open/fork 及 session-bound command；protocol helper 只拒绝冲突/非法 envelope identity，不变成授权器。原测试移至 protocol owner；Pi compatibility checker 明确校验 helper 所属文件。
- Pi worker 专项 10 passed（含 command affinity），全 Rust lib 302 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning，Rust fmt、`pnpm check`、lint、format 与 diff check 通过。`pi_worker_runtime.rs` 现为 1,665 行；未改 Host authorization 或 worker wire envelope。

## 第四十五切片：Billing usage projection

- `event-to-session-update.ts` 既归并不完整的 Pi usage snapshot，又将美元成本转成 product `1e-10 USD` ticks 并生成 legacy billing usage payload。该换算与 event/timeline reducer 的变化原因不同，现归 `billing-usage.ts`。
- `projectAgentEvent` 继续掌握 `usage.updated`/`run.finished` 的顺序、per-session latest usage 生命周期和 timeline/session updates；新 owner 只合并 usage fields、标记 partial/incomplete usage 与投影计费单位，不改 context-token 诊断。
- 新增 direct tests 覆盖 measured USD 换算、非 USD/不完整成本不得伪装为零，以及 partial snapshot 保留最后已知成本；既有 event reducer integration test 继续覆盖 billing/context 分离。`event-to-session-update.ts` 从 923 行降至 849 行，owner `billing-usage.ts` 81 行。定向 27 项与 full `pnpm test:unit` 406 项通过；`pnpm check`、lint、format 和 production build 通过，build 仍有既有 >500 kB chunk warnings。

## 第四十六切片：Subagent Markdown inventory scan

- `config_subagents.rs` 的 Pi manifest 与 capability inventory 均发现同一类 agent Markdown 文件，但 inventory 曾复制目录遍历、排序、数量上限、fallback name 和解析错误处理；两条路径可能随时间出现不同的文件资格/unsupported 分类。
- 现由 `agent_definition_paths` 提供相同的排序与 128 文件边界，`parse_agent_definition_entry` 提供同一 fallback/错误分类；runtime manifest、plugin loading 与 native/plugin inventories 均复用该扫描和解析入口。没有新建转发模块，也没有改变来源优先级、scope 或 Host manifest authority。
- 新增 inventory 回归测试覆盖安全定义的 path/scope 与 dynamic-hook definition 的 unsupported 字段。定向测试 1 passed，全 Rust lib 303 passed；`cargo check` 无 warning，Rust fmt、`pnpm check`、lint、format 和 diff check 通过。该片只改 Rust，JS unit/build 沿用第四十五片 406/build pass。

## 第四十七切片：Subagent Settings inventory projection

- `list_melody_agent_definitions` 只需要全局 enable、per-agent toggle、源 path/scope 和 supported/unsupported summary；此前先完整调用 Pi policy manifest（重新扫描 native/plugin Markdown、读取 roles/personas/inline inputs 并规范化 prompt/config），随后再单独重读配置以构造 Settings inventory。
- 现在 Host command 在授权 workspace 后仅读取一次 user/project config；独立的 `merge_agent_inventory_config` 负责 scoped precedence、enable/toggle 与 inline-definition inventory projection，随后复用共享文件扫描入口并按原来的 native → plugin → inline precedence 输出。`pi_subagent_policy_manifest` 仍是 session manifest 的独立唯一投影路径；Host authorization 与 worker manifest 不变。
- 新测试直接覆盖 user/project 全局开关、per-agent override、inline shadowing、origin path/scope 与 unsupported field projection。`config_subagents` 8 passed，全 Rust lib 304 passed；`cargo check` 无 warning，Rust fmt、`pnpm check`、lint、format 与 diff 门禁通过。只改 Rust；JS unit/build 最近一次于第四十五片完整通过。

## 架构门禁复核：source-level dependency boundaries

- 现有 `check-architecture.mjs` 用正则检查 `src/domain` 的禁止依赖和 worker 的 Pi SDK import owner，但静态正则漏掉 side-effect、dynamic、`import type`、re-export、`import()` type 与 `require` 等语法，也会把注释/字符串当作代码。
- 改用 TypeScript AST 收集真实模块 specifier，规则仍只表达已有边界：domain 不依赖 UI/store/lib、React/Tauri；Pi SDK 只从 worker `src/pi/` owner 导入。没有增加新的模块分层或推断职责/循环规则。CI 现有 `pnpm check:architecture` 步骤会运行对应的三个契约自测、格式检查与真实树扫描。
- 新测试验证各种 import 语法、注释/字符串忽略、domain 禁止依赖和 Pi SDK owner allowlist；`pnpm check:architecture` 的 3 项自测和当前仓库扫描通过。下一步仍需检查核心依赖环、跨层调用和重复协议契约，当前门禁不覆盖这些内容。

## 第四十八切片：TypeScript 架构依赖门禁

- `check-architecture.mjs` 原本用 source regex 检查禁止依赖，可能漏掉 dynamic/type/re-export/CommonJS 形式或误扫注释/字符串。现在由 TypeScript AST 收集真实 module specifier，覆盖各 import 形式并用 3 个测试自证；既有 domain 与 Pi SDK owner 规则未扩大为职责分类或循环检测。
- `pnpm check:architecture` 的 AST contract tests、Prettier 与仓库扫描通过；后续 review 仍需独立检查依赖环及职责内聚，不能把 source-level gate 结果当作架构完整性证明。

## 第四十九切片：Host MCP capability inventory

- Pi preflight 原先在 `capability-report.ts` 复制约 180 行 MCP root traversal、transport/schema/URL/header 解析，与 Rust Host MCP loader 的支持判断易产生漂移。现在 Host 的 `inspect_mcp_config` 提供只读、不开启进程的 inventory command；renderer 只消费 `supported` 与错误名称，不再自行判定可执行性。
- runtime strict loader 仍遇到不可解析配置时拒绝启动；仅 preflight inventory 跳过 parse-failed scope 并继续报告另一份可读 scope，保证 parse-blocking diagnostic 与 MCP degradation 可并存。Tauri command 先经 WorkspaceRegistry 授权，权限 allowlist、compatibility manifest 和静态 wiring gate 均已接通。
- 回归覆盖两种边界：Host 对“看似有效”的配置拒绝仍显示 degradation；Host 接受而 renderer 快照描述不一致时不重复否定。Rust owner test 覆盖一份 scope parse error 时保留另一份可读 inventory。能力报告定向 42 passed、全 JS unit 407 passed、MCP config Rust 1 passed、全 Rust lib 305 passed；`cargo check` 无 warning，Rust fmt、`pnpm check`、lint、format、build、diff check 通过。Vite build 保留既有 >500 kB chunk warnings。

## 第五十切片：Subagent launch policy ownership

- `session-adapter.ts` 同时决定内建 subagent type 的 capability ceiling、definition/request mode 的 approval intersection；`subagent-policy.ts` 已负责同一策略域的 manifest/default resolution，因此 adapter 中重复一个 `general-purpose -> all / other -> read-only` default 和权限等级表会让规则变更需要同步改两处。
- `defaultPiSubagentCapabilityMode` 与 `intersectPiPermissionModes` 现由 `subagent-policy.ts` 持有；manifest resolver 复用同一个 capability default，session adapter 只将请求/父会话状态送入 policy helper，仍保留 session/task 生命周期、父权限夹限及 Host authorization boundary。
- Direct policy tests 覆盖 built-in/custom type defaults 与双向 permission ceilings；`test:agent-worker` 现包含已有 `subagent-policy.test.mjs`，避免专属策略测试只在全量 unit 命令运行。Subagent policy 7 passed，worker 152 passed，full unit 408 passed；`pnpm check`、lint、format、build 和 diff check 全通过，Vite 保留既有 >500 kB chunk warnings。仅 worker policy/test wiring 变化，无 Rust 或版本调整。

## 第五十一切片：Pi model catalog runtime owner

- `session-adapter.ts` 之前拥有 Pi `ModelRuntime` cache、catalog refresh serialization/revision、provider auth/model projection、Host `MELODY_PI_MODEL_*` credential replacement/rollback、auth command handling，以及 product model ID resolution。它们是 provider/catalog 生命周期，与 Pi session/task lifecycle 分属不同变化原因，现集中到 `model-catalog-runtime.ts`。
- 新 owner 只通过 `WorkerEmitter` 和 `refreshLiveSessionSettings` callback 与外部交互：目录同步和 policy snapshot 属于 model owner；把新 settings 应用到 root/child Pi sessions 仍由 adapter 在生命周期队列、run boundary 上执行。没有引入另一份 catalog state，也未改变 Pi-only runtime 或 Host 的凭据投影边界。
- Owner-level tests 覆盖 non-secret model event/auth/refresh diagnostics、canonical/display/Host-generated model aliases 和 headless-auth error contract；既有 adapter integration test 继续覆盖 credential replacement、provider override removal、catalog event 与 idle-session refresh。
- `session-adapter.ts` 从 4,129 行降至 3,836 行，新 owner 343 行。Worker 155 passed，full unit 411 passed；`pnpm check`、`pnpm check:architecture`、lint、format、production build 与 `git diff --check` 通过。Build 保留既有 >500 kB chunk warnings；branch/version/release state unchanged。

## 第五十二切片：Model-policy test ownership

- `model-policy.ts` 的 8 个 parser/validation/settings-projection tests 原本留在 `session-adapter.test.mjs`，导致 adapter suite 同时要求知道纯策略文件的 schema 和 native `SettingsManager` stale-field 规则。
- 将原 tests 原样迁至 `model-policy.test.mjs`；session-adapter suite 保留会话边界、model-sync integration 与实际策略应用行为。worker-specific 与 root unit test manifests 均显式纳入 owner test，无测试删除或复制。
- 新旧 test owner 聚合 54 passed；完整 worker suite 155 passed，full unit 411 passed，`pnpm check`、lint、format 与 diff check 通过。该片只有测试组织/script 清单变化，生产代码无变；production build 复用第五十一切片通过的结果。

## 第五十三切片：Subagent launch-policy projection

- `subagent-policy.ts` 现以窄 request/resume/parent snapshots 计算 child launch policy：built-in 与 legacy named-role/agent alias、capability/permission ceilings、isolation、exact MCP grants、model/reasoning precedence 和 prompt policy resolution 均由一个纯 owner 决定；Pi session creation、Host worktree authorization、resource loader 与 task/event lifecycle 仍由 session adapter 控制。
- 两种 launch input normalizer 与 subagent type/isolation types 归到 policy owner；`tool-gateway.ts` 只 re-export normalizers/type，`subagent-records.ts` 与 task tools 按稳定路径消费类型。Compatibility checker 跟随实际 owner，并检查 gateway adapter wiring；Host 的最终授权和 worktree 路径裁决没有移动。
- Direct policy tests 覆盖 fresh custom-agent/default policy 与 parent/MCP ceilings、legacy custom-role alias、resume 对持久类型/isolation/model/reasoning 的遵循、capability/MCP/permission 只能受 parent ceiling 收紧，以及 malformed request 在 resume 时仍 fail-closed。复审发现 explicit invalid isolation 在 resumed policy 原先会因旧 adapter 的预校验被拒绝；已恢复该行为并加独立 regression test。
- `session-adapter.ts` 当前 3,753 行（本片前 3,836 行）；policy owner 当前 950 行，adapter 只组装快照并负责后续 I/O/lifecycle。Worker tests 159 passed、full unit 415 passed；`pnpm check`、`pnpm check:architecture`（3 tests）、lint、format、production build、`git diff --check` 通过。Build 保留既有 >500 kB chunk warnings。当前 branch/version 仍为 `beta` / `0.4.0-beta.2`，未发布或合并。

## 第五十四切片：Tauri command permission owner

- 将 Tauri invoke handler、main-window `commands.allow`、renderer `invoke()` 扫描及 `src` traversal 收进 `tauri-command-permission-check.mjs`。它通过 `checkTauriCommandPermissions(root)` 返回错误列表，调用方不需要知道匹配/遍历规则；`check-pi-compatibility.mjs` 仍聚合错误并作为组合 gate 保留原输出。
- 保留原有 regex 覆盖与失败分类，不把 Pi capability/config policy 搬进新 owner，也不改变 Rust invoke registration 或 allowlist。三项 fixture tests 覆盖注册命令缺 permission、完整 allowlist + 未注册 renderer invoke、缺失 handler/allowlist declaration。
- `check:pi-compatibility` 现在先对 owner/module tests 做 targeted Prettier 检查并运行这些 fixture tests，再执行完整 Pi compatibility checker。通过 `pnpm check:pi-compatibility` 和 `pnpm check` 确认原有组合 gate 仍运行；`pnpm check:architecture` 3 tests、lint、`pnpm format:check`、full unit 415 passed 和 `git diff --check` 均通过。新脚本只改变检查结构，未改产品 runtime；单独产物 build 不因本片重跑。
- 仍未完成 checker 的其余结构审计：AST 显示 958-2312 行 manifest block 有 worker core checks 和 19 个独立 Host bridge contract groups；需后续基于依赖/共用解析器决定更大组间 seam，不能把本片当成全 checker 治理完成。

## 第二十七切片：Pi browser URL trust policy

- `pi_browser_runtime.rs` 同时负责 WebView/session/tab/snapshot/interaction 生命周期与远程目标信任边界。公开 HTTPS 主机过滤、私网/loopback/IP 拒绝、loopback-only preview、本地 preview snapshot 的 origin equality 以及 popup destination allowlist 共同构成一份稳定的 URL safety contract，现归入 `pi_browser_runtime/browser_policy.rs`。
- Browser runtime 继续负责导航/预览 Host 命令、WebView 创建、session scope、snapshot 和 popup 生命周期；仍在真正导航和弹窗创建前执行 policy 函数。policy 未改变 scheme、hostname、credential、长度、control character 或 preview origin 检查语义。
- compatibility checker 现在读取 browser policy owner 并断言 parent module/import wiring；现有 browser runtime tests 通过 parent 的窄 imports 覆盖公共 HTTPS、私网、loopback preview、snapshot-origin 和 popup 行为。
- `pi_browser_runtime.rs` 从 1,711 行降至 1,629 行，独立 URL policy 为 97 行。定向 browser tests 12 passed、完整 Rust lib 285 passed；`cargo check --locked --lib` 无 warning，Rust fmt、`pnpm check`、lint、format、diff check 通过。无 TS/runtime API 或版本变化。

## 第二十八切片：Pi worker wire protocol

- `pi_worker_runtime.rs` 原本将 process supervisor 与 newline JSON protocol contracts 混写：command envelope shape/request ID/version/frame size、event version/ID/replay/workerEpoch/sequence/type 和 partial-line/CRLF framing 都是一组可独立验证的边界规则，现集中于 `pi_worker_runtime/protocol.rs`。
- supervisor 仍保留 `worker_epoch`/`last_seq` 状态、handshake timeout、stdin/stdout 生命周期、sequence violation 重启/关闭决策和 event dispatch；protocol module 只解析/验证一个 envelope/frame，不拥有 child process 或 session state。
- Pi compatibility checker 跟随 wire contract 所有者检查 protocol version/frame limit/编码/事件验证/reader markers，同时确认 supervisor 声明并导入模块。现有 runtime tests 保留在集成测试模块，覆盖稳定 command IDs、版本拒绝、monotonic epoch/sequence、CRLF 和 oversized frame 行为。
- `pi_worker_runtime.rs` 从 2,285 行降至 2,144 行，protocol owner 159 行。worker runtime tests 8 passed、完整 Rust lib tests 285 passed；`cargo check --locked --lib` 无 warnings，Rust fmt、`pnpm check`、lint、format、diff check 通过。未改变 protocol version、frame limit、启动/恢复行为或外部 envelope。

## 第二十九切片：受限 `.envrc` 投影

- worker runtime 的 `.envrc` loader 原来与进程 spawn/supervisor 放在同一文件；它有独立的配置开关、direnv 子进程环境、白名单重放、输入 JSON 解析、注入变量名拒绝和数量/字节上限，现归入 `pi_worker_runtime/envrc.rs`。
- supervisor 继续拥有完整 `INHERITED_WORKER_ENV` allowlist 与 worker command configure/spawn 顺序，并只把该 allowlist 传给 loader。loader 仍先 `env_clear()` 再还原列明环境变量、禁用 direnv log、限时/限量读取并拒绝 `NODE_OPTIONS`/`DYLD_*` 等注入 key；任何环境变量都不从解析结果之外的来源进入 Pi worker。
- compatibility checker 将 `.envrc` bounds/filter/env-clear/direnv checks 指到新 owner，并断言 supervisor 显式传入 inherited-env allowlist。原有 env projection tests 仍直接验证有害 key/invalid name 舍弃与过长 value 拒绝。
- `pi_worker_runtime.rs` 从 2,144 行降至 2,053 行，envrc owner 为 113 行。worker runtime tests 8 passed、Rust lib 285 passed；`cargo check --locked --lib` 无 warnings、Rust fmt、`pnpm check`、lint、format、diff check 全通过。无运行时协议或平台设置变化。

## 第三十切片：Pi resource discovery 与 manifest projection

- `config_extensions.rs` 在 Pi policy projection 拆分后仍同时承载通用扩展命令/插件 inventory，以及受限 Pi skill/command 扫描、ignore path 解析、Settings inventory projection 与 worker resource manifest assembly。后几项共同构成 Host 对声明式 worker 资源的受控投影，现归入 `config_pi_resources.rs`。
- 新模块继续使用现有 plugin inventory、merged config 与 extension enablement，不重复状态或路径规则；`config_extensions.rs` 只通过显式 re-export 保留跨模块调用路径。静态 compatibility checker 现在检查新所有者的扫描边界/manifest 和 parent module wiring。
- Pi worker 仍收到相同 manifest shape、root order、disabled snapshots、concrete skill/prompt paths、忽略语义与文件/总量限制；Host 保持最终 workspace/config path authority。`config_extensions.rs` 从 1,737 行降至 1,067 行，Pi resource owner 为 699 行。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` 285 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning；Rust fmt、`pnpm check`（含 Pi compatibility）、`pnpm lint`、`pnpm format:check`、`git diff --check` 全通过。未改 TS runtime、版本、UI 或发布状态。

## 第三十一切片：Marketplace registry state owner

- `config_marketplace_native.rs` 原本直接拥有 registry 文件 bounds/serde、installed plugin projection 与安全路径解析、安装 key/record schema、rollback 和 shared repository removal mutation；这些共同维护安装登记状态，与 command authorization / source lifecycle 是不同变化原因，已归入 `config_marketplace_registry.rs` 的 `MarketplaceRegistry`。
- native command owner 仍负责 workspace authorization、stage/copy/backup 与实际安全文件删除；registry child 负责记录加载/保存、installed projection、duplicate lookup、stable-key validation、install rollback snapshot 与 remove outcome。返回 `MarketplaceRegistryRemoval` 只交出受控路径信息，由 parent 的 `remove_managed_path` / `remove_managed_subpath` 再执行 Host filesystem checks。
- Registry 继续用 `serde_json::Value` 保留未知 top-level 和 record 字段；marketplace install/update provenance、installed ordering、subdir containment 和已有调用面语义不变。父文件从 1,812 行降至 1,567 行，registry owner 500 行。
- 新增 registry owner tests 覆盖 rollback 恢复旧 record 且保留未知字段，以及 shared repository 先移除单个 plugin、最后一个 plugin 才移除 repo record。一次测试最初用非 canonical expected path 比较 canonical API output；修正测试前置条件后通过。
- Marketplace native 专项 10 passed，registry owner tests 2 passed，全 Rust lib 287 passed；`cargo check --lib` 无 warning、Rust fmt、`pnpm check`、`pnpm lint`、`pnpm format:check`、unit tests 403 passed、build 与 `git diff --check` 全通过。Build 仍有既有 >500 kB chunk warnings。未改版本或发布状态。

## 第三十二切片：Remote model catalog owner

- `pi_model_config.rs` 原本同时处理用户/项目 model merge、Pi provider/policy projection 与远程 models endpoint precedence、fetch policy、HTTPS validation、bounded HTTP/JSON parsing、model normalization 和 cache fallback。后者是独立的 catalog lifecycle，现归入 `pi_remote_model_catalog.rs`，由 `resolve_remote_catalog` 提供窄调用面。
- Model-config owner 继续决定本地模型优先级、stable alias projection、api backend/provider schema 和短期 Host secret environment references；远程 catalog owner 只返回经过验证的候选模型及当前 configured catalog key，不拥有最终 Pi catalog 写入。Resolved result 不实现 Debug，避免 key 进入诊断输出。
- Remote fetch default/override precedence、no-redirect、15 秒 timeout、4 MiB body limit、1024 model limit、HTTPS address checks、exact-origin cache fallback 和 cache file limit 均保留；兼容 checker 跟随新文件并断言 model-config wiring。`pi_model_config.rs` 从 1,488 行降至 1,104 行，新 owner 488 行。
- 增加 cache origin 与数量上限的 direct tests。定向 model config tests 16 passed，remote catalog tests 2 passed，全 Rust lib 289 passed；`cargo check --lib` 无 warning，Rust fmt、`pnpm check`、lint、format、403 unit tests、build 和 diff check 均通过。Build 仍有既有 >500 kB warnings。

## 第三十三切片：LSP result projection

- `pi_lsp_runtime.rs` 混合了受限 server config/process lifecycle/JSON-RPC framing 与纯 result rendering。Location URI decoding、结果排序/去重、symbol/hover 文本格式和 UTF-8 安全输出限长只依赖 JSON 值与 label，不需要 child process 或 workspace state，因此归入 `pi_lsp_projection.rs`。
- LSP runtime 仍拥有 server selection、路径/配置校验、spawn/timeout/shutdown 和请求 dispatch；它只调用 projection module 的小接口，Host 只读语义与 worker 工具合同不变。Projection tests 直接在新 owner 中验证位置、嵌套 symbols/hover 和多字节截断边界。
- 完整 Rust lib tests 290 passed（其中 LSP projection 3、LSP runtime 5）；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning，Rust fmt、`pnpm check`（含新 owner/wiring 静态检查）、lint、format 和 diff check 均通过。该片仅改 Rust 和兼容 checker，之前 remote-catalog 切片的 TS unit/build 403/build pass 仍适用。

## 第三十四切片：Pi subagent durable records

- `session-adapter.ts` 原本将子代理 sidecar schema、字段边界、MCP grants 限额、transcript root containment、record file identity、读取错误映射和 atomic write 与 session/task lifecycle 共置。Sidecar 的可信格式/磁盘协议现归入 `subagent-records.ts`，session adapter 继续负责从 live `TaskHandle` 投影记录并将 storage outcomes 映射到既有 `AgentError`。
- 新 owner 独占 load/parse/save 和 task-id hash file layout；加载仍先 canonicalize 真实 transcript 并确认位于 session root，写入仍要等 transcript 是 regular file、经 sibling temp 文件后 rename。resume scope/parent/identity checks 和 task/session orchestration 仍留在 adapter。
- thinking-level 与 subagent-type 集合验证随 persisted schema 归一到同一 owner，避免 adapter 和 parser 各维护一份枚举；worker test 直接调用新 storage module。
- adapter 从 4,420 行降至 4,149 行；新 owner 326 行。Worker tests 145 passed、full unit 403 passed、`pnpm check`/lint/format、build 和 diff check 通过；build 保留既有 >500 kB chunk warnings。未变版本、协议错误码、恢复资格规则或 Host 授权。

## 第三十五切片：LSP trusted config owner

- `pi_lsp_runtime.rs` 原先把 process/JSON-RPC 生命周期与 user/project server config loading、project `trusted=true` gate、字段 bounds、server inventory 和 workspace/transcript path containment 混在一起。这些 config 变动原因现归 `pi_lsp_config.rs`；runtime 仍在授权之后选择 server 并启动一次性 stdio child。
- 新 config owner 负责 config file fallback/size/schema、user-over-project precedence、transport/env/args/extension validation、workspace folder containment、file path canonicalization、server command projection 和 file URI encoding。Parent 只通过显式 imports 消费 validated `LoadedServer` 与 path/config helpers。
- Config trust、invalid transport 和 relative workspace folder tests 移到新 owner；worker Host `lsp` bridge、tool response/error behavior 与 project trust requirement 不变。`pi_lsp_runtime.rs` 从 1,051 行降至 732 行；config owner 338 行，output projection 230 行。
- Config tests 2 passed，runtime tests 3 passed，全 Rust lib 290 passed；`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning，Rust fmt、`pnpm check`、lint、format 和 diff check 全通过。只改 Rust 与 static compatibility checker，本片未重跑 JS unit/build。

## 第三十六切片：Marketplace safe filesystem owner

- `config_marketplace_native.rs` 原先同时维护 Marketplace command orchestration、bounded plugin tree copy、staged directory replacement/backup 与 registry-root constrained removal。文件系统操作共享 symlink、root containment 和 copy size/count rules，现归 `config_marketplace_filesystem.rs`；native owner 仍协调 registry snapshot/save/rollback 与文件替换顺序。
- 新 owner 还负责临时 clone directory 的自动清理，以及 plugin-data 名称校验；调用方通过 `CleanupDirectory::path()` 读取路径，不访问守卫内部字段。路径校验继续复用 catalog validator，不新增第二套相对路径规则。
- 原有 symlink-skipping copy semantics 保持不变；测试覆盖 install-root 外删除拒绝、subpath symlink 只解除链接不删除目标、plugin-data 路径逃逸名拒绝。Marketplace 专项 15 passed，全 Rust lib 293 passed；`cargo check --lib` 无 warning、Rust fmt、`pnpm check`、lint、format 和 diff check 通过。仅 Rust/计划记录变化；未改 Pi 协议、权限、版本或发布状态。

## 第三十七切片：Browser screenshot owner

- `pi_browser_runtime.rs` 原本同时负责 tab/session lifecycle 与平台原生窗口枚举、截图裁剪、缩略图/JPEG 编码和 transfer size limit。后者依赖当前 tab 的已验证 URL、屏幕 bounds 和 Tauri window，却不拥有 session 状态；现集中到 `pi_browser_runtime/screenshot.rs`。
- Parent 只从受控 session entry 读取当前 viewport bounds 与 local preview origin，再传给 screenshot owner。新 owner 统一校验 screenshot origin/visible state、Wayland 限制、native capture、缩放裁剪和 512 KiB JPEG cap；`BrowserScreenshot` 原 crate 路径通过 re-export 保留。
- 两项 crop geometry tests 跟随实现迁移到 owner；原捕获平台、裁剪坐标、JPEG quality、尺寸/数据上限和错误语义不变。Browser runtime 定向 12 passed，全 Rust lib 293 passed；`cargo check --lib` 无 warning、Rust fmt、`pnpm check`、lint、format、diff check 通过。仅 Rust 变更，未重跑 TS unit/build。

## 第三十八切片：Browser page tools owner

- `pi_browser_runtime.rs` 还把固定 DOM snapshot script、eval callback/timeout framing、untrusted page projection、snapshot-ref 生成、bounded wait input 和 click/type automation 放在 tab/session runtime。它们共同构成对远端页面的受限 interaction protocol，现归 `pi_browser_runtime/page_tools.rs`。
- Page owner 负责页面数据/refs bounds、validated-origin snapshot gate、wait filters 与 ref-coupled URL/element checks；parent 仍决定当前 active tab、从 entry 取得 snapshot refs，并在异步 capture 后更新 per-tab state。`BrowserSnapshot` crate path 通过 re-export 保留。
- Wait filter tests 移到新 owner；session close/tab switch 与 page evaluation timeout、field allowlist、snapshot text/element caps 和现有响应文本行为不变。Browser runtime 定向 12 passed，全 Rust lib 293 passed；`cargo check --lib` 无 warning、Rust fmt、`pnpm check`、lint、format、diff check 全通过。仅 Rust 变更，未重跑 TS unit/build。

## 额外验证修复：Monitor output drain ordering

- 全量 Rust 测试暴露短命命令的 race：waiter 可能先把 monitor 标为 `Completed` 并保存最终快照，而 stdout/stderr reader 尚未发送已缓冲行。
- Waiter 现先等待两个 reader thread 排空，再发布 terminal outcome/final snapshot；monitor regression test 同时断言事件内容与 completed snapshot 的 `emitted`/`output`。目标测试连续通过 3 次，完整 Rust lib 289 passed。

## 第十四切片：Pi worker TypeBox schemas

- `tool-schemas.ts` 现在拥有 40 份全部 Host gateway tool input schemas（包括 browser catalog 原先 inline 的 10 份），以及与 schema 边界共用的 foreground/background timeout maxima/default。
- 网关只导入 schema 并组装 catalog/handler；不再运行时构造 TypeBox schema。已有 `PI_TERMINAL_MAX_TIMEOUT_MS` 与 background timeout 常量仍从原 gateway import path re-export，schema contracts 不再重复。
- Pi compatibility checker 改读 `tool-schemas.ts`，继续检查 scheduler 的参数 key 与 worker/Host 清单一致，并对 terminal timeout bound 做静态核验。测试直接检查 schema owner 的 terminal/browser/task timeouts，并确认 gateway re-export 指向原常量值。
- 此 slice 初次移动 30 份顶层 schema 后，测试暴露 `createTools()` 仍直接构造 browser schemas；最终将 10 份 browser schema 也一并迁出。`tool-gateway.ts` 从第十三切片后的 2,416 行降至 1,836 行，参数声明模块为 644 行。最终 worker tests 142 passed、unit tests 400 passed、`pnpm check`/lint/format/diff check/build 全通过；build 保留既有 >500 kB chunk warnings。分支仍是 `beta`，未改版本/发布/合并。

## 第十五切片：Pi worker task result projection

- background task snapshot 文本输出上限与原 `task` compatibility response formatting 是纯 projection，不读 session/permission state，也不决定 task lifecycle；两者已迁入 `task-results.ts`。
- `boundedTaskSnapshots` 通过输入结构 `{ output?: string }` 工作，复制 snapshot 后裁剪 output，不让结果展示模块依赖 gateway 私有 `PiTaskSnapshot` 或 registry/controller；`legacyTaskText` 单独持有旧工具的 background/foreground 文本合同。
- `PiToolGateway` 仍持有 Host task controller 回调和 task call handler，不改变 task ownership、session visibility、timeout/default 或 tool response content。直接测试覆盖 64 KiB 截断、未变更 source object 与兼容文本格式。
- 该 slice 后 gateway 为 1,794 行，`task-results.ts` 47 行。worker tests 143 passed，full unit 401 passed，`pnpm check`/lint/format/diff check/build 全通过；Vite 保留既有 >500 kB chunk warnings。没有 Rust、权限语义或协议变化。

## 第十六切片：Pi worker request lifecycle

- `PiToolGateway` 先前同时组装 tool catalog 和维护 pending tool/interaction maps；后者还有独立超时、run/session 身份校验、事件发射与 worker close 的拒绝语义，属于可独立测试和变化的状态所有者。
- 新 `PiToolRequestLifecycle` 通过组合持有两张 pending map 和 `WorkerEmitter`；gateway 继续公开兼容的 `request`、`requestInteraction`、`resolve`、`resolveInteraction`、`rejectAll` 入口并把调用委托给组件。组件不接触 tool definition 或 Host 授权策略。
- `gatewayError` 迁入共享 `tool-errors.ts`，避免重复构造错误类型。checker 改为读取 lifecycle owner，验证核心 lifecycle methods/event pairs 与 gateway composition wiring。
- 既有 `tool-gateway.test.mjs` 覆盖通过 façade 的完整生命周期。定向 gateway 31 项、完整 worker tests 143 项、unit 401 项、`pnpm check`/lint/format/diff check/build 全通过；build 保持已有 chunk warning。网关当前 1,491 行，request lifecycle owner 349 行。未改 Rust、版本、权限裁决或 wire contract。

## 第十七切片：Pi worker permission identity contract

- permission interaction 需要向 Host 提供可持久化匹配、但不复制写入/patch/调度提示/MCP 参数等完整用户数据的稳定身份；多个工具各自采用小而不同的 key shape，属于一个纯合同责任。
- `tool-permission.ts` 现在拥有 raw-input identity projection 与 Host allow/reject response envelope 的向后兼容解析。tool gateway 只调用这些函数决定交互结果是否接受；它既不持久化授权，也不能替代 Rust Host 的 request authorization。
- 新 direct tests 覆盖多 domain identity、payload omission、导航 URL query/fragment 丢弃、legacy/nested allow/reject 响应。`tool-gateway.test.mjs` integration checks 仍覆盖权限 request lifecycle。兼容 checker 读取合同 owner 并验证 gateway wiring。
- 当前 `tool-gateway.ts` 为 1,381 行、`tool-permission.ts` 128 行；worker 145 passed、unit 403 passed、`pnpm check`/lint/format/diff check/build 全通过。Build 保留既有 chunk warning；未改 Rust/授权语义/协议。

## 第十八切片：Pi worker task tool catalog

- Gateway 原本在 `createTools()` 的两个大型条件分支中构造 spawn/background/legacy task 与 session-scoped wait/output/kill tools。它们共享 subagent spawn contract、`PiTaskController` 和任务快照 projection，形成一个比通用 gateway 更内聚的 tool domain。
- `task-tools.ts` 拥有上述 definitions/types 并通过有限回调取得 session identity、task controller 和 gateway mode checks。旧 `tool-gateway.ts` 导入路径继续 re-export 任务类型，运行时创建仍按是否提供 spawn/controller 保持原有条件和 tool 顺序。
- 通用成功文本与 JPEG 截图投影迁入 `tool-results.ts`；bounded snapshots / legacy task text 仍在 `task-results.ts`，避免混合 Pi `AgentToolResult` 外壳与具体任务内容格式。
- worker/full unit tests 分别 145/403 全通过，定向 gateway 33 passed，check/lint/format/diff check/build 全通过。`tool-gateway.ts` 现为 1,008 行，task-tools 375 行，tool-results 58 行；build 的大 chunk warning 既有未变。

## 第五十五切片：Pi resource compatibility owner

- `promptTemplates` 与 `skillPaths` 都检验同一 worker resource-discovery owner；Skill 合同还同时约束 Host static plugin resources、显式 activation、configured paths、name precedence 与双端 `skills.ignore`，故形成一个资源投影合同簇。相关 checks 收入 `scripts/pi-resource-compatibility.mjs` 的 `checkPiResourceCompatibility({ promptTemplates, skillPaths, sources })`，主兼容门禁仍聚合 diagnostics 并保留原合同覆盖。
- Owner 统一校验 worker export env vars、worker/root 数量与字节 bounds、flat command/外部 Markdown 根策略、Host plugin bounds/activation 与 cross-owner ignore policy；共享 parser 接受简单安全整数乘法、下划线和 TS `export const` / Rust `pub(crate) const`，不识别的常量表达式 fail closed。
- 4 个 owner fixture tests 覆盖对齐合同、worker env/bound drift、Host plugin 与 ignore drift，以及不支持表达式。第一次 owner 测试和实际 root gate 揭示 patch 重复 declaration 与 parser 漏读 `export const`；均已按原合同修正并记录。
- `check-pi-compatibility.mjs` 从 2,263 行降至 2,045 行；Pi resource owner 238 行，测试 137 行。`pnpm check:pi-compatibility` 7 项（含 4 项资源合同与 3 项 Tauri permission）通过，`pnpm check`、`pnpm check:architecture` 3 项、lint、format、full unit 415 项及 `git diff --check` 全通过。该片只改变 checker/package scripts/docs，不改产品 runtime 或 Rust；未重跑 production build，版本仍 `0.4.0-beta.2`。
- 主 gate 余下 17 个 Host bridge groups 尚未完成耦合审计；不得把本片当成整个 compatibility checker 或全仓维护性目标已完成。

## 第五十六切片：共享 source numeric constant parser

- Pi compatibility gate 的 model-policy 与 goal-safety 使用相似局部 helper；codebase-index 与 Hook 还各自用正则加 `split("*")` 解析；Pi resource owner 亦有自己的 TS/Rust 常量 parser。这些消费者应对同一类有限语法作一致判断，而各契约组的诊断仍需局部保留。
- `scripts/source-numeric-constant.mjs` 的 `readNumericSourceConstant(source, name)` 现在接受 exact uppercase identifier、TS `export const`、Rust `pub`/`pub(crate)`/`pub(super)` typed declarations、十进制下划线分组和简单乘积；对未知表达式、缺失/错误标识符或 unsafe product 返回 `undefined`。Model policy、goal safety、codebase-index、Hooks 与 resource contract owners 都复用它；原 per-domain diagnostics 与 manifest comparison 保持独立。
- 3 个 parser fixture tests 覆盖 TS/Rust declarations、精确名字与非法/unsafe 表达式。`check-pi-compatibility.mjs` 从本片起点 2,045 行降至 2,009 行，source parser 34 行，tests 56 行。
- Pi compatibility gate 10 tests 通过，真实 checker 通过；`pnpm check`、`pnpm check:architecture` 3 tests、lint、format、full unit 415 tests 与 `git diff --check` 均通过。仅改 checker/scripts/package gate/planning docs，不改产品 runtime 或 Rust，故未重跑 production build。
- 余下 17 个 Host bridge groups 的契约耦合审计仍未完成；本片只统一有限数字源语法解析，不代表 compatibility checker 或全项目技术债治理完成。

## 第五十七切片：Pi resource discovery 测试所有权

- `session-adapter.test.mjs` 中 6 个用例只直接调用 `piPromptPathsFor` / `piSkillPathsFor`，断言 Host allowlisted paths、Skill 根扫描/刷新、静态插件 roots、ignore prefixes 与声明插件目录；它们属于 `resource-discovery.ts` 的模块接口，不需要 adapter lifecycle。
- 将这 6 个测试移动到 `resource-discovery.test.mjs`，并在 worker 与 root `test:unit` manifests 显式登记。真正验证 live session 应用 Host refresh manifest 的 integration test 保留在 `session-adapter.test.mjs`，无覆盖删除或复制。
- 定向 owner + adapter tests 38 passed；worker suite 159 passed；full unit 415 passed；`pnpm check`、`pnpm check:architecture`（3 tests）、lint、`pnpm format:check`、`git diff --check` 全通过。变更只涉及测试归属与 test manifests，不改 runtime/security behavior；未重跑 build。
- 当前仍处于 beta / `0.4.0-beta.2`，三处版本声明一致，未 commit/push/publish/merge；compatibility gate 其余 Host bridge groups 和全仓结构审计仍未完成。

## 第五十八切片：agentSchedules compatibility owner

- `check-pi-compatibility.mjs` 中 `agentSchedules` block 是单一跨端契约：worker scheduler tool names 与 Host request-policy names、Host scheduler route、从 live `agent_session_bindings` 继承身份、worker schema fields 与 Host dispatcher fields 双向一致，以及最大间隔约束。
- 将 `schemaTopLevelKeys` 和该职责簇迁入 `scripts/pi-agent-schedule-compatibility.mjs`。Owner 接收兼容清单 contract 与 worker `tool-names.ts` / `tool-schemas.ts`、Host `request_policy.rs` / `scheduler_tools.rs` / schedule store / policy 的 source snapshots；组合 gate 保留文件读取、缺失文件诊断和聚合职责。
- 原 gate 只检查 schedule store 源码含 `MAX_SCHEDULE_INTERVAL_MS` 标记；现在还从真正 owner `database_agent_schedules/policy.rs` 解析常量，并与 `agentSchedules.maxIntervalMs` 比对。真实 `30 * 24 * 60 * 60 * 1_000` 解析为 `2_592_000_000`；缺失/不支持表达式或值漂移均 fail closed。没有改变 scheduler runtime、session identity 来源或 Host authorization。
- 6 个 fixture tests 覆盖对齐 contract、worker/Host tool-name drift、schema 与 Host 消费字段双向 drift、Host route/session-binding/interval marker 缺失、实际 interval 值 drift，以及只读 schema parser 的 top-level/nested/string handling。
- `pnpm check:pi-compatibility` 16 项通过并运行真实 checker；`pnpm check`、`pnpm check:architecture`（3 tests）、lint、`pnpm format:check`、full unit 415 tests、`git diff --check` 全通过。只改 compatibility tooling/manifests/docs，未重跑 production build。
- 17 个 Host bridge groups 中该组已归 owner，余下 16 组尚需逐组审计；当前仍在 beta / `0.4.0-beta.2`，未 commit/push/publish/merge。

## 第五十九切片：modelPolicySnapshot compatibility owner

- `check-pi-compatibility.mjs` 原先在聚合入口内核验 `modelPolicySnapshot`，但其合同横跨 worker loader、Host 生成器/validator、Host worker-launch 环境投影与 manifest，适合作为可 fixture 测试的独立契约 owner。
- `scripts/pi-model-policy-compatibility.mjs` 接收 manifest contract 和三个 source snapshots，校验 worker env/数值 bounds、Host 文件名和真实 byte/idle-timeout/threshold bounds、Host writer 到 worker parser 的 version/root/field projection，以及 prepared policy path 的 Host-to-worker launch。组合 gate 仍负责文件读取、错误归集与总体执行。
- 原 checker 只核验 worker idle-timeout 下限；Host 的 `MAX_PI_IDLE_TIMEOUT_SECS`（秒）现在也通过共享 numeric owner 解析并乘 1,000 与 manifest `maxIdleTimeoutMs` 精确比较。Host 文件 cap `PI_MODELS_LIMIT_BYTES` 同样与清单比较，`maxBytes`/schema fields/serialized keys 不再只靠孤立标记。
- Rust Host 的百分比校验此前直接写 `100`；将其提为 `MAX_PI_AUTO_COMPACT_THRESHOLD_PERCENT` 并由 validator 实际使用，行为与数值不变，随后 Host 与 worker 的真实常量均由 manifest cross-check。
- 新增 5 个 fixture tests 覆盖对齐、worker env/数字 drift、Host bounds drift、生成文件/version/root/path drift 与 camelCase serialized fields drift。Pi compatibility tests 21 passed；`pnpm check` 与真实 checker 通过；全 Rust lib 305 passed、`cargo check` 无 warning、Rust fmt、architecture 3 tests、lint、format、full unit 415 和 diff check 全通过。
- 同次职责审计发现既有 `max_retries` 交叉边界风险：worker/manifest 限制为 10,000，但 Host 当时仅使用非负值解析，可能把超限 policy 写入后再由 worker 拒绝。第 59 切片先记录；该 Host/worker 行为差异已由第 61 切片在生成入口收敛并增加边界测试。
- `check-pi-compatibility.mjs` 从 1,907 行降至 1,877 行；17 个 Host bridge groups 中已有 schedule/model-policy 两组转为 owner，余下 15 组待审计。当前 beta / `0.4.0-beta.2`，未 commit/push/publish/merge；本切片也不代表全仓治理完成。

## 第六十切片：subagentPolicy MCP 边界与合同 owner

- `subagentPolicy` 原先把 Host/worker MCP grant bounds 与工具 allowlist capability mapping 检查写在主 compatibility checker 内；现抽到 `scripts/pi-subagent-policy-compatibility.mjs`，组合 checker 继续负责读取 source snapshots 和聚合诊断。Owner fixture checks 覆盖 Host/worker 数量及名称 bounds、实际 validator 使用、字符集/模式、wire/call-site wiring 与四种能力档。
- 重新核验后修正了早先的描述：Host `parse_agent_list` 和 JSON-array normalizer 会在能力映射前静默丢弃超过 128 字节的 tool ID；不是把 129–167 字节直接送给 worker。段上限组合的理论最大 ASCII 名是 167 字节（`mcp__` + 64 + `__` + 96）。静默丢弃会让显式 `tools` allowlist 变窄且缺少 unsupported 诊断；worker 对原始 129 字节名称确实 fail-closed。
- Host 现在保留过长条目交由 capability ceiling resolver 拒绝，并将整个 agent 置为既有 `unsupportedAgents` 路径；未拓宽任何 MCP grant。新增并接入 manifest `maxNameBytes=128`；Host/worker 分段限制改为具名常量，worker regex 从常量生成，兼容 owner 也要求 full-name 常量确实参与校验。
- Host Markdown parser seam 已用 128/129 字节边界回归覆盖：首次执行在 129 字节处复现静默丢弃（红），修正后 128 保留 exact grant、129 标为 unsupported（绿）。worker normalizer seam 另有 128/129 字节 characterization test；Host 保持最终 capability ceiling 与 request authorization authority 不变。
- 用户确认的三处测试 seam 已按方案覆盖；复验 `pnpm check:pi-compatibility` 27 passed、worker 160 passed、Rust lib 305 passed、`pnpm check`、architecture 3 tests、lint、format、full unit 416、production build 与 `git diff --check` 全通过。build 仍有既有 >500 kB chunk warnings；14 个 Host bridge groups 仍待审计。

## 跨端合同审计候选：terminal output preview cap

- 当前清单 `terminalPolicy.maxOutputBytes` 是 8,388,608；真正 Host owner `src-tauri/src/pi_tool_gateway/tool_output_archive.rs` 的 `TERMINAL_MAX_OUTPUT_BYTES` 当前也是 8 MiB，且 `TerminalOutputCapture::with_policy` 用它 clamp Host preview policy。
- 现有 `check-pi-compatibility.mjs` 只断言 manifest 数值等于脚本内的 `8 * 1024 * 1024`，没有解析实际 Host owner 常量。因此 Host cap 漂移时，即使工具门禁仍通过，也会留下 Host/manifest 的隐性不一致；目前是门禁缺口，不是已观察到的运行时数值漂移。
- 后续可把实际 Host source snapshot 纳入 terminal-policy contract owner fixture，比较 manifest、Host 数值常量及 worker timeout/schema。它现在是下一项终端合同门禁候选；新增测试前仍须确认测试 seam。

## 跨端合同审计候选：backgroundTerminalTasks 完整性

- 清单声明了 Host background-terminal registry 的 task ID prefix、64 个活跃 task、120,000 ms wait cap、64 KiB 输出预览、Host-owned cancellation 和 worker-stop cleanup；当前 `check-pi-compatibility.mjs` 与 `scripts/` 下的兼容 owner 都没有读取 `backgroundTerminalTasks` 字段，故这些跨端事实没有静态 drift 门禁。
- 当前实际值/owner 可由 `terminal_tasks.rs` 中的 `PI_BACKGROUND_TERMINAL_TASK_PREFIX`、`BACKGROUND_TERMINAL_MAX_TASKS`、`BACKGROUND_TASK_CONTROL_MAX_OUTPUT_BYTES`，父网关 `task_timeout_ms`，worker `tool-names.ts` 的 task prefix 与 `tool-schemas.ts` 的 `BACKGROUND_TASK_MAX_TIMEOUT_MS` 核对；worker-stop cleanup 的 Host 调用位于 `pi_worker_runtime.rs`。
- 建议把这组 source snapshots 与相邻 `terminalPolicy` config/preview constraints 纳入 fixture-tested terminal compatibility owner，而不是把硬编码 marker 继续加进组合脚本。已验证当前已见数值对齐（64、120000、65536、prefix），但尚未做完整 source-owner/fixture gate；这是验证缺口，不代表已观察到运行时漂移。

## 第六十一切片：Host 模型 retry 上限对齐

- Host `pi_model_config.rs::model_policy` 现在经 `bounded_retry_value` 校验 model/global `max_retries`，共享具名上限 `MAX_PI_POLICY_RETRIES=10_000`；超过上限在 `prepare_pi_models_with_remote` 完成 projection 时返回配置错误，因此 models catalog 与 policy snapshot 都不会写入。10,000 仍可写入，worker/manifest 上限与 Host 一致。
- Host 测试走真实快照生成入口，覆盖 global 和 per-model 的 10,000 接受、10,001 拒绝及拒绝前两个输出文件都不存在。worker `loadPiModelPolicies` 测试独立固定 10,000 接受、10,001 fail-closed。
- `pi-model-policy-compatibility.mjs` 与 owner fixtures 现将真实 Host 数值常量和 validator 使用、默认/模型两条调用路径与 manifest `maxRetries` 交叉核验。真实 source gate 曾暴露严格 marker 对 rustfmt 换行与尾随逗号的假阴性；改用空白/可选逗号稳健匹配后 fixture 与真实检查都通过。
- 验证：Pi compatibility fixtures 29 passed；worker 161、完整 unit 417、Rust library 306 passed；`cargo check` 无 warning、Rust fmt、`pnpm check`、architecture 3、lint、format 与 production build 通过。Vite 仍报告既有 >500 kB chunks；最终 planning-doc format 与 `git diff --check` 在文档更新后复验。

## 第六十二切片：终端与后台终端任务合同 owner

- 本轮只读核对确认当前数值一致，但现有 Pi compatibility gate 没有从全部真实 owner 读取它们：manifest `terminalPolicy.maxTimeoutMs=36,000,000` 与 Host `PI_TERMINAL_ABSOLUTE_MAX_TIMEOUT_MS`、worker `PI_TERMINAL_MAX_TIMEOUT_MS` 对齐；`maxOutputBytes=8,388,608` 与 Host `PI_TERMINAL_DEFAULT_OUTPUT_BYTES` 和 `TERMINAL_MAX_OUTPUT_BYTES` 对齐，`TerminalOutputCapture::with_policy` 会把可配置值 clamp 到 Host cap。
- `backgroundTerminalTasks` 的 prefix 在 Host `terminal_tasks.rs` 和 worker `tool-names.ts` 一致；Host active registry cap 为 64、control preview 为 64 KiB、`task_timeout_ms` 与 worker schemas 的最大等待值都为 120,000 ms。Worker failure、stdout-close、explicit-stop、workspace-stop 四处均调用 Host cancellation。
- 原 checker 只从 worker 校验 terminal timeout，并将 8 MiB 直接写在脚本表达式中；它没有读取实际 Host caps，也没有 `backgroundTerminalTasks` 检查。这是 drift-gate coverage gap，不是已观察到的运行时数值漂移。
- 新 `scripts/pi-terminal-compatibility.mjs` 拥有前台 terminalPolicy 与后台 task registry 合同；组合 checker 负责源文件读取与诊断聚合。现在会把 manifest bounds 对齐到 Host `config_pi_policy.rs` timeout/output caps、真实 `tool_output_archive.rs` cap/clamp、worker `tool-schemas.ts` timeout；也验证配置 keys/env vars 与 Host route。
- 后台合同检查 Host/worker prefix、Host active task cap 及使用、Host 120 秒 Duration 与 gateway wait clamp、worker 三个 task-control schema bound、64 KiB Host preview、Host process kill/cancel signal，以及 worker generation failure/exit/explicit-stop/workspace-stop 四个 Host cancellation call sites。
- 7 个 fixture tests 通过 aligned source snapshots 与数值漂移/接线断开案例。最后 `pnpm check:pi-compatibility` 的 owner fixture 总计 36 passed，真实仓库 gate 通过；`pnpm check`、architecture 3、lint、format、unit 417 与 `git diff --check` 通过。此切片只改脚本/测试/package gate/docs，未改运行时代码，未重跑 production build。
- 后续优先审计 `pi_worker_runtime.rs` 的 Host turn dispatch acknowledgement ledger 与 generation teardown 状态边界；先完成 owner 调用图审查，并在写测试前确认 seam。

## 第六十三切片：PiWorkerRuntime dispatch acknowledgement ledger

- `PiWorkerInner` 原先直接持有 pending dispatch 与 session revision 两张独立 map，`PiWorkerRuntime` 同时完成事件解析、request/prompt 关联、32 项容量限制与 generation 清理；调度器再把 `TurnDispatchOutcome` 映射为 schedule journal 结果。
- 新增 `pi_worker_runtime/dispatch_ledger.rs` 作为这些短生命周期状态的唯一 owner。`PiWorkerRuntime` 保留 process 生命周期、event acceptance/persistence 顺序与 `submit_and_await`；`TurnDispatchOutcome` 仍从原父模块 re-export 给 `schedule_dispatch.rs`。
- Owner tests 通过真实 `begin`、`observe_event`、revision 查询与 generation clear 接口，验证 `run.accepted` 按 promptId 接受、`runtime.error` 按 requestId 拒绝、session opened/configured/imported revisions 更新及清零、32 项容量上限，以及 generation 清理把 pending completion 变成 `Unacknowledged`。
- 重构不改变 15 秒 acknowledgement deadline、write failure/timeout 清理、worker event 先 acceptance+persist 再观察 ledger 的时序，或 schedule journal outcome 语义。测试 seam 获用户确认后按 red/green 完成；owner 4 passed。
- 验证：全 Rust library 310 passed，`cargo check --lib` 无 warning，`cargo fmt --check`、Pi compatibility 36、architecture 3、`pnpm check`、`pnpm format:check` 与 `git diff --check` 通过。仅 Rust runtime source 与计划记录变更，未重跑 production build。
- 这是一项状态归属与验证边界治理，不是发现运行时协议漂移；后续继续审计剩余 Host bridges 与复杂 runtime 状态 owner。

## 第六十四切片：questionTimeoutPolicy 跨端合同 owner

- 原 checker 内联的约 40 行 question-timeout checks 只对比 manifest 与 worker ToolGateway 常量；没有比较 Host 真实上限和秒到毫秒 clamp，也没有固定 worker 环境策略解析与 resource manifest parser 的上限。
- 当前真实数值均为 2,147,483,647，Host `positive_question_seconds_to_millis` 和 worker gateway 都应用该界限；此次解决的是兼容门禁的 drift-coverage 缺口，而非已观察到的运行时值不一致。
- 新 `pi-question-timeout-compatibility.mjs` 接收 Host `config_pi_policy.rs`、`config_extensions.rs`、`config_pi_resources.rs`、worker launch、ToolGateway 与 session adapter 的只读 snapshots；组合 checker 保留仓库 I/O 和 diagnostics aggregation。
- Owner 比较 Host/worker gateway caps 与 manifest，检查 Host clamp、worker 环境与 manifest bounds，并验证 Host policy→manifest→worker env→adapter→ToolGateway 的字段/变量接线。
- 五项 fixture tests 覆盖 aligned contract、Host cap/clamp、worker gateway cap/validation、worker parser bounds 和跨端 wiring drift。真实源接线首轮因 Rustfmt 在 `command.env` 参数间换行而未被字符串标记识别；改用容忍空白的窄正则后 source gate 通过。
- 验证：Pi compatibility fixtures 41 passed，真实 Pi compatibility 检查通过；`pnpm check`、full unit 417、architecture 3、lint、format 和 `git diff --check` 全通过。仅静态 checker、fixture tests、package gate 与 planning 文档变化；未改 runtime 或版本，未重跑 production build。

## 第六十五切片：子代理会话边界 owner

- 将 resume ID normalization、cwd realpath/symlink containment、resume root/parent/status/identity checks、interactive child scope 与 Host worktree response validation 收敛到 `subagent-session-boundaries.ts`。这些 helper 是进入 session reopen/launch 前的信任边界，而不是 Pi session lifecycle 或 durable record persistence。
- `session-adapter.ts` 通过原路径 import/re-export 并在既有启动/恢复位置调用该 owner；新增 identity selector coverage 及回导 identity characterization，确保外部调用路径、错误码和运行策略不变。
- owner direct tests 7 passed，adapter integration tests 与 owner targeted suite 共 35 passed；worker 164、完整 unit 420、Pi compatibility fixtures 41 passed。`pnpm check`、architecture 3、lint、format、production build、`git diff --check` 通过。Build 只有既有 >500 kB chunk warnings。
- 用户确认的切片只移动既有校验与测试，没有扩大路径授权或子代理权限；全项目结构债务治理仍未完成。

## 后续只读审计：子代理会话边界候选（已由第六十五切片实施）

- 本记录描述的候选已获用户确认并完成，详见第六十五切片；以下内容保留当时的调用图与边界判断作为审计依据。

- `session-adapter.ts` 仍包含一组不属于 Pi session I/O 的子代理信任边界函数：resume ID 规范化、cwd realpath/symlink containment、resume root/parent/status/selector identity 校验、交互式 child scope，以及 Host worktree response parsing。调用图目前显示这些 helper 只由 session-adapter 调用；测试也集中在其 adapter test 中。
- 该规则组与 `subagent-records.ts` 的 sidecar schema/path/persistence 职责邻接但不同：record owner 验证持久化数据形状；boundary candidate 决定用户/Host identity 和路径能否进入 session reopen/launch。
- 仅作候选，不把行数或“看起来像 policy”当成充分理由。拟采用独立 `subagent-session-boundaries.ts`，保留调用处/必要兼容导出；先征求用户确认测试 seam，再决定是否实施。拟保留/迁入的验证包括 symlink 越权拒绝、同 root/parent resume、status/identity 约束与 worktree legacy field/类型/控制字符/长度边界。

## 第六十六切片：webTools 跨端兼容门禁 owner

- 原 checker 内联检查把 manifest 中的 web tool names、worker Search/Fetch parameter schema、Host ToolGateway route，以及 `pi_web_runtime.rs` 的请求解析/HTTPS URL/有界响应/格式化 marker 混在聚合脚本中，缺少可独立 fixture 测试的 owner。此次只修复测试所有权与 drift-coverage 可测性，不是运行时漂移修复。
- 新 `scripts/pi-web-tools-compatibility.mjs` 接收 `policy` 与 `workerToolGateway`、`hostToolGateway`、`hostWebRuntime` 快照；`check-pi-compatibility.mjs` 继续持有 source reads 和总 diagnostics。Host runtime 仅在清单存在 `webTools` 时读取，原有错误和未配置时 no-op 行为保留。
- 五项 fixtures 验证 aligned source、manifest tool name 漂移、worker schema/Host route 断线、HTTPS URL validator 缺失、bounded response reader 与 search output formatter 缺失。首次 import 因 owner 不存在而 `ERR_MODULE_NOT_FOUND`；owner 与 fixture 完成后 5 项通过。
- `pnpm check:pi-compatibility` 与 `pnpm check` 的兼容 fixtures 共 46 项通过，真实 Pi source checker 通过；全量 unit 420、architecture 3、lint、format、`git diff --check` 通过。首轮组合门禁只因新 fixture 未格式化失败，Prettier 后复验通过。未改 Host/worker runtime，也未重跑产品构建。
- 该 owner 继承原检查范围，验证安全/有界处理的 source markers，并未把 `maxQueryBytes`、`maxUrlBytes`、`maxResponseBytes`、`maxFetchedTextBytes` 数值与真实 Host constants 交叉比较；如需数值漂移门禁，应另行确认并做真实 owner 对齐，而不是将 marker 测试当作完整数值验证。

## 第六十七切片：memoryTools 跨端兼容门禁 owner

- 原有 `memoryTools` inline gate 横跨 worker tool names/schemas、Host ToolGateway routes、memory runtime/store、SQLite lexical sidecar、重建命令和 worker supervisor lifecycle；这些检查共享同一份 manifest contract，但位于主 checker 内，不能通过独立 fixtures 直接验证。
- 新 `scripts/pi-memory-tools-compatibility.mjs` 接收 policy 与八组 Host/worker source snapshots；组合 checker 继续持有文件读取和统一诊断。它保持原有 memory bridge/store/index/lifecycle markers，并使用 manifest `persistentIndex.file` 和 `rebuildCommand` 检查 sidecar 和显式重建命令。
- 七项 fixture tests 覆盖 aligned sources、tool-name drift、worker schema/Host route drift、Host memory/store capabilities、runtime/store/index owner wiring、SQLite index markers/file/rebuild/search route 与 worker lifecycle wiring。首次 aligned fixture 遗漏 `persistentIndex.file` 后得到预期诊断；补齐独立 manifest 字段后全绿。组合 gate 首轮仅因新增文件未格式化停止，Prettier 后通过。
- 验证：`pnpm check:pi-compatibility` / `pnpm check` 的兼容 fixtures 共 53 passed，真实 Pi checker 通过；完整 unit 420、architecture 3、lint、format、planning-doc Prettier、`git diff --check` 全通过。没有修改运行时实现，也未重跑产品构建。
- 本 slice 未把 manifest `maxQueryBytes`、`maxFileBytes`、`maxTotalBytes`、`maxFiles`、`maxOutputBytes` 或 `maxNoteBytes` 与真实 Host constants 做数值比较；此次维持获确认的 wiring/owner scope，不将现有 markers 误称为数值验证。该数值 drift gate 可作为后续独立候选。

## 第六十八切片：memoryTools 与 webTools 数值边界 drift checks

- 用户确认本片只增加静态 contract drift checks，不改运行时常量、manifest 值或 worker schema。两个已独立化的 owners 现在从 Host source snapshot 解析真实数字，并逐字段与 manifest 做相等性比较。
- Memory 六项当前对齐：`maxQueryBytes=2048`、`maxFileBytes=2097152`、`maxTotalBytes=67108864`、`maxFiles=512`、`maxOutputBytes=524288`、`maxNoteBytes=16384`，分别由 Host `MAX_QUERY_BYTES`、`MAX_FILE_BYTES`、`MAX_TOTAL_BYTES`、`MAX_FILES`、`MAX_OUTPUT_BYTES`、`MAX_MEMORY_NOTE_BYTES` 承担。
- Web 四项当前对齐：`maxQueryBytes=2000`、`maxUrlBytes=4096`、`maxResponseBytes=10485760`、`maxFetchedTextBytes=524288`，由 `MAX_QUERY_BYTES`、`MAX_URL_BYTES`、`MAX_RESPONSE_BYTES`、`MAX_SEARCH_OUTPUT_BYTES` 承担。
- 两个 drift fixtures 分别把全部 Host declarations 改为不同值，并验证 owner 报出精确字段诊断；真实仓库通过共享有限数字语法 parser 解析。新增的是漂移覆盖，不是修复实际值不一致。
- 单位边界：TypeBox worker schema 中的 `maxLength` 与 Rust 字符串 `.len()` 的 UTF-8 byte counts 不可直接视为同单位；本片不据此声称 worker 字符数 schema 与 Host byte caps 完全等价。
- 验证：两个 owners 定向 14 passed，Pi compatibility fixtures 55 passed 且真实源 checker 通过；`pnpm check`、full unit 420、architecture 3、lint、format 与 `git diff --check` 通过。静态 checker/test/doc-only 改动，无需 product build。

## 后续只读审计：LSP compatibility contract owner 候选（已由第六十九切片实施）

- 第六十八片后检查总 Pi compatibility checker 的剩余 inline groups。`lspBridge` 仍把 manifest tool mapping、Host runtime/config/result projection marker 与 worker request-routing wiring 检查放在同一条件块内；它们共属一个 LSP cross-end contract，且 parent 已经集中读取对应 source snapshots。
- 适合的纯接口候选是 `checkPiLspCompatibility(policy, sourceSnapshots)`；聚合 checker 仍负责文件读取和读取错误，不迁移 LSP runtime、Host 授权或 session 路由行为。迁移需保持原有诊断文本和 no-policy 行为。
- TDD skill 要求确认测试 seam 后才能新增 fixtures；用户确认纯函数 owner seam 后，按单测试→实现循环完成迁移，详见第六十九切片。运行时和授权未变。

## 第六十九切片：LSP compatibility contract owner

- 新增 `scripts/pi-lsp-compatibility.mjs`，由纯 `checkPiLspCompatibility(policy, sources)` 比较清单工具名、worker LSP schema marker、Host runtime/config/projection marker 与 Host module/worker routing wiring。`check-pi-compatibility.mjs` 继续负责文件读取、source snapshots 与聚合诊断，并在无 `lspBridge` policy 时保持无诊断。
- 九个 fixtures 覆盖 aligned contract、工具名遗漏、worker schema/Host route 缺失、Host framing/document bounds、config trust/path validation、bounded result projection、Host config/projection owner wiring、worker route wiring，以及 no-policy no-op。公开 seam 最终与确认一致，为 `checkPiLspCompatibility(policy, sourceSnapshots)`；迁移保留原有每条诊断文本和触发范围，没有修改 LSP runtime、Host 授权或 session routing。
- 按获确认 seam 逐项 red→green；缺少 owner、各类 source marker/wiring drift 均先由 fixture 证明失败，再实现原有检查。期间一次 patch context 未匹配而无写入；一次实现遗漏 config snapshot 解构触发 ReferenceError，均已修正。
- 验证：9 个 LSP owner fixtures、Pi compatibility 总计 64 个 fixtures 与真实仓库 checker 通过；`pnpm check`、完整 unit 420、architecture 3、lint、format、`git diff --check` 通过。只改静态 checker、fixtures、package gate 与规划文档，不需重跑产品 build。
- 当前运行时值未改变；该切片改善兼容规则的单元测试所有权和 drift 可测性，不代表发现真实 LSP 行为漂移，也不代表整个结构债务目标完成。

## 后续只读审计：codebaseIndex compatibility owner（已由第七十切片实施）

- `check-pi-compatibility.mjs` 中的 `codebaseIndex` 条件块同时检查 manifest tool、worker 参数 schema 与 Host route、Tree-sitter runtime/parser markers、parser owner 接线、Host worker routing，以及已有的三个 Host 数值上限（glob 数量、glob 长度、workspace index 数量）。
- 只读核对当前三项 Host 数值分别为 `64/512/16`，与清单中的 `maxPatterns`、`maxPatternBytes`、`maxWorkspaceIndexes` 一致；未执行 runtime 或 manifest 修改。
- 其余清单中的 `maxFiles=4096`、`maxFileBytes=2097152`、`maxTotalBytes=67108864`、`maxResults=100` 与 Host source constants 当前也一致，但现有 checker 只检查对应 marker、未逐值比较；这属于额外 drift-test coverage 候选，不纳入本次待确认 seam。
- 聚合 checker 已集中读取 `codebaseRuntime`、`codebaseParser`、worker ToolGateway/runtime/routing snapshots；这些断言可收敛到纯 `checkPiCodebaseIndexCompatibility(policy, sourceSnapshots)` owner，而不迁移 runtime 或扩大数值覆盖范围。
- 该候选已获确认并完成，详见第七十切片；当前未宣称发现运行时漂移。

## 第七十切片：codebaseIndex compatibility owner

- 用户已确认纯测试 seam `checkPiCodebaseIndexCompatibility(policy, sourceSnapshots)`。范围仅迁移现有 worker tool/schema、Host route、Tree-sitter runtime/parser markers、parser/module wiring、worker routing 与三项既有 Host 数值对比；不新增其他数值范围，不改运行时或授权。
- 新 owner 文件和 fixture 文件已创建。首个 aligned fixture 在 owner 尚不存在时按预期因 `ERR_MODULE_NOT_FOUND` 失败；提取原有 checks 后 aligned fixture 转绿。
- 新 owner `scripts/pi-codebase-index-compatibility.mjs` 接收 manifest policy 与只读 snapshots；父 checker 继续负责仓库文件读取与诊断聚合，并调用该 owner。移出的逻辑保持原有 marker 与 diagnostic 范围，Host 数值只比对已有的 `maxPatterns`、`maxPatternBytes`、`maxWorkspaceIndexes`。
- 七个 owner fixtures 覆盖 aligned sources、worker schema/Host route、Host runtime/parser markers、parser/worker routing wiring、三项既有数值漂移、manifest tool 映射缺失与 no-policy no-op。
- `pnpm check:pi-compatibility` 中新 owner 后总计 71 fixtures 全通过，真实 source checker 通过；`pnpm check`、full unit 420、architecture 3、lint、`pnpm format:check`、规划文档 Prettier 与 `git diff --check` 通过。暂无运行时修改，也未重跑产品 build/Rust runtime tests。

## 第九十三切片：Hooks compatibility contract owner

- `check-pi-compatibility.mjs` 原有 Hooks block 将 Host Hook runtime markers、Host config preflight wiring、worker tool-routing/lifecycle wiring 与七项 manifest 数值边界混在聚合入口，无法独立 fixture 验证其跨端合同。用户确认后，纯 `checkPiHooksCompatibility(policy, sourceSnapshots)` 接管这些既有 assertions；总检查器仍负责读取 source 与聚合 diagnostics。
- 七项当前 Host bounds 与 manifest 对齐：`maxFiles=64`、`maxHooks=256`、`maxFileBytes=1048576`、`maxCommandBytes=4096`、`maxInputBytes=262144`、`maxOutputBytes=65536`、`maxTimeoutMs=30000`；本次没有发现 runtime limit drift，也未改变 Hook command 执行、Host 权限或安全裁决。
- 7 项 owner fixtures 覆盖 aligned contract、runtime/config/worker wiring 缺失、七项 limits drift、unsupported numeric expression fail-closed 与 no-policy no-op。诊断文字和既有覆盖范围保持一致。
- 全量兼容 fixture 共 86 项通过，真实 source checker 也通过；`pnpm check`、430 unit、339 Rust lib、architecture 3、lint、format、build、Cargo check/fmt 和 `git diff --check` 均通过。Vite 仍发出既有大型 chunk 警告。

## 后续 Hotspot 复核：Pi ToolGateway dispatcher

- 当前 `src-tauri/src/pi_tool_gateway.rs` 共 1,533 行，但 Rust unit-test module 从第 377 行开始；大部分行数来自已有行为测试，不能用文件行数作为拆分依据。
- 当前生产 dispatcher 集中在 `resolve_request_with_host_policy`，同时读取 event identity、应用 Host-provided permission/gitignore/terminal policy、执行授权 gate、获取 workspace mutation lock 并路由各 tool owner。该边界横跨 Host 权限与执行顺序；尚未确认一个足够窄且行为可保真的新 seam，先不建议机械抽离。

## 全仓 Hotspot 复核：Host sandbox 与 worker session lifecycle

- 只读盘点当前最大的源文件时，`session-adapter.ts` 为 3,460 行；它同时持有 root/child session 与 task registries、per-session lifecycle queue、Pi submit/steer/cancel transitions、resource/model refresh、子任务控制和 config revision apply。多个状态机共享同一 session identity 与 run 生命周期，现阶段仅凭方法数量不能断言应拆分；需先找出状态是否可以由更深但更小接口统一拥有。
- `workspace_sandbox.rs` 为 1,107 行，测试模块从第 889 行开始。实现中，profile 文件来源/路径 normalization 位于 `resolve_profile`，Linux Landlock syscall/enforcement 位于约 190–519 行，Seatbelt policy rendering 与跨平台 decision/command creation 同文件；这些机制组合后仍统一 fail-closed。
- 当前共享接口有实质调用者：`terminal_tasks.rs` 的 foreground/background terminal 命令和 `pi_monitor_runtime.rs` 的 monitor/probe 都调用同一个 `sandboxed_shell_command`；Tauri preflight 调用 `sandbox_decision`。已有测试固定 terminal/monitor 同决策、Linux 实际子进程限制、network/glob unsupported 和 custom deny policy。此共用路径是安全不变量，拆模块不可复制决策。
- 相比行数拆分，更可信的后续候选是保留 `sandbox_decision`/`sandboxed_shell_command` 作为共同接口，将 Seatbelt 与 Landlock enforcement implementation 收入私有平台 owner；两个真实平台适配使此 seam 有实质差异。仍须核实跨平台编译条件和现有测试覆盖，并在写测试前确认具体 seam；不在本轮改 sandbox 代码。
- 当前验证面：`.github/workflows/check.yml` 只在 Ubuntu 跑全 Rust tests；release matrix 在 macOS arm64/x64 与 Windows 构建但不跑 tests。当前 macOS checkout 的 `cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_sandbox::tests` 7/7 通过。现有 macOS tests 断言 `sandboxed_shell_command` 产生 Seatbelt command shape，并覆盖 shared decision/profile policy；Linux 才有真实 Landlock 子进程写入/拒绝测试。因此若深化平台 owner，要分别保留真实 Linux integration 和 macOS 接口/Seatbelt behavior 验证；不能声称当前 CI 已测试 macOS runtime enforcement。

## 第七十一切片：Linux Landlock 平台 owner

- 现将 Host sandbox 的 Linux Landlock syscall、ABI/路径 preflight、ruleset fd lifecycle 与子进程 `pre_exec` enforcement 收入 `src-tauri/src/workspace_sandbox/landlock.rs`。`workspace_sandbox.rs` 仍拥有共同 profile/Host fail-closed 决策、Seatbelt projection 和唯一命令组装入口。
- Landlock owner 对父模块只暴露两项操作：`preflight(profile)` 返回不可变的私有 rules type；`install(command, rules)` 在启动 child 前准备 ruleset，并只在 fork 后执行不可逆的 `restrict_self`。父模块不再知道 ABI 常量、path rule syscalls 或 fd close details。
- 保持现有测试 seam `sandbox_decision` 与 `sandboxed_shell_command`。Linux confinement integration test 改为经 Host preflight 判断 Landlock 不可用/ABI 过低时跳过，不再直接依赖 `landlock_abi_version` 内部函数；没有增加测试入口或新 policy。
- 逐行比较了 HEAD 中原 Landlock 实现与新 owner 的 body，语义仅在聚合 preflight/install 调用面及必要可见性上变化；profile allowlist、ABI 3 下限、write/read-only overlap 拒绝、rule creation、资源清理与 child-only irreversibility 均保留。
- 当前验证宿主只安装 `aarch64-apple-darwin` Rust target，故 Linux `cfg` owner 与真实 Landlock child confinement 未在本机编译/执行；不可把 macOS 的 310 项 library suite 描述为 Landlock integration pass。Linux target 未通过工具链安装等外部状态修改擅自添加。

## 后续核心 owner 审计：Marketplace direct plugin source resolution

- 当前 `config_marketplace_native.rs` 为 1,381 行，测试从约第 1,044 行开始；文件已拥有 catalog、filesystem、registry 与 Git transport owners，剩余 parent 仍混有 marketplace lifecycle orchestration 与 direct plugin input/source resolution。
- 一个值得继续确认的职责簇是 `DirectPluginSource`、`parse_direct_source`、`detect_plugin_directory` 和 `resolve_direct_git_plugin_path`（约第 48–568 行中的分段）。它统一解释用户直接输入的 local/Git URL、GitHub shorthand/ref/SHA、`#subdir`，再定位目标 plugin；命令 lifecycle 负责后续 clone、install transaction 与 registry。
- `config_marketplace_sources.rs` 已处理 configured Marketplace source input，但该入口不接受 plugin `#subdir`，也负责配置 TOML CRUD；`config_marketplace_transport.rs` 拥有 URL/ref/SHA validation、clone/cache transport。两个模块语义相关但不等价，目前不能直接合并 parser 以免改变来源协议。
- 用户确认后，已将 direct source parsing、plugin-directory detection 与 Git checkout path resolution 收入私有 `plugin_source` owner。Parent 通过 `parse_direct_source` / `resolve_direct_git_plugin_path` 消费来源解析，并保留对 owner-owned `detect_plugin_directory` 的现有调用；clone、install transaction、registry 与授权语义仍由原 parent/lifecycle owner 管理。
- owner-interface tests 覆盖 canonical local path、local `#subdir`、local/Git traversal 拒绝、GitHub shorthand、branch+subdirectory、full SHA pin、唯一 nested plugin 自动发现与多 plugin 歧义拒绝；测试不触发网络 clone。Rust library suite（317 tests）、`cargo check --locked`、Rust formatting 与 architecture gate 均通过。
- `install_melody_plugin` 仍没有 command-level end-to-end test；本切片只加强了 source-resolution owner contract，没有宣称覆盖真实 Git clone、desktop Marketplace 操作或完整安装事务。
- 全仓大文件再次排序后，`pi_tool_gateway.rs` 1,533 行、`pi_worker_runtime.rs` 1,512 行、`config_marketplace_native.rs` 1,381 行、`pi_mcp_runtime.rs` 1,287 行。多个已有 owner 后剩余行数不能单独作为新拆分依据。

## Marketplace direct source resolver 的验证界面

- 实施前 `install_melody_plugin` 没有命令级测试，`parse_direct_source` 也没有独立测试；直接行为测试仅覆盖 Git checkout 中自动发现/显式选择相同 plugin directory、subdir 记忆与 `../outside` 拒绝。
- 现在 `plugin_source` owner 有独立 interface tests，覆盖本地路径/subdir、GitHub shorthand/ref/SHA、路径越界、唯一/歧义目录解析；Marketplace lifecycle tests 仍覆盖 `install_snapshot` 与配置式 candidate，不覆盖 direct install command 的完整事务。
- 真实 clone 与 desktop Marketplace 交互仍属于现场验收边界；当前测试不会访问网络，也不证明安装/授权行为之外的路径。

## Pi MCP runtime 剩余职责复核

- 已拆出的 `mcp_config.rs`、`stdio_transport.rs` 与 `remote_transport.rs` 分别拥有 configuration interpretation、local process/framing 和 remote HTTP/SSE protocol；`PiMcpRuntime` 继续负责跨传输连接缓存、配置变化时替换 transport、工具目录/调用路由、session/run cancellation 与 workspace shutdown。
- `active_calls` 与两类 connection maps 看似可再拆，但 cancellation 与连接停止顺序共享相同 workspace/session lifecycle；一个只封装 mutex/map 的新 registry interface 会增加调用面，却不会让 Host/runtime 决策更局部。目前没有足够深且独立变化的 seam，不按其约 1,287 行规模继续切分。
- 现有 15 个 runtime 测试覆盖 stdio/HTTP/SSE list/call、认证错误、请求取消、远程连接停止和 workspace 子目录 stop。当前判断是保留此协调 owner，除非后续发现独立变化原因或可复用的第二个 adapter。

## 剩余 subagent/model configuration owner 复核

- `config_subagents.rs` 的 runtime manifest 与 Settings inventory 共用 agent roots、Markdown parser 与 precedence，但两条调用面故意返回不同内容：Pi 获得完整、Host-validated policy manifest；Settings 只读取 toggle/inline metadata 与 file support 状态。再次合并成统一 manifest 构造会重建刚消除的多余扫描/规范化工作，当前没有新的独立 seam。
- `pi_model_config.rs` 当前将 user/project merge、local/remote model alias precedence、provider/parameter projection、model policy snapshot 与 secret-env slot 投影后一起写入 app-owned files；remote fetch/cache 已有专属 owner。仅从辅助函数数量或文件大小看，不足以把 `CredentialWriter` 或薄字段 parser 独立成模块；尚未发现可让验证或变化局部化的更深接口。
- 以上是基于当前函数调用和外部投影结果的只读复核，不代表全仓审计结束；继续寻找真实独立变化原因，而不是为了减少文件行数拆模块。

## Subagent prompt-file path handling 的验证缺口

- `config_subagents.rs` 仍含 `read_prompt_file`、`with_file_instructions` 与 role/persona/agent projection。文件读取负责相对路径、canonical containment、regular-file/size、UTF-8/control-character 检查与 trim；组合层负责 inline/file fallback 与输出 precedence。
- 当前可见测试覆盖 inline instructions 与 Markdown agent parser，但没有 `prompt_file`/`instructions_file` filesystem behavior test。现实现拒绝 canonical target 离开 base 的路径（包括外逃 symlink），但允许 canonical target 仍在 base 内的 symlink 和含 `..` 的内部相对路径；测试不可扩大为拒绝所有 symlink/`..`。
- 已提出将仅 `read_prompt_file(base, raw)` 拆入私有 `prompt_file` owner，并在 parent-facing owner interface 测试允许的相对文件、absolute 和逃出 base 的 traversal/symlink、non-file/size、invalid UTF-8/control characters 与 trim。`with_file_instructions` 的 fallback/precedence、manifest projection 与权限语义保持原地不动；等待用户确认测试 seam，答复前不新增测试或迁移安全路径代码。

## Pi compatibility fixture gate 与 Worker reader-loop seam 复核

- 当前 `package.json` 的 `check:pi-compatibility` 格式检查与 `node --test` 列表覆盖全部 10 个 `pi-*-compatibility` owner/test pairs，以及单独命名的 Tauri permission 与 numeric-source owner/test。`check-pi-compatibility.mjs` 明确导入这些 owners 并在同一主 gate 调用；`check:architecture` 由 CI 单独执行。当前未发现 fixture 漏入 gate，不为自动发现而改变跨平台命令解析。
- `PiWorkerRuntime` 仍保留 generation/process lifecycle；其 `spawn_readers` 则集中有序完成 frame decode、event ID/epoch/sequence acceptance、持久化先于 renderer emit、memory lifecycle observation、dispatch acknowledgement、Host Hook observation 与 permission/tool request routing。stderr reader 独立，stdout 结束/失败进入 generation cleanup。
- 这里的变化原因不是“函数过长”，而是有序副作用链同时交互 SQLite、runtime state、memory lifecycle、Hook、tool gateway 与 UI event channel。若继续治理，应先为 reader loop 定义可替换的内部 adapters/observable order tests；简单移成流解析模块会是浅 adapter，且存在改变 persist-before-emit / acknowledgement 顺序的风险。当前只记录候选，不改实现。

## 稳定架构指南与当前 Pi-only 治理状态

- `docs/architecture-improvement-plan.md` 顶部的“无立即架构阻塞项”是 2026-08-23 五项架构改进回顾的历史结论；在 2026-10 当前目标中，它不足以代表 Pi-only runtime 的结构治理完成状态。
- 为避免旧结论被当作全仓验收，已追加 dated supplement：明确 `PiSessionAdapter`/`PiWorkerRuntime` 的生命周期和时序职责、`PiToolGateway` 的 Host 最终权限裁决、内部实现 owners 与跨端 compatibility owners 的测试职责，并要求无既有测试 seam 时先确认可观察不变量。
- 这是稳定架构指引，不是对现有 dirty tree 或所有 owner 实现的独立验收；当前权威细节仍在 pi-migration README、handoff 和兼容清单。全仓结构治理仍未完成。

## Subagent prompt-file reader owner

- 用户确认了 `read_prompt_file(base, raw)` 的私有 owner/test seam，限定在相对路径解析、canonical directory containment、越界/符号链接策略、regular-file/size 与文本完整性；不得扩展到真实配置读取、`with_file_instructions` fallback/合并或权限投影。
- `config_subagent_prompt_file.rs` 现在持有 bounded reference、canonical path containment、文件类型/大小、UTF-8/control-character 检查及 trim。父 `config_subagents.rs` 保留调用组合与策略投影，只把文件读取调用指向该 owner。
- 测试明确固定一项关键兼容语义：内部 `..` 和 canonical target 仍在 base 内的 symlink 允许；逃逸路径与逃逸 symlink 拒绝。其余测试覆盖 absolute、非文件、1 MiB/32 KiB 上限、invalid UTF-8/control chars 与过长引用。全 Rust suite 与 compile 通过；没有读取用户真实配置。

## Worker event acceptance state seam candidate

- `spawn_readers` 仍应是进程 I/O、SQLite persistence-before-renderer-delivery 与生命周期/工具路由的协调点；将整段移成 wrapper 会让接口直接暴露 Tauri `AppHandle`、generation、storage、dispatch、memory、Hook 与权限/tool routing，难以获得一个有深度的模块。
- 更合理的局部 owner 是 generation-scoped event acceptance state：从 `PiWorkerRuntime::accept_event` 收拢 bounded event-ID/payload cache、worker epoch 和 monotonic sequence 验证；`PiWorkerRuntime` 保留 current-generation lookup、ready/handshake 处理和持久化后的副作用序列。它是纯 in-process state，可用窄 `accept(&Value)` 接口测试，不需要伪造 Tauri AppHandle。
- 当前测试验证 stateless `validate_event_metadata` 与 dispatch ledger，但不验证完整 cache state；没有发现 `tauri::test`/MockRuntime 测试 harness。需在实现前由用户确认具体 interface tests；durable SQLite 对已淘汰 cache event 的 duplicate 仲裁，以及 persist-before-emit 顺序都必须保持在当前 Host 路径。

## 2026-10-11：Worker event cache 的聚合内存上限风险

- 当前 frame reader 允许单个输入帧达到 `MAX_FRAME_BYTES = 1 MiB`；`PiWorkerRuntime::accept_event` 在 SQLite `parse_event` 的单事件 1 MiB 校验之前，将完整 `serde_json::Value` clone 放入 `seen_events`。缓存仅按 4096 个 event IDs 限长，故源码允许的 payload 字节总量理论上可达 4 GiB，尚不含 `Value`/容器分配开销；单事件数据库 byte cap 不构成缓存的 aggregate memory bound。
- durable SQLite replay owner 通过 `(session_id, event_id)` 查找既有 envelope，精确比较 JSON，并拒绝同 ID 不同 payload；sequence violation fallback 可把已从内存缓存淘汰的 scoped replay 交给数据库仲裁。因此缩小内存 cache 需要验证 durable fallback 顺序，也需单独考虑没有 product session 的 unscoped runtime events：它们不能依靠 event log 仲裁。
- `src-tauri/Cargo.toml` 已包含 `sha2`，故固定长度 payload fingerprint 可不引入新 crate 而避免缓存整份 `Value`；但这会把内存热路径的精确 `Value` equality 变为 digest equality（理论上存在碰撞），不是纯机械搬移。若采用，仍须验证相同 ID 的 changed payload 不会被投递、且 cache eviction 的 scoped replay 由 SQLite 精确仲裁。
- 这高于单纯职责移动，是独立的资源上限/重放语义问题。本轮只记录源代码推导出的理论风险，没有增加新 cache policy、改变当前 4096-ID 行为或新增测试。先前提交的 `PiWorkerEventAcceptance` seam 确认问题只覆盖原行为提取；任何 byte-budget、fingerprint 或 unscoped replay 行为变更应另行确认并以真实外部 interface 测试。

## Pi web runtime 的响应投影 owner 候选

- 当前 `pi_web_runtime.rs`（约 779 行）将可信配置合并、web search/fetch policy 与 URL 检查、两种 HTTP workflow、JSON citations 归一化和 HTML→text 转换放在同一个 Host runtime。安全策略与 network I/O 必须继续留在 Host runtime，不能为了缩小文件而泄漏到 worker 或复制到 renderer。
- 源码显示 `html_to_text`/entity decode 是纯有界 HTML→text projection；`citations_and_text`/`format_search_output` 是独立 search response projection。当前父模块 5 项测试直接覆盖其中 URL policy、HTML projection 和 search citation，未发现本轮新增或修正了错误行为。
- 可评估的深模块不是再包一层 HTTP client，而是纯 response-projection owner：外部调用面接收已取得的 body/JSON 与明确上限、返回现有文本形状；配置、域名/私网策略、credentials、redirect policy、网络 I/O 和最终 Host 工具授权留在原 Host runtime。这样可让 projection 变化与网络/安全决策局部化，但需要检验当前内部测试改为 owner interface tests 后既有输出和边界完全一致。
- 这是候选而非已确认 seam。本轮只读审计，没有改 runtime、兼容门禁或测试；在新增 projection owner tests 前仍须按 TDD seam 要求确认接口与可观察行为范围。

## 2026-10-11：Config Skill catalog command 的依赖方向修复

- 复核发现 `config_extensions::scan_plugin_tree` 调用 `config_plugin_details::plugin_capability_from_directory`，但 `config_plugin_details::get_melody_skill_details` 反向调用 `config_extensions::pi_skill_catalog_paths`，形成 sibling owner 的直接依赖环；资源 catalog 和文件详情责任因此双向耦合。
- 将 Skill details/delete commands 放回 catalog/lifecycle owner `config_extensions`，继续调用 `config_plugin_details` 提供的解析与 path-safety helpers；保持 Tauri command name、`config_runtime` re-export、`lib.rs` handler registration、workspace authorization 与 catalog/path-validation 时序不变。`config_plugin_details` 不再 import `config_extensions`，向上依赖被移除。
- 没有建立新测试 seam；既有 config behavior suite 27/27、完整 Rust lib 332/332、Rust fmt、`cargo check` 及 `pnpm check`（含 79 compatibility/permission fixtures）通过。验证覆盖 compile/re-export/permission registration，但不替代未来命令级 filesystem failure-injection；此改动是纯 command ownership relocation。

## Browser session lifecycle seam audit (superseded by slices 119–120)

- 更正上一轮笔记中的“parent 没有 tab state/profile 测试”：当前 `pi_browser_runtime.rs` 的 9 项测试已覆盖 tab 上限、未知 tab 选择不改 active id、关闭 active tab 后邻接选择、profile label/session identifier、平台 profile mode、bounds 与浏览器 URL/remote-capability policy。本机定向命令 `cargo test --manifest-path src-tauri/Cargo.toml --lib pi_browser_runtime::tests` 当前 9/9 通过。
- `browser_policy.rs`、`page_tools.rs`、`screenshot.rs` 已拥有 URL trust policy、页面交互协议与截图裁剪/编码。剩余 parent 集中管理 `BrowserSession` 的 tab index/entry map、WebView lifecycle、可见性、status projection 与命令编排；单独抽 `BrowserTabIndex` 会重复现有小型纯状态测试，不构成有足够深度的新 owner。
- 未覆盖的行为位于 index/entry 和 WebView effect 的协调顺序：`close_browser_tab` 先移除 entry/index 再调用可能失败的 `close_view`；`select_browser_tab` 先切换 active id 再逐项 apply/hide views。源码表明操作失败时会返回错误，但本轮没有注入失败的 WebView adapter，因而没有验证过真实平台的残留/部分可见状态；这是风险窗口，不是已复现的 runtime bug。
- 若继续深挖，候选应是一个拥有 tab transition、entry-map consistency、visibility/close effect ordering 与 status projection 的 session lifecycle owner，并以 Tauri adapter + in-memory test adapter 穿过同一 owner interface 测失败回滚/一致性；URL/popup Host security callbacks、Pi tool routing、SQLite/其他 runtime owners 不迁入。先确认该 adapter/interface 和 observable tests，再写测试；否则保留现有 runtime coordinator，避免薄 wrapper 或伪装真实 WebView E2E。

### 后续实现闭环

- slice 119 将 `BrowserTabIndex` 的直接测试迁入 `session_lifecycle.rs`；slice 120 保持并使用同一个 `BrowserSessionLifecycle` interface，覆盖 Tauri 与 in-memory adapters 下 create/select/close failure ordering，并将 session-isolated WebView construction 迁入 `view_creation.rs`。
- Browser-scoped tests 当前为 15/15，完整 Rust lib 为 350/350。Parent 仍负责 `browser_status` projection、tool command orchestration 与实际 Tauri WebView integration；adapter failure tests 是共享生命周期 owner 的可观察合同，不声称验证真实平台 WebView 故障注入。
- 因此候选的 tab transition/entry lifecycle 部分已完成；remaining status/command projection 暂留在 parent，只有出现独立变化原因时再评估，不按文件大小追加薄层。

## Pi-only renderer transport guard audit

- 当前 production Desktop 的默认/归一化路径是 Pi：`app-settings-store.ts` 默认 `agentEngine="pi"`，加载历史 `legacy-acp` 值时也归一成 `pi`；`use-agent-bridge.ts` 在 Pi capability report blocking 或检查失败时拒绝打开，不将会话切到 ACP；Pi subscribe/start 失败只做清理并向用户报错。旧会话只读 archive 分支在 transport subscription 之前返回。
- 但 renderer adapter 仍提供 `AgentClientEngine = "legacy-acp" | "pi"`、`legacyAgentClient`、session engine overrides 与 `usePi ? "pi" : "legacy-acp"` route；在 Tauri runtime 下该 legacy adapter 会 invoke `send_acp`/监听 ACP events，而当前 `src-tauri/src/lib.rs` command list 已没有这些 ACP runtime commands。非 Tauri browser preview 则由 `sendAcp`/`subscribeToAcp` 使用 deterministic in-memory fixture；这是预览模拟，不是桌面 runtime。
- 当前 Pi compatibility checker 验证 manifest `runtimeFallback=none` 及 capability/diagnostic fallback claims，但没有覆盖实际 renderer client routing；`rg --files src` 未发现 `agent-client` 或 `app-settings-store` 的测试文件。故现证据支持“默认 Desktop 路径 Pi-only，残留 ACP transport 是可误选/误调用的架构面”，但尚不能证明所有调用方在未来改动下仍无法选择它，也没有发现当前默认 Desktop 启动走到 ACP 的证据。
- 高价值候选是把界面改为显式 `Tauri Pi client` 与 `browser-preview fixture adapter` 两种运行环境，不把 `legacy-acp` 当作生产 engine；保留 ACP archive/import codecs 与只读 migration logic。测试 seam 应覆盖 Desktop send/subscribe 固定走 Pi、Pi blocking/failure 不回退、browser preview fixture 行为保留、archive session 不订阅任何 runtime。先确认 interface/test surface，再做可能跨 `agent-client`、settings 与 `use-agent-bridge` 的迁移，避免把显式环境分支压成新的 pass-through wrapper。

## PiSessionAdapter child-session lifecycle review

- 当前 `session-adapter.ts` 为 3,460 行，`PiSessionAdapter` 仍是 worker-facing Pi protocol/lifecycle owner。child `TaskHandle` 继承完整 `PiSessionContext`；其 map 被 session context lookup、root/child resource 与 model refresh、root close/closeAll、run cancellation、task wait/cancel/continue、nested task callbacks 和 `onPiEvent` 共用。`spawnSubagent`（约 2551–3109 行）因此不是可无状态搬走的独立函数；单独移 `spawnSubagent` 会让任务 map 与 callbacks 在父模块中继续分散。
- 当前 `session-adapter.test.mjs` 定向 suite 28/28 通过。可观察测试已覆盖 lifecycle operation queue、`closeAll` 清理 child tasks、task ownership/wait、以及 durable child record 校验；`subagent-policy.ts` 与 `subagent-session-boundaries.ts` 另行覆盖纯 launch policy 和 resume/worktree trust rules。该 suite 没有直接测试 `spawnSubagent` 创建/续接时的 session、worktree/permissions callback、终态投影、记录持久化和失败清理组合。
- 后续若需要深化，应设计一个真正拥有 task registry/child-session lifecycle 的 `PiTaskRuntime`，并让 parent 通过窄 interface 做 root-context lookup 与 Host lifecycle integration；该 owner 还必须接管所有现有 map readers/writers，不能只包围 spawn/wait 方法。需要单独设计 Pi session factory 与 Host tool/emitter/persistence adapters，并验证 root-session authorization identity 仍由 Host ToolGateway 裁决。现有证据尚不足以确定它比现有 `PiSessionAdapter` facade 更深，因此本轮不拆 runtime、不新增未确认 seam 的测试。

## Host sandbox profile resolver review

- 当前 `workspace_sandbox.rs` 为 766 行，其中 profile/env/path semantics（builtin/none 识别、`MELODY_HOME`/home/TMPDIR roots、用户/项目 `sandbox.toml` 查找优先级、relative/`~/` exact deny canonicalization、glob/network unsupported projection）形成共同输入规则；解析结果 `SandboxProfile` 同时被 Seatbelt renderer 与 Linux Landlock preflight 消费。
- `seatbelt_profile` 只有少量 SBPL string rendering；独立成 owner 会偏浅。`sandbox_decision` 必须继续是唯一平台选择/Unsupported/fail-closed 决策，`sandboxed_shell_command` 继续是 terminal/monitor 共同 Host command interface，Tauri preflight 仍先经 `WorkspaceRegistry::authorize`。不得把 allow/deny 决策复制进平台 owners。
- 当前 macOS 定向 tests `workspace_sandbox::tests` 7/7 通过，覆盖共享 terminal/monitor 路径、disabled/workspace/custom/deny/glob/network cases 与 Seatbelt rule rendering。当前只安装 `aarch64-apple-darwin` target；Linux Landlock child enforcement 未在本机编译/运行，不能用这 7 项 macOS tests 代替。
- 有效的下一候选是独立 profile-resolution owner，暴露单一 `resolve(SandboxProfileRequest) -> Result<Option<SandboxProfile>>` interface；request 显式承载 workspace、用户/项目配置来源、state/home 与临时路径，owner 负责 profile precedence、path expansion/canonicalization 与规则 projection。要先确认此 interface 和 fixtures，并验证 user profile 不被 project 同名弱化、deny/glob/network 配置不丢失、Linux/Seatbelt consumers 接到相同解析结果；否则保留目前 cohesive Host security module。

## 2026-10-10：macOS 自定义 `read_only` 路径规则偏差（由第八十六切片修复）

- 直接源代码证据：`SandboxProfile.read_only` 的注释定义 child 可读不可写；Linux `prepare_landlock` 对这些路径只添加 `LANDLOCK_READ_ACCESS`，并拒绝与 read-write path 重叠。macOS `seatbelt_profile` 却在全局 `(deny file-write*)` 之后，对 `profile.read_only` 添加 `(allow file-write* (subpath ...))`。该 payload 经 `sandbox_decision` 返回给 Host terminal/monitor 执行 seam。
- 这表明 Mac/Linux 对同一自定义 profile 字段生成的策略不一致，且 Seatbelt 输出明确包含对只读目录的写入 allow；属于潜在 Host sandbox 安全偏差。`git show HEAD:src-tauri/src/workspace_sandbox.rs` 确认此 loop 已在当前基线存在，不是最近 Landlock owner 提取新增。
- 当前环境发现 `/usr/bin/sandbox-exec`，但对受控临时目录运行最小探针返回 `sandbox-exec: sandbox_apply: Operation not permitted`；因此尚无实际子进程读写结果。Linux Landlock target 也未安装。需要区分生成了错误规则这一源码结论与实际平台执法验收。
- 当前直接行为测试未覆盖此字段：macOS `workspace_sandbox::tests` 对 SBPL 只断言全局 write deny、workspace literal 与 device sink；自定义 `locked` fixture 只配置 `read_write` 和 exact deny。Pi compatibility checker 的 Sandbox block 也只检查 wrapper、canonicalize、unsupported profile 和 preflight command 标记，不验证 `read_only` rule。故此为确切的回归保护缺口，不只是对现有测试覆盖的推测。
- 进一步发现，单纯移除只读路径自己的写 allow 不足以处理它位于更宽 `read_write` 子树中的情况：父路径规则仍允许写入，而 Linux Landlock 对任意 read-only/read-write overlap 选择 fail closed。此前提出的“在所有写 allow 后追加只读 deny”依赖 Seatbelt 匹配优先级，尚未验证：本机 `sandbox-exec(1)`/`sandbox(7)` man pages 只描述入口与资源限制，没有明确 SBPL 规则冲突语义；公开二手资料也互相矛盾，一类称 deny 总是优先，另一类称后匹配规则优先（例如 [bx-mac policy note](https://github.com/holtwick/bx-mac/blob/master/CLAUDE.md) 与 [pkg-registry architecture note](https://github.com/git-agentic/pkg-registry/blob/main/ARCHITECTURE.md)）。因此不应将规则顺序方案当作已知安全事实。更稳妥的无假设候选是由共享 Host profile validation 对跨平台的 read-only/read-write overlap 一律 fail closed（与 Linux 语义一致）；否则先在可执行真实 Seatbelt 的环境实测再选策略。该变化的错误映射/用户配置影响须在用户确认范围内处理。
- 用户批准共享 Host fail-closed 策略后，`sandbox_decision` 在平台选择前统一拒绝相等或任一方向的 read-only/read-write overlap，并把 macOS 的 device write exceptions 也视为隐式 writable sinks；因此 `/dev`、`/dev/null`、`/dev/pts` 等冲突只读路径不会漏过 policy。错误仍映射为既有 `PlatformBroken` unsupported decision；Linux Landlock 移除重复 overlap policy。Seatbelt 不再输出 read-only path 的写 allow。三项 TDD tests 分别固定 disjoint readonly 的 SBPL 输出、显式 read/write overlap 关系及 device-sink overlap。此修复不依赖未验证的 SBPL precedence。
- 当前 macOS Rust unit tests 验证 Host decision 与生成规则，不代表执行了受限子进程的真实 Seatbelt file operation；本环境内嵌 `sandbox-exec` 探针仍被外层限制为 `sandbox_apply: Operation not permitted`。Linux Landlock child integration 也未在本机目标上运行；跨平台真实 enforcement 验收仍需相应 runner。

## 第八十二轮审计：Session Explorer 跨端合同覆盖缺口

- `sessionExplorer` manifest 定义了原生 `nativeEntryId` 锚点、已完成纯文本 assistant 回复资格、Host fork authorization、opaque Pi 分支物化、持久 lineage、bring-back 12,000 codepoint 上限、禁止自动提交与 restart recovery 等约束；但 `scripts/check-pi-compatibility.mjs` 没有读取 `hostBridges.sessionExplorer`，也没有独立 contract owner。`rg` 搜索确认 checker 内无 `sessionExplorer` 字段引用。
- 当前已有两个互补但局部的测试：Rust `database_agent_forks::tests::fork_lineage_is_durable_retryable_and_bound_to_its_original_anchor` 覆盖 Host 持久 lineage/anchor/read-reference；worker `session-adapter.test.mjs` 的 `validates a persisted Explorer fork artifact for crash recovery` 覆盖 Pi 原生分支父会话/锚点校验。重跑分别为 2/2 与 28/28 通过。
- 目前未见 `session.fork` command validation/Host dispatch/renderer acknowledgement/UI eligibility 的集成或 fixture contract test；仓库文档也明确 desktop end-to-end 与 failure-injection 尚待验收。不能把上述两个局部测试视为全链路成功证据。
- 深模块候选是纯 `checkPiSessionExplorerCompatibility(contract, sourceSnapshots)`：由现有聚合 checker 提供 contract 与 agent contract、Host `database_agent_forks`/worker-runtime、worker `session-adapter`、bridge 与 UI source snapshots；owner 仅校验字段/接线/边界声明并返回 diagnostics，不拥有 runtime、权限或数据库状态。Fixture 应确保 anchor 身份、Host authorization/wiring、自动提交及 bring-back bounds 的 drift 可被发现。
- 该 static owner 只能降低跨层声明漂移风险，不能替代 Tauri/desktop failure-injection 或真实并行/重启验收。按 TDD seam 纪律，fixture owner interface 与覆盖范围仍须用户确认；答复前不写 tests 或变更运行时代码。当前较早提出的 compaction gate seam 也尚无明确选择。
- 补充核对更正测试盘点：`src/domain/agent/explorer-branch.test.mjs` 已有 6 项纯行为测试，覆盖 draft-only reference、显式发送时展开、JSON 不可信上下文与 bring-back codepoint 截断；定向重跑 6/6 通过，且纳入 `pnpm test:unit`。Rust Host 和 TypeScript 当前都设为 12,000 codepoints，并与 manifest 对齐；但三个独立声明尚无 cross-language drift fixture。应将新 owner 的必要价值限定为跨层合同/接线/重复上限 drift 检测，而不是重复现有纯行为测试。
- 本次复核发现更新的语义差异：`PiSessionExplorer.bringBack` 实际调用 `appendExplorerSessionReferenceToDraft`，写入的是显式分支引用；清单却描述为写入锚点后的 assistant 结论，且 `appendExplorerConclusionToDraft` 当前没有产品调用点。历史 slice 已测试/保留显式引用行为，因此不能单凭清单推断应改 runtime；需由用户决定以哪种产品语义为准，再选择更新清单或行为。决定前不新增把当前行为强制对齐到某一侧的 checker。

## 第八十三切片：MCP transport manifest drift owner

- `pi-compatibility-manifest.json` 中 `hostBridges.mcpTransports` 当前声明 `stdio`、`http`、`sse`。对 manifest 的 `hostBridges` key 做 source crosswalk 后，主 checker 和现有 `pi-*.mjs` compatibility owners 均未消费该 transport list；主 checker 有独立的 `mcpInventory` 合同块，但它验证的是 Host capability inventory command/authority，而不是 transports。
- 当前实现没有发现 transport drift：`mcp_config.rs` 将 stdio/local、HTTP aliases 与 SSE aliases 解析为三种受支持类型；`stdio_transport.rs` 实现本地 process protocol；`remote_transport.rs` 实现 HTTP/SSE connections。既有 Rust parser tests 覆盖 stdio、streamable HTTP 和 unsupported config，runtime tests 另覆盖本地 stdio、remote HTTP 与 SSE。上述证据证明当前实现行为，不证明 manifest 变化会被兼容 gate 捕捉。
- 用户明确确认 source-snapshot fixture seam 后，新增 `scripts/pi-mcp-transports-compatibility.mjs` 并由 `check-pi-compatibility.mjs` 调用。owner 精确要求 manifest canonical set 为 stdio/http/sse（顺序无关、拒绝重复/alias 替代），分别核对 parser mapping、local stdio normalization、parent module/dispatch wiring、stdio configured-command startup、remote `execute_remote_request`/HTTP client 与 SSE bootstrap。它不会把 `local`、`streamable-http`、`server-sent-events` 等 parser aliases 暴露成额外 canonical transport，也不做 runtime/authentication/authorization decisions。
- `scripts/pi-mcp-transports-compatibility.test.mjs` 提供 8 项纯 source-snapshot fixtures。首轮测试先因 owner 文件不存在失败；随后增加针对 remote HTTP execution marker 的 tracer bullet，证明仅有 enum/as_str/SSE bootstrap marker 不足以保护实际 HTTP owner wiring，再以最小 source marker check 通过。最终通过数据见 progress log。
- 同一 crosswalk 也确认 `sessionExplorer` 尚无 manifest gate；局部 Host/worker/domain tests 已记录在第八十二轮，桌面端到端和 failure-injection 仍缺。MCP transport 与 Explorer 是彼此独立的 drift/test gaps，暂不把它们塞入同一个 owner。

## 第八十四轮审计：Pi-only renderer 中的惰性 ACP bridge

- 当前 Desktop 默认设置是 Pi；`app-settings-store.ts` 在读取旧持久值时将 `legacy-acp` 归一为 Pi。`use-agent-bridge.ts` 对归档会话在任何 runtime subscription 前返回，且 Pi worker 错误会明确失败，不执行 ACP fallback。因此现有证据不支持“默认 Desktop 仍运行 ACP”的结论。
- 但 `agent-client.ts` 仍公开 `legacyAgentClient` 与 `legacy-acp` 路由；`melody-bridge-runtime.ts::sendAcp` 在非 Tauri 环境使用确定性预览 fixture，在 Tauri 环境仍调用 `invoke` 的 `send_acp`，`subscribeToAcp` 的 Tauri 分支仍监听旧 `melody://acp-message` / `melody://acp-stderr`。当前 `src-tauri/src/lib.rs` 没有 `send_acp` handler 注册，Host 源码也没有相应 ACP event emit；这是不可用的 Desktop path surface，不是正常路由中的 fallback。
- `agent-client.ts` 的注释仍把 ACP 描述为默认/能力回退、Pi 描述为 opt-in，与当前 app settings 和 Host commands 不一致；这是维护者误解与未来回归风险。浏览器预览和只读 ACP archive/import 仍是独立有效范围，不能因 Desktop Pi-only 清理而删除。
- 已提出精确 TDD seam：在现有 bridge send/subscribe 调用面，为 Desktop ACP paths 添加调用前 fail-closed 保护，同时保留预览 fixture/archive/import，并改正过时说明；测试应证明 Tauri 不 invoke/listen 已移除的 ACP transport，非 Tauri fixture 仍可工作。此可能是运行时边缘语义变化，尚未用户确认；本轮没有修改 source/test。桌面端之外的兼容 API 清理仍需依赖图审计，不先扩大 scope。
- 用户随后明确批准该 seam。已把 fixture/send/subscribe 收入 `src/lib/melody-bridge-acp.ts`，runtime detection 收入 `melody-bridge-runtime-context.ts`，旧 `melody-bridge-runtime.ts` 保留原 re-export 接口。Desktop send/subscribe 在碰触已移除的 Tauri command/event 前 fail closed，ACP owner 不再导入 `invoke`/`listen`；preview initialize fixture 的 JSON 响应保持原样。
- `melody-bridge-acp.test.mjs` 从公开 send/subscribe interface 覆盖 Desktop 两条 fail-closed path（并断言没有 invoke side effect）及浏览器 preview deterministic initialize 响应。只读归档/ACP→Pi import、Host authorization、正常 Desktop Pi routing 未变；当前 test/build/check 结果见 progress 的第八十四切片记录。
- 同步修正 agent-client、Pi event projection/store 和 bridge hook 中称 ACP 默认、Pi opt-in 或 capability fallback 的注释。未扩展到删除 `AgentClientEngine` legacy variant 或其它 ACP archive/import compatibility code。

## Pi migration handoff code map refresh

- 只读复核发现 `handoff.md` 的 worker/Rust Host code map 仍把若干已拆出的实现笼统归在 parent 文件，难以据此定位稳定 owner；本轮修订 §2.2–2.3，列明 session adapter/tool gateway 组合边界与真实 TS/Rust child owners。
- 交叉核对确认 Rust Memory lexical index 的真实路径为 `pi_memory_runtime/store/search_index.rs`（不是 runtime 根目录下的 sibling）；文档现按 `pi_memory_runtime/store.rs` 与 nested index 分别导航。其余列出的 worker、worker runtime、tool gateway、MCP、Browser、LSP、marketplace、schedule/event contract 与 Landlock owner path 均在当前树中存在。
- 此为导航/责任归属文档修复，不代表全仓审计完成，也不替代其他待确认行为/fixture seam；该文档变更本身未改运行时或测试。

## 第八十五切片：Pi Explorer renderer workflow owner（完成）

- `AgentWorkspace` 原约 830 行，actions、layout、view 已有明确 owner；本切片只提取另一个职责完整的 Pi Explorer workflow，不以行数为理由继续拆 composition root。
- 用户批准后，新增 `pi-session-explorer.ts`，以 `createPiSessionExplorer` 拥有 load、explore、resume、bring-back 工作流；`use-pi-session-explorer.ts` 作为生产 adapter 组合 Pi bridge、Zustand workspace、draft storage、selection 与 Application Error 映射。`AgentWorkspace` 继续通过原有 view callback/state 形状组合 UI，现为 612 行。
- 同一 interface 的 in-memory adapter tests 覆盖 7 个可观察行为：分支保存 anchor 前的 projection prefix 并激活、native fork 失败仍保留可恢复记录、不抢占并发切换后的当前会话、pending fork 从持久会话集合恢复、恢复失败保留最新 fork/error、成功写回显式 session reference、草稿写失败不切换源会话。
- 没有移动或改变 Host fork persistence/authorization、Pi native replay、归档格式或 session-selection policy；分支存储/fork/插入/焦点和失败可恢复顺序保持不变。
- 验证：`pnpm check`、`pnpm lint`、`pnpm test:unit` 430/430、`pnpm check:architecture`、`pnpm build`、`pnpm format:check` 与 `git diff --check` 均通过；Vite 仅提示既有 >500 KiB chunks。兼容与权限 fixture 为 79 项。
- 当前 branch 仍是 `beta`，版本 trio `0.4.0-beta.2`；未 commit、push、publish、release 或同步 `main`。全仓结构性目标仍进行中。

## 2026-10-11：SQLite owner 与 Pi runtime 的删除生命周期依赖

- `database_sessions.rs` 与 `database_projects.rs` 各自仅为 delete command 导入 `PiWorkerRuntime` 及 `remove_pi_session_artifacts`；`PiWorkerRuntime` 本身依赖 `database` 的 event/session persistence。结果是数据库 owner 在持久化之外还负责 worker lifecycle orchestration，形成 runtime→database 与 database→runtime 的依赖回路。
- `delete_session` 和 `delete_project` 属于跨 store/use-case 编排，不属于 SQLite transaction implementation。现将 Tauri handlers 移入 `agent_session_lifecycle.rs`，由 Host root-level lifecycle owner 协调 Pi worker、native artifacts 和 database；纯事务/purge helpers 留在现有 DB modules。
- 这是 command relocation，Tauri 注册名与原执行顺序不变；Pi-bound 才停止 worker、artifact cleanup failure 阻止 DB deletion、project cleanup 跳过 ACP-only worker 的语义保留。database modules 不再依赖 Pi worker/artifact store，worker 对数据库的依赖保持单向。
- 未增加行为/adapter tests：当前没有真实 Tauri lifecycle adapter 的替身，而且本次没有更改观察到的语义；迁移前后 `database::` 现有 55 项 tests 均通过，完整 Rust lib、编译与 Pi/permission command registration checks 也覆盖了可验证的现有接口。真实并发/故障顺序未声称已由测试覆盖。

## 2026-10-11：ToolGateway 与 MCP 的共享 output archive owner

- 现有 archive helper 同时管理 terminal stream 的 bounded preview/full-output file、workspace readback 与 MCP result archival，但文件位于 `pi_tool_gateway/tool_output_archive.rs`；`pi_mcp_runtime` 因而直接依赖 ToolGateway module 取 shared archive function/prefix。
- 将 implementation 提升到 `pi_tool_output_archive.rs`，让 gateway terminal/workspace modules 与 MCP runtime 都依赖同一个 Host-owned owner；`pi_mcp_runtime` 不再 import `pi_tool_gateway`。原有 gateway public call paths/tests 保留，MCP archive path/name 与 terminal/MCP output behavior没有改变。
- 同步 Pi terminal compatibility checker 读取的新 owner 路径；原有 preview cap/drift assertions 保持不变。此前首次 `pnpm check` 因旧文件路径失败，修正后 79 项 fixtures 通过。
- 这是 shared-resource ownership 调整，不是新增 archive abstraction/adapter；现有 gateway 35 项和 MCP 15 项 suite 通过，完整 Rust lib 332 项通过，warning-free Cargo check 与 crate fmt 通过。并未声称新增行为覆盖或真实桌面 acceptance。

## 2026-10-11：Pi web response projection owner（第八十九切片）

- 先前 `pi_web_runtime.rs` 混放 Host 配置/SSRF/HTTP 工作与 HTML→text、bounded-text、search-citation projection。后者是确定性纯转换，无需复制或提升 Host 网络权限。
- 用户继续总目标后，抽取为 `pi_web_runtime/projection.rs`，保留旧 behavior tests 并让它们直接调用新的内部 module interface。Host URL/redirect policy、credential/header flow 与 request/response handling 留在 `pi_web_runtime.rs`。
- 现有 targeted tests 5/5；全量 Rust lib 和 web compatibility checker 通过。该 slice 仅改善 projection locality，未改变内容解析边界或宣称完整 HTML parser/搜索服务行为已覆盖。

## 2026-10-11：PiWorkerEventAcceptance generation-local owner（第九十切片）

- 用户明确确认此 interface/test scope。`PiWorkerRuntime` 仍锁定当前 `WorkerProcess` 后，将 `Value` 交给 `PiWorkerEventAcceptance::accept(&Value)`；新 owner 仅负责 generation-local exact event payload deduplication、epoch/sequence validation 和 bounded cache，不触碰 process lock、ready/handshake 或 database。
- 新 owner 的五项 tests 固定首次接受、相同 ID/相同 payload duplicate、相同 ID/different payload rejection、epoch/sequence violations 与 FIFO cache 第 4096/4097 项的 eviction transition。eviction 后旧事件继续形成 sequence error；reader 仍让 `persist_pi_event`/SQLite 确认 durable duplicate，再决定是否忽略或终止。
- `protocol.rs` 现在只保留 framing/command contract，Pi compatibility checker 对 acceptance owner 及 runtime->acceptance/SQLite wiring 增加 marker verification。全量 Rust lib 336/336、事件 acceptance suite 5/5 与 all current compatibility checks 通过。
- 未改 payload-cache 的总字节上限：worker 单帧 cap 为 1 MiB、event cache 保留至多 4096 个完整 `Value`，理论 retained payload 可达约 4 GiB 加对象开销。此资源风险独立于本次 owner seam，需另行设计总字节预算/oversize policy；本 slice 为保行为未自行新增 eviction/validation semantics。

## 2026-10-11：BrowserSessionLifecycle 与 WebView effect ordering（第九十一切片）

- Browser session 原来以 parent runtime 的 `BrowserTabIndex` 与 `entries` 两个独立字段散布 open/select/close state change 和 Tauri WebView effects。现将两者作为一个 state owner 收入 `pi_browser_runtime/session_lifecycle.rs`，让其公开小型 `BrowserTabAdapter` interface；产品端 `TauriBrowserTabAdapter` 和测试端 in-memory adapter 穿过相同 interface。
- 用户选择沿用当前顺序而不加失败补偿：`open` 先 reserve id，创建失败时移除 reservation；`select` 先更新 active id，再按原 map 顺序逐个 apply WebView visibility/bounds，失败即返回但保留 active id；`close` 先移除 entry/选择邻接 tab，再关闭 view，失败仍保留 state 更新。`pi_browser_open` 使用的 `ensure_active_entry` 单独保留旧创建失败不清除 reservation 的路径。
- 3 项新 tests 分别覆盖 open rollback、close side effect error 后 tabs/entries/active 状态、select side effect error 后 active state 和 effect trace。Host URL allowlist/SSRF、popup/loopback preview policy、Tauri commands/permissions、外部事件顺序未改；该抽取不代表真实桌面 WebView failure-injection acceptance。
- Pi compatibility checker 已检查 session lifecycle owner marker、Tauri adapter 和 open/select/close 接线。浏览器 tests 15/15、全 Rust 339/339、无 warning Cargo check、Rust fmt、`pnpm test:unit` 430/430、`pnpm check` 79 fixtures、architecture/lint/format/build gates 与 diff check 均通过；只有既有 Vite chunk-size warnings。当前 beta 且无发布/main 操作。

## 2026-10-11：Pi resource manifest composition root（第九十二切片）

- `config_extensions.rs` 的 `pi_resources` child 从 `config_extensions.rs` 父 owner 读取插件/资源配置；旧 `pi_resource_manifest` 又从该 child 调用 `config_subagents::pi_subagent_policy_manifest`。同时 `config_subagents` 需要 `config_extensions::pi_plugin_agent_roots`，形成 sibling owner 间的循环依赖。
- 既有实际调用方 `pi_worker_runtime.rs` 与 `pi_worker_runtime/launch.rs` 已经通过 `config_runtime` 使用 `pi_resource_manifest`，因此该 facade 是现成组合 root。现把子模块输出收窄为 `pi_resource_manifest_parts`，由 `config_runtime` 按 resource → subagent → optional timeout → optional goal 的既有求值顺序组装完整 Value；字段、错误边界与调用 API 未改变。
- Compatibility source checker 现在明确检查 resource owner 无 `config_subagents` 依赖，并检查 `config_runtime` facade 负责 subagent-policy composition；79 项兼容/权限 fixtures 通过。测试门禁覆盖既有 resource discovery 和 subagent policy tests 及完整 Rust lib。
- Full suite 首轮发现 `failed_view_selection_keeps_the_new_tab_active` 对 `HashMap` 遍历强加固定先后顺序，尽管它单独运行会通过。实际 Tauri adapter 迭代也来自同一个未排序 map，因此保留生产遍历，只把测试断言改成验证失败目标和新 active id，不再假定 deterministic effect ordering；这项测试修复无 renderer、Host 权限或运行时行为变更。

## 第九十四切片：SessionAdapter 的内部 task-contract import ownership

- `PiSessionAdapter` 仍通过 `tool-gateway.ts` 组合入口 import type-only 的 `PiTaskController`/`PiTaskSnapshot`/`PiSubagentCapabilityMode`/`PiSubagentIsolation`，但它们的定义所有者在 `task-tools.ts`、`tool-access-policy.ts` 和 `subagent-policy.ts`。这使 session lifecycle owner 对 gateway aggregate 形成不必要的类型依赖。
- 仅将内部 imports 改为直接 owner 路径；gateway 既有兼容 re-export 保持，runtime constants/class 仍从 gateway 导入。这个精确依赖图收敛不要求抽出薄 facade、测试接口或运行时状态。
- 验证：worker 164、完整 unit 430、完整 `pnpm check`（86 compatibility/permission fixtures）、lint、format、build 通过；未改 Rust/runtime code。Build 保留既有 Vite chunk warnings。

## 第九十五切片：Subagent resume boundary 的 task status type ownership

- `PiTaskStatus` 定义于 `task-tools.ts`，但 `subagent-session-boundaries.ts` 通过 `tool-gateway.ts` 聚合入口导入。它是一个不涉及 runtime 的内部 type dependency；直接引用定义者消除了此处对 gateway aggregate 的隐藏依赖。
- 该调整不涉及 task state transitions、resume authorization、Host ToolGateway policy 或公开 re-export。worker tests 164/164、worker TypeScript build 与 architecture gate 3/3 通过。

## 第九十六切片：Config write core 与 runtime refresh dependency

- `config_core.rs` 的 `update_melody_config` Tauri command 在配置存储完成后直接操作 `PiWorkerRuntime`；除 workspace authorization 与 patch classification 外，配置解析/写入属于 core owner，Pi model/resource refresh 属于 Host runtime orchestration。
- 将 command composition 移到既有 `config_runtime.rs` facade，并让 facade 调用 `config_core::update_melody_config_inner`。保持 renderer command/permission、授权、写入与 refresh 顺序、best-effort failure semantics 不变；`config_core.rs` 现在无 `PiWorkerRuntime` dependency。
- 全 Rust lib 339/339、Cargo check、Rust fmt、86 项 Pi compatibility/permission fixtures 均通过。这是既有 command interface 的职责归属修正，没有新增 test seam。

## Session Explorer bring-back semantics (user decision applied)

- 用户明确选择保留 branch-reference 语义。`PiSessionExplorer.bringBack` 仅在 fork ready、anchor 存在且所带回的 assistant entry 位于 anchor 之后时，把 `&session:<branch-id>` reference 加入源会话对应的本地 composer draft；写回成功后才选择源会话，不自动提交。
- 兼容清单已改为 `explicit-branch-session-reference-appended-to-session-keyed-local-draft`，并删除结论正文路径专有的 `bringBackMaxCodepoints`。
- `appendExplorerConclusionToDraft` 仅被自身测试引用、没有产品调用点；连同结论长度常量和三个测试用例移除，避免维护两种互相矛盾的产品语义。现有 Explorer owner integration test 直接验证被选定的引用写回行为和失败顺序。
- 本次不增加独立静态 checker：manifest 与真实行为测试已经落在同一个批准语义上；若今后再增加跨端 `bringBack` 限制，应该随完整 contract owner 一起设计，而不是为单个字符串另建浅模块。

## 2026-10-11 hotspot re-audit after slice 97

- Fresh line counts after current changes: `pi_mcp_runtime.rs` 1,287; `config_subagents.rs` 1,212; `config_marketplace_native.rs` 1,234; `pi_worker_runtime.rs` 1,451; `pi_tool_gateway.rs` 1,531. Treat these as navigation leads, not refactor justification.
- `config_marketplace_native.rs` now imports distinct catalog/filesystem/plugin-source/registry/transport owners; its remaining methods center on Host command authorization and install/update/uninstall transaction orchestration. No additional seam chosen from size alone.
- `pi_mcp_runtime.rs` now centers on shared connection/session orchestration over the extracted config, stdio, remote transport and shared archive owners; helper/function index alone does not show a second independent state owner.
- `config_subagents.rs` still produces both Pi policy manifest and Settings inventory, but both paths share native-agent path discovery and Markdown parsing; the inventory deliberately avoids Pi-manifest construction and role/persona I/O. Its duplicated plugin-agent file scan has now been consolidated by slice 98: both projections consume one bounded streaming visitor and preserve their deliberate naming differences. Keep the overall config owner intact; no deeper standalone module boundary was justified by this seam.
- The declarative Markdown parser itself already lives in `config_subagent_markdown.rs`, but two sizable tests (`parses_safe_markdown_agent_definitions_and_rejects_dynamic_fields`, `tolerates_real_world_frontmatter_and_maps_tool_lists`) remain in the parent test module and directly call only parser-owned behavior. Move those direct tests next to the parser implementation; keep scope/manifest/inventory and plugin-name precedence tests in `config_subagents.rs` because they exercise parent integration.
- Slice 99 completed that test-ownership cleanup: the two direct frontmatter/parser/capability-ceiling tests now live in `config_subagent_markdown.rs::tests`; the integration tests stayed in the parent. The plugin `visit_plugin_agent_definitions` helper remains a private streaming interface inside `config_subagents.rs`, not a separate module.

## 2026-10-11: subagent record test ownership follow-up

- `validates durable subagent records before reopening a transcript` imported only the path, parse, load and save APIs from `subagent-records.ts`; it did not instantiate `PiSessionAdapter` or verify transcript reopening. Keeping it in the adapter suite obscured which module owns the durable sidecar contract.
- Moved the existing test unchanged to `subagent-records.test.mjs`, registered it in both the package worker suite and root unit suite, and retained actual adapter recovery/lifecycle tests in `session-adapter.test.mjs`. No new test seam or behavior claim was introduced.
- Verification: owner test 1/1, worker suite 164/164, full unit suite 427/427, `pnpm check` (86 compatibility/permission fixtures), lint, Prettier and diff whitespace checks passed. Runtime source is unchanged.

## 2026-10-11: ToolGateway direct-test ownership audit

- `tool-gateway.test.mjs` still grouped five tests that only called owner APIs: bounded/legacy task-result projection, permission identity projection, permission response-envelope interpretation, subagent capability intersection/tool allowlisting, and plan/ask monitor classification. They did not instantiate or exercise `PiToolGateway`.
- Moved the existing contract tests unchanged into `task-results.test.mjs`, `tool-permission.test.mjs`, and `tool-access-policy.test.mjs`. Kept Gateway re-export characterization and `createTools`/request/dispatch/integration tests in the aggregator suite; this preserves the tests that actually prove its composition responsibilities.
- Registered the three owner suites in both worker and root test manifests. Targeted owner+gateway tests 32/32, worker 164/164, full unit 427/427, `pnpm check` with 86 compatibility/permission fixtures, lint and formatting passed. No runtime/security implementation changed.

## 2026-10-11: MCP runtime test ownership follow-up

- The `pi_mcp_runtime.rs` test module contains direct tests for `mcp_config.rs` parsing and `remote_transport.rs` response policy/connection behavior, alongside genuine runtime integration tests.
- Source-level call tracing showed the local stdio and remote HTTP/SSE list/call cases instantiate `McpConnection`/`RemoteMcpConnection` directly rather than `PiMcpRuntime`; they are transport-owner tests too. The cancellation-through-connection cases also test those transport owners.
- Moved 2 config parser tests, 2 stdio connection tests, and 8 remote HTTP/SSE policy/connection tests into their implementation owners. Existing test bodies/assertions are retained; no product runtime code or Host security policy changed.
- The parent retains the shared MCP result-text projection, MCP output archive, and workspace-stop cancellation test; only the last exercises `PiMcpRuntime` lifecycle state. The remote request reader now sits with remote transport tests.
- Validation: all 16 MCP module/runtime tests, full Rust lib 340/340, warning-free Cargo check, Rust fmt, `pnpm check` (86 fixtures), lint, format check and `git diff --check` passed.

## 2026-10-11: Marketplace direct-test ownership follow-up

- The native marketplace test module still contained five tests whose call graphs ended at already extracted owners: catalog relative-path validation/scan, registry load/provenance/path containment, and transport Git-SHA validation.
- Moved those existing tests into `config_marketplace_catalog.rs`, `config_marketplace_registry.rs`, and `config_marketplace_transport.rs`; their assertions stayed unchanged. The catalog path test now uses the owner-local `super::validate_relative_path` path.
- Kept install/update registry compatibility, marketplace candidate install/refresh, and update-message behavior in `config_marketplace_native.rs` because those exercise native orchestration/projection rather than a single child owner.
- Validation: marketplace-filtered Rust tests 22/22, full Rust lib 340/340, warning-free Cargo check, Rust fmt, `pnpm check` (86 fixtures), lint, format check and `git diff --check` passed. One initial owner-module compile error was corrected before the successful runs.

## 2026-10-11: PiSessionAdapter residual pure-contract audit

- The current beta worktree still has `packages/agent-worker/src/pi/session-adapter.ts` at 3,459 lines after prior extractions. Its top-level exported contract helpers include turn-config snapshot validation, active-run/cancel identity guards, attachment model-support/bounds/decoding, native session path projection, and fork-target matching; the runtime class remains the lifecycle coordinator.
- Existing `session-adapter.test.mjs` already tests these helpers through `session-adapter.ts` exports. For this slice, the user approved keeping the adapter exports as the test interface rather than adding owner-local tests at a new seam.
- Call tracing found attachment policy/decoding has a focused owner: model modality checks, single/batch byte ceilings, and bounded data-URL decoding are consumed by the adapter's turn submission path and do not depend on session lifecycle state. The implementation moved to `attachment-policy.ts`; turn ordering, total-byte accumulation, idempotency and prompt composition remain in `PiSessionAdapter`.
- Existing tests continue to import the adapter's compatible exports. Adapter tests 27/27, worker tests 164/164, full unit tests 427/427, `pnpm check` including 86 compatibility/permission fixtures, lint, format check and production build pass; build retains existing >500 kB chunk warnings. No test or runtime behavior assertion changed.
- Fresh environment check: branch `beta`; `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` are all `0.4.0-beta.2`; the long-running worktree remains intentionally uncommitted.
- Follow-up call tracing: `normalizeThinkingLevel` and `normalizeSessionModeId` are shared by configuration/open/refresh paths, while turn snapshot validation and active-run/cancel guards are exercised at submit/steer/cancel entry points. Moved them into pure `turn-policy.ts`; existing adapter exports still drive the same tests and callers.
- Turn-policy verification: adapter 27/27, worker 164/164, full unit 427/427, `pnpm check` (86 fixtures), lint, format check, build, and diff check pass. Existing error codes/messages/scopes and sequencing assertions remain unchanged; no Host/security policy was touched.

## 2026-10-11: Pi extension policy/resource test ownership follow-up

- `config_extensions.rs` still hosts three tests that only call already-extracted policy/resource owners: sandbox profile precedence (`resolve_sandbox_profile`), native Skill ignore projection/scanning (`pi_skill_ignore_paths` + `scan_pi_skill_root`), and plugin Skill scan-root ignore projection (`pi_skill_scan_roots`).
- These can move unchanged into `config_pi_policy.rs` and `config_pi_resources.rs`; the owner modules have no test modules yet. Keep PluginEnablement, configured-plugin inventory, declarative plugin surface, and opt-out extension tests in `config_extensions.rs` because they exercise its orchestration/state.
- Moved the sandbox-profile precedence test to `config_pi_policy.rs` and two native Skill ignore/scan-root tests to `config_pi_resources.rs`; existing assertions remain unchanged.
- Removed the now-unused `resolve_sandbox_profile` test import and two parent test-only re-exports. Preserved PluginEnablement, plugin inventory/precedence, declared-plugin and extension opt-out tests in `config_extensions.rs` because those cross the parent orchestration boundary.
- Validation: config-extension-filtered tests 11/11, full Rust lib 340/340, warning-free Cargo check, Rust fmt, `pnpm check` (86 fixtures), lint, format check and `git diff --check` passed. One missing owner-local fixture helper and stale test-only re-exports were corrected before success.

## 2026-10-11: Pi native session persistence policy owner

- `piSessionFileFor` hashes the workspace cwd and product session ID into a stable opaque JSONL filename; `piForkTargetMatches` checks the persisted fork parent path, leaf anchor, and anchor entry before retry recovery.
- The two rules belong together because they prevent product session identity from being inferred or misapplied when native JSONL artifacts are opened. `PiSessionAdapter` remains responsible for session-root selection, operation ordering, and mapping an unsuccessful match to the existing `pi.fork_target_mismatch` `AgentError`.
- The existing session adapter tests are the agreed behavior seam and remain unchanged; they cover workspace-specific deterministic paths, opacity, accepted matching artifacts, and rejection for source-path or anchor drift.
- The new owner adds no file or process I/O and does not alter authorization, root selection, fork creation, recovery ordering, or Pi-only runtime. Host error construction remains at the adapter call site.

## 2026-10-11: Pre-extraction PiSessionAdapter task-lifecycle audit (superseded by slice 108)

- At this pre-extraction audit, `session-adapter.ts` was 3,459 lines. Its `TaskHandle` extended the general Pi session context, and the adapter owned both root-session and child-task maps.
- Task-specific logic spans task projection, durable record load/save, hierarchy visibility, wait/cancel/continue, Host background-task control and `spawnSubagent` across roughly lines 1,904–2,848. Root open/close/refresh/event paths directly inspect the same task map; child and root sessions share model/resource callbacks and event identities.
- Existing visible integration coverage includes root shutdown reaping orphan child tasks and background task wait/cancel ownership. Any meaningful deepening must account for the shared session context and Host task dispatch rather than extracting only the isolated `spawnSubagent` method.
- The user selected the existing `PiSessionAdapter` command/event interface as the behavior seam. `session-adapter.test.mjs` currently bypasses that seam for the task cases: it writes `adapter.sessions`/`adapter.tasks` directly and calls private `waitTasksForSession` / `cancelTaskForSession`. Any replacement tests for the lifecycle owner should instead drive `PiSessionAdapter` commands and observe emitted events; do not introduce an owner-local test seam or retain implementation-detail assertions merely for convenience.
- At that point, the candidate was a substantive child-session/task lifecycle owner with a deliberately small call surface from `PiSessionAdapter`. The public-command fixture and owner extraction were subsequently completed as recorded below; the extraction was not limited to the isolated `spawnSubagent` method.

## 2026-10-11: Pi subagent lifecycle public-command characterization

- Reused the real worker command/event protocol with an in-process OpenAI-compatible stub provider, so a test can create a Pi session, have the model call `run_background_task`, and send `task.cancel` without accessing `PiSessionAdapter` maps or private methods.
- The first characterization run failed before `subagent.changed`: Pi rejected the child session during SDK setup with “Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character”. The worker's logical `childSessionId` includes `:session` and had been passed as Pi's native SessionManager `id`.
- The lifecycle refactor must separate the worker-visible child stream/session identity from the Pi-native session ID, which should be an opaque valid UUID. Preserve worker event/session/task identity and parent-child ownership while fixing the Pi SDK input. This is an in-scope behavior repair established by the public-boundary test, not an authorization change.
- Completed the public-boundary characterization and lifecycle extraction. Child task identity remains the worker-visible logical ID, while Pi-native SessionManager instances receive independent random UUIDs to satisfy the SDK's identifier contract.
- Child registry/hierarchy, record persistence and resume, wait/cancel/continue, child event state, model/resource refresh, root cancellation, shutdown cleanup, and spawn lifecycle now belong to PiSubagentRuntime. PiSessionAdapter remains the root-session and worker protocol coordinator; shared ToolGateway and Host policy authority stay at the adapter/Host boundary.
- Removed the two tests that reached into private task maps/methods. Public worker command/event coverage now verifies wrong-root cancellation rejection, authorized cancellation, task.wait terminal state, and shutdown cleanup while a child is active; no runtime-private test seam was added.
- Verification: worker package 163/163, full unit suite 427/427, pnpm check, lint, format check, build, architecture/Pi compatibility/packaging checks, and git diff --check passed. The build retains existing >500 kB chunk warnings. Rust source was unchanged and Rust lib tests were not rerun for this slice.

## 2026-10-11: Host Pi session-command preflight owner (slice 109)

- `pi_worker_runtime.rs` previously mixed process supervision with renderer command field parsing, workspace registry authorization, active worker affinity, SQLite Pi-session/open/import validation, and durable fork intent. These checks vary with product session and migration policy, while worker process generation/dispatch and Tauri cross-runtime cleanup have distinct lifecycle owners.
- Added `src-tauri/src/pi_worker_runtime/session_commands.rs` as the Host preflight owner. It parses and authorizes renderer-owned paths, checks registered/canonical workspace and active worker affinity, validates Pi engine/session/open/import journal records, and persists fork intent before forwarding. `PiWorkerRuntime` supplies the narrow generation-to-workspace interface; its real implementation delegates to the existing runtime check. Tauri retains MCP/monitor cancellation, memory injection, and pipe forwarding.
- The move preserves check ordering and security authority: envelope/nested session identity is checked before workspace lookup; path registration precedes active worker lookup; import journal validation remains Host-owned; fork lineage is durably recorded before the existing second generation and source-binding checks. No renderer-side authorization or worker-side substitute was introduced.
- Four owner-interface tests cover session identity and Pi/workspace binding, session.open registered path/product identity/ACP refusal, import journal identity, and fork preflight ordering/side effects. The `check-pi-compatibility.mjs` gate now validates these owner invariants, wiring, and the real runtime adapter instead of requiring the command list to stay in the supervisor.
- Verification: session-command tests 4/4; full Rust lib tests 344/344; `cargo check --all-targets`; Rust format check; `pnpm check` including 86 compatibility/permission fixtures; lint, format check, architecture gate, and Pi compatibility gate all passed. The final `git diff --check` is being rerun after the documentation update. No UI runtime changed.
- Two transient fixture/compile errors were corrected before verification: use registry-canonical path in the worker workspace fixture, and qualify Rust's `std::result::Result` where the local alias shadowed it.

## 2026-10-11: Host Pi model-policy projection owner (slice 110)

- `pi_model_config.rs` combined two related but distinct responsibilities: building the generated provider/model catalog with credential references and resolving a versioned per-model request-policy snapshot consumed by Pi's `SettingsManager`. The latter has an independent Host/worker/manifest contract: retry ceiling, idle-timeout representation, and model/session/default auto-compaction precedence.
- Moved only the pure Host policy projection and its policy type into `src-tauri/src/pi_model_config/model_policy.rs`. The module accepts already scoped TOML tables and an alias, returns the validated policy, and performs no I/O. The parent remains the composer and owner of remote/local model merging, provider/credential projection, output-file layout, and persistence.
- The projection always supplied the default 85% compaction threshold, so its `Option<PiModelPolicy>` return and per-model `if let Some` branch were unreachable as a meaningful absent case. It now returns a required policy and inserts it directly; the serialized fields, schema version, casing, precedence, error text, file-write order, and Host-owned secrets behavior are unchanged.
- Added three owner-interface tests for model/global/session/default precedence, retry and timeout limits, and integer 0–100 threshold validation. Kept parent integration tests for merge precedence, JSON snapshot serialization, and rejecting invalid retry configuration before either output file is written.
- Updated the fixture-testable Host/worker compatibility owner to read the new Host policy source separately and require the parent composer to invoke it. README and handoff now distinguish policy projection from model catalog/credential/file orchestration and document all three snapshot fields.
- Verification: policy-owner tests 3/3, model-config tests 17/17, Rust lib 347/347, warning-free `cargo check --all-targets`, Rust fmt, `pnpm check` (86 fixtures), full unit 427/427, lint, format check, architecture gate, model-policy compatibility fixtures 8/8, and real Pi compatibility gate passed. No UI/runtime code changed.

## 2026-10-11: macOS Seatbelt command adapter (slice 111)

- The earlier sandbox audit rejected extracting only `seatbelt_profile`: that would move a shallow string formatter while leaving the executor check and wrapper construction in the shared Host module. This slice instead moves the complete macOS command adapter—executor availability, SBPL path/rule projection, and `/usr/bin/sandbox-exec -p <profile>` command construction—behind one private `command(&SandboxProfile) -> Result<SandboxCommand, String>` interface.
- `sandbox_decision` remains the only Host profile/platform selection and fail-closed authority. It maps adapter errors to the existing `PlatformBroken` decision; shared profile resolution/overlap checks and `sandboxed_shell_command` authorization/execution paths remain unchanged. Linux Landlock stays a separate real platform adapter and the macOS module is `cfg(target_os = "macos")`.
- Seatbelt owner tests cross the same command interface the production caller uses and verify executor path/argv, writable vs read-only projection, device write sinks, exact deny output/order, and escaping of quotes/backslashes. Host integration tests remain in `workspace_sandbox.rs` for common decision, terminal/monitor sharing, and profile/fail-closed behavior.
- The inline Pi compatibility gate now follows the parent `seatbelt::command` wiring and reads the actual `seatbelt.rs` owner for executor, availability, and profile projection markers. The handoff code map names both platform owners without attributing shared security policy to either.
- Verified on the current macOS host: Seatbelt owner tests 2/2, Host sandbox tests 9/9, full Rust library 348/348, all-targets locked Cargo check, Rust formatting, `pnpm check` (87 compatibility/permission fixtures), full unit 427/427, lint, Prettier format check, architecture gate 3/3, real Pi compatibility gate, and `git diff --check` passed. This remains source/command-shape verification only: nested `sandbox-exec` remains blocked by the outer environment, and Linux Landlock runtime verification requires a Linux runner.

## 2026-10-11: Pi web projection test ownership (slice 112)

- `pi_web_runtime/projection.rs` already owned bounded text, HTML/entity conversion, and search citation output, but `pi_web_runtime.rs::tests` still contained two tests that only called `projection::html_to_text` and `projection::format_search_output`. These are now owner-local tests; runtime tests continue to own web search key, fetch URL/domain, and Host runtime policy behavior.
- Added two interface tests for the existing `bounded_text` semantics: text at the byte limit is unchanged; overflow truncates the body at a valid UTF-8 boundary and appends the existing marker. This characterizes current output without changing the meaning of the configured body limit.
- Projection tests now run as `pi_web_runtime::projection::tests` (4/4), while parent runtime tests are 3/3. Full Rust/JS and static gate results are recorded in progress.md. No HTTP, credentials, SSRF/redirect, Host authorization, or Pi routing behavior changed.

## 2026-10-11: Pi compaction compatibility contract owner (slice 113)

- `check-pi-compatibility.mjs` still owned the worker compaction contract inline: manifest entry-point attachment, both compaction passes, task-digest source-owner linkage, and the digest-only failure fallback. These rules form one worker/manifest contract but were not independently fixture-testable.
- Extracted the checks into `scripts/pi-compaction-compatibility.mjs` with a small `(contract, sourceSnapshot) -> diagnostics` interface. The aggregate checker continues to own filesystem reads, missing-source diagnostics, and final reporting; worker extension/runtime and Host authorization behavior are untouched.
- Six owner fixtures cover aligned wiring, entry-point drift, either missing pass, each digest source owner, fallback removal, and absence of a declared contract. The manifest entry point now drives the checked hook marker; its existing `session_before_compact` value and diagnostic remain unchanged.
- `pnpm check` now runs the formatter, fixtures, and real Pi compatibility checker through the existing gate. Full verification results are recorded in `progress.md`.

## 2026-10-11: Pi-only renderer route ownership audit (slice 114)

- The renderer duplicated one runtime fact across `AgentClientEngine`, a per-session engine override Map, persisted `agentEngine`, Hook subscription selection, session identity, workspace stop logic, and Pi Explorer gating. A stale `legacy-acp` value could disagree with the Pi-only Desktop invariant.
- Runtime context is now the only route selector: Tauri Desktop → Pi; non-Tauri browser preview → deterministic ACP fixture. `beginAgentSession` uses the product session ID for Pi and the supplied ACP session ID for preview. The persisted setting remains only for old-settings compatibility/normalization and no longer selects runtime or Pi Explorer behavior.
- The archive check still precedes runtime hookup; legacy sessions remain read-only through `beginArchivedSession`. ACP→Pi import continues through the existing Host binding, migration journal, `shouldImportPiSession`, and import-plan path. No Host permission, worker command policy, or wire contract changed.
- User-confirmed seams are the real `agentClientForRuntime()` and `beginAgentSession()` entry points. New Vite SSR tests exercise those actual modules with a `legacy-acp` setting in Desktop and verify product/preview session identities.
- Slice 114 is complete; the repository-wide structural-debt goal remains in phase 3.

## 2026-10-11: Renderer runtime state versus legacy ACP persistence (slice 115)

- After renderer routing became Pi-only, `AgentStore` still named its active runtime key, lifecycle phase, and normalized event checkpoint `acpSessionId`, `acpPhase`, and `acpCursor`. Those names were misleading because `SessionRecord.acpSessionId/acpCursor` are retained legacy archive/import storage fields, not the identity/cursor of every active runtime.
- Rename only ephemeral store/projection state to `runtimeSessionId`, `runtimePhase`, and `eventCursor`; keep source/import/storage/wire ACP names unchanged. `beginAgentSession` now names its persisted inputs `sourceAcpSessionId/sourceAcpCursor`, and the persistence adapter maps `eventCursor` back to the legacy stored `acpCursor` at the write boundary.
- The active Pi open path continues to send the product session ID; browser preview continues to use the fixture's source ACP ID. No persisted database schema or archive JSON shape changes.
- The existing approved `beginAgentSession()` integration seam now observes the actual `send_pi_agent_command` `session.open` envelope and asserts envelope/session/product IDs all equal the product session ID on Desktop. Projection patch behavior remains covered at its existing owner interface.

## 2026-10-11: Pi provider error projection owner (slice 116, complete)

- `session-adapter.ts` previously embedded provider-message bounds/redaction, rate-limit classification, and the `AgentError` shape inside event handling. These rules are a pure untrusted-input projection; run state, recovery behavior, and terminal event ordering remain lifecycle responsibilities.
- Moved the existing sanitizer and classifier to `packages/agent-worker/src/pi/session-errors.ts`. Error code, Chinese product message, retriable flag, run scope, bounded provider/API/model identity, and credential redaction are unchanged. The adapter still calls the owner only from the existing provider-failure event path and retains the `run.finished` projection.
- Replaced two tests that reached into private adapter session maps and `onPiEvent` with one public worker command/event protocol integration test. A local OpenAI-compatible provider verifies an observable assistant `stopReason=error` followed by a successful assistant response and error-free terminal event after 503, while repeated 400 responses produce `pi.provider_rate_limited` / `rate_limit` and redact Bearer/API-key samples.
- Verification: worker suite 163/163, full unit 430/430, `pnpm check` (93 compatibility/permission fixtures + source gate), architecture gate 3/3, lint, format check, production build, and `git diff --check` passed. An initial concurrent worker/unit batch returned nonzero; the captured unit failure was an unrelated timing assertion (23 ms observed versus 25 ms expected), and serial reruns passed without changing that test. Build emitted the existing >500 KiB chunk warnings. No Host permission or wire-protocol behavior changed.

## 2026-10-11: MCP inventory cross-layer compatibility owner (slice 117, complete)

- `pi-compatibility-manifest.json` declares the Host-owned MCP inventory command, owner, and `Host` validation authority. The aggregate Pi compatibility checker currently contains the cross-layer assertions inline: MCP config owner wiring, authorized Tauri command/registration/permission, renderer bridge and preflight use, and capability reporting that consumes Host-validated support rather than parsing MCP entries again.
- The existing `pi-mcp-transports-compatibility.mjs` owner covers canonical stdio/HTTP/SSE parsing and transport wiring; it does not cover the inventory command or its renderer/Host authority chain. `pnpm check:pi-compatibility` currently passes 93 fixture/permission tests and the real source checker, but no owner fixture independently exercises inventory drift; the aggregate source check is the only current coverage for that inline contract.
- A cohesive candidate is a pure `checkPiMcpInventoryCompatibility({ inventory, sources }) -> diagnostics` owner. The aggregate checker would retain filesystem reads and final diagnostics, supplying source snapshots. The owner must not change MCP runtime behavior, Tauri authorization, or Host validation authority; fixture coverage would be limited to the declared cross-layer contract.
- User confirmed this seam in the current turn: implement the pure owner interface `checkPiMcpInventoryCompatibility({ inventory, sources })` and fixture-test the declared Host/Tauri/renderer/capability chain. Before this confirmation, no owner tests or source extraction had been made.
- Current source evidence: manifest declares command `list_melody_mcp_servers`, owner `pi_mcp_runtime::inspect_mcp_config`, authority `Host`; `config_runtime` authorizes `cwd` before calling that owner, `lib.rs` registers the command, and `permissions/default.toml` grants it. `melody-bridge-config.ts` invokes the command, `pi-compatibility.ts` obtains its snapshot for preflight, and `capability-report.ts` consumes `McpServerSnapshot[]` and filters `!server.supported` without its own MCP parser.
- The aggregate checker previously contained the complete cross-layer marker set inline near its MCP section. It now reuses existing `configRuntime`, `mcpRuntime`, and `mcpConfig` snapshots, reads the Tauri registry/permission, renderer bridge/preflight and capability report, and delegates predicates to the owner; filesystem reads and top-level diagnostic aggregation remain in the caller.
- The pure owner validates command/owner identifiers, detects missing/malformed inventory contracts, and checks the Host-authority/no-duplicate-parser chain. Six fixture tests pass; no runtime source changed. A stronger counterexample keeps `registry.authorize` and the inventory owner call in an unrelated function; the initial whole-file check falsely passed, so the owner now isolates the declared Tauri command body and verifies authorization precedes delegation. The strengthened fixtures pass. The earlier aggregate gate passed 99/99 before this last checker refinement and must be rerun.
- The strengthened aggregate gate and `pnpm check` pass. Full unit first run produced one unrelated existing rate-limit timing failure (24 ms observed vs 25 ms expected, `research-source-adapter.test.mjs`); all other 429 unit tests passed. The isolated research-source test passed 6/6, then serial full `pnpm test:unit` passed 430/430. No unrelated timing test was modified.

- Completion verification after the final checker refinement: aggregate `pnpm check` passes with 99 compatibility/permission fixtures and the real source gate; serial `pnpm test:unit` passes 430/430; all Rust library tests pass 350/350, `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` is warning-free, marketplace-focused tests pass 26/26, `pnpm lint`, `pnpm format:check`, `pnpm check:architecture` (3/3), `cargo fmt --all --check`, and `pnpm build` pass. Build retains existing >500 KiB chunk warnings. No MCP runtime source or Host authorization behavior changed.

## 2026-10-11: Pi model configuration responsibility audit

- Reopened `pi_model_config.rs` after slice 110: its single preparation path still reads/merges user and project TOML, resolves the remote catalog, normalizes provider/model fields, projects policy, emits Pi `models.json`, and writes credential references to `auth.json` through `CredentialWriter`.
- The file already delegates model-policy validation to `pi_model_config/model_policy.rs` and remote catalog acquisition/parsing/cache to `pi_remote_model_catalog.rs`; those are not candidate work to repeat. `PiWorkerRuntime` is the only production caller of `prepare_pi_models_with_remote`, while worker launch consumes its `PreparedPiModels` result.
- A possible provider-credential projection owner would need to centralize secret/reference policy without moving Host authority or broadening key persistence. Source outline alone is insufficient to establish a deep seam: inspect the complete projection/auth implementation, current integration tests, and compatibility checks before selecting or asking to test it. No seam selected and no tests/source edits made.

## 2026-10-11: Pi model projection owner selected (slice 118)

- Full call tracing confirms `project_projection_with_remote` is a cohesive pure transformation: scoped TOML merge + remote model overlay + provider/model schema normalization + model policy projection + generated credential-reference bindings. File/config I/O and remote catalog fetch/cache are already distinct owners and stay outside.
- Extract that pure transformation and its normalization helpers to `pi_model_config/model_projection.rs`; the parent keeps the same production preparation path and `PreparedPiModels` result. Preserve existing test imports through the current parent module without adding or changing a test seam.
- Compatibility checker references to the provider identity, retry-policy projection and parent orchestration must be reviewed and updated to validate actual owner wiring, not frozen implementation location. Preserve stable provider IDs, merge precedence, error text, JSON fields, retry limit, generated file names and secret handling.
- This is a structural move, not a behavior proposal. Slice 118 was initially deferred while the user-confirmed MCP inventory owner was completed; it has now been resumed and implemented. Parent orchestration and `PreparedPiModels` remain stable, while `model_projection.rs` owns the pure transformation and credential-reference generation. The focused `pi_model_config::tests` suite passed 17/17 after extraction, full Rust lib passed 350/350, `cargo check --lib`, `pnpm check`/real Pi compatibility gate, lint, formatting and Rust fmt checks passed. No full JS unit/build rerun was needed for this Rust-only slice.

## 2026-10-11: Browser tab-index test ownership (slice 119, complete)

- `BrowserTabIndex` is implemented in `pi_browser_runtime/session_lifecycle.rs`, but its two direct behavior tests (`browser_tabs_are_bounded_and_closing_active_tab_selects_a_neighbor` and `browser_tab_selection_rejects_unknown_ids_without_changing_active_tab`) are still inside the parent `pi_browser_runtime.rs` test module, which imports the child type only under `cfg(test)`.
- Moved both existing assertions verbatim into the lifecycle owner test module next to its `BrowserSessionLifecycle`/`BrowserTabAdapter` ordering tests. No coverage, behavior, interface, or seam changed; parent WebView/security tests remain in place. Browser-scoped Rust tests pass 15/15 after the move, and the full Rust library suite passes 350/350.

## 2026-10-11: Browser WebView creation owner (slice 120, complete)

- The parent `pi_browser_runtime.rs` still owns cross-platform WebView construction, session-specific profile selection/directory identity, popup-window callbacks and navigation callbacks alongside command/session orchestration. These are a cohesive Tauri creation adapter, distinct from URL validation (`browser_policy.rs`), tab lifecycle (`session_lifecycle.rs`) and tool/request routing.
- Extract only platform-specific view/profile construction and its callback wiring to `pi_browser_runtime/view_creation.rs`; keep `TauriBrowserTabAdapter`/`BrowserEntry` composition and state ordering in the parent. The new owner will expose one creation function and hide platform branch details.
- Moved the existing profile-label and platform-isolation assertions verbatim into the new owner tests; no new tests or test seam. URL validation and popup destination rules remain in `browser_policy.rs`; the capability-file assertion remains with parent integration tests.
- Browser-scoped Rust tests pass 15/15, full Rust lib 350/350, `cargo check --all-targets`, and `pnpm check` (99 compatibility/permission fixtures plus the real source gate). Platform/session profile rules, navigation and popup checks, page-load notification, and hidden-child creation semantics remain unchanged.

## 2026-10-11: Pi worker direct test ownership (slice 121, complete)

- Five existing tests called only protocol framing/command validation, `.envrc` projection or worker launch environment allowlist behavior. Moved them unchanged into `pi_worker_runtime/protocol.rs`, `envrc.rs` and `launch.rs`; supervisor-level unscoped runtime event classification stays in the parent.
- The first `pnpm check` after relocation revealed that the goal-safety environment-variable predicate searched the supervisor source snapshot, where its only remaining occurrence was in the moved test. Updated the predicate to use the already-loaded `workerLaunch` source snapshot so the gate follows the implementation owner.
- The affected Rust runtime suite remains 22/22 and the full Rust library suite 350/350; `pnpm check` passes 99 compatibility/permission fixtures plus the real source gate. No runtime behavior, Host authority, protocol, or test assertions changed.

## 2026-10-11: Browser URL policy test ownership (slice 122, complete)

- Three existing parent tests called only `browser_policy.rs` URL trust, loopback preview, snapshot-origin and popup predicates. Moved them unchanged into that policy owner; Tauri remote-capability and bounds tests remain integration coverage in the parent.
- Compatibility source wiring now confirms `pi_browser_runtime.rs` declares both page-tools and screenshot owners, and that each uses `browser_url_is_allowed_for_snapshot` from `browser_policy.rs`. This corrects the prior parent test location assumption while retaining the policy-consumer guard.
- Browser-scoped tests remain 15/15; full Rust lib remains 350/350; the 99-fixture Pi compatibility/permission gate passes. No security decision, runtime path, capability, or assertion changed.

## 2026-10-11: Normalized message-stream projection owner (slice 123, complete)

- `event-to-session-update.ts` remains the normalized event reducer: it owns envelope/session validation, internal tool filtering, event dispatch, and state-result composition. Its message family has a cohesive per-message lifecycle: message/part offsets, streaming assistant-row identity, final-message reconciliation, and completion cleanup.
- The small capability/skill predicate was rejected as a standalone extraction because it would create a shallow module. The complete message-stream lifecycle moved to `src/domain/agent/message-projection.ts`; its result is a timeline projection plus message-state patch or duplicate diagnostic. The outer reducer interface remains the only test seam and continues to compose the common state shape.
- Existing `projectAgentEvent` interface tests were retained without new or modified assertions or a new test seam. The message owner does not handle Host I/O, authorization, Pi runtime dispatch, or durable event state; live and replay still use the same reducer.
- Focused reducer tests pass 24/24, full unit tests 430/430, and `pnpm check` passes with 99 compatibility/permission fixtures and the real Pi source gate. This is a pure TypeScript ownership refactor with no wire/storage contract or user-visible behavior change.
- The first `pnpm check` only reported the now-unused `AgentAssistantMetadata` import; removing it made the full check pass. Lint, architecture tests 3/3, build, Prettier checks, and `git diff --check` pass; the build retains existing large-chunk warnings. Still on `beta`, version trio `0.4.0-beta.2`, with no commit/push/publish/release/main sync; the broader debt goal remains in phase 3.

## 2026-10-11: Pi config policy test ownership (slice 124, complete)

- `config_runtime.rs::tests` still directly exercised six terminal/question-timeout/goal-safety projection cases owned by `config_pi_policy.rs`; those tests now live in the policy module's `direct_policy_tests`. The existing sandbox-profile precedence test was already owner-local and remains there.
- Composite config command, manifest assembly, marketplace, plugin, and extension behavior tests remain in `config_runtime.rs` because they exercise parent orchestration or multiple owners. This move did not alter assertions, runtime behavior, interfaces, Host authorization, or test seams.
- Baseline config-runtime suite was 27/27; post-move `config_` suite was 85/85 and the full Rust library suite 350/350. `cargo fmt --all --check` passed after `cargo fmt` corrected two line-wrap differences. Branch remains `beta`, all app-version fields remain `0.4.0-beta.2`, and nothing was committed or published.

## 2026-10-11: Pi configuration capability-policy owner (slice 125, complete)

- `capability-report.ts` mixed final diagnostic composition with a large set of config-shape predicates and Pi-specific configured-policy rules. The pure `inspectPiConfigCapabilityPolicies` owner now classifies those rules into a named snapshot; the report composer retains exact message text/order, public seam, Host runtime inventory aggregation, and final blocking/degradation derivation.
- The owner includes sandbox profile detection, bounded codebase-index patterns, external auth/OIDC, dynamic subagent definitions, terminal/question policy value validation, config-derived LSP presence, semantic memory degradation, and advanced goal orchestration. The existing capability-report suite remains the only test interface; no new seam/assertions or config schema/runtime changes.
- `capability-report.ts` is 483 lines (was 852). Targeted tests pass 42/42, full unit tests 430/430, `pnpm check` including 99 fixture/permission checks and real Pi source gate, lint, architecture gate 3/3, format check, build, and diff check pass. Vite reports the same existing >500 kB chunk warnings. Branch/version remain `beta` / `0.4.0-beta.2`; no commit/publish/release/main sync.

## 2026-10-11: Pi worker resource/policy snapshot owner (slice 126, complete)

- `session-adapter.ts` still mixed launch-time environment snapshot parsing and Host resource-manifest validation with root-session/lifecycle orchestration. Added `resource-policy-snapshot.ts` as the worker's inbound config boundary: it parses gitignore/question/goal/subagent launch snapshots and validates the Host cwd, trusted Skill/Prompt roots, and policy payloads. Root path discovery remains in `resource-discovery.ts`; model/subagent/goal policy normalization remains delegated to existing owners.
- The adapter still owns mutable session/child state, command ordering, applying Host refresh snapshots, and reloading live root/child sessions. Host snapshots remain authoritative; omitted optional policy clears stale state. Errors, codes/messages, validation order, and runtime behavior stayed unchanged.
- Compatibility source checks now follow the new owner for environment variables and question-timeout bounds while validating adapter wiring. Existing session adapter/resource discovery tests pass 29/29, question-timeout compatibility fixtures 5/5, worker suite 163/163, full unit 430/430, `pnpm check` (99 fixtures plus real source gate), lint, architecture 3/3, formatting, build, and diff checks pass. `session-adapter.ts` decreased from 1,928 to 1,753 lines. Branch/version remain `beta` / `0.4.0-beta.2`; no commit/publish/release/main sync.

## 2026-10-11: Post-slice-126 resource-loader audit (candidate rejected)

- The current worktree and planning files are authoritative through completed slice 126; earlier continuation notes lag behind. Current branch is `beta...origin/beta`, all three release version sources are `0.4.0-beta.2`, and `git diff --check` passed before this audit note.
- `PiSessionAdapter` (1,753 lines) is the sole implementation owner for bounded `DefaultResourceLoader` construction, first-party extensions, scoped instruction loader and allowlisted root/prompt paths. `PiSubagentRuntime` does not build a parallel loader; its private wrapper forwards every argument through the exact `createResourceLoader` factory injected by the parent, and both root and child sessions are composed through that one implementation.
- Rejected extracting a new loader owner: it would replace the existing single callback with another forwarding interface, increasing indirection without reducing duplicate knowledge or enabling a second adapter. Keep session-specific mutable policies and refresh ordering at the adapter, and retain the existing shared factory seam. This is a verified no-edit audit result, not a completed cleanup slice.
- A better next seam is owner-local verification for `resource-policy-snapshot.ts`: `parsePiRuntimePolicyEnvironment` and `normalizePiResourcePolicySnapshot` are pure exported entry points over an explicitly supplied environment snapshot, but no `resource-policy-snapshot.test.mjs` exists and the worker/package manifests do not list one. Existing adapter tests around startup and Host refresh should stay integration tests because they verify state application/clearing and reload timing; add direct tests at the owner interface rather than moving or duplicating those assertions.

## 2026-10-11: Resource policy snapshot test seam (slice 127, complete)

- The direct `resource-policy-snapshot.ts` interface accepts an explicit environment record, but its root normalization delegated to `normalizePiResourceRoots`, whose `pluginRootsFor`/`skillRootsFor`/`promptRootsFor` read `MELODY_HOME`, `HOME`, and `USERPROFILE` directly from `process.env`. This made the snapshot owner only partially controlled by its stated input and made root trust harder to test deterministically.
- `normalizePiResourceRoots` now accepts an optional environment record defaulting to `process.env`; its root-source helpers consume that same record, and `normalizePiResourcePolicySnapshot` forwards its explicit snapshot. Existing production callers retain prior behavior while Host refresh validation uses one consistent input.
- Added four owner-local tests for valid/malformed startup snapshots, custom `MELODY_HOME`/`HOME` root trust through the supplied environment, Host omission clearing optional policies rather than reading stale environment values, and Host cwd/policy rejection. The configured roots are intentionally nested below trusted roots so the fixture would fail if normalization fell back to the process environment.
- Worker suite 167/167 and full unit suite 434/434 pass; focused owner test 4/4 passes after finalizing the custom-root fixture. `pnpm check` passes with all 99 compatibility/permission fixtures and the real Pi source gate, architecture tests 3/3, lint, `pnpm format:check`, production build, and `git diff --check`. Build still shows the existing >500 kB chunk warnings.
- The compatibility source gate now requires policy root normalization to pass the explicit environment to both skill and prompt trust helpers. No Host/worker authority, allowed-root rules, runtime policy, resource ordering or default production environment changed.

## 2026-10-11: Post-slice-127 owner candidate audit (slice 128, in progress)

- The worktree remains the authoritative accumulated beta refactor. `pi_tool_gateway.rs` is 1,531 lines, but its production portion is roughly 370 lines: the gateway already composes request-policy, workspace-path/tool, terminal-task, monitor, scheduler, instruction-scope, and subagent-worktree owners. Most remaining size is integration tests. Splitting it by file size or moving tests alone would add little leverage, so it is rejected as the primary slice.
- `config_subagents.rs` remains a cohesive Host projection owner for scoped config and trusted source resolution into two intentionally different outputs: the worker policy manifest and Settings inventory. Markdown parsing, prompt-file access, and shared agent-file scan/provenance already have dedicated internal owners. A further split is not selected without evidence of duplicated semantics across those interfaces.
- No production or test source was changed during this candidate scan. Continue auditing the remaining runtime/bridge candidates for a complete behavior cluster with a small, meaningful interface; avoid adding a test-only private seam.
- A stronger renderer-side candidate is the unresolved-interaction cluster still embedded in `src/stores/agent-store.ts`: `resolvePlan`, `resolvePermission`, and `resolveQuestion` together perform pending-entry validation, root/background timeline lookup, optimistic update/rollback, persistent project permission-rule writes, and Host interaction-resolution commands. They depend on the existing `AgentStoreAccess` get/set seam and are exposed through the store's established public action interface. Existing tests do not appear to exercise these actions directly, so verify the current suite/test boundary before deciding whether to add focused public-store coverage.
- The neighboring actions already use owner modules (`agent-store-session.ts`, `agent-store-submit.ts`, and receive modules) with `AgentStoreAccess`; this suggests a cohesive interaction owner rather than a new framework or pass-through. Preserve the order of permission persistence, optimistic state changes, Host sends, and error rollback exactly if selected.
- Slice 128 selects `agent-store-interactions.ts` as the owner for the three existing user-resolution actions. The interface is the already-used production `AgentStoreAccess` (`get`/`set`) and existing `AgentStore` method signatures; the behavior tests will call the production owner functions through that seam. This is not a test-only private hook.
- Preserve these behavior invariants: plan status moves optimistically before the Host command and reverts to awaiting approval if sending fails; project permission rules persist before timeline mutation/Host resolution; permission resolution updates the correct root or background timeline and uses the root product-session identity for Pi child requests; question responses keep their `chat_about_this`/`skip_interview` wire mapping, resolve against the question/background session identity, and update the timeline only after successful Host resolution.
- Implemented `agent-store-interactions.ts` with the three production handlers. `agent-store.ts` now retains the original public `AgentStore` signatures and delegates through the same `{ get, set }` context already used by session/submit/receive owners. Added four direct owner tests through `AgentStoreAccess` covering normal plan settlement, failed-send rollback, background permission/root-session command routing, and question wire mapping plus post-ack state update. Focused test result is 4/4; full gates are pending.
- Final verification: `pnpm test:unit` 438/438 with no HMR-port warning; `pnpm check` and all 99 compatibility/permission fixtures pass; lint, architecture tests 3/3, `pnpm format:check`, production build, and `git diff --check` pass. Build retains the pre-existing >500 kB chunk warnings. Branch/version remain `beta...origin/beta` / `0.4.0-beta.2`; no commit, push, publish, release, or main sync.

## 2026-10-11: Post-slice-128 renderer configuration owner audit

- Current `agent-store.ts` still implements four user-facing session-configuration actions (`selectModel`, `selectReasoningEffort`, `selectSessionMode`, `selectPermissionMode`) inline. All four guard current/pending selection, update renderer state or send `session.configure` against `configRevision`, and contain error/reconciliation state transitions. Their callers are the chat workspace and Settings; `submitAgentPrompt` reads the same selected configuration snapshot.
- Neighboring production action owners receive the existing `AgentStoreAccess` (`get`/`set`) interface. This gives a real production seam for extracting configuration actions without introducing a test-only interface. Existing source test search found no direct tests for these four selectors; their ACP response acknowledgements live separately in `agent-store-receive-requests.ts`, and Pi config updates reconcile through `agent-store-pi.ts`.
- Before selecting scope, inspect both acknowledgement paths and existing store-test infrastructure. A move that only relocates handlers may be too shallow; prefer a bounded owner that makes model/reasoning/mode configuration request behavior easier to understand and verify while keeping Host revision authority and protocol IDs unchanged.
- The acknowledgement handlers are deliberately transport adapters: ACP response IDs route through `handleAgentRequestResponse`, while Pi normalized configuration/error events reconcile in the Pi event reducer. This slice will own the renderer-originated selection command decisions, not move those two protocol adapters or merge transport-specific response parsing into a shared module.
- Selected the configuration action cluster for slice 129. Preserve each existing preview/no-runtime/live-session branch, `configRevision`, stable ACP request IDs, live-session pending patches, model-derived `contextUsage`, optimistic permission-mode update/error rollback, and exact error/status behavior. Verify via the existing store's `AgentStoreAccess` production seam and the single Vite SSR test harness (which avoids a second concurrent SSR/WebSocket server).
- Implemented `agent-store-configuration.ts`; `agent-store.ts` retains all four public action signatures and delegates through the existing `{ get, set }` store access. No ACP/Pi response routing, Host revision authority, command wire shape, or runtime behavior changed. Three new tests exercise preview/no-runtime state changes, all four live revision-bound command envelopes/pending state, and action-specific command-failure recovery; the existing SSR file now passes 11/11.
- Full validation passes: `pnpm check` (including 99 compatibility/permission fixtures and the Pi source gate), `pnpm test:unit` (441/441), `pnpm lint`, `pnpm check:architecture` (3/3), `pnpm format:check`, and `pnpm build`. Build retains its known >500 kB chunk warnings. Final diff/branch/version audit is recorded in progress.md after completion.

## 2026-10-11: Post-slice-129 next-owner audit (slice 130 candidate scan)

- Revalidated current worktree: `beta...origin/beta`, HEAD `4eddef67`, 179 accumulated tracked/untracked status entries; previous config owner and all accrued changes remain present. `session-catchup.py` produced no recovery report.
- `subagent-runtime.ts` (1,284 lines) is a fresh candidate after prior resource, policy, record, and boundary owners: it currently owns live child Pi session creation/resume/run/cleanup, an in-memory task hierarchy/controller, and compatibility routing for Host background terminal tasks through the Host ToolGateway. The class has a single caller (`PiSessionAdapter`) and a task-controller callback consumed by ToolGateway; size alone is not evidence to split.
- Potential seam is uncertain: child-session lifecycle and Host terminal-task delegation are distinct concerns, but Host task handling may be only a small adapter over the existing Host authority and one gateway path. Do not create an indirection-only `host task service`; inspect the controller call contract, spawn method responsibility cluster, current behavior-test boundaries and existing injected adapters before selecting a slice.
- The task controller is already a narrow production interface (`wait` / `cancel` with parent session identity), and `PiSubagentRuntime` is the only production adapter; `session-adapter.ts` composes it into `PiToolGateway` and owns root session lifecycle. Existing coverage is strong at the real worker smoke level for child spawn/cancel/wait/shutdown, while direct class coverage is limited to the host-snapshot parser contract in the adapter suite.
- A more credible next seam than a host-task wrapper is the hidden Pi SDK acquisition inside `spawnSubagent`: all surrounding dependencies (model catalog, resource loader, gateway, emitter and policy snapshots) are already injected, but this one static loader prevents direct lifecycle-owner tests. A required `loadPiSdk` constructor dependency could use the existing production loader in `PiSessionAdapter` and a small Pi SDK adapter in owner tests; determine whether that fake is compact enough to meaningfully test the owner, not merely replicate the full SDK.
- Selected this as slice 130 because the external seam already owns actual lifecycle/test behavior (`PiSubagentRuntime` plus its `PiTaskController`); the missing SDK dependency is the blocker to exercising that seam without launching a worker process. Keep Host terminal process handling delegated through the existing `PiToolGateway`/Host authority rather than creating a second wrapper.
- Design the test adapter against only the SDK methods used by a deterministic child-session lifecycle (`SessionManager`, `SettingsManager`, `createAgentSession`, prompt/subscription/abort/dispose). If the fake becomes broad or assertion-driven by implementation details, stop and revisit the seam instead of building a shadow SDK. Preserve the existing worker-smoke end-to-end coverage.

## 2026-10-11: Pi subagent lifecycle owner SDK seam (slice 130, complete)

- `PiSubagentRuntime` now receives its Pi SDK loader as an explicit dependency; its sole production caller, `PiSessionAdapter`, passes the existing production `loadPiSdk`. Pi-only routing, Host ToolGateway authority, and task event contracts are unchanged.
- Added an owner test using the public runtime/task-controller seam and a compact SDK fake. It verifies child prompt startup, completed task snapshot/event, root-session ownership, and rejects cross-root access without inspecting private maps. Existing worker-smoke integration coverage for spawn/cancel/shutdown remains.
- Worker tests pass 168/168 and full unit tests pass 442/442. `pnpm check` passes including TypeScript and 99 compatibility/permission fixtures; lint, architecture tests 3/3, format check, Vite build, and `git diff --check` pass. Build retains the existing >500 kB chunk warnings.
- Final state remains `beta...origin/beta`; package/Cargo/Tauri versions are all `0.4.0-beta.2`. Accumulated unrelated beta edits were preserved; no commit, push, publish, release, or main sync.

## 2026-10-11: Post-slice-130 owner audit (slice 131 candidate)

- The authoritative tree remains on `beta` with the accumulated uncommitted structural refactor intact. The current non-test source scan still has multiple large core modules, so the remaining work cannot be treated as complete.
- `pi_codebase_runtime.rs` is 1,020 lines after its Tree-sitter parser owner was extracted. Its implementation combines the bounded per-workspace index/cache and refresh/query lifecycle with the untrusted worker request contract (operation aliases, required file/position fields, query bounds, workspace containment, and Host result/error envelopes).
- Selected for slice 131: move worker argument and workspace-path validation behind one `parse_request(root, arguments) -> Result<ValidatedRequest, String>` interface. Keep Host envelope extraction/tool allowlisting and result/error envelopes in the existing adapter; keep index/cache, project policy loading, and final runtime routing in their current owners. Preserve validation order and exact `pi.codebase_tool_failed` mapping.
- The request owner will hold the operation aliases, required file/position rules, path canonicalization/containment (including symlink resolution), bounded query/position parsing, and normalized request fields. Existing index refresh/query integration tests remain at the parent; owner tests exercise the validated-request interface and its security contract.
- `pi-codebase-index-compatibility.mjs` currently receives Host runtime and parser snapshots but no request-owner snapshot. Update the aggregate source reader and compatibility checker so bounds/path validation live at the new owner and the parent remains wired to it.
- The slice 130 progress entry had landed before slice 129 because an identical older section was used as the append marker; it is now ordered after slice 129, and the accidentally repeated stale slice-128 audit bullet was removed. No historical test result was removed.
- Implemented `pi_codebase_runtime/request.rs` as the request-contract owner: `parse_request` canonicalizes the Host-selected workspace and returns a validated operation/path/position/query projection. The parent still extracts/allowlists the worker tool, maps request errors to the existing Host envelope, loads config policy, refreshes/queries the index, and composes bounded output.
- The owner preserves operation→workspace→file→position→required-position→query→include-definition validation order, original error strings and `pi.codebase_tool_failed` mapping. File containment still canonicalizes symlink targets before checking the workspace prefix; root refresh reuses the same canonical-workspace helper instead of duplicating it.
- Request owner tests pass 4/4, including operation aliases, validation precedence, query/position bounds, absolute/outside paths and Unix symlink escape. The codebase source compatibility fixtures pass 8/8 after adding request-owner markers and parent wiring checks.
- Slice 131 gates pass: full Rust library tests 353/353, full TypeScript unit tests 442/442, `pnpm check` (100 compatibility/permission fixtures), lint, architecture 3/3, format check, Cargo check/fmt, and `git diff --check`. `task_plan.md`, `findings.md`, and `progress.md` formatting was rechecked after the final update.
- Final state remains `beta...origin/beta`; `package.json`, `Cargo.toml`, and `tauri.conf.json` agree on `0.4.0-beta.2`. No commit, push, publish, release, or main sync. Slice 131 is complete; repository-wide structural-debt work remains in progress.

## 2026-10-11: Codebase index/cache owner audit (slice 132)

- After the request-contract extraction, `pi_codebase_runtime.rs` still combines Host envelope dispatch and project indexing policy with the per-workspace index registry, bounded filesystem walk, fingerprint refresh/rebuild, and symbol/location query model. `parser.rs` and `request.rs` are already narrow owners, so the index/cache is the remaining distinct lifecycle boundary in this bridge.
- Selected slice 132 to move the cache, file scan/fingerprint state, refresh/rebuild, index status and symbol/location queries to `pi_codebase_runtime/index.rs`. Keep project policy precedence, request parsing, Host error/success envelopes, JSON response composition and Tauri dispatch in the parent.
- The seam must retain one Host-owned workspace registry, the 16-workspace eviction bound, no-follow/containment behavior, gitignore/ignored-directory rules, file/total byte caps, parse-on-change behavior, result ordering/truncation, and exact existing failure mapping. Parent request tests remain integration coverage; index lifecycle/query tests move to the owner.
- Implemented `pi_codebase_runtime/index.rs` as the sole per-workspace cache/index owner. Its `with_index` interface serializes refresh/rebuild/query under the same registry+workspace locks; parent still decides project policy, selects request operation, constructs response JSON and maps errors to the existing Host envelope.
- Moved file fingerprints, `CodebaseIndex`, workspace registry/idle eviction, bounded walking, status and symbol/location projection into the owner. The parent no longer owns index state or file-walk/query mechanics; one cache and the existing 16-workspace cap remain.
- Owner tests exercise changed-file refresh, definition/reference/document/workspace queries, 100-result truncation, the 2 MiB per-file skip, and Unix symlink non-following. The parent integration test still covers request/error envelopes and end-to-end codebase operations.
- The compatibility checker now snapshots `index.rs`, verifies parser/request/index wiring, and compares the workspace-cache cap against the manifest at its actual owner. Focused codebase tests pass 14/14, source fixtures 9/9, full Rust library tests 356/356 and full TypeScript unit tests 442/442. `pnpm check` passes with 101 compatibility/permission fixtures; lint, architecture 3/3, format, Cargo check/fmt and `git diff --check` pass.
- Final state remains `beta...origin/beta`; `package.json`, `Cargo.toml`, and `tauri.conf.json` agree on `0.4.0-beta.2`. No commit, push, publish, release or main sync. No UI or bundle configuration changed, so this Rust/source-checker slice did not require a Vite production build. Slice 132 is complete; repository-wide structural-debt work remains in progress.

## 2026-10-11: Post-slice-132 architecture and owner audit

- Revalidated the live tree: `beta...origin/beta`, HEAD `4eddef67` (`fix: make Windows beta worker packaging path-safe`), existing cumulative work preserved, and the planning session-catchup script returned no report.
- `scripts/check-architecture.mjs` parses TypeScript/JavaScript imports and enforces two constraints: `src/domain` may not import UI/store/React/Tauri layers, and Pi SDK imports must stay under `packages/agent-worker/src/pi/`. It does not construct a resolved internal module graph or report dependency cycles.
- The size scan still has large files, but size alone is not enough to justify splitting: `session-adapter.ts` (1,754 lines) is now an adapter/orchestrator with many owners already extracted; `pi_tool_gateway.rs` (1,531 lines including tests) has separate tool owners; `PiSubagentRuntime` (1,286), `pi_worker_runtime.rs` (1,195), and `config_subagents.rs` (1,128) need responsibility review before selection.
- Next audit: establish whether real production TypeScript module cycles exist using the current compiler/module resolution. Only add a cycle guard if it catches a concrete repository risk without test/barrel false positives; otherwise continue with a behavior-owned module seam.

## 2026-10-11: Agent contract runtime cycle and graph gate (slice 133)

- The compiler-resolved runtime graph had one SCC in `packages/agent-contract/src/index.ts` and `validation.ts`. `validation.ts` imported the runtime `AGENT_PROTOCOL_VERSION` value and three type-only contract shapes from the public barrel; the barrel re-exported the validator. A separate research workspace SCC was type-only and did not represent a runtime cycle.
- Moved the version constant to `protocol-version.ts`. `index.ts` keeps it in the public contract, while `validation.ts` imports the value directly from its owner and imports contract shapes via `import type`, removing the runtime barrel back-edge without changing the public export or wire version.
- `check-architecture.mjs` now resolves runtime imports with TypeScript using each source file's nearest tsconfig and builds the production graph under `src` and `packages`. It excludes test/spec files and declaration files; ignores `import type`, `export type`, and type-position `import()` edges; keeps side-effect, value re-export, CommonJS and dynamic `import()` edges; and reports strongly connected components (including self-cycles). Existing domain and worker ownership checks remain active.
- Owner tests cover type-only exclusion, value/dynamic/CommonJS edges, direct and three-node indirect cycles, dynamic-edge fixtures, self-cycles and acyclic components. Contract TypeScript check, 5/5 architecture tests and the resolved production graph pass; full project regressions also pass as recorded in `progress.md`.

## 2026-10-11: Pi resource discovery owners (slice 134)

- Current `packages/agent-worker/src/pi/resource-discovery.ts` has three distinct change reasons: Host-trusted root/path normalization (including plugin roots, explicit environment snapshots, symlink checks and ignore prefixes), recursive bounded Skill scanning, and flat Markdown command-template scanning. The latter two do not share traversal depth or filtering semantics: Skills are recursive, depth/byte-bounded and honor Host ignore prefixes; prompts are direct children only with disabled-name/byte bounds.
- Their trust boundary is intentionally shared: keep root construction, Host manifest normalization, canonicalization, symlink rejection and root membership in the common resource discovery/root owner. Split only the resource-specific scanners into `skill-discovery.ts` and `prompt-discovery.ts`; do not copy authorization/path rules or create a facade module.
- Existing `resource-discovery.test.mjs` exercises both production interfaces with Host root refresh, project/user/plugin roots, symlink rejection, nested Skill ignores and disabled names. Preserve it as direct owner-interface coverage while importing scanners from their respective owners.
- `check-pi-compatibility.mjs` and `pi-resource-compatibility.mjs` currently snapshot the combined source. Update them to read the shared root, Skill scanner and prompt scanner independently, and assert each bound/environment/security marker at the owner that implements it.
- Implemented `skill-discovery.ts` and `prompt-discovery.ts`. The shared `resource-discovery.ts` remains the authority for root construction, Host manifest parsing/normalization, canonicalization, symlink checks, and trusted-root membership. The session adapter now imports each scanner directly; there is no compatibility facade and no duplicated path policy.
- The compatibility gate now reads each source owner independently: Skill and prompt environment variables and byte/path bounds are checked against their scanners; root environment manifests, plugin discovery, `isWithinRoot`, and ignore policy stay checked at the shared root owner.
- The existing discovery tests now call the production Skill and prompt interfaces directly. Their 6 scanner tests plus 4 policy-snapshot tests pass, including nested Skill discovery/ignore, disabled names, project/user/plugin roots, symlink rejection, and Host refresh add/remove behavior. Full Pi compatibility fixtures pass 101/101.
- Full validation passes: worker type check, `pnpm check`, unit tests 442/442, lint, format, architecture tests 5/5 with no runtime cycles, production build, and `git diff --check`. Only existing >500 kB build chunk warnings remain; Host authority and Pi-only routes are unchanged.

### 第一百三十五切片：Pi goal state 与 extension seam（候选已确认）

- `packages/agent-worker/src/pi/goal-extension.ts` 当前约 837 行，存在可按职责辨认的纯数据 owner 与 Pi extension adapter：policy/objective normalization 与 durable state reconstruction、start/transition/summary 约在 150–423 和 559–588；纯 token/stall guard 逻辑位于 424–558；`createGoalExtension` 从 602 起负责 Pi 事件、命令和 tool 注册。
- 这些不是按行数猜测的拆分：`resource-policy-snapshot.ts` 只使用 `normalizeGoalPolicy`；`compaction-extension.ts` 使用 goal state entry、reconstruction 与 summary；`session-adapter.ts` 使用 `createGoalExtension` 和 tool 名。它们是不同调用者、不同变更理由。
- 现有 `goal-extension.test.mjs` 把纯状态转换、guard 计算、Pi 生命周期 integration tests 放在同一文件；guard functions 已是纯输入/结果 interface，可让 state 与 guard tests 分别直接通过生产 owner interface 测试，并保留 adapter event integration tests。
- slice 135 将 goal contract/持久化状态运算归 `goal-state.ts`，token/stall deterministic accounting 归 `goal-guards.ts`，Pi lifecycle/tool schema/registration 留在 `goal-extension.ts`。外部 runtime remains Pi-only；Host 仍提供 goal policy 并保留最终安全授权，worker 内部 guard 仅执行既有显式 token/stall policy，不扩展权限裁决。
- compatibility gate 目前把 `enforceGoalGuards` 与 `startGoalState` 都从 `goal-extension.ts` 读 marker；将同步为检查 `goal-guards.ts` 和 `goal-state.ts` 的真实 owner，并保留 `goal-extension.ts` 中 Pi registration 的 bridge 验证。
- 实施已将 Goal contract、持久化重建、policy/objective normalization、state transitions（含 pause/resume/clear）和 summary 移至 `goal-state.ts`；token usage parsing、safe counters 与 token/stall guard projection 移至 `goal-guards.ts`；`goal-extension.ts` 现在只拥有 Pi lifecycle、commands、tool schema/registration 和 turn event 接线。
- `resource-policy-snapshot.ts` 与 `compaction-extension.ts` 现在直接使用 `goal-state.ts`；`session-adapter.ts` 仍使用 Pi extension adapter。Pi compatibility 检查同步读取三个实际 owner，且 compaction digest fixture 现在明确追踪 `goal-state.ts`。
- 纯 state 与 guard 测试分离到 `goal-state.test.mjs`、`goal-guards.test.mjs` 并直测生产接口；`goal-extension.test.mjs` 保留 adapter integration，并新增 command lifecycle 接线覆盖。worker 和 root unit manifests 均登记了新 owner suites。
- 全量验证通过：goal/compaction/policy 定向 42/42、`pnpm check:pi-compatibility` 101/101、`pnpm check:architecture` 5/5 且 production runtime graph 无 cycles、最终 `pnpm test:unit` 446/446、`pnpm check`、lint、worker/touched-file formatting、production `pnpm build` 和 `git diff --check`。Build 仅报告既有 >500 kB chunk warnings。
- 行为边界复核：未改变 durable entry 字段、turn revision 捕获与 turn-end persist/notify/abort 顺序、token cumulative/fallback 规则、stall 判断、Host-projected policy 或 Pi-only runtime；Host security authority 仍留在 Host。
- 最终复核仍为 `beta...origin/beta`、HEAD `4eddef67`；`package.json`、`Cargo.toml`、`tauri.conf.json` 版本一致 `0.4.0-beta.2`。累计工作树变为 81 个 tracked modifications 与 112 个 untracked paths，包含此前用户工作和本切片文件，未清理；无 commit/push/publish/release/main sync。

## Slice 136：session adapter lifecycle test seam

- `session-adapter.test.mjs` 至少六处通过 `adapter.sessions.set(...)` 直接注入 root handle，另有 stale-steer 测试直接把 `handle.runFinished = true`；覆盖 Host resource refresh、活动 run defer、model credential refresh、steer/cancel race、cancel-before-replacement 与并发 cancel。它们绕过 `openInternal` 建立的真实 handle invariants。
- `PiSessionAdapter` 构造函数当前只接收 emitter，并在 `openInternal` 等路径直接调用模块级 `loadPiSdk()`；`PiSubagentRuntime` 已把 `loadPiSdk` 作为 option 注入。可增加相同窄 loader seam：生产继续使用静态 loader，测试复用真实 `SessionManager` / `DefaultResourceLoader` / `SettingsManager`，只替换外部 SDK 的 `createAgentSession` adapter。
- `PiModelCatalogRuntime` 默认 `allowModelNetwork` 由环境变量开启，默认 false；其 auth/models 路径可由 `MELODY_HOME` 收敛到测试临时目录。真实公开 `open()` 路径预计可离线建立 fake Pi session，不必访问 provider。
- 保留一个重要范围限制：Host credential synchronization integration test 仍 stub `adapter.modelCatalog.getModelRuntime`，因为它验证 model-catalog runtime 对外部 Pi ModelRuntime 的替换结果和 live-session settings refresh；没有为单个测试再扩大 `PiSessionAdapter` constructor interface。
- 使用 codebase-design 的 seam 原则：把已存在的外部 SDK variation 注入到 adapter，并让测试跨公开 lifecycle interface 验证可观察行为；避免新增测试专用 map setter。
- 实施结果：新增可选 `loadPiSdk` constructor dependency，PiSessionAdapter 与 PiSubagentRuntime 共用同一个 loader；生产不传选项时仍使用原本静态 bundle loader。测试通过真实 loader 中的 SessionManager、DefaultResourceLoader 和 SettingsManager 建立 session，只替换 `createAgentSession` 返回的外部 session adapter。
- 七组 lifecycle/configuration tests 已改为通过公开 `open/refreshResources/submit/steer/cancel/configure` 建立或竞争 live session；session adapter tests 中已无 `adapter.sessions` map 写入或 `handle.runFinished` 直接修改。Host credential synchronization test 仍使用独立 model-catalog collaborator stub。
- 验证通过：session-adapter 24/24；`pnpm test:agent-worker` 173/173；`pnpm test:unit` 447/447；Pi compatibility 101/101；architecture 5/5；worker typecheck、`pnpm check`、lint、format、production build 与 `git diff --check` 均通过。Build 仍只有既有 >500 kB chunk warnings。
- 复核 `beta...origin/beta`，`package.json`、Cargo 与 Tauri 三处仍是 `0.4.0-beta.2`；没有 commit、push、publish、release 或 main sync。Pi-only runtime 与 Host authorization authority 未改变。

## Slice 137 candidate audit: renderer workspace actions

- `AgentWorkspace` 为 610 行，但前期 slice 85 已确认 actions/layout/view/Explorer workflow 有明确 owners；不把 composition root 单独变小当作目标。
- 下一候选 `agent-workspace-actions.ts` 为 639 行。其 callback 范围含 workspace tabs/files/subagents、research workflow、workspace/sidebar resizing and mode, session-history navigation，以及 TaskLauncher；`WorkspaceActionsOptions` 将多组 state/setters 与 store methods 汇总为一份宽参数对象，AgentWorkspace 再解构大量独立 callbacks。
- 候选 seam 是按真实 caller 与 dependency subset 评估 action groups 是否应变为小接口（如 tab opening、research navigation、session history），但暂未确认这些逻辑是否共享不可拆的排序/状态约束。还需读完整选项/返回类型及各 callback dependency arrays；在此之前不移动实现、不新建 pass-through hooks。
- 精读后确认唯一生产 caller 是 `AgentWorkspace`；option type 含状态、多个 React setters、workspace/session selectors 与 TaskLauncher inputs。返回 callbacks 属于 tab/file actions、research/workspace-mode transitions、sidebar/panel resizing、session-history navigation 和 task launch；其中 `changeWorkspaceMode → openResearchSection → openSettings` 与历史切换后的 panel/conversation reset 是真实跨动作排序关系。
- 因而还不能简单按 callback 名称拆 hooks：需检查现有 `agent-workspace-utils.ts` 是否已承载纯转移、view callback group 是否稳定，以及窄模块是否能减少而非仅重排 props。若没有足够深的独立 owner，就保留该 composition/action coordinator。
- 决策：暂不拆 `agent-workspace-actions.ts`。它只有一个 `AgentWorkspace` composition-root caller，且 mode/research/settings/panel/tab/session-history transitions 会有序地协调多个 UI surfaces；把 hook 拆成多个小 hook 会让 caller 重学并重新组合同一套宽状态，当前没有证据证明能形成更窄、更深的稳定 interface。记录为可维护性观察点，不按行数制造更多 hooks。

## Slice 137 secondary candidate audit: agent store session lifecycle

- `src/stores/agent-store-session.ts` 596 行，仅导出 `beginAgentSession` 与 `beginArchivedSession`；二者共享 `restoreSessionHistory`，但前者承担约 449 行 active runtime/session restore flow，后者处理约 65 行 read-only archive view state.
- 它有一个生产 caller（Zustand `agent-store.ts`）和直接 owner tests（`agent-session-routing.test.mjs`）。Active path visibly touches runtime identity (Pi product id vs ACP id), timeline migration/projection, transient background state, and bridge open/bind; must inspect full data/side-effect ordering before proposing any split. Archive path is short and may not merit a new module merely to move code.
- 目前只是审计候选；尚未选择抽取，也没有源代码变更。优先确认 active flow 是否有可重复、已存在的 projection/policy interface，再判断可维护性收益。
- 精读 `beginAgentSession` 后，active flow 将 workspace/runtime identity 选择、timeline/history 及 token-usage restoration、background cache 消费、Pi migration import journal、session.open/initialize command 与 setup timeout 按严格顺序编排；`beginArchivedSession` 共用同一 history projector，但刻意不启动 runtime。
- 决策：暂不拆 store session owner。这个函数是唯一 session-activation coordinator caller，流程先后正是行为契约；没有证据显示存在能独立变化的深模块，机械抽成多个 owner 会把排序和跨层恢复知识扩散。现有三项 routing tests 已覆盖 Pi product-ID 与 browser ACP-ID 的关键选择；若后续发现更具体的遗漏，应在同一 `AgentStoreAccess` seam 增加行为覆盖。

## Slice 137 candidate: model-catalog runtime adapter seam

- `PiModelCatalogRuntime` directly constructs external `ModelRuntime` through static `ModelRuntime.create`; three owner tests replace `catalog.getModelRuntime` method itself. Session adapter credential-sync integration has one additional `adapter.modelCatalog.getModelRuntime` private-field override.
- This forces tests past both module interfaces. A narrow `createModelRuntime(options)` dependency on `PiModelCatalogRuntime`, defaulting to Pi's current static factory, would provide a real pair of adapters (production Pi model runtime + deterministic local test adapter); threading that same dependency through `PiSessionAdapter` would remove the private collaborator mutation without exposing the catalog or runtime object.
- `subagent-runtime.ts` (1,286 lines) was also audited: task persistence, Pi child session spawn/continue/cancel/event handling form one lifecycle owner; its tests already drive public `spawnSubagent`/`taskController` and do not write private maps, so no split selected from this scan.
- Audit confirmed three owner tests cover model snapshot/error projection, canonical/display/Host-alias resolution, and authentication error wrapping; only `PiSessionAdapter` constructs the production catalog, and child sessions share it.
- **Decision:** implement the narrow `createModelRuntime(options)` dependency on `PiModelCatalogRuntime`, defaulting to Pi's static factory and threaded through `PiSessionAdapter`'s existing dependency options. Tests will inject deterministic local runtimes, while still exercising catalog initialization/cache, event projection, alias resolution, authentication wrapping, Host credential sync, and live-session settings refresh through the production owners.
- The adapter is constrained to the external construction seam only. Catalog state, lazy initialization/cache, path/environment policy, event projection, Host credential synchronization, and safe live-session refresh remain implemented and exercised behind their existing production interfaces. Test model paths remain under each test's temporary `MELODY_HOME`; model networking stays disabled.
- Implemented `PiModelRuntimeFactory` as one optional catalog dependency, with production defaulting to a closure around Pi's `ModelRuntime.create`; `PiSessionAdapter` passes the optional dependency through its existing constructor options. No extra catalog facade or mutable test setter was added.
- Migrated all four test seams from `getModelRuntime()` method replacement to factory adapters. Catalog tests now cross `getModelRuntime`/`listModels`/`resolveModel`/`authenticate`; the session integration crosses `open`/`syncModels`, then observes credential projection, model event, and live-session settings refresh.
- The offline temporary-home test verifies default Pi factory construction; injected-factory coverage verifies exact options and one-time lazy cache. `rg` confirms no remaining `catalog.getModelRuntime =` or `modelCatalog.getModelRuntime =` test overrides.
- Verification: catalog 5/5, session adapter 24/24, worker 175/175, full unit 449/449, architecture 5/5, Pi compatibility fixtures 101/101, `pnpm check`, lint, formatting, production build, and `git diff --check` pass. Build retains only the existing >500 kB chunk warnings.
- Final invariants: branch is `beta` at `4eddef67`, three release versions remain aligned at `0.4.0-beta.2`; no commit/push/publish/release/main sync. Pi remains the sole Agent runtime; Host credential projection/authorization and existing catalog/event/session behavior are unchanged.

## 2026-10-11 continuation audit after slice 137

- Revalidated current state before continuing: root `AGENTS.md` matches the user-provided beta-only/version-alignment rules; branch is `beta...origin/beta` at `4eddef67`; package/Cargo/Tauri versions remain aligned at `0.4.0-beta.2`; session catch-up reports no unsynchronized work. The existing tree is still large and dirty (81 tracked modifications, 112 untracked paths); preserve it.
- The former unresolved-interaction candidate is already implemented: `agent-store-interactions.ts` owns plan/permission/question actions, `agent-store.ts` delegates via the existing `AgentStoreAccess`, and `agent-store-session-routing.test.mjs` has direct owner behavior tests at the production functions. Do not repeat that slice; continue scanning open candidates against current source.
- Current-source crosswalk also invalidates several older open-candidate notes: `pi_worker_runtime/event_acceptance.rs` now exists; `pi_web_runtime.rs` delegates pure response formatting to `pi_web_runtime/projection.rs`; the store interaction owner and tests are present. Treat those older findings as historical, not remaining work.

## Slice 138: Host sandbox profile resolution owner (selected)

- Current `src-tauri/src/workspace_sandbox.rs` combines a bounded profile-resolution cluster (`SandboxProfile`, canonical path/state/temp helpers, custom user/project `sandbox.toml` loading and precedence, built-in aliases, exact/glob deny projection, read-only/read-write paths and network restriction) with the separate Host decision/command surface (`sandbox_decision`, Tauri-authorized `read_workspace_sandbox_plan`, and `sandboxed_shell_command`).
- `seatbelt.rs` and `landlock.rs` both consume the same normalized `SandboxProfile`; this is a real shared profile interface, not a guessed extra layer. Keep shared overlap/device-sink checks, unsupported-profile mapping, platform selection, Host `WorkspaceRegistry::authorize` order and shell execution in the parent. The profile owner must not decide authorization or weaken fail-closed behavior.
- Before extraction, two profile-specific tests lived in the parent and custom sandbox tests read configuration from implicit process/user paths. The resolver owns those environment and file-source semantics, so its tests now pass an explicit private environment snapshot and create user/project files only under temporary fixtures; parent decision tests construct normalized profiles directly.
- Selected extraction: move `SandboxProfile` and profile/path/config resolution into `workspace_sandbox/profile.rs` with a compact parent-facing `resolve_profile(workspace, requested)` entry point. A private environment snapshot feeds the same implementation for deterministic owner tests; production snapshots the current OS values. Preserve state-dir fallback, temp-dir inclusion only when directories exist, original profile-name reporting, user-profile-over-project behavior, project-only additions, canonicalization, `~` expansion, glob classification and all existing error wording/order.
- Update the existing Pi compatibility sandbox marker to read the profile owner where the read-only aliases move; parent source checks must continue to assert Tauri command registration, authorization and common command wiring. Do not claim that local SBPL strings or target-gated Linux code prove live cross-platform enforcement: this host's sandbox probe is outer-sandbox-blocked and the Linux target is unavailable.

## Slice 138 completed

- Extracted `SandboxProfile`, process environment projection, state/temp path selection, profile aliases, trusted user/project TOML precedence, deny tilde/glob handling, and canonical path projection to `src-tauri/src/workspace_sandbox/profile.rs` (408 lines). `workspace_sandbox.rs` is now 568 lines and retains fail-closed Host decisions, overlap/device-sink checks, Tauri workspace authorization/preflight, command construction and the shared terminal/monitor execution boundary.
- The profile owner exposes one production `resolve_profile(workspace, requested)` entry point plus a private environment-injected test path. Existing `workspace_sandbox::resolve_profile` remains as a crate re-export; the `SandboxProfile` adapter re-export used by platform modules remains unchanged.
- Added deterministic profile tests for built-in/disabled aliases and roots, custom path canonicalization/tilde/glob projection, and user-profile precedence over project definitions. Parent overlap/glob tests now pass explicit normalized profile values instead of reading an actual user config.
- The Pi compatibility gate now reads the canonicalization/network-alias markers from the profile owner and still verifies parent decision wiring, Seatbelt command selection, Tauri command registration and Host preflight. The shared Host authorization/fail-closed behavior and platform adapters are unchanged.
- Validation on the current macOS host: sandbox subtree 12/12, full Rust library 357/357, `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` clean, `cargo fmt --check`, `pnpm check` (Pi compatibility fixtures 101/101), `pnpm test:unit` 449/449, `pnpm check:architecture` 5/5, `pnpm lint`, `pnpm format:check`, `pnpm build`, and `git diff --check` passed. Production build retains existing large-chunk warnings.
- These tests verify profile projections and the Seatbelt command shape, not live macOS sandbox enforcement; the sandbox probe is constrained by the outer environment. Linux Landlock runtime behavior was not executed from this macOS host.
- Final repo check: branch `beta...origin/beta`, HEAD `4eddef67`; `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` are all `0.4.0-beta.2`. All accumulated work remains uncommitted; no main sync, publish, commit or release was made.

## Slice 139 audit: worker stdout event ingestion

- Current-tree revalidation: branch `beta...origin/beta`, HEAD `4eddef67`; package/Cargo/Tauri versions are all `0.4.0-beta.2`. Worktree remains at 81 tracked modifications with accumulated untracked artifacts; preserve all. The planning catch-up script produced no unsynchronized report.
- `PiWorkerRuntime::spawn_readers` is an event-critical coordinator, not a self-contained projection: stdout handling performs frame/JSON decode, generation acceptance and dedupe, durable persistence (including the sequence-replay recovery path), memory observation, dispatch acknowledgement, async lifecycle hooks, persisted permission lookup, event emission, tool/permission request routing, and fail/finish cleanup. A separate stderr loop emits diagnostics.
- The current order is itself the interface contract: only newly accepted and durably inserted events trigger observers/dispatch acknowledgements and renderer delivery; duplicate durable replays do not acknowledge dispatch; product events are persisted before renderer visibility; read/protocol/persistence failures stop the generation.
- Decision: do not extract `spawn_readers` as written. Moving it behind an `EventStreamHost` containing the supervisor, event DB, memory lifecycle, dispatch ledger, Hook runner, permission DB, ToolGateway, emitter and teardown would merely rename broad coupling or create a wide interface. Existing child owners already isolate frame protocol, event acceptance and Host tool routing; no second adapter or narrower implementation is justified by current evidence.
- No source code changed in slice 139 audit. Next inspect `scripts/check-pi-compatibility.mjs` against its fixture-tested owner modules and tests; determine whether it still owns implementation behavior or correctly serves as one aggregation/composition gate before choosing another cut.

## Slice 139 audit result: capability contract is the stronger future candidate

- The manifest's `worker.engine` is `pi` and `runtimeFallback` is `none`; the real `PI_CAPABILITIES` object in `session-adapter.ts` advertises engine/version/protocol, tools, limitations, and diagnostics. The checker first compares package/manifest/source declarations, then imports the actual object through Node and enforces tool-set equality and no ACP/legacy fallback claims.
- Search found no fixture suite for these checker diagnostics. Existing worker tests validate runtime capabilities and individual tools, while the checker itself is invoked in `pnpm check` but has no direct test seam.
- Candidate ranking: a pure Pi runtime-manifest/capability checker is more semantically cohesive and safety-relevant than the generic Host/worker ToolGateway wiring marker group. The real runtime import remains in the aggregate gate; a later owner would consume its result and explicit manifest/package/source snapshots.
- Current user direction remains audit only. No tests/source changed; both candidates remain unelected for implementation pending future direction.

## Slice 139 secondary owner audits

- `config_marketplace_native.rs` remains a 1,114-line Host command/lifecycle coordinator over the existing catalog, transport, registry, filesystem, and direct-plugin-source owners. Its public flows combine authorization/config/source resolution, refresh, catalog scan, registry projection, install/update/uninstall and rollback ordering; splitting by command would make those shared invariants harder to see. Existing temporary-directory tests exercise install/update registry compatibility, local marketplace install/refresh, and version messaging. No narrower owner selected.
- `install_snapshot` is a small but meaningful internal transaction that stages a copy, records registry state, swaps directories, saves, and rolls back on save failure; existing integration tests exercise successful install/update, but no injected failure adapter exists. Moving the function alone to a new file would not yet establish enough leverage; leave it local pending evidence for a stable transaction interface or failure-injection need.
- `pi_monitor_runtime.rs` (947 lines including tests) is a coherent Host monitor lifecycle owner: process start/read/wait, line and rate/lifetime limits, status/snapshot buffers, session/workspace ownership, cancellation, and Tauri commands share one registry/lifecycle contract. `monitor_tools.rs` is already the distinct ToolGateway adapter. Owner-local tests cover sandbox launch, automatic stop and cancellation/tail snapshots; no split selected.
- Slice 139 read-only audit closeout: reject extracting `spawn_readers`; rank pure Pi runtime-manifest/capability compatibility above generic gateway wiring; defer all implementation because the user selected audit-only continuation.

## Slice 139 audit: Pi runtime manifest and capability policy

- The inline manifest gate is a cohesive but mixed section: npm dependency-version equality, worker engine/protocol declarations, manifest-vs-source tool declaration, an actual Node subprocess importing `PI_CAPABILITIES`, runtime-vs-manifest tool-set equality, `runtimeFallback=none`, fallback claims in capability limitations/diagnostics/Host bridges, and Browser limitation accuracy.
- The live capability import is valuable evidence and should remain real; a candidate deep owner would be only the pure compatibility policy consuming the manifest, package metadata, source snapshots, and the actual probe result. Do not replace the subprocess with a mock in the aggregate gate or claim fixtures reproduce runtime behavior.
- This appears more semantically cohesive and directly protects the Pi-only invariant than the generic gateway wiring candidate, but exact manifest shape and existing test coverage remain to be verified. User requested audit only; no tests/source changed.

## User direction on slice 139

- The user explicitly chose continued audit only. The proposed generic ToolGateway wiring seam remains unimplemented and pending; do not write tests or source changes as part of this continuation.
- Continue read-only assessment with the Pi runtime/capability compatibility block, looking for a more cohesive, independently testable policy owner and preserving the real runtime capability probe as evidence.

## Slice 139 selected candidate: generic ToolGateway ownership compatibility

- Exact inline block review (current checker lines 591–744) confirms two related halves: Host ToolGateway's workspace/request-policy/terminal/monitor/scheduler module dispatch wiring; and worker gateway imports/ownership for stable names, access policy, schemas, request lifecycle, errors, permission contract, and task-tool definitions.
- These checks are distinct from the existing manifest-driven web/MCP/schedule/terminal/memory/LSP/codebase/Hooks/compaction checkers. The aggregator currently owns the generic ownership marker logic inline and has no fixture test, while other feature contracts use small source-snapshot interfaces and local test suites.
- Proposed seam: one `checkPiToolGatewayOwnershipCompatibility({ hostSources, workerSources })` function with two grouped snapshot adapters. Keep actual filesystem reads/error aggregation and the real worker capability probe in the aggregator; keep feature-specific manifest checks in their existing owners.
- This is selected pending user confirmation of the test seam required by the TDD guidance. No source changes or tests have been written.

## Slice 139 follow-up: compatibility checker residual ownership

- The current compatibility script imports 14 focused fixture-tested contract owners, but still reads dozens of worker/Host source files and performs substantial inline includes/regex markers; this confirms it is not merely an aggregation entrypoint even though aggregation is one of its responsibilities.
- Candidate under investigation: the generic worker/Host ToolGateway wiring group that spans worker tool names/schema/request policy and Host ToolGateway/workspace/terminal/monitor/scheduler owners. Feature-specific contracts for schedules, terminal policy, monitor/scheduler tools, memory/web/MCP/LSP/codebase/Hooks/compaction are already separate, so the residual group may own the common cross-runtime gateway compatibility contract.
- No extraction is selected yet. Need inspect the complete block and its exact source inputs, all consumers, and whether reusable fixtures can drive the new checker without exporting a wide bag of unrelated content or weakening the top-level gate.

## Slice 139 follow-up: Pi runtime capability policy owner audit

- Current-tree `scripts/check-pi-compatibility.mjs` is 1,924 lines, not the roughly 2,300 noted by an earlier scan; treat that older size as stale. It loads the migration manifest and worker package, reads many source snapshots, imports 16 owner fixture suites through `check:pi-compatibility`, then runs the aggregate gate in CI via `pnpm check`.
- The inline block at lines 1179–1309 couples package pins, source-text identity/tool markers, an actual Node import probe for `PI_CAPABILITIES`, runtime/manifest tool-set parity, Pi-only fallback policy, diagnostic/limitation claims, Browser limitation accuracy, and legacy ACP bridge wording. No `check-pi-compatibility.test.*` fixture suite exists; worker tests exercise runtime/tool behavior but not these migration-gate diagnostics.
- A viable future seam is a pure structured-data policy checker for manifest/package/runtime-capability consistency and Pi-only claims. Keep filesystem reads, source-text marker checks, subprocess import/JSON decoding, and aggregate error/exit handling in the entrypoint; pass a typed probe outcome so an import failure remains a gate failure. Avoid passing concatenated raw source blobs or a shared mutable `failures` array through the new interface.
- Evidence boundary: comparing `PI_CAPABILITIES.tools` to the manifest checks announced capability parity; it does not prove each named tool is actually registered or that Host authorization/sandbox policy is enforced. The runtime probe is real, but it returns declared capability data rather than executing tool paths. Do not present this gate as behavioral or security enforcement evidence.
- User direction remains audit-only. The checker is the leading candidate for a later fixture-tested owner, but no implementation or tests were authorized in this turn.

- Current validation: `pnpm check:pi-compatibility` passed on this worktree: formatting clean, 101/101 listed fixture tests passed, and the final real aggregate Pi compatibility/Tauri permission check passed. These fixtures test the extracted owner modules; they still do not exercise this entrypoint’s manifest/capability diagnostic policy.

## Slice 139 follow-up: actual Pi tool-registration parity

- Current source composes the root session from `PiToolGateway.createTools(...)` plus `DefaultResourceLoader` extension factories. `PI_CAPABILITIES.tools` is `PI_GATEWAY_TOOL_NAMES` plus `todo_write` and `update_goal`; the event mapper uses the same gateway-name list. Root wiring supplies subagent/task-controller dependencies, while child capability modes intentionally filter their available tools.
- A read-only Node probe instantiated `createTools` with the production root shape (all capability mode, subagent spawner, task controller): it returned 42 unique gateway names, exactly matching the 42 names in `PI_GATEWAY_TOOL_NAMES`. The goal/todo owner tests separately assert their registered names; combined, those two names plus the gateway set match all 44 advertised capability names.
- Targeted existing tests passed 37/37 for `tool-gateway`, `todo-extension`, and `goal-extension`. They cover owner behavior and individual registration, but no current test compares the complete root registration union with `PI_CAPABILITIES.tools`. The manifest gate's source-string search likewise does not prove this runtime composition equality.
- Priority revision: the missing durable composition-level parity assertion is a higher-value follow-up than extracting only pure manifest diagnostic policy. A test can cross the existing public `createTools` and extension-factory interfaces without introducing a new registry facade; inspect the session-adapter harness/resource-loader visibility before choosing the precise test owner. User direction remains audit-only, so do not add it yet.

## Slice 139 follow-up: composition test seam is available

- The installed Pi SDK exposes `ResourceLoader.getExtensions(): LoadExtensionsResult`; each loaded `Extension` publicly exposes its `tools` map. `PiSessionAdapter`'s existing test harness uses the real `DefaultResourceLoader` and injects only `createAgentSession`, whose callback receives the complete SDK options. A test can capture `options.customTools` and inspect `options.resourceLoader.getExtensions().extensions[*].tools.keys()` against `options.tools`/`PI_CAPABILITIES.tools` through these existing interfaces.
- This is narrower than replacing the loader or inventing a new registry port: it can verify actual root composition, including that the production loader includes the goal/todo extensions, while the existing fake SDK keeps model/session execution deterministic. Child capability filtering remains a separate behavior and should not be compared to the global capability declaration.
- This makes a root composition parity test a concrete high-value next slice; the pure manifest policy extraction is still useful but lower priority. No implementation was made under the current audit-only direction.

- A current source scan found only `todo-extension.ts` and `goal-extension.ts` call `registerTool` among the root-injected first-party extensions; instruction-scope and compaction extensions do not add model tools. Root session also sets `noTools: "builtin"`. Thus the 42 gateway definitions plus these 2 extension registrations are the relevant full root set to compare.

## Slice 140: root Pi tool declaration parity test

- The test seam is already a real module interface: `PiSessionAdapter.open()` creates the production resource loader and passes the resulting `resourceLoader`, Gateway `customTools`, `noTools`, and explicit `tools` allowlist to the injected Pi SDK `createAgentSession` function. No new production interface or registry facade is needed.
- The installed SDK's public contract says `tools` is the allowlist; `customTools` add to Pi's tools; `noTools: "builtin"` disables built-ins while leaving custom/extension tools enabled. `ResourceLoader.getExtensions()` returns loaded extensions whose `tools` are public maps. The root composition test compares these three declared inputs and fails on duplicates or extension-load errors.
- Root-only scope is intentional: child capability modes filter available tools and cannot be compared to the global `PI_CAPABILITIES.tools` declaration.
- Verification supports adapter-to-SDK declaration parity, not execution of a provider call or Pi's internal post-construction registry. The fake SDK seam is retained; individual extension registration has existing owner tests. Host authorization and security enforcement are unchanged and are outside this worker-side contract.

## Slice 141: compatibility-gate JSON input validation

- The aggregate checker parsed JSON but accepted any root value. Its `if (manifest && workerPackage)` gate therefore skipped every Pi package/capability comparison when the worker package root was valid JSON `null` or `false`; a child-process test using an in-memory `readFileSync` replacement reproduced a false success with exit code 0.
- A malformed Pi manifest was correctly recorded by the JSON reader, but the later pre-probe `manifest.hostBridges` access threw a `TypeError`, obscuring the intended diagnostic. Root `null` similarly crashed before aggregate error reporting.
- `readJsonObject` now accepts only non-null, non-array JSON objects for both the manifest and worker package. The optional manifest bridge scan safely skips when loading/validation fails; the recorded read/parse/shape failure remains sufficient to make the aggregate gate exit nonzero.
- Five integration cases exercise the executable CLI with only one JSON file read replaced in memory: worker package `null`, worker package `false`, manifest `[]`, manifest `null`, and malformed manifest syntax. They assert nonzero exit and actionable diagnostics; no production filesystem fixture or test-only runtime port was added. The real worker capability probe remains active for all valid-input runs.
- This validates malformed root handling and CLI diagnostics, not semantic validation of every nested manifest property. Pi-only claims, Host authorization and OS sandbox enforcement remain covered by their own contracts and are not proven by these root-shape tests.

## Slice 142: `config_subagents.rs` ownership audit

- Revalidated current state: branch is `beta...origin/beta`; `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` all declare `0.4.0-beta.2`; planning session catch-up produced no unsynchronized-context report. Existing dirty changes were preserved.
- The module has substantial implementation breadth, but the current behaviors form one Host-side subagent-definition projection domain. It already delegates Markdown parsing/field classification to `config_subagent_markdown.rs` and prompt-file containment/reading to `config_subagent_prompt_file.rs`; project/user roots and Pi plugin roots remain owned by their existing config owners.
- Several implementation details are already shared where the contracts truly overlap: deterministic bounded Markdown path enumeration, parse projection, plugin-agent visitation, and source-root precedence. Both the Pi manifest and Settings inventory use those seams rather than implementing separate parsing or scans for the same invocation.
- The two exported projections intentionally differ. `pi_subagent_policy_manifest` needs normalized role/persona/model/toggle policy and bounded Pi worker payloads. Settings inventory needs only effective definition path/scope, enabled/support state, and unsupported-field labels. Its `list_melody_agent_definitions` path also authorizes the requested workspace through `WorkspaceRegistry` before reading; that authority must remain in place.
- A unified inventory owner is not yet a justified deep module: making both projections consume one full normalized policy object would make Settings do role/persona normalization and produce fields it discards; forcing the manifest through the Settings metadata projection would lose policy payloads and separate plugin bare-name behavior. A generalized source-record layer would add an interface while precedence/parse helpers are already shared.
- Conclusion: do not extract by file size alone. No production edit or new test was made in this audit. Revisit only if a concrete duplicated precedence rule or independently testable policy contract emerges; otherwise continue to a different owner candidate.

## Slice 143: Pi worker reader-loop ownership audit

- `PiWorkerRuntime::spawn_readers` still combines stdout/stderr frame consumption with the full event-delivery lifecycle. For accepted stdout events, its sequence is material: read/parse → active-generation acceptance/readiness handshake → workspace identity → durable replay fallback and event persistence → memory/dispatch observation → asynchronous Host hooks → persisted permission and tool-request routing → renderer emit. Malformed/unaccepted or failed-persist events terminate the generation; EOF calls the generation-finish path. Stderr has a separate bounded frame-to-diagnostic projection.
- `event_acceptance.rs` has owner-local tests for first readiness, duplicate payloads, reused IDs, epoch/sequence violations and bounded exact-ID eviction. The parent runtime suite only tests unscoped-session classification; no test calls `spawn_readers` or verifies persistence-before-renderer, duplicate-not-acknowledged, or failure teardown behavior.
- A scan of the actual `src-tauri` tree found no Tauri mock-app/test-runtime harness. The tree's existing non-worker test owners are module-level `*_tests.rs` files. Worker binary path can be overridden for development, but no controllable process fixture is currently wired into this runtime suite.
- A simple file move would not establish a better interface: the existing reader coordinates Host database/workspace validation, generation state, memory lifecycle, scheduling acknowledgements, permissions and tool execution. A useful seam must make that ordered behavior testable without moving or weakening Host workspace authorization, changing persistence-before-delivery, or adding an oversized collection of callbacks.
- The user selected a narrow internal event coordinator + fake port before implementation. Keep framing, process supervision and Host authorization decisions in their current owners.

## Slice 144: Pi worker event pipeline coordinator

- Added `pi_worker_runtime/event_pipeline.rs` as an internal event lifecycle owner. The parent continues byte framing, JSON parsing, best-effort workspace lookup, and generation fail/finish handling.
- The private `EventPort` keeps the coordinator interface small: worker-generation acceptance, durable event persistence, and post-commit publication/observation. `HostEventPort` delegates to the existing runtime acceptance, `persist_pi_event` (including Host workspace/session authorization), memory lifecycle, dispatch ledger, Host hooks and tool/permission routing.
- The coordinator preserves the existing replay contract: exact in-memory duplicates skip storage; sequence violations are arbitrated by SQLite; persisted duplicates do not acknowledge or emit; inserted accepted events are observed and delivered only after persistence; unknown sessions, other acceptance failures, and storage failures stop the generation through the existing caller path.
- Nine owner tests cover the operation order and failure/duplicate branches. The red baseline failed all six original tests because the new coordinator was a placeholder. The first implementation test compile exposed an import-visibility mistake; importing `is_sequence_violation` from its actual `event_acceptance` owner fixed it.
- Full Rust library suite: 366/366; `cargo check --lib`, `cargo fmt --all -- --check`, Prettier on planning docs, and `git diff --check` pass. This validates the Host-side Rust event pipeline contract and compilation; it does not simulate a live Tauri app renderer or execute an actual worker process.
- No protocol, event persistence schema, runtime routing, permission policy, release version, or user-facing event shape changed. No commit, push, publish, release, or main sync.

## Slice 145: session/project agent-row cleanup audit

- `database_sessions.rs::purge_session_agent_rows` owns seven explicit cleanup statements: timeline entries, fork lineage, session binding, Pi event log, migration journal, schedule runs, and schedules. `agent_session_lifecycle::delete_session` calls it inside the transaction that removes the session row.
- `database_projects.rs::delete_project_record` repeats six of those cleanup categories with project-scoped subqueries, then deletes the project’s sessions and project row. Project-only permission-rule cleanup and the project transaction itself remain distinct. Its caller is the lifecycle command after it stops relevant Pi workers and removes per-session opaque Pi files.
- Both cleanup paths explicitly avoid depending on foreign-key cascade behavior, including older databases where enforcement was not enabled. Existing tests check schedule/run cleanup for a session and schedule/run plus fork cleanup for a project, but the SQL policy and table fan-out currently live in two owners.
- The user selected extraction of a shared cleanup owner. Its interface will accept the existing SQLite transaction and target id for session- or project-scoped cleanup; it will not open/commit transactions or own lifecycle side effects.
- Interface tests should assert each shared dependent table is scoped correctly for both modes, including forks where either session endpoint is in the deleted scope, and that rolling back the caller transaction restores all affected rows. Replace old direct helper tests rather than layering implementation-shaped assertions.
- Preserve project-only `permission_rules`, deletion of `sessions`/`projects` parent rows, transaction creation/commit, worker shutdown, and opaque Pi artifact removal in their current owners/callers. Host authorization and Pi-only runtime are not part of this SQL cleanup owner.
- Current recheck before implementation: `beta...origin/beta`; `package.json`, Cargo and Tauri versions all `0.4.0-beta.2`. Existing dirty work is preserved.
- The exact shared policy is seven dependent tables: `session_timeline_entries`, `pi_session_forks`, `agent_session_bindings`, `agent_event_log`, `migration_journal`, `agent_schedule_runs`, and `agent_schedules`. Session cleanup matches the target id directly; project cleanup resolves target sessions by `sessions.project_id`. Fork rows are removed when either source or branch session is in scope.
- `database.rs` already uses explicit `#[path]`-backed database owner modules and crate-level re-exports. The new owner can preserve the existing `purge_session_agent_rows` import path and give `database_projects` a sibling-module call without changing external callers.
- Implemented `database_agent_cleanup.rs` with two small transaction-in/target-id interfaces. Session/project scope SQL, including run-before-schedule ordering and fork removal on either endpoint, now lives together; `database_projects` still owns project permission rows, parent deletion, commit, and error mapping, while lifecycle callers still own Pi worker/file effects.
- The old direct session cleanup test was replaced by four owner-interface tests; the existing `delete_project_record` integration test remains. The focused owner suite passes 4/4 against a fixture with foreign-key enforcement disabled, so the explicit SQL policy is exercised rather than hidden by cascades.
- Diff review also confirmed the pre-existing dirty tree already contains the lifecycle-command extraction into `agent_session_lifecycle.rs` (including `database_projects.rs`/`database_sessions.rs` command removals). This slice preserved that user work and only changed the existing SQL owner imports/call sites plus cleanup code; no unrelated dirty files were edited.
- Final verification: Rust library suite 369/369, cleanup owner suite 4/4, `cargo check --locked --lib`, `cargo fmt --all -- --check`, Prettier on the three planning documents, and `git diff --check` all pass. The checkout remains `beta` and all three release declarations remain `0.4.0-beta.2`.

## Slice 146: next core runtime owner scan

- Current-source LOC scan is discovery-only: `session-adapter.ts` 1,770 lines, `pi_tool_gateway.rs` 1,531, and `subagent-runtime.ts` 1,286; other modules are also large. Size alone does not establish a deepening opportunity.
- `pi_tool_gateway.rs` is a misleading size candidate: the production implementation ends near line 374 and its embedded test module starts at line 375; it already delegates to instruction-scope, request-policy, worktree, terminal, monitor, scheduler, path, and workspace owners. Keep its remaining role as Host authorization/dispatch coordinator unless an actual logic cluster crosses that seam.
- `session-adapter.ts` has one primary production consumer (`main.ts`) and one large public `PiSessionAdapter` facade, with extracted owners for turn policy, resource/skill/prompt discovery, model policy/catalog, attachment handling, provider errors, persistence rules, and subagent runtime. Its 1,221-line tests are currently integration-shaped; inspect method clusters before splitting the orchestrator.
- `subagent-runtime.ts` already depends on distinct policy, persisted-record, resume/path-boundary, task-tools, and model-catalog owners. Its remaining class lifecycle may warrant a seam, but inspect actual methods and test contracts before deciding.
- `PiSubagentRuntime` otherwise owns the child-session/task lifecycle: spawn, resume, visibility checks, wait/cancel, event-tail ordering, terminal events, cleanup, and persistence. The large `spawnSubagent` orchestration remains a coherent workflow; extracting it wholesale would require a wide callback/adapter surface.
- A narrower cross-domain seam exists in the same owner: `waitTasksForSession`/`cancelTaskForSession` route Host terminal task IDs by prefix, then `hostBackgroundTaskControl` resolves a Pi session context, builds a Host ToolGateway request, maps Host failures, and parses returned snapshots. The process registry and final workspace/session authorization remain on the Host side.
- The parser has one production caller in the Host bridge and a compatibility re-export through `subagent-runtime.ts` → `session-adapter.ts`; the only behavioral test is incorrectly located in `session-adapter.test.mjs`. Both worker and root unit test commands use explicit source-file lists, so the new owner test must be added to both manifests.
- Selected slice: isolate the Host terminal-task bridge and snapshot parser into a small adapter owner with direct fake-gateway/context tests. Keep unified task-ID routing and mixed Host/Pi rejection in `PiSubagentRuntime`; preserve Host request session/root/run/cwd/permission identity, `approved: true` inspect/cancel semantics, task IDs, error mapping, and the ToolGateway authorization path.
- Implemented `host-task-control.ts` and moved parser assertions from `session-adapter.test.mjs` into four direct owner tests. `subagent-runtime.ts` keeps Host task-ID classification/routing and mixed-scope rejection; `session-adapter.ts` still exposes the parser through the existing compatibility chain.
- The first full check showed the static compatibility gate still expected event acceptance/duplicate arbitration inside `pi_worker_runtime.rs` even though slice 144 moved that coordinator to `pi_worker_runtime/event_pipeline.rs`. The gate now inspects both the current owner and supervisor wiring, with an integration regression test that removes the owner source in memory.
- Final slice-146 gates pass: worker tests 180/180; root unit tests 454/454; `pnpm check`; Pi compatibility tests 107/107; lint, format check, production build, and `git diff --check`. Existing tree remains beta-only with aligned versions.

## Billing-usage projection candidate audit (resolved)

- `src/domain/agent/billing-usage.ts` already owned normalized usage merging, USD tick conversion, and session-update payload projection. `src/domain/session-projection-updates.ts` also contained a roughly 50-line camel/snake-case decoder for the same `AgentBillingUsage` shape.
- Resolved by moving that decoder into `billing-usage.ts` as `parseBillingUsage`; `applySessionUpdate` remains the existing behavior/test interface, while `session-projection-updates.ts` retains turn ordering and timeline placement. No private parser test seam or duplicate tests were introduced.
- The pre-extraction `applySessionUpdate` and billing owner suites passed 27/27. After extraction, the full unit, type/compatibility, lint, format, and build gates passed; Host authorization, runtime routing, and event behavior were untouched.

## 后续候选对照：Composer 与 agent store

- `primaryViewKey` 在 `agent-workspace.tsx` 中决定 motion key，而 `agent-workspace-view.tsx` 又用一份相同优先级条件选择实际 screen。Settings 作为 stage-level view 另行覆盖 primary view；workspace panel 则独立作为 overlay。这个重复投影会让动画 identity 与实际内容发生 drift，是 Surface owner 的直接可观察合同：可由一个纯 `resolveWorkspaceSurface` 投影同时驱动 key 与 render 分支，并保留底层 New Task/Research 状态；它不是把所有 flags 强行压成一个 mutually-exclusive union。
- `src/features/chat/agent-workspace-actions.ts` 为 639 行，单一 caller 是 `agent-workspace.tsx`。`WorkspaceActionsOptions` 把 project/session/task/research/panel/layout 状态及大量 setter 汇入一个 hook，返回的动作又横跨多个领域。尤其 `openSettings`、`openWorkspaceTab`、`openResearchSection`、`openResearchPaper` 和 `changeWorkspaceMode` 分散维护右侧面板、Settings、Research 与 New Task 的互斥/打开顺序；父视图还按优先级读取这些独立布尔值。比逐个搬动 callback 更有意义的 seam，可能是纯 Workspace Surface transition owner：以小的 state+action 接口集中视图转换，副作用留在 React adapter。仍需确认 transition contract 与测试 seam，不能直接把大 hook 按主题切成多个浅层 hooks。

## Workspace store candidate audit

- `src/stores/workspace-store.ts` is 411 lines and owns initialization, project CRUD/archive/restore, session CRUD, active project/session selection, per-project session caches, fallback session creation, and worker shutdown ordering before deletion. These state lifecycles share `activeProject`, `activeSession`, `sessions`, `sessionsByProject`, `loading`, and `error`; splitting by entity name alone risks fragmenting their invariants.
- `agent-workspace.tsx` is the primary action consumer; workspace hooks and agent-store modules also read active project/session state or call `replaceSession`. `use-workspace.ts` only triggers initialization. No owner-local workspace-store test file was found; nearby Pi session-explorer tests exercise a different injected interface.
- `selectProject` clears the prior selection, then may await an uncached session read or fallback-session creation before it unconditionally writes its project and sessions. Rapid selections of a not-yet-cached/empty project can therefore allow an older completion to replace the later selection. This is a concrete candidate for an external-interface test, but resolving it would be a behavior correction, not merely moving lines.
- No extraction was selected: the store is a cohesive project/session aggregate, and its sole storage adapter does not establish a real alternate-adapter seam. The useful next discussion is whether to add an injectable/testable aggregate interface and lock selection ordering before implementation; current pending seam choice remains unanswered.

## Pi session bridge candidate audit

- `src/hooks/use-agent-bridge.ts` is a 357-line single-consumer lifecycle owner coordinating archive detection, Pi compatibility preflight, event subscription, worker status/start, session open, and teardown. Most async success paths and stream callbacks check the effect's `disposed` flag; teardown unsubscribes and clears the Pi stream.
- The `getPiCapabilityReport` rejection branch does not check `disposed` before replacing `capabilityDiagnostics` and calling `setStatus(failed)`. If session A's preflight rejects after navigation has disposed A and opened session B, the stale A failure can overwrite the current session's status. This conflicts with `CONTEXT.md`'s Async Operation rule that stale results cannot replace the current page.
- The root unit harness is an explicit Node `--experimental-strip-types --test` file list; current dependencies provide React/ReactDOM but no hook renderer or DOM testing library. Search found no `useAgentBridge` lifecycle test. A direct hook test would require new test infrastructure; a small pure connection-lifecycle module with one production adapter and a fake test adapter can use the existing Node test runner without adding dependencies.
- The hook's lifecycle remains cohesive; extracting isolated archive/preflight helpers would be shallow. A viable deep seam would encompass the ordered connection lifecycle behind one narrow coordinator interface, with the existing bridge/store calls as the production adapter and a deterministic fake for lifecycle tests. Pi-only Desktop routing, fail-closed capability policy, Host permission authority, and React cleanup ownership must remain unchanged.
- This is a candidate audit only. No source or tests were changed; user confirmation is still needed before establishing that public lifecycle test seam. The workspace-store latest-request question is already pending, so do not send a duplicate selection prompt in the same turn.

## Host/Pi tool routing ownership audit

- Current route remains Host-owned: `event_pipeline` forwards accepted worker events to `PiWorkerRuntime::resolve_tool_request`; `host_tool_routing` resolves the live worker root, authorizes requested paths through `WorkspaceRegistry`, requires authorized descendants of that root, runs enforceable PreToolUse hooks, reads persisted session permissions, applies explicit denies, and dispatches to Host owners.
- Persisted permission-store errors fail closed to interactive handling. Memory writes, browser mutations, and MCP calls have separate Host permission checks; ordinary file/terminal work receives Host-derived gitignore and terminal policy, and the Pi ToolGateway retains mutating-tool approval, allowlist, path and shared mutation-lock enforcement. Extracted tool submodules are private to the Host gateway module tree.
- No authorization bypass was observed in this source trace. This is bounded source evidence, not a runtime penetration test or full proof of Host security.
- Test coverage is asymmetric: `pi_tool_gateway.rs` has direct tool/path/permission tests and `event_pipeline.rs` has fake-port ordering/failure tests, but `pi_worker_runtime/host_tool_routing.rs` is 683 lines with no direct tests. Existing lower-level tests do not verify the combined event → workspace authorization → persisted permission/hook → domain dispatch sequence.
- The best structural candidate is a narrow Host router coordinator/interface that preserves `WorkspaceRegistry` and Host policy as authorities while allowing a fake adapter to exercise the combined authorization order. Avoid extracting another pure parser/helper; no interface or test seam is selected yet.
- The code-review skill's mandated fixed point was unavailable for this checkout: `beta` equals `origin/beta`, while the refactor is uncommitted/untracked. This turn therefore performed a bounded source audit only, not a two-axis branch review.

## Pi ToolGateway request-policy test ownership

- The request-policy owner centralizes event classification, permission identity, and request metadata projection, but eight direct tests for those functions were nested in the large gateway test module.
- Moved those existing tests beside their owner without expanding assertions or changing production logic. Gateway integration tests for authorization, filesystem, terminal, scheduler, and monitor behavior remain in the gateway module.
- The focused request-policy suite passes 8/8; the complete Pi ToolGateway family passes 37/37; the full Rust library suite remains 369/369.
- This is test-ownership alignment only. It does not close the separate Host routing integration-test gap or change Host final authorization.

## HostTool routing coordinator seam proposal (not implemented)

- Current production path resolves the active worker root, authorizes any requested cwd through WorkspaceRegistry and enforces descendant scope, handles the internal instruction lookup, runs enforceable PreToolUse, reads persisted permission, applies deny precedence and tool-specific gates, dispatches to Host owners, writes the resolution, then runs observational post-hooks.
- The ordering is a cross-owner contract; tests at request-policy helpers or the lower-level event-pipeline port cannot prove the full sequence. A route-only pure policy module would still leave workspace authorization and hook/permission ordering unverified.
- Proposed test seam: a Host routing coordinator that owns this ordered request lifecycle and depends on a small Host port implemented by the real Tauri/WorkspaceRegistry/database/runtime adapter and a deterministic recording adapter for tests. Tests would observe denial, dispatch and completion through that interface.
- The production adapter remains the sole authority for WorkspaceRegistry, hooks, persisted permission storage, domain runtimes, and worker resolution writes. No worker-side authorization, Host policy relaxation, or behavior change is intended.
- This is a design proposal only. Under the TDD seam-confirmation rule, no coordinator interface or tests will be implemented until the user selects this interface or another target.

## PiSessionAdapter residual owner audit

- The current adapter is 1,770 production lines with a 1,198-line interface-level test suite. It composes distinct owners for ToolGateway, model catalog, subagent lifecycle, turn policy, resource discovery/policy, session persistence and attachment validation; its command/event entry points remain the stable worker boundary.
- Root and child sessions intentionally share the resource-loader factory. The refresh orchestration updates Host policy snapshots, defers mutation while a run is active, refreshes root/child bindings, aggregates failures and emits one protocol warning; extracting that orchestration would need a wide callback surface or split invariants. Per-session binding construction is a narrower cluster and is documented in the focused extraction below.
- The remaining Pi event handler combines event mapping with root/child run-state transitions and notification ordering; the pure Pi-to-protocol mapper already has a separate owner. No narrow production/test seam was established for further splitting the class in this pass.
- Decision: do not extract the facade, refresh coordinator or event/run-state transitions solely because the file is large. Preserve PiSessionAdapter as the tested public command/event interface; the per-session binding owner was extracted without moving that orchestration.
- 转换语义不等于简单互斥：`openSettings` 关闭 workspace panel 并清空 tabs，但不清 `newTaskOpen`/`researchMainOpen`；非 `skills` 的 research 导航关闭 Settings/panel，却不清 `newTaskOpen`；`skills` 则进入 Settings。父视图优先级明确为 `new-task > workspace-start > research > conversation`。`changeWorkspaceMode` 会清 `newTaskOpen`，进入 research 时走 `openResearchSection("overview")`，进入 work 时清 detail/main 并关闭 panel。任何新状态 owner 必须先固定这些可观察转换，不能用“单活跃页面”联合类型意外改变现有行为。
- `src/hooks/use-agent-bridge.ts` 为 357 行、由 `agent-workspace.tsx` 单点调用的生命周期协调器，串联归档识别、Pi capability preflight、事件订阅、worker 启动、session open 和清理。它当前集中体现顺序与失败语义；直接抽出会需要宽依赖接口，而当前测试只覆盖归档策略的相邻行为，没有 hook lifecycle contract。它是比纯 UI 子组件更值得继续评估的风险面，但在 seam 和可控 adapter 测试确认前不动实现。
- `src/features/chat/agent-composer.tsx` 是 594 行、仅由 `agent-workspace.tsx` 使用的 UI owner。它把草稿状态/持久化、模型图片能力门禁、选择器状态和同一 composer 的附件/模型/推理/会话模式/权限/上下文/提交控件组合在一起；草稿存储、provider grouping 和控件各自已有 owner。当前没有足够证据支持再拆一个参数密集的 props/callback 接口；按职责它更像单一交互面，而不是多个独立模块堆叠。
- `src/stores/agent-store.ts` 的当前组成已是 facade：receive、session、submit、Pi-event、interaction、configuration 分别委托到 `agent-store-*.ts` owners；子代理、解析和 runtime 也有对应模块。此前工作树已有大量状态域拆分，不应仅因 facade 导入多而再次分层。下一步若继续查此区，应验证 owner 间循环依赖/状态耦合及测试覆盖，而不是重复按命名拆文件。
- 前一轮已审计 `sidebar-projects-navigation.tsx`：树投影、展开/选择和三种列表呈现属于同一导航交互，尚无证据表明抽离纯 helper 会形成更深的接口。与 Composer 交叉比较后，当前不选这两个 UI owner 作为下一个代码切片。
- 一次 LOC 命令因 zsh 未匹配 `*.tsx` glob 而报错，未造成文件变更；后续审计使用 `rg` 源码与调用图，因此不重复失败命令。

## 2026-10-12：累积 beta 工作树复验

- 当前累计前端 root unit tests 454/454、Pi worker tests 180/180、Rust library tests 369/369 均通过；`pnpm check`、`pnpm check:architecture`（5/5 fixtures）、lint、format、build、Rust check/fmt 和 `git diff --check` 通过。
- `pnpm check` 实际覆盖 root TSC、agent-contract、worker TSC、packaging 与 Pi compatibility aggregate；`check:architecture` 单独确认 domain/runtime 模块边界扫描及 cycle diagnostics。
- Build 仍报告 editor/main/language chunks 大于 500 KB 的告警（build 完成）；这不是失败，但也不是桌面运行时验收。没有因此把全仓治理目标视为完成。
- 当前没有新的产品源代码变更；`beta` 与 `0.4.0-beta.2` 三版本一致。现有不回答的 seam 选择仍待用户回覆，后续可继续审计其他 owner。

## Pi session resource-loader owner extraction

- Moved the per-session loader implementation from `session-adapter.ts` into `session-resource-loader.ts`. The owner now contains Pi `DefaultResourceLoader` setup, ambient discovery shutdown, first-party extension wiring, scoped-instruction seeding, and mutable Host-projected Skill/prompt path refresh.
- The owner receives one options object for cwd and dynamic session/capability/token/goal-policy inputs, plus a policy-snapshot callback. `PiSessionAdapter` retains the shared root/child factory, initial and Host-refreshed policy state, and multi-session refresh ordering; `PiSubagentRuntime` continues using that same factory. Host policy remains authoritative and runtime remains Pi-only.
- Existing `PiSessionAdapter` tests remain the behavior seam; no implementation-private test seam was added. The compatibility checker now validates both the new owner and adapter wiring, with regressions for removing either side of the connection.
- Validation: adapter 25/25, worker 180/180, root unit 454/454, Pi compatibility 109/109, aggregate `pnpm check`, lint, format, production build, and `git diff --check` pass. Build retains the existing >500 KB chunk warning; no desktop UI/platform acceptance was performed.

## 2026-10-12: Resource-scanner owner-map reconciliation

- Revalidated that `skill-discovery.ts` and `prompt-discovery.ts` are separate scanner owners, while `resource-discovery.ts` retains shared Host-trusted root construction, canonicalization, symlink rejection, and root membership. The existing `resource-discovery.test.mjs` calls both production interfaces directly; `pnpm check:pi-compatibility` independently checks both scanner owners and their wiring.
- Removed two temporary owner-local test drafts from the preceding audit because they duplicated the existing combined direct-interface coverage; no runtime source changed. Updated the stale task-plan item and handoff owner map to match the current implementation and existing test-ownership decision.
- Verification this turn: discovery suite 6/6; Pi compatibility fixtures 109/109 plus source gate; Prettier and `git diff --check` pass. Branch remains `beta`; all three release declarations remain `0.4.0-beta.2`.
- This is documentation/test-ownership cleanup, not a new runtime slice. The broader structural-governance goal remains active; no release, publish, commit, or `main` sync occurred.

## 2026-10-12: Tool activity input/text owner

- `session-projection-updates.ts` separately unwrapped nested `gateway: "melody"` arguments, selected a display command, and formatted text/raw output while `tool-activity.ts` already parsed the same tool payload for operation/path/query/file activity. A gateway input-shape change could therefore drift across the semantic and display projections.
- Added `projectToolText` to the existing `tool-activity.ts` interface and shared the gateway input unwrapping with `extractToolActivity`. The session projection now consumes the command/output result and retains status, completion timestamps, previous-value fallback, permission state, and timeline updates.
- The owner-interface red baseline failed on the missing export, then passed; existing projection integration contracts passed 55/55 focused tests. Full verification: root unit 455/455, `pnpm check` (Pi compatibility 109/109), architecture 5/5 plus live graph, lint, format, build, and `git diff --check`.
- No runtime routing or Host authorization changed; beta and aligned `0.4.0-beta.2` versions were retained. Whole-repository governance remains in progress.

## Workspace primary-view projection audit

- `agent-workspace.tsx` computes `primaryViewKey` for the animated page key using this precedence: New Task, no active session, eligible Research (research mode + main open + section not `skills`), then conversation.
- `agent-workspace-view.tsx` repeats the same conditions to select the primary content branch. Settings is a separate stage-level override outside the animated workspace branch; WorkspacePanel remains an independent overlay.
- A shared pure projection could remove key/render drift without changing the stored surface booleans or transition actions. It must not collapse states into an exclusive union: `openSettings`, Research navigation, and workspace-mode changes intentionally preserve different hidden flags.
- No source or tests were changed. TDD requires user confirmation of the exact test seam; an async prompt was sent for a narrow `resolvePrimaryWorkspaceView` projection consumed by both the key and render branches, with four precedence cases. The broader surface-transition reducer remains unselected.

## Pi-only contract and fallback-language consistency

- Active source comments contradicted the current Pi-only runtime in three places: `AgentGoalPolicy` said higher-level orchestration could fall back to ACP; subagent inventory described a shadowed definition as an ACP fallback; the Pi memory transcript path described semantic consolidation as an ACP fallback.
- Current Host/worker capability code instead reports configured semantic/vector Memory as unavailable in the Pi session. The deprecated `AgentCapabilityDiagnostic.fallbackEngine` field remains for wire compatibility and is not an active route.
- Updated the three source comments to state current behavior. Preserved the dated 2026-10-05 acceptance snapshot and added a supersession note that its ACP fallback wording for embedding/vector/dream was replaced by the 2026-10-11 Pi-only decision.
- Historical migration sections explicitly marked superseded were left intact. No runtime logic, protocol shape, or historical test result was changed.
- Root `pnpm check` passed, including agent-contract and Pi compatibility checks (109 fixture tests); `pnpm format:check` and `git diff --check` passed.

## Context-usage wire decoding ownership candidate

- `parseSessionContextUsage` in `session-projection-updates.ts` decodes camel/snake wire fields (`used`/`used_tokens`, `size`/`max_tokens`) and optional cost, but is also imported by `agent-store-parsing.ts` for result and metadata parsing. The latter selects among result usage, metadata, and model-derived fallback; the former also owns timeline mutations and `applySessionUpdate`.
- `session-projection-persistence.ts` separately reads token usage from persisted timeline rows and converts cumulative total tokens. This is adjacent context-usage behavior, but a unified owner would need to keep timeline persistence, result precedence, and update projection roles distinct.
- `billing-usage.ts` normalizes billing counters and cost ticks; those are not the same contract as context-window usage and should not be merged based on the shared word “usage.”
- A bounded `*.test.mjs` search found no explicit `usage_update` wire-case test. Existing tests cover adjacent context restoration and event projection, but do not by themselves establish the update parser's error/normalization behavior.
- No-split decision: the parser is a small shape normalizer appropriately consumed from the existing `session-projection` domain facade. Extracting only it would create a shallow owner; folding result precedence, model defaults, and persisted timeline access into one module would broaden the interface across distinct responsibilities. Keep current placement and do not combine it with billing usage. No source or test changes were needed.

## Existing Pi-only renderer-routing test interface

- `agent-session-routing.test.mjs` exercises the current public `agentClientForRuntime()` and `beginAgentSession()` interfaces: Desktop remains Pi despite a legacy preference; browser preview selects the deterministic ACP fixture; Desktop uses product session IDs while preview retains source ACP IDs.
- `melody-bridge-acp.test.mjs` separately verifies Desktop ACP send/subscription fail closed before native invocation and that browser preview retains its deterministic initialize fixture.
- These tests already cover the named Pi-only routing invariant at its selected interface. No duplicate coverage or runtime change is warranted by this audit.

## Pi ToolGateway workspace-tools test ownership candidate

- Current `pi_tool_gateway.rs` has a small production facade with its `#[cfg(test)]` module beginning at line 374; `pi_tool_gateway/workspace_tools.rs` is a 1,091-line implementation owner with no local test module in the current source scan.
- The facade test module includes workspace file read/search/list, gitignore enforcement, patch preflight/mutation, and symlink cases. These appear to exercise the extracted workspace-tools owner, while Host permission override and combined dispatch/authorization assertions may belong at the facade and must remain there.
- `request_policy.rs` already owns its direct policy tests after Slice 147, establishing the intended direction for tests that exercise a single extracted owner.
- Candidate only: inspect exact calls and fixture dependencies before moving any existing tests. Preserve assertions and production/Host authorization code; no tests or source have been changed in this audit.

## PiSessionAdapter public test-boundary revalidation

- Current `session-adapter.test.mjs` no longer references `adapter.sessions`, `adapter.tasks`, `waitTasksForSession`, or `cancelTaskForSession`. The lifecycle suite uses public adapter commands such as open/submit/steer/cancel/configure and observes emitted events/session behavior.
- Subagent path/resume rules have owner-local tests in `subagent-session-boundaries.test.mjs`; `subagent-runtime.ts` imports that owner directly. The adapter's helper re-exports are explicitly characterized for compatibility, so they were not removed as incidental cleanup.
- The public PiSessionAdapter test seam selected earlier remains intact; no code or test change is needed for this boundary in this audit.

## Slice 151: Pi persisted-fork owner

- Re-audited `PiSessionAdapter` through its public command/event interface. The root/child refresh coordinator and event/run-state transition handler remain cohesive with lifecycle ownership; splitting either would require a broad callback/state surface, so neither was extracted.
- The persisted fork workflow was a narrower use case embedded in the facade: source/root/scope validation, safe-file checks, plain-assistant anchor validation, crash-retry target verification, exclusive copy, temporary SDK artifact cleanup, and target-session opening.
- Moved that workflow to `session-fork-runtime.ts`. Its internal dependencies are limited to source-session lookup, the Pi SDK loader, and a callback into the existing target `openInternal` path. `PiSessionAdapter.fork()` retains the source-session lifecycle queue; the session command/event contract and compatibility export of `assertPiForkTargetMatches` remain unchanged.
- Added an interface-level persisted-fork test using the real Pi `SessionManager` with a deterministic fake `createAgentSession`: the branch gets a distinct native file and anchored leaf, the source session leaf stays put, and the target emits `session.opened`.
- Host authorization/dispatch, runtime routing, resource policy, and external behavior were not changed. The new owner remains Pi-only and does not introduce a new public test seam.

## Pi session-import command owner candidate

- The current adapter already owns import materialization in `session-import.ts`, but `importSessionInternal` still coordinates the higher-level Host-to-Pi transaction: same-cwd validation, live-session replacement without `session.closed`, optional backup selection, reopen without early lifecycle acknowledgement, then ordered `session.imported` → `session.opened` → warning events.
- Existing `session-import.test.mjs` covers materialization and backups directly; no test currently invokes `PiSessionAdapter.importSession()` through the selected public command/event seam. The Host journal requires the import event to arrive before the normal open acknowledgement so the Host can atomically switch the persisted binding.
- Selected through the already-agreed `PiSessionAdapter` command/event seam; a characterization test passed against the original implementation before extraction. Preserve source-session lifecycle queue, Host journal authorization, explicit backup, and original `openInternal`/`closeInternal` paths. Completed as Slice 152 below without adding a new public seam.

## Slice 152: Pi session-import transaction owner

- Moved the Host-to-Pi import transaction from `PiSessionAdapter.importSessionInternal()` into `session-import-runtime.ts`; `session-import.ts` continues to own plan validation and atomic native JSONL materialization.
- The owner receives source-session lookup, narrowly scoped existing close/open callbacks, and the existing worker emitter. The facade keeps the selected public command/event interface and per-session lifecycle queue; Host journal authorization and persistence remain Host-owned.
- Added a public-command characterization test for replacing an existing persisted session. It verifies an explicit backup, fresh native session identity, suppression of `session.closed`, and ordered `session.imported` -> `session.opened` -> warning events.
- The test preserves the Host handoff contract: the import event switches the durable binding before the worker emits the ordinary open acknowledgement. No Pi-only routing, security authorization, error codes, or protocol shapes changed.

## Slice 153: Pi session configuration transaction owner

- The existing `PiSessionAdapter.configure()` command boundary is already the selected lifecycle test seam, and its interface-level suite passes 27/27 before this change. The current test `validates the complete session configuration before mutating Pi` covers rejected partial model changes, invalid session modes, permission update, revision increment, and the emitted `session.configured` event.
- `configureInternal()` is a cohesive cross-owner transaction: expected-revision and no-op rejection; validation of all supplied values before mutation; model resolution and Pi model/settings changes; session mode, permission, model and reasoning projection; revision commit; then one configuration acknowledgement.
- A `PiSessionConfigurationRuntime` can own that transaction behind `configure(command, requestId)` with only the existing session lookup, model-catalog operations, and worker emitter. The adapter should retain only the public command and per-session lifecycle queue. This deepens an existing command module; it does not create another public test seam or duplicate model catalog policy.
- Preserve the exact validation-before-mutation property and event payload/order. Keep Host authority, Pi runtime selection, model-catalog lifecycle and session lifecycle queue in their current owners.
- The first combined planning patch missed the exact Slice 152 finding text and applied no changes; after reading the actual file tail, the corrected Slice 153 audit and implementation plan were added successfully.
- Extracted the transaction into `session-configuration-runtime.ts`; `PiSessionAdapter.configure()` now queues and delegates through the established public command/event seam. The owner receives only session lookup, the two required model-catalog operations, and the emitter. No public seam, Host permission decision, model-catalog lifecycle, or protocol behavior changed.
- Baseline and post-extraction adapter suites both passed 27/27; full worker tests 182/182, root unit tests 457/457, `pnpm check` including Pi compatibility 109/109, architecture 5/5, lint, format, production build, and `git diff --check` passed. Build retains the existing >500 kB chunk warning.
- Updated the Pi migration handoff code map. The initial aggregate implementation patch did not match the adapter method context and applied nothing; after re-reading current source, the exact old method range was removed with `apply_patch`.

## Slice 154: Pi attachment turn-input preparation owner

- `attachment-policy.ts` already owns model image-modality checks, per-file decoding, and the 10 MiB single-attachment ceiling. `PiSessionAdapter.submit()` still owns the 25 MiB aggregate decoded-byte check, image/text collection, and prompt attachment projection, splitting one input contract across policy and command orchestration.
- The adapter submit implementation checks modality before decoding, rejects aggregate overflow before idempotency claim and `run.accepted`, then places text attachments after the user content while forwarding image blocks separately. These ordering and presentation details must remain unchanged.
- Existing direct helper tests exercise attachment policy through adapter compatibility exports, but there is no aggregate-overflow assertion through the selected public `PiSessionAdapter.submit()` seam. Add one characterization there before deepening the existing owner; do not introduce a new adapter or owner-test seam.
- The dependency is in-process and existing: move the aggregate preparation into `attachment-policy.ts` as a single prepared-input operation. Keep the existing individual helper exports for compatibility, and keep run admission, idempotency, event ordering, Host policy, and runtime routing in the adapter.
- Added the public submit characterization before extraction; it passed the original implementation and confirms 25 MiB + 1 byte is rejected before `run.accepted` and `Pi.prompt()`.
- Implemented `preparePiTurnAttachments()` in the existing owner and changed submit to consume its `{content, images}` result. A second public submit test checks text placement and image delivery. The adapter suite passes 29/29, worker tests 184/184, root unit 459/459, `pnpm check` including Pi compatibility 109/109, architecture 5/5, lint, format, production build, and `git diff --check`; existing >500 kB chunk warning remains.
- Updated the migration handoff ownership map. One parallel root-unit run hit a Research source-adapter timing assertion at 24ms vs 25ms; the isolated assertion and subsequent complete root suite passed. No Research implementation was changed.
- Pi-only runtime, Host security/authorization, command payloads, run admission/idempotency ordering, and external behavior remain unchanged. No new test seam or owner module was introduced.
- A first test attempt expected a backup from an empty native session and failed because the fixture had not persisted a file; adding a real user entry established the precondition and the baseline then passed.

## Slice 155: Pi session close lifecycle owner

- `PiSessionAdapter.close()` already provides the selected public command/event seam. The close workflow is also reused by `PiSessionImportRuntime` with `emitLifecycle=false` so the Host can switch its persisted Pi binding at `session.imported` before any ordinary open acknowledgement.
- Added a running-session close characterization through that existing seam and passed it against the original implementation before extraction. It checks one Pi abort, exactly one cancelled run terminal event carrying the close reason, and `session.closed` after the run terminal event.
- Moved session lookup, child cancellation, run finalization before abort, queue clearing, best-effort abort, listener/session disposal, idempotency clearing, session-map removal, and optional ordered lifecycle emission into `session-close-runtime.ts`. `PiSessionAdapter` retains lifecycle serialization; public close and import call the same owner.
- Validation after extraction: adapter suite 30/30, worker tests 185/185, root unit tests 460/460, `pnpm check` including Pi compatibility 109/109 and packaging, architecture 5/5, lint, format, production build, and `git diff --check` passed. Build retains the pre-existing >500 kB chunk warning.
- A parallel read-only audit found the current `workspace_tools` cases intentionally cross `resolve_request`: they exercise Host path/gitignore/permission policy, protocol envelopes, mutation atomicity, and user-visible workspace outputs together. Keep them at the gateway seam instead of moving assertions into private child-function tests. This closes the ownership audit without weakening Host-policy coverage or creating another seam.
- Pi-only runtime routing, Host authorization, command/event shapes, import binding order, and release state remain unchanged. The broader repository goal stays active/incomplete; the unconfirmed Workspace-store, Host-router, and view-projection test seams remain open.

## Slice 156: persisted Pi subagent resume test boundary

- `PiSubagentRuntime` already exposes the selected `spawnSubagent()` lifecycle seam with an injected Pi SDK adapter. Its owner-level test covered fresh spawn, completed-task wait, stream identity, and cross-root task denial; `subagent-records.test.mjs` covered sidecar validation separately, but no test exercised the runtime's durable `resume_from` path across those owners.
- Added a direct interface test that creates a real sidecar and transcript under a temporary Pi session root, then resumes through `spawnSubagent({ continueExisting: true, resumeFrom })`. It verifies the existing task identity and file are reopened, saved model/reasoning are retained, only the continuation prompt is submitted, and the completed task event retains `resumedFrom`.
- The test observes the returned task, injected SDK `SessionManager.open()` adapter, submitted prompt, and emitted lifecycle events; it does not read the runtime's private maps or add another seam. Production code and Host/worker authorization paths were unchanged.
- `pnpm check` including Pi compatibility 109/109, worker tests 186/186, root unit tests 461/461, lint, format, and `git diff --check` pass. No build was necessary for this test-only slice.

## Slice 157: Config facade test ownership

- `config_runtime.rs` contained 21 tests in its facade-level `tests` module, but each test directly called an implementation helper from one of six child owners: extension discovery, marketplace sources, plugin/skill details, Pi resource inventory/scanning, config patching, or marketplace response projection.
- These tests did not exercise `config_runtime` command authorization or its `pi_resource_manifest` composition. Keeping them in the facade made owner changes require editing a distant test module while implying broader facade coverage than the assertions provided.
- Moved the existing tests without changing their bodies or assertions: 2 to `config_extensions.rs`, 3 to `config_marketplace_sources.rs`, 7 to `config_plugin_details.rs`, 4 to `config_pi_resources.rs`, 2 to `config_core.rs`, and 3 to `config_marketplace_native.rs`. Existing `config_extensions` scanner test use required retaining only the `scan_pi_skill_root` test re-export.
- Validation: baseline facade tests 21/21; after movement full Rust library tests 369/369, warning-free `cargo check --locked --lib`, `cargo fmt --check`, and `git diff --check` pass.
- Evidence boundary: no Tauri command authorization/ordering assertion was introduced, and these tests do not verify Host routing, Pi-only selection, or `pi_resource_manifest` wiring. No production behavior changed.

## Slice 158: Pi Hook configuration and execution owners

- `pi_hook_runtime.rs` combined two caller paths: `config_runtime::list_melody_hooks` parses and inventories untrusted Hook definitions for capability preflight, while `host_tool_routing` invokes the Host command runner after workspace authorization. Their shared `HookSpec` is the configuration owner’s validated output; execution consumes it.
- Split the implementation into `pi_hook_runtime/hook_config.rs` (trusted roots, symlink/regular-file/size checks, JSON parsing, unsupported-field inventory and preflight snapshots) and `pi_hook_runtime/hook_execution.rs` (event payload projection, matcher, process lifecycle, environment/input/output/time bounds, and PreToolUse structured decision). The 53-line parent is now a crate compatibility facade; existing crate-level import paths remain valid through re-exports.
- Moved parser/preflight and matcher tests next to their owners; kept the end-to-end PreToolUse denial test at the facade. `PiWorkerRuntime`/`HostToolRouting` were not changed: authorization still precedes PreToolUse; persisted permission and normal gateway follow; resolution is delivered before observational post hooks.
- Updated `check-pi-compatibility.mjs` to load both owners. `pi-hooks-compatibility.mjs` now verifies parent wiring, config-to-execution parser use, Host command/preflight routes, worker routing, and the seven numeric limits at their owning files; fixtures cover missing owner wiring and drift.
- Validation: Hook Rust tests 3/3; Hook source-compatibility fixtures 8/8; full Rust library 369/369; warning-free Cargo check; Rust fmt; `pnpm check` with Pi/Tauri fixtures 109/109; root unit 461/461; lint, format, and `git diff --check` pass.
- Scope limit: this proves the existing bounded bridge and compatibility wiring, not full semantic equivalence with other Hook runtimes. Host authorization, Pi-only routing, timeout/output semantics, and event ordering did not change.

## Slice 159: Pi monitor bounded-output owner

- The Host monitor runtime combined process lifecycle/registry/session ownership with rolling line admission, per-line UTF-8 truncation, and the bounded output tail. The latter policy is a cohesive resource-control owner used by reader threads and snapshot projection; it does not own task authorization or process state.
- Added `pi_monitor_runtime/output.rs` with a narrow `MonitorOutput` interface: record/admit one line, record a lifecycle notice without charging the process-output budget, and project emitted count/tail. It owns the 120-line rolling window, 10,000-line lifetime limit, 4 KiB line cap, and 200-line tail. Parent runtime retains `MonitorStatus`, task registry, session ownership, cancellation, sandboxed process creation, reader/waiter lifecycle, and stop-event coordination.
- Existing `start_monitor` event/snapshot integration tests remain at the runtime seam. The two preexisting bounded-policy tests moved to the output owner; assertions and limit behavior were preserved. No new external test interface was added.
- Baseline monitor tests 6/6. After extraction runtime integration 4/4, output owner 2/2, full Rust library 369/369, warning-free `cargo check --lib`, Rust fmt check, `pnpm check` (110 compatibility fixtures), lint, format, and `git diff --check` passed. The supported-host sandbox test emitted the existing environment message `sandbox_apply: Operation not permitted` and followed its existing skip-safe path.
- Evidence boundary: this confirms the bounded-output policy and current runtime integration only. It does not establish new Host authorization or sandbox guarantees, and none of those policies or monitor event/stop semantics were changed.

## Slice 160: Pi subagent policy normalization owner

- `subagent-policy.ts` mixed two independently consumed responsibilities: parsing/bounding Host-projected policy snapshots and launch aliases, versus selecting policy defaults and projecting a child launch under parent ceilings. The policy/resume callers consume the latter; resource snapshot, ToolGateway, durable records, and boundary/task types consume the former.
- Moved bounded manifest parsing, role/persona/agent field validation, MCP name/grant limits, built-in type checks, and capability/isolation alias normalization into `subagent-policy-normalization.ts`. The existing `subagent-policy.ts` remains the owner of default resolution, parent-child permission/capability intersection, launch projection, and prompt composition.
- Kept the former module path's established normalization exports as compatibility re-exports. Internal runtime callers now import from the actual normalization owner; runtime orchestration remains in `subagent-runtime.ts` and Host authorization remains outside the worker.
- Updated `check-pi-compatibility.mjs` to read both owners, verify parser/policy wiring and compatibility exports, and supply both source snapshots to the existing Host-worker MCP contract check.
- Baseline policy tests 13/13 and source compatibility fixtures 6/6. After extraction, worker tests 186/186, root unit tests 461/461, `pnpm check` with Pi/Tauri fixtures 110/110, architecture checks, lint, format, production build, and `git diff --check` passed; build retained the existing >500 kB chunk warnings.
- Evidence boundary: no policy, error, MCP grant, permission/capability ceiling, Pi-only routing, Host authority, launch/resume or wire behavior was intentionally changed. Existing tests exercise policy behavior through the same function interface, with normalization assertions now imported directly from its owner.

## PiSubagentRuntime task-command response projection

- `waitTask` and `cancelTask` performed distinct lifecycle actions but duplicated the same `task.changed` request response projection. Their shared fields are a single stable event contract, not separate lifecycle ownership.
- Added a characterization through the existing runtime interface and verified the wait/cancel envelopes before refactoring. Both methods now delegate only event construction/emission to one private helper; wait/cancel validation, awaiting, cancellation, and status timing remain at their call sites.
- Runtime tests 3/3, worker 187/187, root unit 462/462, `pnpm check` (110 fixtures), architecture 5/5, lint, format, build, full Rust 369/369 and `cargo check` passed. Build retains the pre-existing >500 kB chunks warning.
- Evidence boundary: this is payload-drift prevention, not a new task event protocol or lifecycle change; Host authorization, runtime routing, and worker wire behavior did not change.

## Pi ToolGateway workspace-tools test ownership (user-selected)

- The user approved moving owner tests only and retaining Host authorization/dispatch integration tests in `pi_tool_gateway.rs`.
- Moved the two tests that call `workspace_tools::apply_patch` directly (all-file preflight atomicity; add/delete/move behavior) into `workspace_tools.rs` without changing their test bodies/assertions. They now live beside the implementation they specify.
- Kept read authorization, search/list/generic gitignore responses, Host gitignore precedence, mutation permission and symlink integration tests at the gateway because they exercise `resolve_request`/Host policy or response envelopes; they are not converted into private-function tests.
- Workspace owner tests 2/2 and full Rust library tests 369/369 pass; no runtime or Host authorization changes. This closes only the test-location question, not the separately unselected Host router coordination seam.

## PiSessionAdapter open/event ownership audit (Slice 163 candidate)

- `openInternal()` remains the Pi session creation/lifecycle coordinator: it checks live-session idempotency/cwd, assembles the SDK session, publishes the handle, subscribes to events, and emits `session.opened`/the disabled-builtins warning. Its creation setup crosses model catalog, tool gateway, subagent, resource-loader, persistent SessionManager, and adapter session context; extracting a second factory would require a broad dependency surface, so leave that path in the adapter for now.
- `onPiEvent()` is a separate event-lifecycle responsibility currently embedded in `session-adapter.ts`: it resolves root/child context, projects Pi events, records provider errors, enriches safe assistant leaf anchors, feeds subagent output/settlement, emits run completion/context usage, and serializes/recoveries event-tail failures in the subscription callback.
- The event owner can present one internal `enqueue(sessionId, event, context)` operation behind the existing `PiSessionAdapter.open()`/`submit()` command-event seam, with only context resolution, subagent observation, and `WorkerEmitter` dependencies. Keep session creation, registration/subscription, Host routing/authorization, and lifecycle command serialization with the adapter.
- Existing `event-mapper.test.mjs` tests pure mapping; existing adapter suites test public command/run behavior but do not pin the `agent_settled` -> single `run.finished(pi_settled)` bridge. Add that characterization through public `open()` and `submit()` before moving event ownership. This is not a new test seam and leaves the unselected Workspace store, Host router, and Workspace view-projection questions untouched.
- Preserve event root/stream/run identities, native leaf matching, `observePiEvent` order, `message_end` provider error classification, error-tail recovery, and `turn_end` context event exactly. The implementation and its validation are recorded in Slice 163 below.

## Slice 163: Pi event-lifecycle runtime owner

- Added `session-event-runtime.ts` as the single owner of Pi event serialization/projection, provider-error capture, safe native leaf anchors, subagent observation, settled/context events, and event-tail failure recovery. `PiSessionAdapter` now keeps subscription registration and exposes the existing command/event seam; `PiSubagentRuntime` routes child events through the same projector while retaining its own child-task queue/recovery.
- Added a `PiSessionAdapter.open()`/`submit()` characterization: one `agent_settled` produces exactly one `run.finished` with the established `pi_settled` reason and root/run identity. It passed before extraction and after it.
- During full worker testing, the first extraction missed the child-session callback from `PiSubagentRuntime`; the two existing child-task cancel/shutdown smoke tests timed out waiting for task events. Reconnected that callback to the event owner's direct `handle()` method (the subagent continues to serialize with its own `eventTail`); both isolated smoke cases and the full suite then passed. This failure demonstrated why the event owner must cover both root subscriptions and the existing child callback.
- Validation after the fix: adapter tests 31/31, full worker tests 188/188, root unit tests 463/463, `pnpm check` including 110 Pi/Tauri compatibility fixtures, architecture 5/5, lint, format, production build, and `git diff --check` passed. Build retains the existing >500 kB chunk warning. No Rust source changed, so Cargo was not rerun.
- Host authorization/permission decisions, Pi-only runtime selection, event root/stream/run identity, ordering, wire shape, error codes, and native leaf-anchor rules were not intentionally changed. Workspace store, Host router, and shared Workspace view-projection seams remain unselected.

## Marketplace install transaction owner audit (current slice candidate)

- Fresh checkout still contains the accumulated uncommitted beta refactor; current branch is `beta...origin/beta`, and package/Cargo/Tauri versions remain aligned at `0.4.0-beta.2`.
- `config_marketplace_native.rs` remains a 1,225-line command/transaction owner after transport, catalog, filesystem, registry, and direct-source parsing have separate child owners. Its `install_snapshot` composes safe staging/copy, target replacement, registry transaction, rollback, and backup cleanup; the same transaction is called by Marketplace candidate installs, direct local/Git installs, and local/Git updates (five production call sites).
- Existing tests already observe this function through its current module-level test interface: the registry-compatibility case installs then replaces a package and checks unknown registry fields, metadata, files, and backup cleanup; the Marketplace candidate case installs then refreshes a package and checks stable source identity/version. The filesystem owner separately tests symlink skip and managed-path deletion rules. No existing case asserts rollback after a registry write failure.
- Selected candidate for the next structural slice: move the shared install snapshot transaction behind a small child-owner interface, leave Tauri authorization, source resolution, cloning, and install/update command ordering in `config_marketplace_native.rs`, and keep safe path/filesystem primitives in their existing owner. Before extraction, characterize the failure/rollback branch through the existing module-level test surface; then relocate owner tests with the transaction.
- Preserve Host workspace authorization, managed-path deletion rules, marketplace identity, legacy/unknown registry fields, staging bounds, replacement behavior, rollback, and existing command outputs. No marketplace install/update policy change is intended.
- A deterministic rollback fixture is available without a fake filesystem port: make `registry.json` a directory. Registry load treats it as absent, while `TextFileStore`'s atomic file rename fails at commit after replacement; the current transaction restores the prior target. The new characterization passed against the pre-extraction implementation (Rust focused test 1/1).
- `check-pi-compatibility.mjs` and source checks contain no owner-location assertion for this transaction; no compatibility gate rewrite is currently needed. Use the real temporary filesystem as the local adapter and avoid adding a speculative second I/O interface.
- Completed as Slice 164: `config_marketplace_install_transaction.rs` now owns the atomic staged snapshot transaction behind `InstallSnapshotRequest` and named provenance fields. Five native command call sites use it; the command owner retains workspace authorization, source resolution, cloning, and install/update sequencing. Transaction compatibility and rollback tests moved with the owner; Marketplace source/candidate tests remain at the parent.
- Post-extraction validation: owner tests 2/2, parent candidate install/refresh 1/1, full Rust library 370/370, warning-free `cargo check --lib`, Rust fmt, `pnpm check` (110 compatibility fixtures), architecture 5/5, lint, formatting and diff checks pass. Frontend unit/build were not rerun because this slice changed only Rust and documentation.
- No Host authorization, managed-path policy, Marketplace identity, registry compatibility, Pi-only runtime, version, or external release state changed. Branch remains `beta`; no commit, push, publish, release, or `main` sync.

## Slice 165 candidate audit: PiSubagentRuntime residual lifecycle owners

- Fresh state: `beta...origin/beta`; all three application versions remain `0.4.0-beta.2`; the large accumulated dirty worktree is still present and preserved. Session catch-up exited 0 with no report. Slice 164 in the previous goal turn was progress: a new transaction owner, rollback coverage, and broad Rust/static checks.
- Planning drift found and reconciled: Slice 164's checks and completion status were already complete, but its heading still said `(进行中)`; the heading now matches the verified state.
- `packages/agent-worker/src/pi/subagent-runtime.ts` is 1,183 lines with a 320-line owner test file. Existing owners now include policy normalization/selection, session-boundary validation, durable records, Host task control, task response projection, and shared session event projection. Avoid repeating those extractions.
- Current runtime surface includes root/child context, refresh/cancel/shutdown, task snapshot and persistence, controller wait/cancel, public wait/cancel/continue, and spawn. Its options already inject the SDK loader, ToolGateway, model catalog, resource factory, event handling, and Host policy snapshots. Direct interface tests cover spawn/completion/ownership, wait/cancel envelope parity, and persisted resume; worker smoke tests cover command routing/cancel/shutdown.
- This is only an audit candidate, not a selected refactor. Inspect the remaining lifecycle methods, callers and public worker behavior coverage next; select an owner only if it reduces real responsibility coupling behind a stable seam. Explicitly avoid the still-unselected Workspace-store latest-request, Host-router coordinator, and shared Workspace view-projection seams.
- Residual methods `observePiEvent`, `refreshModelSettingsForLiveSessions`, `refreshResources`, `cancelForRootSession`, `closeAll`, record load/save, task visibility, and runtime snapshot projection are lifecycle state of the same child-session owner. The bounded-output, policy, records parsing, event projection, and Host task-control responsibilities already have specialized owners.
- `waitTasksForSession` intentionally coordinates a shared worker task namespace: it validates/deduplicates/bounds IDs, routes all-Host task batches to `HostTaskControl`, rejects mixed Host/Pi batches, and waits/projects Pi child snapshots. `cancelTaskForSession` similarly selects Host control vs. Pi child cancellation. Splitting the Host adapter again would risk reducing this to a thin forwarding layer; keep this mixed namespace semantics in view while auditing the larger spawn operation.
- Production creation is reached through the `PiSubagentRuntime` instance wired by `PiSessionAdapter` and the nested `spawnSubagent` callback; `task-tools.ts` invokes that callback for the model-facing task tools. Existing direct runtime tests use the injected Pi SDK adapter and call the same public `spawnSubagent()` interface, so characterization can stay at that established seam rather than adding an owner-local test port.
- Current owner-level behavior coverage checks foreground completion/task ownership, wait/cancel response parity, and persisted transcript resume; worker smoke coverage also exercises command routing and cancellation/shutdown. It does not directly pin event-writer failure, cancellation during initial status emission, or resume-record failure warning behavior; those are candidate lifecycle characterizations if a run owner is selected.
- `TaskHandle` already contains the run identity, root/child/session contexts, lifecycle status, resource/model refresh callbacks, event-tail queue, output and cleanup handles. The post-open owner can therefore receive a prepared task plus the initial user prompt and only three operations (`emit`, child-event observation, record persistence); its interface appears bounded, and PiSessionAdapter remains the sole production runtime adapter while the existing class-level tests exercise the same behavior seam.
- Existing worker-smoke cancellation coverage tests parent/root ownership; no test currently gates the first running-status emission and then cancels before provider prompt, leaving the documented race without a direct regression check.
- Added that characterization to the existing `PiSubagentRuntime.spawnSubagent()`/`cancelTask()` test seam. It gates the initial `subagent.changed(running)` emission, cancels the background child, and asserts no prompt, exactly one `run.finished(cancelled, parent_cancelled)`, and a terminal cancelled task projection. It passed against the current implementation (runtime suite 4/4) before extraction.
- Repo `CONTEXT.md` language confirms Agent Session and Task Launch vocabulary; no adjacent ADR was found for this worker module. This extraction keeps its existing public worker method as the behavior interface.
- `TaskHandle` extends the existing `PiSessionContext`, so the new internal module can own its task subtype and run lifecycle without changing the caller contract. Proposed single operation: activate one prepared task with the initial status prompt, a deferred child-prompt projection, `emit`, child-event observation, and record persistence. The parent retains task admission/map ownership, SDK/session/worktree setup, and foreground/background result selection.
- The new `subagent-task-lifecycle.ts` implementation now contains the prepared-task interface and existing run/cancel/event/persistence/cleanup sequence. `PiSubagentRuntime` inserts the task into its own map, then activates the owner; SDK/session/worktree setup and foreground/background result selection remain in the parent.
- The same four direct runtime behavior tests pass after the extraction, including the new cancellation race characterization; this currently verifies unchanged foreground completion/ownership, wait/cancel envelopes, and persisted resume. Static compatibility and complete worker/root gates remain pending.
- First `pnpm check` caught the now-unused parent `onPiEvent()` forwarding method after the lifecycle owner began consuming `handlePiEvent` directly. Removed that dead wrapper; the rerun passed including TypeScript, packaging, Prettier checks, all 110 compatibility/permission fixtures, and the aggregate Pi compatibility gate.
- After that correction, `pnpm test:agent-worker` passed 189/189; both existing worker smoke tests for child cancellation and shutdown remain green with the lifecycle owner wired.
- Root `pnpm test:unit` passed 464/464 after the extraction. No Rust runtime changed, so Cargo gates are not part of this slice; architecture, lint, formatting, build, and final diff/state checks remain.
- `pnpm check:architecture` passed 5/5 with module graph intact; `pnpm lint`, `pnpm format:check`, and `git diff --check` also passed. Only the production build and final state audit remain.
- Production `pnpm build` passed; Vite reported the repository's existing chunks above 500 kB, including the same large editor/vendor assets seen before this slice.
- Manual focused review confirmed the adapter still registers the task before activation, the initial status → accepted → refreshed prompt → terminal event sequence is unchanged, cancellation remains idempotent, and persistence/writer failures are caught before final task projections. No production behavior drift was found in the moved block.
- Prettier ran over task plan, findings, progress, and Pi migration handoff; all files were already formatted.
- Final state checks: `beta...origin/beta`, all three version declarations `0.4.0-beta.2`, format gate and `git diff --check` clean. The accumulated dirty worktree is preserved; no commit, push, publish, release, version bump, or `main` sync occurred.
- Updated the Pi migration handoff owner map: child task run lifecycle is separate from `PiSubagentRuntime` setup/map/controller ownership; direct runtime behavior tests remain at the existing `spawnSubagent()` seam.
- The rest of `spawnSubagent()` divides into two observable phases: setup/preparation (resume identity/scope, launch policy, admission/pruning, Host worktree request, model/resource/session-manager creation) and post-session run lifecycle (TaskHandle assembly, child event subscription, cancellation, run acceptance/prompt/terminal events, persistence warning, final task projections, foreground/background return). The latter is a plausible cohesive owner, but must not become a callback-heavy facade or move Host worktree authorization.
- The post-open run phase currently couples child `PiAgentSession` state with root event emission and durable record persistence. A worthwhile owner would need to localize terminal-event ordering, cancellation races, event-tail failure cleanup, and persistence-warning behavior behind the existing `spawnSubagent()` interface; confirm caller/test coverage and dependency count before extracting.

## Slice 166 discovery: current checkout inventory

- Current continuation state was revalidated from the worktree: `beta...origin/beta`, `0.4.0-beta.2` version trio, clean diff whitespace check, and no planning catch-up report. Preserve the accumulated dirty tree.
- The previous goal turn (Slice 165) was real progress; next action is a fresh inventory of remaining large owners and call graphs. Do not select the still-unapproved Workspace-store, Host-router, or shared Workspace-view seams merely because they recur in the plan.
- Largest remaining production owners are `pi_tool_gateway.rs` 1,275 lines (Host authorization/dispatch; keep safety authority there), `config_subagents.rs` 1,128, `pi_mcp_runtime/remote_transport.rs` 1,120, `session-adapter.ts` 1,086, `config_marketplace_native.rs` 1,082, `pi_worker_runtime.rs` 1,078, `config_extensions.rs` 1,041, and `config_pi_resources.rs` 1,027. Do not treat size as proof; choose only if the call graph reveals mixed responsibilities behind a stable seam.
- `config_subagents.rs` has only two production callers through `config_runtime`: `pi_subagent_policy_manifest(cwd)` and `list_melody_agent_definitions(registry,cwd)`. Internally it combines ordered user/project/plugin definition discovery and inventory, role/persona/agent normalization, manifest projection/environment overrides, and UI-list projection. Markdown syntax parsing and bounded prompt-file IO already have separate owners. A source-inventory owner is a candidate, but inspect exact precedence/error behavior and the public policy/list results before selecting it.
- The two agent outputs independently enumerate the same source families: manifest builds native Markdown definitions via `load_agent_definition_files`, then plugin definitions via `load_plugin_agent_definitions`; Settings inventory separately calls `collect_agent_definition_inventory` and `collect_plugin_agent_definition_inventory`. Both share `agent_definition_roots`, `agent_definition_paths`, `parse_agent_definition_entry`, and a plugin visitor, but still duplicate orchestration/traversal and maintain separate precedence code. A deep source-inventory owner could return parsed definitions plus origin/support metadata once per request, leaving policy normalization and Settings projection in `config_subagents.rs`; preserve their intentional differences (qualified plugin names, inline wins, unsupported entries and role/persona collisions).
- Host ordering is explicit: the `list_melody_agent_definitions` Tauri command delegates to a function that calls `registry.authorize(&cwd)` before filesystem/config scanning; retain that authority in the command path. Worker policy is composed in `config_runtime::pi_resource_manifest` after resource parts and before question/goal policies; preserve that evaluation/error order. Do not move either Host authorization or runtime selection into a source owner.
- Existing `config_subagents` tests mix private helper checks (TOML file parsing, shared plugin scanner, inline inventory config) and user-observable policy/list behavior (role/persona merge, project-file manifest, plugin qualification). Any source owner must be tested through the existing `config_runtime` manifest and definition-list seams; do not add another module-local test interface. Inspect current facade test coverage before selecting extraction.
- Current source confirms `config_runtime.rs` has no test module; its existing production interfaces are the manifest composer `pi_resource_manifest(cwd)` and Tauri definition-list command. The latter delegates to `config_subagents::list_melody_agent_definitions`, whose first action is `registry.authorize(&cwd)`. A possible source-inventory extraction is not selected yet: the shared path enumeration and parser are already common, while the remaining duplicate native loops are small. Before changing code, confirm whether tests may exercise the existing `pi_subagent_policy_manifest(cwd)` and authorized definition-list module interfaces, and whether a unified parsed-source inventory is worth the extra interface.
- User approved those existing behavior seams for the source-inventory candidate. One implementation/testing constraint remains under inspection: Tauri `State` has a private field and no public constructor in the installed crate, so the authorized Settings command needs a real test harness or an existing registry-backed invocation path; do not replace it with a test-only private helper.
- Slice 166 moved one `AgentDefinitionCatalog` into `src-tauri/src/config_subagent_catalog.rs` after characterization through `pi_subagent_policy_manifest` and the authorized Settings command harness. It stages native discovery at the old pre-config point for policy, loads plugin definitions at the old post-inline point, and lets Settings project native/plugins before inline entries. This preserves authority/evaluation order while eliminating parallel native and plugin projection scans; the projections deliberately retain bare-name versus `<plugin>:<agent>` rules.
- The catalog-backed authorized Settings test passes for file-to-inline replacement, scope/path, supported/unsupported status, enablement, and qualified plugin output; policy tests still cover plugin qualified plus free bare names and nested-file/inline precedence. Private scanner-loop tests were removed only after their relevant output assertions moved to the approved public seams.
- Slice 166 gates pass: Rust library 370/370, warning-free Cargo check, Rust fmt, `pnpm check` (110 fixtures), architecture 5/5, lint, formatting, and diff checks. One existing sandbox test emitted a platform permission diagnostic but passed; no claim about target-platform sandbox enforcement is made.

## Slice 167 discovery: Pi plugin catalog candidate

- `config_extensions.rs` currently combines generic extension commands/scans with a cohesive plugin catalog cluster: `PluginEnablement`, `plugin_identity`, source-root discovery (native/project, user, and configured roots), bounded/symlink-safe traversal, capability parsing through `config_plugin_details`, and scope-based duplicate resolution. This cluster is consumed by the Pi capability command/resource projection, extension listing, Marketplace installed-plugin listing, and plugin-agent/resource roots.
- A focused `config_plugin_catalog.rs` child owner can own the catalog while `config_extensions` retains generic Skill/Hook scanning and settings command orchestration. Keep `PluginEnablement` and `pi_plugin_resources(cwd)` available through the existing facade so current callers keep their contract; do not move the `config_plugin_details` parser or Host `WorkspaceRegistry` authorization.
- Preserve exact current behavior: user/project array replacement semantics, `<scope>/<hex8>/<name>` identity, `disabled` wins, explicit opt-in for installed plugins, configured `[plugins].paths` auto-enabled unless disabled, root/depth/entry bounds, symlink rejection, deduplication/sorting/name conflict rules, and static-vs-dynamic capability projection.
- User approved two existing Tauri behavior seams for characterization: `list_melody_plugin_capabilities` and Marketplace `list_installed_melody_plugins`. Tests must use the real authorized command functions with `tauri::test::mock_builder`; do not add a test-only production port.
- The Marketplace command reads `MELODY_HOME` user config and install registry. Since Rust environment variables are process-global and other tests mutate them, isolate this command test in a child test process rather than adding an unsynchronized `set_var` to the parallel suite. The capability command can use an isolated temporary workspace and unique plugin names without environment mutation.
- `scripts/pi-resource-compatibility.mjs` currently couples plugin numeric bounds/activation checks to `sources.hostExtensions`; change it to inspect a dedicated catalog source while retaining separate `hostExtensions` checks for facade `pi_plugin_resources` wiring and shared `MAX_PI_SKILL_IGNORE_BYTES` ownership.

## Slice 167 complete: Pi plugin catalog owner

- `config_plugin_catalog.rs` now owns effective plugin enablement, stable identity, bounded native/configured root discovery, symlink-safe traversal, deduplication/name precedence, capability inventory and `pi_plugin_resources(cwd)`. `config_extensions.rs` remains the compatibility facade and owns generic Skill/Hook scan/settings orchestration; `config_plugin_details.rs` remains the lower-level parser.
- Existing command order and boundaries are preserved: capability listing authorizes the workspace before catalog use, Marketplace and extension projections use the shared inventory, configured plugin paths retain implicit activation, explicit disable wins, and parser/dynamic-surface classification is unchanged. Two pre-extraction authorized-command characterizations are retained as the behavior guard; former private scanner-loop tests were removed after output behavior moved to those seams.
- The Pi resource checker now reads plugin bounds and activation from `config_plugin_catalog.rs`, while still checking facade `pi_plugin_resources` wiring and `MAX_PI_SKILL_IGNORE_BYTES` in its original owner. The aggregate checker tests module wiring.
- Validation passed: Rust library 365/365; warning-free locked `cargo check --lib`; Rust fmt; `pnpm check` with 111 compatibility/permission fixtures; architecture 5/5; lint; format; `git diff --check`. The edited fixture's initial Prettier failure was corrected. No UI/build gate was needed for this Rust/script/docs slice.

## Slice 168 discovery: Skill detail and path-policy owner

- A fresh source-size audit showed `config_plugin_details.rs` at 950 lines. Plugin manifest/capability/detail parsing is distinct from Skill `SKILL.md` frontmatter, bounded recursive file inventory, and direct-child allowed-root policy. `config_extensions` commands own workspace authorization and Skill catalog membership; the Pi resource projection calls the Skill description and deletability helpers.
- Existing interfaces are sufficient: `get_melody_skill_details` validates catalog membership before projecting metadata, while `delete_melody_skill` authorizes the workspace before applying allowed-root policy. Characterization through these commands avoids a test-only production port and keeps Host authority at the existing command facade.
- Slice 168 extracts Skill Markdown/details/file/path policy implementation into `config_skill_details.rs`; `config_plugin_details.rs` retains plugin manifest/capability/detail behavior. `config_runtime` declares both sibling owners, while `config_extensions` and `config_pi_resources` use the Skill owner directly. Error text, the 1 MiB Markdown bound, depth/file caps, sorting and no-symlink traversal stay unchanged.
- Before extraction, the authorized detail/delete command tests passed 2/2. After extraction they still pass 2/2; plugin detail tests remain 5/5. Full validation passed: Rust library 365/365, warning-free `cargo check --locked --lib`, Rust fmt, `pnpm check` with 111 compatibility/permission fixtures, architecture 5/5, lint, format, and diff check. `beta` and all three `0.4.0-beta.2` declarations remain unchanged.

## Slice 169 discovery and completion: Pi prompt resource owner

- `config_pi_resources.rs` had two distinct discovery policies: recursive bounded Skill traversal and flat command prompt-template scanning/root policy. Prompt behavior already had stable consumers through `config_runtime::pi_prompt_paths` and `config_runtime::pi_resource_manifest`; these seams can verify the change without introducing a test-only interface.
- Added a pre-extraction facade characterization for sorted flat Markdown projection, the 512-path bound, disabled names, oversized files, nested files and symlinks, plus the runtime root snapshot that retains disabled prompt names. Baseline passed 1/1.
- `config_prompt_resources.rs` now owns prompt scanner bounds, command-root ordering (project/user/static plugin), disabled-name snapshots and concrete path projection. `config_extensions` retains the existing `pi_prompt_paths` re-export; `config_pi_resources` retains Skill traversal, resource projection and manifest-parts composition. `config_runtime::pi_resource_manifest` composition/evaluation order is unchanged.
- Removed two private prompt-scanner tests after the existing facade characterization covered their behavior; Skill implementation-local tests remain with the Skill resource owner. Added Host prompt numeric-bound checks to the Pi compatibility checker and fixture, so Host path/file/aggregate caps track the compatibility manifest as well as worker bounds; an aggregate checker test now guards the new Host owner wiring.
- Validation passed: focused facade test 1/1; full Rust library 364/364; warning-free locked `cargo check --lib`; `pnpm check` (113 compatibility/permission fixtures); Pi compatibility; architecture 5/5; ESLint; repository and planning Markdown format; `git diff --check`. Branch remains `beta` and version trio remains `0.4.0-beta.2`; no release/publish/main sync occurred.

## Slice 167 complete: Pi plugin catalog owner

- `config_plugin_catalog.rs` now owns effective plugin enablement, stable identity, bounded native/configured root discovery, symlink-safe traversal, deduplication/name precedence, capability inventory and `pi_plugin_resources(cwd)`. `config_extensions.rs` remains the compatibility facade and owns generic Skill/Hook scan/settings orchestration; `config_plugin_details.rs` remains the low-level parser and path-safety helper owner.
- Existing command order and boundaries are preserved: capability listing authorizes the workspace before catalog use, Marketplace and extension projections use the shared inventory, configured plugin paths retain their implicit activation rule, explicit disable still wins, and parser/dynamic-surface classification is unchanged. The two pre-extraction authorized-command characterizations remain the behavior guard; the former private scanner-loop tests were removed after their output behavior was covered there.
- The Pi resource checker now reads plugin bounds and activation from `config_plugin_catalog.rs`, but still checks facade `pi_plugin_resources` wiring and the separate `MAX_PI_SKILL_IGNORE_BYTES` owner. The aggregate checker tests that the catalog module remains wired.
- Validation passed: focused `config_extensions::tests` 5/5 after extraction; Rust library 365/365; warning-free `cargo check --locked --lib`; Rust fmt; `pnpm check` including 111 compatibility/permission fixtures; architecture 5/5; lint; format; `git diff --check`. One initial Prettier check failed on the updated fixture and passed after formatting. No UI/build gate was needed for this Rust/script/docs slice.

## Slice 170 complete: apply_patch owner

- The patch parser and file-operation planner form a cohesive policy/transaction cluster inside `workspace_tools.rs`: they share one `apply_patch(root, arguments)` entry point and own patch grammar, path validation, all-file preflight, bounded file reads/writes and add/update/delete/move behavior. Existing direct owner tests exercise preflight atomicity and lifecycle operations; gateway tests separately exercise permission, Host gitignore override and symlink rejection.
- Moved that implementation and its two existing tests to `src-tauri/src/pi_tool_gateway/workspace_tools/patch.rs`. `workspace_tools::apply_patch` remains the same re-exported interface; shared path/gitignore/write helpers remain private to the parent implementation and Host authorization, policy override, mutation lock and dispatch remain in `pi_tool_gateway.rs`.
- Validation passed: patch owner tests 2/2, gateway tests 25/25, Rust library 364/364, warning-free `cargo check --locked --lib`, `cargo fmt -- --check`, plus repository `pnpm check`, architecture, lint, format and `git diff --check` gates. The first compile correctly exposed an insufficient child-module visibility on the re-export; it was narrowed to the gateway subtree. The first fmt invocation used an unsupported `--locked` flag and was rerun with the correct Cargo fmt syntax.
- Branch/version state remains `beta` / `0.4.0-beta.2` across package, Cargo and Tauri configuration. Existing accumulated work remains uncommitted and untouched outside the selected slice; no release, publish or `main` sync.

## Slice 171 complete: agent-contract resource manifest validator owner

- The 836-line validation module combined command-envelope dispatch, ordinary command checks, shared input helpers and the bounded Host resource-manifest schema. Resource roots, question timeout, subagent policies and goal policy form one cohesive validation responsibility invoked only by the existing command dispatcher.
- Moved that implementation and its numeric bounds into validation/resource-manifest.ts. validation/shared.ts now owns the reusable record/string/permission/control-character primitives; validation.ts retains the public command-envelope validator, dispatch order and the same control-character exports through a re-export.
- The existing validation.test.mjs suite remains at the validateAgentCommandEnvelope seam and continues to cover valid/invalid resource refresh, all Host-projected subagent modes, and adjacent command contracts. No test-only interface or new implementation-coupled test was added.
- Added nested validation modules to the package formatting command/check globs so the new owner is covered by repository format verification.
- Validation passed: contract tests 4/4, contract and worker TypeScript checks, pnpm check with 113 compatibility/permission fixtures, root unit tests 464/464, architecture tests 5/5, lint, format:check, and git diff --check. Current checkout remains beta with aligned 0.4.0-beta.2 declarations; no commit, push, publish, release or main sync.

## Slice 172 complete: Agent session binding Host preflight owner

- `database_agent_bindings.rs` mixed binding CRUD/Tauri handlers with persisted Pi session admission checks. The latter form one policy owner because open, command, import, fork, and workspace checks share bounded session identity and persisted SQLite ownership/engine facts; production callers include worker command forwarding and fork/event handling.
- Extracted `required_id`, its 256-byte cap, import-plan byte/record caps, and `validate_pi_session_{open,import,command,fork,workspace}` into `database_agent_bindings/preflight.rs`. The child is independent of the binding parent; `database_agent_bindings.rs` imports the shared ID check for CRUD validation and re-exports the same crate-level admission functions.
- Existing binding and fork behavior tests remain at their previous interfaces and unchanged call paths: 7/7 and 2/2 passed both before and after extraction. No test-only interface or new behavior test was introduced. Host remains authoritative for product session/workspace/engine admission and bounded migration input.
- Validation passed: Rust library 364/364, warning-free `cargo check --locked --lib`, Rust fmt, `pnpm check` (113 compatibility/permission fixtures), architecture 5/5, lint, Prettier format and `git diff --check`. No frontend unit/build gate was needed for this Rust/docs-only slice.

## Slice 173 discovery: Pi runtime capability policy owner

- The current 2,076-line `scripts/check-pi-compatibility.mjs` is a composition gate for many focused compatibility owners, but its Pi runtime capability section still combines structured policy with package/source checks and an actual Node subprocess probe of `PI_CAPABILITIES`.
- The structured portion has a cohesive, pure interface candidate: compare declared and observed tool sets; reject runtime fallback metadata/claims in limitations, diagnostics, or Host bridge declarations; and ensure Browser capability limitations are present and accurate. Keep dependency/source-marker checks, subprocess launch, JSON decoding, filesystem reads, and aggregate diagnostic output in the entrypoint.
- Existing `scripts/check-pi-compatibility.test.mjs` tests fail-closed JSON roots and selected wiring through the real CLI, but do not assert negative cases for this capability policy. Current baseline passed 10/10 CLI tests and the real aggregate checker.
- Proposed test seam: `checkPiRuntimeCapabilityPolicy({ declared, observed }) -> diagnostics`. The fixture would test policy only; the aggregate gate must retain the real worker import probe so fixtures are not misrepresented as runtime/tool execution evidence.
- This candidate is pending explicit seam confirmation under the TDD guidance. No source or test changes were made. The separate Explorer fork-reference seam request also remains unanswered; no authorization or security path was moved.

## Agent migration journal owner audit

- `database_agent_migrations.rs` coordinates one durable conversion state machine: begin/idempotent retry, failed-attempt identity, plan and backup matching, worker import preflight, and the atomic `session.imported` completion that updates the engine binding.
- Production entrypoints are the Tauri begin/list/fail commands, `pi_worker_runtime::session_commands` import validation, and `database_agent_events` transaction completion. Stage names, plan/fingerprint identity, backup choice, migration ID, and SQLite transaction ordering are shared invariants across these paths.
- The current six owner tests pass, but they call private `begin_pi_migration_inner`/`complete_pi_migration_tx` helpers and directly seed/update SQLite. This is useful local state-machine coverage, not a public Tauri/worker behavior seam.
- Decision: keep the migration journal as one cohesive owner. Splitting request checks from persistence or separating SQL CRUD would make the shared state contract less local and create a shallow handoff; no code or tests changed. Any future public behavior-test expansion needs a user-confirmed command/event seam.

## Workspace sandbox owner re-audit

- Current source layout is already responsibility-oriented: `workspace_sandbox/profile.rs` owns profile/config/path resolution; `workspace_sandbox/seatbelt.rs` and `workspace_sandbox/landlock.rs` own OS-specific command/enforcement adapters; `workspace_sandbox.rs` is the shared Host coordinator.
- The parent owns the security-critical single `sandbox_decision` fail-closed path, read-only/read-write/device-sink conflict policy, Tauri workspace authorization/preflight, and the single `sandboxed_shell_command` used by terminal and monitor callers. Splitting decision policy by OS would duplicate or diffuse authority; splitting the small renderer/plan projection would create shallow modules.
- Existing user-approved tests already exercise overlap rejection through `sandbox_decision` and command policy through `sandboxed_shell_command`; no additional test seam or product behavior is needed for this audit.
- Current parent/child source sizes are 568/421/115/347 lines (`workspace_sandbox.rs`, `profile.rs`, `seatbelt.rs`, `landlock.rs`). Raw line count does not reveal a remaining mixed owner here.
- Validation limits remain explicit: the current Rust host only has `aarch64-apple-darwin`; Linux Landlock is not compiled/executed here, and nested `/usr/bin/sandbox-exec` returns the outer-environment `sandbox_apply: Operation not permitted`. This audit makes no cross-platform enforcement claim.
- Decision: no further sandbox extraction. Continue the full repo audit on a different owner; preserve Host authorization and common fail-closed decisions.

## Recovery, schedule dispatch, and session-projection owner re-audit

- `database_agent_recovery.rs` is a read-only Host snapshot: binding applicability, bounded event scan, lifecycle accumulator, safe payload-free output, action, and reasons are derived from one session state. Separating the event reducer from the snapshot policy would expose internal accumulator state and make safety conclusions less local; no extraction selected.
- `schedule_dispatch.rs` (712 LOC including tests) is one dispatch lifecycle from due-schedule claim through live session/binding policy, per-session single-flight claim, permission narrowing, worker result acknowledgement, journal recording, and loop scheduling. Its independent calendar/interval advancement policy already lives in `database_agent_schedules/policy.rs`; the remaining pure helpers do not justify another module.
- `pi-session-import.ts` is one bounded import-plan conversion pipeline with `buildPiSessionImportPlan` and the existing session-bound wrapper. Host durable session admission is already a separate Rust preflight owner; splitting individual parser/converter helpers would add a shallow handoff.
- `session-projection-updates.ts` remains the `applySessionUpdate` timeline/lifecycle owner after message streaming, tool activity/text, and billing usage were moved to their respective owners. Its remaining event ordering/state mutation is shared, not a new independent projection.
- A concrete cross-layer contract gap remains in Pi recovery response validation: Rust `MAX_RECOVERY_ID_BYTES = 256` checks UTF-8 byte length, while the renderer's `MAX_ID_LENGTH = 256` checks JavaScript string code units. The renderer therefore accepts a wider malformed-response domain; this is not evidence that the current Host emits such values. The compatibility manifest/checker has no recovery contract group.
- This could be hardened through the existing `parsePiRecoveryPlan` interface and the Host recovery command seam, plus a source-contract drift fixture. That new behavior-test/contract scope has not been confirmed; no runtime or tests changed. Do not use this gap to claim active user data corruption or a security exploit.

## Workspace bridge and Pi migration candidate (Slice 177 discovery)

- Prior source audit located `src/lib/melody-bridge-workspace.ts` as a mixed bridge owner: project/session operations, Pi fork lifecycle, migration reporting/planning/journal helpers, and workspace filesystem/terminal wrappers. This is a candidate map, not a decision to extract by file size.
- The prior call-site scan found live consumers for `readPiSessionForkReference` and migration begin/fail operations, while several report/plan/journal helpers and `migrateStoredSessionToPi` had no direct application source callers. Lack of internal callers alone is insufficient grounds to delete an exported bridge surface.
- The explicit `migrateStoredSessionToPi` helper and `agent-store-session.ts` legacy import lifecycle appear to overlap but have different ordering: the store path handles admission/preflight, setup timeout, and event acknowledgement, whereas the bridge helper starts/sends directly. Treating them as one owner without confirming the lifecycle contract could change behavior.
- No `melody-bridge-workspace` behavior suite was identified in the prior audit. Re-open source and test/call graph before choosing a seam; no code or test changes are selected yet.

### Current-source recheck

- `agent-store-session.ts::beginAgentSession` is the active legacy import path. It restores archive/snapshot state, checks timeline completeness, builds the bounded import plan, reads Host binding defaults, journals with backup enabled, sends `session.import`, arms the existing setup timeout, and relies on the established event lifecycle for eventual settlement.
- `migrateStoredSessionToPi` instead reads its own stored-session plan, journals, starts the worker, sends `session.import`, and returns immediately after send. It does not await an import/open acknowledgement or arm the store setup timeout. Consolidating these paths requires explicitly preserving the store lifecycle and cannot be done as a mechanical helper call.
- `agent-session-routing.test.mjs` invokes the production `beginAgentSession()` owner, but its current cases cover Pi/preview client routing and product-vs-ACP session IDs only. It does not characterize migration journal inputs, imported-command ordering, setup timeout, or event settlement.
- Historical user confirmation of `beginAgentSession()` was limited to runtime routing and ID semantics. It is not approval to expand the behavior-test scope to migration lifecycle. No existing migration seam authorization was found in the user-message search.
- Migration subcandidate status: `beginAgentSession()` remains a store-owned activation lifecycle with no confirmed migration-test expansion; do not merge it with the bridge helper based on similarity alone.
- The existing worker contract test exercises `PiSessionAdapter.importSession()` and asserts `session.imported` precedes `session.opened` (with the following warning order), so Host migration completion/binding handoff has an established command/event seam. It does not include the renderer `beginAgentSession()` preparation, model/permission projection, or setup-timeout behavior.
- The Explorer UI owner already has injected dependency behavior tests, while the documented Explorer fork-reference seam request is still open. Do not fold that UI/fork seam into this migration decision.
- A more promising deep owner within the same mixed bridge is the existing `forkPiSession(source, target, nativeEntryId)` production interface. Its implementation coordinates durable Host fork intent, Pi worker startup, binding lookup, event subscription, source open acknowledgement, target fork acknowledgement, timeout/error propagation, and listener cleanup. The renderer Explorer tests inject/mock this function and therefore do not test that lifecycle.
- The user explicitly approved `forkPiSession(source, target, nativeEntryId)` as the behavior-test seam and requested test-first lifecycle extraction. Scope is the existing production interface only: no test-only production port and no movement of Host authorization.

## Pi Explorer fork lifecycle owner (Slice 178)

- Added `src/lib/melody-bridge-pi-fork.ts` as the renderer owner for Pi worker startup, source-open/fork acknowledgements, timeout/error propagation, and event listener cleanup. `melody-bridge-workspace.ts` preserves its existing `forkPiSession()` re-export and all current consumer imports remain valid.
- The behavior tests exercise the existing production seam through the bridge facade and fake Tauri IPC/event boundary, now colocated in the already-registered `agent-session-routing.test.mjs` Vite SSR suite. They cover Host fork intent, open-before-fork sequencing, identities/binding, matching `runtime.error`, missing source-open acknowledgement timeout, suppression of target fork on failure, and both cleanup layers.
- `package.json` includes the owner in formatter lists; its test remains covered by the existing unit/formatter entries for `agent-session-routing.test.mjs`. No Host authorization moved and no test-only production port was introduced.
- Validation passed: success-path pre-extraction baseline 1/1; the colocated owner scenarios pass 3/3. Full `pnpm test:unit` passes 467/467 without the prior second-Vite-server port warning. `pnpm check` (113 compatibility/permission fixtures), architecture 5/5, ESLint, full `pnpm format:check`, production build, and whitespace check also passed. Build emits the repository's existing large-chunk warnings.

## Host Pi LSP bridge audit (Slice 179 candidate)

- `database_agent_schedules.rs` explicitly owns persistent schedule state and lifecycle claims; its policy is already in `database_agent_schedules/policy.rs`, while due-time dispatch is separately owned by `schedule_dispatch.rs`. Remaining schema, CRUD, claim, journal, and Tauri command paths share one state/transaction contract; no new storage split is indicated.
- `config_marketplace_native.rs` already delegates install transaction, catalog, filesystem, registry, transport, and plugin-source responsibilities to child owners. Its remaining scan/install/update/uninstall paths are command orchestration, not an obvious additional subsystem.
- `pi_lsp_runtime.rs` has separate config and output-projection children, but combines Host request/envelope validation with a one-shot child-process JSON-RPC lifecycle. The process lifecycle includes bounded frame reads/writes, server-request replies, request-ID matching, initialization, document opening, shutdown, and kill-on-error guard.
- Current parent tests cover operation aliases, disabled-server selection, and bounded positions, but not real subprocess protocol/error/cleanup behavior. A potential deep split would be a session/process owner with the existing `resolve_request(root, value)` seam preserved; it must not move Host tool authorization or workspace/file path validation.
- Adding a fixture-backed fake language server test requires checking cross-platform process setup and timeout behavior. No implementation/test change is authorized or selected pending the user's seam choice.

## WorkspaceStore latest-selection and retry behavior (Slice 180)

- The existing selectProject(project) action immediately projects a selection, then awaits uncached session listing and possibly fallback session creation. Without a latest-request check, an older completion can replace the project/session chosen more recently; a stale failure can also overwrite the current error/loading state.
- The store now uses the existing RequestGate domain primitive around the action's async completions. It checks freshness after awaited reads and creation and before state-changing error handling, leaving the Host bridge and command contracts unchanged.
- initialize() already used initialized as an in-flight/duplicate-call guard, but its catch path did not clear the flag. A failed first project load therefore made future calls return without retry. The catch now resets the guard.
- Regression tests use the existing Zustand actions and native bridge boundary in src/stores/agent-session-routing.test.mjs (the existing Vite SSR server); no test-only production seam was added. The race test was observed failing against the prior selection logic, and the retry test was observed failing when the catch reset was temporarily absent.
- Validation after the repair: related suite 16/16, full unit suite 469/469, pnpm check with 113 compatibility/permission fixtures, ESLint, Prettier, and git diff --check. Branch/version remain beta / 0.4.0-beta.2; broader goal remains in progress.

## Pi turn run-transition owner (Slice 181)

- `PiSessionAdapter.submit()`, `steer()`, and `cancel()` were a cohesive command-side run lifecycle: they jointly own run admission/identity, idempotency, cancellation transition ordering, Pi prompt/steer/follow-up invocation, resource refresh, and exactly-once terminal settlement. These are not independent helper functions; the shared `PiSessionHandle` state and sequencing make them one owner.
- The previously approved PiSessionAdapter public command/event boundary remains the test seam. Its existing `session-adapter.test.mjs` passed 31/31 before extraction and covers attachment submission, stale steer handling, cancel identity, cancel coalescing, and submit-after-cancel ordering. No test-only production port was added.
- Moved these transitions into `session-turn-runtime.ts`, injected with the existing session map, Pi subagent runtime, and worker emitter. `PiSessionAdapter` keeps the command methods as delegating entry points and retains the existing compatibility helper exports; `turn-policy.ts` still owns pure config/run identity checks, and `attachment-policy.ts` still owns attachment constraints and decoding.
- Host authorization and ToolGateway permission decisions remain unchanged. The worker still runs Pi only; no ACP path or renderer command/event contract was added or moved.
- Post-extraction validation: adapter behavior suite 31/31, root `pnpm test:unit` 469/469, `pnpm check` including 113 compatibility/permission fixtures, `pnpm check:architecture` 5/5, `pnpm lint`, and full `pnpm format:check` passed. Current tree remains on `beta` with aligned `0.4.0-beta.2` versions; no release/publish/main synchronization.
- In the same read-only owner audit, `config_subagents.rs` already obtains bounded native/plugin discovery and parsing through `config_subagent_catalog.rs::AgentDefinitionCatalog`. The Pi policy manifest and Settings inventory deliberately preserve different naming/conflict rules and projections; another common inventory facade would add a shallow interface without removing the meaningful policy split, so no further extraction was selected.

## Host Pi worker tool-routing audit (Slice 182 candidate)

- Current source still centralizes the final request path in Host `host_tool_routing::resolve_tool_request`: resolve the active generation's workspace, authorize a requested cwd through `WorkspaceRegistry` and require descendant scope, short-circuit internal instruction-scope reads, run enforceable `PreToolUse`, read the persisted permission decision and preserve deny precedence, then dispatch through the Host-owned Pi ToolGateway/domain owner and send a worker resolution. Post/failure hooks remain observational and run after resolution delivery.
- The production event path is `event_pipeline` after generation acceptance and durable persistence. It emits the accepted event and schedules lifecycle hooks, persisted interaction resolution, and tool routing; reader and generation teardown remain coordinated by `PiWorkerRuntime`.
- Coverage remains asymmetric on the current tree: `event_pipeline.rs` has a fake-port suite for accept/persist/publish order and failure behavior; `pi_tool_gateway.rs` has direct Host policy/execution tests; `host_tool_routing.rs` is 683 lines without direct behavior tests. Neither lower seam can prove the joined workspace → Hook → persisted permission → Host dispatch → resolution order.
- `PiWorkerRuntime`'s remaining process/generation start-stop, handshake, EOF/failure and kill cleanup appears to be one lifecycle state machine after its existing launch, protocol, event, session-command, dispatch, memory and Host-tool child owners. Do not split the parent solely by LOC or move Host authorization out of the router/ToolGateway.
- A genuinely deep next module could own the ordered Host routing workflow behind one narrow interface, with a production adapter for WorkspaceRegistry/DB/Hooks/ToolGateway and a deterministic test adapter. The existing `PiWorkerRuntime` event/tool-resolution path is the proposed external seam; no tests or source were changed because it has not been confirmed for this behavior scope.

## Marketplace settings owner audit (Slice 183)

- `MarketplaceSettings` combines marketplace source CRUD, scan/refresh lifecycle, catalog grouping/search/paging, and plugin install/update. These responsibilities share one page state: source save/delete triggers scans, and configured source records also define catalog group identity and edit/delete controls. Splitting them into several hooks would currently distribute loading/error/live-activity and scan ordering across new prop/state interfaces.
- `MarketplaceSourceDialog` and `MarketplacePluginRow` already isolate the two locally replaceable view units. The remaining parent is the page composer and scan workflow; no smaller implementation has yet been shown to remove more caller knowledge than it adds.
- Source inspection found no direct MarketplaceSettings component/behavior suite. `SettingsWorkspace` receives `cwd`; its Settings view uses a stable animation key, but the normal sidebar project-selection path closes Settings before switching projects. A late old-cwd scan could theoretically overwrite the page only if the same Settings mount survives a cwd change; source evidence does not establish that as a reachable normal navigation path, so do not claim a reproduced stale-result bug.
- Decision: no LOC-driven split or unconfirmed React test seam. Keep the candidate as an observation only; if the product permits cwd change while Settings stays mounted, specify that behavior and confirm a production-facing lifecycle seam before adding tests.

## Pi subagent command/event integration coverage (Slice 184)

- The direct `PiSubagentRuntime` tests characterize the child owner, while the selected behavior seam is the existing `PiSessionAdapter` command/event interface. A gap remained at their composition: the adapter's registered background-task tool, child runtime, and task-cancel command had no single regression that observed cancellation during the initial running-status event.

## Pi subagent cancellation test-boundary de-duplication (Slice 185)

- The initial-running-event cancellation race is now covered at the selected `PiSessionAdapter` command/event seam: a registered `run_background_task` launches the child, a gated `subagent.changed(running)` event lets the public `task.cancel` command race with activation, and the test observes no provider prompt, one `run.finished(cancelled, parent_cancelled)`, and the final cancelled task acknowledgement.
- Removed the lower-level direct test for that same race and its one-off `onEmit` test-helper callback. The three distinct `PiSubagentRuntime` public-interface cases remain for foreground completion/ownership, wait/cancel response shape, and persisted transcript resume; the adapter integration is not layered on top of a duplicate race assertion.
- Verification after replacement: focused adapter/runtime tests 35/35, worker suite 189/189, and root unit suite 469/469. Only test coverage placement and evidence documents changed; no production behavior or authorization boundary changed.

## PiSessionAdapter test seam cleanup (Slice 186)

- A resource-refresh test had read the private `questionTimeoutPolicy` field to assert environment → Host snapshot → omitted-policy clearing. It now drives the registered `ask_user_question` tool during real `PiSessionAdapter.submit()` turns and observes timeout/recovery through the adapter's interaction events and `resolveInteraction()` command.
- A lifecycle serialization test had replaced private `openInternal()`. It now issues two concurrent public `session.open` commands via the existing injected Pi SDK adapter and observes a single native session plus matching idempotent acknowledgements.
- The focused behavior cases, worker suite (189/189), and root suite (469/469) pass. No runtime implementation changed. `refreshes and clears the Host-projected goal safety policy` still reads private `goalPolicy`; its downstream `createGoalExtension` behavior and refresh timing need characterization before that assertion can be replaced without silently redefining semantics.
- Added the scenario to `session-adapter.test.mjs`: open a root session through the adapter harness, execute its registered `run_background_task`, pause delivery of `subagent.changed(running)`, issue the public adapter `task.cancel` command, then resume event delivery. It asserts that the child provider prompt never starts, exactly one `run.finished(cancelled, parent_cancelled)` is emitted, and the command acknowledgement reports cancelled.
- This uses existing production interfaces and the fake Pi SDK adapter already present in the owner harness; no test-only production port, private map access, Host permission move, runtime change, or protocol change was added. Existing direct owner and worker-smoke tests remain complementary.
- Validation passed: `session-adapter.test.mjs` 32/32, worker suite 190/190, root unit suite 470/470, `pnpm check` (113 compatibility/permission fixtures), ESLint, full Prettier check, and `git diff --check`. The Rust library suite had already completed 364/364 in this continuation; this test-only slice does not touch Rust.
- The new characterization improves the verified adapter/runtime seam; it does not claim the whole repository's structural-debt goal is complete.

## Pi session resource-refresh owner (Slice 187)

- `PiSessionAdapter.refreshResources()` coordinated root and child refresh using a single Host snapshot, queued root mutation across session lifecycle work, deferred changes during active runs, aggregated failures, and emitted a completion warning. These steps share ordering and failure policy, so they form one workflow owner rather than independent helpers.
- Extracted the workflow into `session-resource-refresh-runtime.ts`; `PiSessionAdapter.refreshResources(command, requestId)` remains the existing entry point and delegates without moving Host authorization or changing Pi-only runtime selection, policy projection, event ordering, or wire contracts.
- Added a public adapter failure characterization for root reload failure: it emits the established `pi.resource_refresh_failed` error and no success event. The adapter does not expose a new test-only production port.
- Updated static compatibility checks to follow the policy normalization/application in the new resource-refresh owner and its state/delegation wiring in the adapter. Fixture coverage now rejects an owner that no longer applies the normalized Host snapshot.
- Validation: refresh suite 5/5, worker suite 190/190, root unit suite 470/470, `pnpm check` with 113 compatibility/permission fixtures, ESLint, full Prettier check, architecture suite 5/5, and `git diff --check` passed. The adjacent private `goalPolicy` test remains intentionally pending semantic characterization.

## Pi session-open lifecycle owner (Slice 188)

- Session opening was the adapter's remaining long workflow after the command-specific fork/import/configure/refresh/close/turn owners. It combined idempotent reopen checks, model/resource resolution, restricted Pi session construction, handle registration, event subscription, and lifecycle acknowledgements as one state transition.
- Moved that workflow into `session-open-runtime.ts` behind `open(command, requestId, emitLifecycle)`. `PiSessionAdapter` retains its public `open()` command and per-session lifecycle queue; fork and import still call the same internal open workflow. No Host authorization or Pi runtime selection moved.
- Kept validation at the existing adapter command/event seam. Five focused cases covering injected SDK failure, advertised root tools, Explorer fork, import acknowledgement, and concurrent idempotent opens passed before and after extraction.
- Updated aggregate compatibility checks to require adapter-to-owner delegation and model-policy application inside the owner, with drift fixtures for both. Full validation passed: worker 190/190, root unit 470/470, `pnpm check` with 115 fixtures, ESLint, full Prettier, architecture 5/5, and `git diff --check`.

## Agent Session latest-generation projection guard (Slice 189)

- `beginAgentSession()` commits the selected session synchronously, then awaits Host binding and session-open/import work. The hook's effect-local `disposed` check ends before this awaited store action; a later rejection from an older activation could therefore write global `runtimePhase`, `chatStatus`, and `status` after a newer session was selected.
- The existing same-session in-flight branch is a real idempotency contract. A repeated call that returns there must not invalidate the pending activation whose later result/error owns the current state. New generations are allocated only when an invocation actually claims a session activation.
- The store module now keeps a `RequestGate` per stable `AgentStoreAccess.get` function in a `WeakMap`, avoiding cross-store interference and a new test-only interface. A commit closure checks both latest generation and current `activeSessionId`/`localSessionId`/non-archived state.
- That closure guards the asynchronous persisted binding config projection, caught error/phase/status, and `armSetupTimeout` callback. The activation continues its existing control flow even after becoming stale: Host migration journaling and session-scoped Pi/preview commands are not cancelled, skipped, reordered, or rewritten.
- Through the approved store seam, one regression confirms A's late binding failure cannot overwrite B's current creating/submitted projection; B's own later failure still reports normally. Another resolves B then A and confirms B's model, reasoning, and permission controls remain selected while both `session.open` envelopes are emitted in their original resolution order with their respective session-specific settings.
- The direct `beginSession` overlap is verified. The separate `use-agent-bridge.ts` capability-report catch is outside this slice and remains a follow-up audit item; no claim is made that all renderer async state is generation-guarded.
- Full validation passed: `agent-session-routing.test.mjs` 18/18; root unit suite 472/472; `pnpm check` (115 compatibility fixtures); architecture 5/5; lint; full format check; production build; and whitespace check. Build output contains the existing >500 kB chunk warnings. Checkout remains beta with package/Cargo/Tauri `0.4.0-beta.2`; no release operations.

## Pi capability preflight stale-failure audit (Slice 190 candidate)

- `useAgentBridge` awaits `getPiCapabilityReport(sessionCwd)` and guards the successful result with `if (disposed) return` before writing `capabilityDiagnostics` or status. Its `catch` has no corresponding guard: after effect cleanup sets `disposed = true`, a late rejection still writes a blocking compatibility diagnostic to Zustand and calls the store's global `setStatus` with the stale session's failure.
- The normal worker-subscription failure path checks `disposed` after awaited cleanup and before committing state. This is a narrow asymmetry, not evidence that every async hook continuation is unguarded. The capability failure remains fail-closed and does not start or fall back from Pi.
- The inspected test setup has no `useAgentBridge` lifecycle test, React hook renderer, or `react-test-renderer` dependency. A possible seam is a small capability-preflight coordinator with an injected report reader/current-effect predicate and one projection callback; a deferred rejection after cleanup should prove zero stale writes, while a current rejection preserves the blocking diagnostic/status.
- No source or tests were changed. This is a candidate, not a reproduced runtime bug. Request exact seam approval before introducing a coordinator/test interface; keep Host inventory and blocking/degradation policy authoritative.

## Session persistence queue ownership audit (Slice 191)

- `useSessionPersistence` has one production caller and already owns a cohesive per-session persistence state machine: latest/pending snapshots, monotonically increasing revisions, serialized flush, payload signatures, archive-entry deltas, retry of only the still-current failed revision, debounce, and pagehide/visibility/unmount flushes.
- Stale write responses update the workspace session list only when the completed snapshot revision remains latest. Serialization and archive diffing happen at the write boundary after queue coalescing, which avoids doing the expensive work for every streamed event.
- Existing domain tests cover timeline projection/version semantics, but the hook's async writer/retry lifecycle has no direct suite. This is a testability opportunity, not evidence of broken behavior. A deeper owner would need a justified production/test adapter for persistence, scheduling and session projection; splitting the current closures into helper files would be shallow. No code change selected.

## Same-session reactivation timeout regression (Slice 192)

- `armSetupTimeout` already receives the activation-scoped `setIfCurrent` callback, but #189's overlap tests only covered stale failures and late binding config while the current session ID differed. The generation check has a distinct case: A's timer can fire after an intervening B activation and a later reactivation of the same A ID, when an ID/phase-only guard would match again.
- Added a behavior test through the existing `beginAgentSession` store seam. It omits `session.open` acknowledgements to retain `creating`, captures the three real 20-second timeout callbacks, then fires the first A callback after A → B → A. The latest A remains `creating/submitted` with no stale error.
- A controlled mutation replacing the old A timer's `setIfCurrent` with raw store `set` made the test fail (`error` instead of `creating`); restoring the generation guard passed. This confirms the assertion detects the intended regression rather than merely testing the current timer delay.
- No production code, command envelope, Host authorization, Pi runtime, or external behavior changed. Validation: focused store routing 19/19, root unit 473/473, `pnpm check` (115 fixtures), architecture 5/5, lint, full Prettier check and whitespace check.

## WorkspaceStore latest selection intent 与 Host 删除清理归属（Slice 193）

- Desktop `deleteSession` / `deleteProject` 不再先从 renderer 发全局 `stop_pi_worker`；现有 Host 删除命令基于 session binding 和 workspace 执行 Pi 生命周期清理。Browser preview 仍由 renderer `stopAgent()` 处理。对应 store tests 只证明 Tauri command delegation，不替代 Host runtime 证据。
- `deleteSession` 的最后一个活动 session 会等待 Host replacement creation；删除之后若当前 session 已变更，迟到 replacement 不得覆盖新选择。创建失败时也要同步清除已删除 session 的列表投影与活动引用。两个交错均通过现有 WorkspaceStore action harness 验证。
- `selectProject(A)` 的 session 查询可挂起；当前 tree 仍允许选择已有 session B。此前只有 project-vs-project `RequestGate`，所以 A 的迟到结果会把活动项目/会话改回 A。`selectSession(B)` 现在使旧 project activation 失效；red test 观察到旧 activeProject=A，修复后 B selection 保持。
- 多个 WorkspaceStore 异步 action 原来直接互相写同一个 `loading` boolean。现在它由当前有效 project selection 与仍 pending 的 loading-owned actions 汇总；选择 B 可结束已失效的 A selection loading，但不会把仍 pending 的 delete session loading 清掉。
- 未新增生产 test port、未改变 Pi-only route 或 Host permission policy。验证：`agent-session-routing.test.mjs` 25/25、全量 `pnpm test:unit` 479/479、`pnpm check` 115 fixtures、lint、format、architecture 5/5、build、`git diff --check` 均通过。Build 保留已有 >500 kB chunk 警告。
- Host `host_tool_routing::resolve_tool_request` 仍没有能覆盖 workspace authorization → hooks → persisted permission → Host dispatch → worker resolution 的直接行为测试；组件测试不可当作组合证据。该接口/seam 仍待选择，本 Slice 没有改动 Rust router。

## Workspace initialization latest intent (Slice 194)

- `initialize()` awaits project discovery and every project's session list before it activates the chosen initial project. A user can select an already-visible Agent Session during that wait; without a shared latest-intent check, initialization later called `selectProject(initialProject)` and replaced the user's newer active session.
- Added a deferred `list_projects` behavior test through the already-approved `initialize()` WorkspaceStore action seam. Red run observed `activeProject=project-initialized-first` instead of the selected project; the test also checks the loaded project catalog remains populated.
- A second deferred behavior test covers the no-project path: selecting the existing session while the native folder picker is pending used to be cleared when the picker returned no path. Initialization now discards that stale cancellation projection after its intent is superseded.
- Initialization now registers its activation intent in the existing `projectSelectionGate` and only starts initial-project activation while that token remains current. The normal `selectProject()` path remains responsible for loading/creating the initial session; later session/project selection invalidates initialization's older intent. The existing loading owner tracks both the pending initialization action and valid selection work.
- No new production port, Host/Pi command, Host authorization path, runtime choice, or session wire contract was added or changed. Verification: `agent-session-routing.test.mjs` 27/27, root unit 481/481, `pnpm check` (115 compatibility/permission fixtures), lint, full format check, architecture 5/5, build, and `git diff --check` passed. Build retains the pre-existing large-chunk warning.
- At the time of Slice 194, the separate delayed-upsert race in `chooseProject()` still awaited test-seam selection; it was later confirmed and covered through the existing action in Slice 197. The Host tool-routing composition seam remains unresolved. Slice 194 did not claim full renderer async latest-intent coverage or completion of the full-repository goal.

## Host goal policy behavior seam (Slice 195)

- The prior `refreshes and clears the Host-projected goal safety policy` test constructed `PiSessionAdapter` without a session and asserted the private `goalPolicy` field directly. It proved snapshot assignment but not that policy reached its model-facing consumer.
- Replaced those assertions with the existing `PiSessionAdapter` harness: open a session, refresh through `session.resources.refresh`, and exercise the loaded Pi goal extension's `/goal start` and `update_goal` interfaces. Results distinguish the initial environment policy, Host-projected budget/stall/blocked-attempt policy, and omitted-policy defaults.
- Pi's real `AgentSession.reload()` reloads `DefaultResourceLoader` and rebuilds extension runtime. The general fake session only incremented a counter, so this test models the SDK resource-loader reload at its existing external-runtime adapter seam and obtains the newly registered extension; no production port or policy semantics changed.
- The test uses Pi's session manager persistence action for extension entries and observes the actual command/tool results, not `adapter.goalPolicy`. It does not claim end-to-end model provider execution; model/network behavior is not required for this Host-policy contract.
- Validation: focused policy test passed; full `session-adapter.test.mjs` is included in passing `pnpm test:agent-worker`; `pnpm test:unit` 481/481; `pnpm check` (115 compatibility/permission fixtures); lint, root format check, architecture 5/5, production build, and `git diff --check` passed. Build retains existing >500 kB chunk warnings. Full-repository governance remains in progress; Slice 182 Host routing seam remains unresolved. The `chooseProject()` action seam was selected and covered in Slice 197.

## Workspace initialization retry preserves the selected session (Slice 196)

- `initialize()` is explicitly retryable after a failed load. If it failed once, then the user selected a session or project before retrying, a fresh retry registered a newer project-selection generation and unconditionally activated the default project, stealing the still-valid selection.
- Added regressions through the previously approved `initialize()` / `selectProject()` actions: after the first `list_projects` failure, select session B and retry; separately select project B with no session after a transient session-creation failure and retry. Before the fix, retry activated default project A or skipped B's required second session creation.
- A retry now retains the project active at retry start only if it remains in the freshly loaded catalog and no newer selection intent supersedes initialization. If its session remains, current session projections are merged into the refreshed list; otherwise the selected project is reactivated to load or create its session. A missing project still falls back to normal initial-project selection.
- Existing initialization-time `selectSession` / `selectProject` generation checks remain authoritative. No test-only production port, Host command, Pi runtime, permission decision, or wire contract changed.
- Validation: routing suite 29/29, root unit suite 483/483, `pnpm check` (115 compatibility/permission fixtures), lint, complete format check, architecture 5/5, production build and whitespace check passed. The build retains its existing >500 kB chunk warnings. Full-repository structural governance remains in progress; the Host router seam remains unselected. The `chooseProject()` action seam was later confirmed and covered in Slice 197.

## `chooseProject()` latest selection intent during registration (Slice 197)

- `chooseProject()` waits for the native folder picker and then for `upsert_project()` before calling `selectProject()`. During that registration wait, the action did not yet claim project-selection intent; a newer `selectSession()` could be followed by the old choose-project completion activating its newly registered project.
- A deferred `upsert_project` test through the user-confirmed existing public action reproduced the stale activation: after selecting Agent Session B while registration was pending, completion changed `activeProject` to the newly chosen project and began loading its sessions.
- The action now starts a project-selection intent after a folder is actually chosen and before registration begins. It always adds the returned project to the workspace catalog, but activates it only if that intent is still current. A later session/project selection therefore wins without cancelling project registration.
- A second action-level test confirms a current choice still loads/creates the first session and activates the newly registered project. The tests observe catalog, active project/session, session commands and aggregate `loading`; they do not add a test-only production port or alter Host/Pi authority, runtime selection, or wire behavior.
- Verification: `agent-session-routing.test.mjs` 31/31, root unit suite 485/485, `pnpm check` (115 compatibility/permission fixtures), lint, full format check, architecture 5/5, production build and `git diff --check` passed. Build retains existing >500 kB chunk warnings. Workspace structural-debt governance remains in progress; Host router composition coverage is still unresolved.

## Initialization preserves a pending project activation (Slice 198)

- `initialize()` unconditionally began a newer `projectSelectionGate` generation. When `selectProject(B)` was still awaiting creation of B's first session, initialization invalidated that action, observed B's still-empty persisted session list, and started another `create_session` for B.
- A deferred creation test through the approved `selectProject()` / `initialize()` actions reproduced two calls for the same first-session operation. It also observes the loading contract while the original selection remains pending and the active session after that original result completes.
- Initialization now only claims its own selection intent if none is pending when it starts. With an existing project activation, it still refreshes workspace/catalog data but skips initial-project activation and does not finish the other action's selection token. The original `selectProject()` remains responsible for committing its session and releasing selection loading.
- No new test-only production port, Host command, Pi runtime, permission decision, or wire contract was added or changed. Verification: `agent-session-routing.test.mjs` 32/32, root unit suite 486/486, `pnpm check` (115 compatibility/permission fixtures), lint, full format check, architecture 5/5, production build, and `git diff --check` passed. Build retains existing >500 kB chunk warnings. Workspace structural-debt governance remains in progress; Host tool-routing composition coverage is still unresolved.
