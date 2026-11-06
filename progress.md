# 进度日志

## 2026-10-11 — Continue structural-debt audit after slice 137

- Previous goal turn was progress: it implemented and fully validated the model-catalog factory seam. This continuation rechecked the root repository rules, `beta`/HEAD/version alignment, dirty-tree inventory, and session catch-up; no unsynchronized changes were reported.
- Rejected the stale `resolvePlan`/`resolvePermission`/`resolveQuestion` follow-up: `agent-store-interactions.ts` and direct owner tests already exist. Scanning remaining candidates against current sources before selecting a new slice.
- Current source checks also found the former worker-event-acceptance and Pi-web-projection candidates already have dedicated owners. The earlier findings are historical; avoid redoing those extractions.
- Selected the shared Host sandbox profile-resolution cluster for slice 138. The `SandboxProfile` record is consumed by both platform adapters; Host fail-closed decision, authorization/preflight order and shell command construction stay in the parent. The key new test design constraint is explicit temporary profile sources rather than the real user's `sandbox.toml`.
- Baseline before edits: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib workspace_sandbox::tests` passed 9/9 on the current macOS host.

## 2026-10-11 — Slice 137 model catalog runtime test seam (complete)

- Revalidated branch `beta...origin/beta`, HEAD `4eddef67`, and aligned package/Cargo/Tauri release version `0.4.0-beta.2`; the large existing dirty tree is preserved. Planning catch-up reported no unsynchronized session state.
- Read the codebase-design and file-planning skills plus the deepening guide; reread the active plan and recent findings before selecting the seam.
- Confirmed three `model-catalog-runtime.test.mjs` cases replace `getModelRuntime()` and one session integration test mutates `adapter.modelCatalog.getModelRuntime`; production catalog construction is localized to `PiSessionAdapter`.
- Selected and implemented a single optional `createModelRuntime` factory dependency, defaulting to Pi's `ModelRuntime.create`, threaded through the existing `PiSessionAdapter` dependency options.
- Red/green: the new factory test first failed because the constructor ignored the dependency and initialized Pi's real default runtime; after injection it passed with exact option/path and single-call cache assertions. All three catalog cases and Host credential-sync integration now use constructor adapters; no `getModelRuntime()` method overrides remain.
- Final verification: catalog 5/5, session adapter 24/24, worker 175/175, unit 449/449, architecture 5/5, Pi compatibility 101/101, `pnpm check`, lint, format, production build, and `git diff --check` passed. Build retains its existing large-chunk warnings.
- Final recheck: `beta...origin/beta`, HEAD `4eddef67`, package/Cargo/Tauri all `0.4.0-beta.2`; accumulated dirty paths remain preserved. No commit, push, publish, release, or main sync. Pi-only and Host security-authority invariants remain unchanged; the broader repository goal continues in progress.

## 会话：2026-10-10

### 第六十切片：subagentPolicy MCP 边界与合同 owner（完成）

- 原始 Host list normalizer 会在 capability projection 前丢弃长度超过 128 字节的条目；这不是 Host 接受并发送 129–167 字节 grant，而是可能静默改变显式 `tools` allowlist。段限组合最大 ASCII 名长度实际为 167 字节；worker 的原始 manifest validator 对 129 字节名称 fail-closed。
- 在既有 Host Markdown parser seam 加入 128/129 边界断言；首轮回归在 129 处失败，证实其原先静默丢弃，修正后按 unsupported 诊断路径拒绝整条 agent policy。worker normalizer 的边界 characterization test 验证 128 接受、129 拒绝。
- Host/worker MCP 数量与名称限制改为具名常量；manifest 加 `maxNameBytes=128`，worker regex 由具名分段常量生成。`subagentPolicy` MCP grant / capability mapping contract 已迁入 `pi-subagent-policy-compatibility.mjs`，添加 6 个 source-fixture tests 并由主 gate 调用；用户已确认 Host projection、worker normalization、compatibility owner 三处测试 seam。
- `docs/architecture/pi-migration/implementation-plan.md` 与 `findings.md` 已按真实静默过滤行为修正文档；无授权范围扩张。分支仍为 `beta`，未改版本、提交、发布或合并。
- 本次复验：`pnpm check:pi-compatibility` 27 passed，`pnpm test:agent-worker` 160 passed，Rust lib 305 passed；`pnpm check`、`pnpm check:architecture`（3）、lint、format、full unit（416）和 production build 均通过。build 仍报告既有 >500 kB chunk warnings；`git diff --check` 待本次文档记录后执行。
- 下一候选为 Host `max_retries` 与 worker 10,000 上限的一致性；Host 当前 projection 可将超限值写入策略快照后由 worker 拒绝。本次已另行征求该候选的测试 seam 确认，未在确认前写新测试或改 runtime。
- 文档收尾时首次 Prettier check 标记了 `progress.md` 的长行；运行 Prettier 后，计划文件格式检查与 `git diff --check` 均通过。

## 本轮继续审计

- 第 60 切片为前一轮已推进内容，本轮 goal continuation 先重新核验工作树：仍在 `beta`，三处发布版本一致为 `0.4.0-beta.2`，累积未提交改动保持原样；计划 catchup 无未同步报告。
- 用户尚未回答新的 `max_retries` 测试 seam 问题，故不新增该候选的测试或运行时改动。只读审计确认 Host `model_policy` 接受非负但无上限的 retry，而 worker/manifest 上限为 10,000。
- 扩展检查 terminal output cap：manifest 与 Host 当前数值均为 8 MiB，但 Pi compatibility gate 比较的是 manifest 与脚本内常数，没有读取真实 Host `tool_output_archive.rs` owner。已把它记录为 Host `max_retries` 后的第二候选。
- 进一步审计发现 `backgroundTerminalTasks` manifest contract 整组未被 Pi compatibility checker 或其 source-fixture owners 引用；实际 prefix、64-task capacity、120000 ms wait ceiling、64 KiB preview 和 stop cleanup 分散在 Host/worker owners。当前看见的关键数值一致，但该组缺少 drift gate；记录为下一组终端合同候选。
- 为遵守用户要求的行为边界，如果 `max_retries` seam 获批准，Host regression 将尽量通过 `prepare_pi_models_with_remote` 的生成策略快照观察 10,000/10,001 边界（project config 显式关闭 remote fetch），而非断言私有 helper；worker 使用 `loadPiModelPolicies`，兼容 owner 从真实 Host constant 与 manifest 做 fixture cross-check。
- 审查兼容 checker 时，两段重叠 `sed` 输出造成 remote catalog wiring guard 的假重复观感；patch 未匹配且没有改文件。用不重叠行号复核确认原源码只有一个 guard，误报已记入任务错误表。
- 后续该 retry seam 获确认后作为第六十一切片完成，见下方记录；此处描述的是尚未获确认时的审计快照。

### 第六十一切片：Host 模型 retry 上限对齐（完成）

- Host `pi_model_config.rs::model_policy` 现在通过 `bounded_retry_value` 对 global 和 per-model `max_retries` 统一执行 10,000 上限校验；超限配置在 Host 生成 projection 时失败，不写 models catalog 或 policy snapshot。worker 与 manifest 上限保持一致。
- 真实快照生成入口覆盖 10,000 接受、10,001 拒绝，以及拒绝前输出文件不存在；worker parser 单测也覆盖相同边界。Pi compatibility owner 读取 Host 真实常量与调用点，再对齐 manifest 和 worker bounds。
- 验证：model policy owner fixtures 29 passed、worker 161、full unit 417、Rust library 306 passed；`cargo check` 无 warning、Rust fmt、`pnpm check`、architecture 3、lint、format、production build 与 `git diff --check` 通过。Vite 仍报告既有 >500 kB chunk warnings。

### 第六十二切片：终端与后台终端任务合同 owner（完成）

- 用户确认的 source-fixture seam 已完成：`pi-terminal-compatibility.mjs` 接收 manifest 与 Host/worker source snapshots；主 checker 继续持有 file I/O 和 aggregate diagnostics，不改 runtime。
- 覆盖 foreground Host/worker timeout、Host config/archive output caps 与真实 capture clamp、config/env/path keys 和 Host route；覆盖 background task prefix、64 项 registry cap、120,000 ms Host/gateway/worker wait bound、三个 worker task-control schemas、64 KiB Host preview、Host process kill/cancel signal 与四条 worker stop/failure/workspace cleanup call sites。
- 新增 terminal owner 7 tests；`pnpm check:pi-compatibility` 的全部 owner fixtures 36 passed，真实 source gate 通过；`pnpm check`、`pnpm check:architecture` 3 passed、lint、format、`pnpm test:unit` 417 passed 均通过，`git diff --check` 通过。只改静态门禁、测试、package script 和计划文档；Rust/worker runtime 未变，未重跑 production build。
- 首轮 fixture 运行暴露 source fixture 字段名与真实 owner marker 不一致；修正后通过。一次后续 patch context 未命中且无写入，测试中的 regex 转义错误在最终 owner suite 前修复。当前 runtime 数值一致，本 slice 解决的是 drift-gate 覆盖缺口。
- 下一候选为 `PiWorkerRuntime` Host turn dispatch acknowledgement ledger；先核对状态接口/调用图，在新增 tests 前确认 seam。

### 第六十四切片：questionTimeoutPolicy 跨端合同 owner（完成）

- 将 inline question-timeout checks 收敛到 `scripts/pi-question-timeout-compatibility.mjs`；组合 checker 提供 manifest 与 Host/worker source snapshots，主 gate 继续负责 file I/O 和 diagnostics 聚合。
- Fixture 覆盖 Host 与 worker ToolGateway cap、Host clamp、worker environment/manifest parser bounds，以及 config projection→manifest→launch environment→worker adapter→gateway 的接线。当前运行时上限对齐；本片补的是 drift-detection coverage，不是修改运行时策略。
- Pi compatibility owner fixtures 41 passed、真实 Pi compatibility gate 通过；`pnpm check`、unit 417、architecture 3、lint、format、`git diff --check` 通过。无 runtime 改动，不重跑 production build。
- 初次真实源码 gate 未识别 Rustfmt 换行的 `command.env`；以窄 whitespace-tolerant regex 修正后 fixture 和真实 gate 均通过。恢复 planning session 的 catchup 首次误用 Node 运行 Python 脚本，改用 Python 后正常，无未同步上下文。
- 下一步：继续只读检查剩余 Host bridge 与 runtime 状态 owner；若要建立新行为测试，先向用户确认具体 seam。

### 第六十五切片：子代理会话边界 owner（完成）

- 将 bounded resume ID normalization、cwd realpath/symlink containment、resume root/parent/status/selector identity checks、interactive child scope 与 Host worktree response validation 移至 `subagent-session-boundaries.ts`；adapter 仍负责调用时序并从原路径 re-export。
- 用户确认后将五项既有行为测试迁入 owner 测试，新增四类 selector identity coverage；adapter 增加 re-export identity characterization。`subagent-records.ts` 仍独立拥有持久记录 schema、路径和读写事务；Host 授权与运行策略未变。
- 首次 red test 因 owner 不存在而失败，符合 TDD 预期；owner 测试 7 passed。一次 targeted typecheck 发现 `PiTaskStatus` 已不再需要，移除旧 import 后修复；一次 Prettier check 标记新 owner 文件，格式化后通过。
- `session-adapter.ts` 4,149 -> 3,460 行；边界 owner 322 行。验证：adapter/boundary targeted 35、worker 164、完整 unit 420、Pi compatibility fixtures 41、architecture 3 passed；真实 checker、`pnpm check`、lint、format、production build、`git diff --check` 通过。Build 仍报告既有 >500 kB chunk warnings。
- 分支 `beta`、版本三处对齐 `0.4.0-beta.2`，未 commit/push/publish/merge。整体治理未结束；下一步回到未处理 runtime/bridge 的只读职责审计。

### 阶段 1：需求与初步结构发现

- **状态：** complete
- **开始时间：** 2026-10-10 Asia/Shanghai
- 执行的操作：
  - 核对工作树和分支：`beta`，起点干净且同步 `origin/beta`。
  - 检查主要 Pi worker/Host 模块规模、职责分布和既有测试文件。
  - 核对当前 Pi migration handoff 与 README，发现 runtime 状态叙述不一致。
  - 阅读既有架构改进原则：深模块、业务不变量归属；确认当前自动架构门禁只覆盖部分依赖方向。
  - 重构前基线通过：`pnpm test:agent-worker`（140 passed），Rust `pi_tool_gateway` 定向单测（35 passed）。
  - 完成首个候选切片设计：从 Pi session lifecycle 提取技能、提示词和插件资源发现，保留现有接口与 Host manifest 语义。
- 创建/修改的文件：
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 2：方案与边界

- **状态：** complete
- 执行的操作：
  - 选择 `packages/agent-worker/src/pi/session-adapter.ts` 内资源发现实现作为首个可独立验证的职责簇。
  - 不改变 worker/Host 协议、manifest schema、文件系统 allowlist 或资源加载上限。
- 创建/修改的文件：
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 3：职责簇重构

- **状态：** in_progress（Pi worker、Host gateway/runtime、MCP、Pi policy/resources、marketplace、subagent parser/records/inventory、memory store、browser URL/page tools、worker protocol、envrc/launch、LSP config/projection、codebase parser、schedule policy、event ingress contract、command affinity、billing usage、架构依赖门禁、Host MCP inventory、subagent launch policy、model catalog runtime、owner-local tests 与 compatibility-gate permission/resource/schedule/model-policy/subagent-policy/config-capability-policy/resource-policy-snapshot owners 共六十二片；继续处理其余热点）
- 执行的操作：
  - 把技能/提示词/静态插件发现、Host-projected root 校验和路径扫描从 5,543 行的 session adapter 中提取为 `resource-discovery.ts`；adapter 只调用其窄接口。
  - 保留原有 allowlist、realpath/symlink 限制、扫描深度/数量/字节上限及兼容路径行为。
  - 将兼容清单检查改为检查职责模块，并校验 adapter 导入关系；修正 Pi-only 架构文档漂移。
  - 后续累计完成四十七个职责簇；Marketplace 文件系统安全规则、Browser screenshot/page-interaction protocol、Markdown 派生的 memory search index、Tree-sitter parser、Pi worker launch boundary、纯 schedule policy、Pi event ingress contract、outbound command affinity、billing usage projection 与共享 subagent Markdown/config inventory projection 均有专属 owner或统一入口，session owner 仍控制 active tab 与 per-tab state。
  - 架构 boundary checker 从 source regex 改为 TypeScript AST，可靠识别静态/动态/type/re-export/CommonJS module references；规则只覆盖既有 domain/Pi SDK 边界，不声称检查依赖环或所有职责边界。
  - 第三十九切片将 disposable SQLite sidecar 所有 schema/path/digest/tamper/rebuild/fallback 逻辑集中到 `pi_memory_runtime/store/search_index.rs`；主 store 保持 Markdown tool/file lifecycle。
  - 第四十切片将纯 Tree-sitter language/AST occurrence extraction 移入 `pi_codebase_runtime/parser.rs`；workspace walk/cache/query/config/path validation 和 Host request boundary 留在 parent。
  - 第四十一切片将 Pi worker exact packaged-binary discovery 和 scrubbed command environment assembly 移入 `pi_worker_runtime/launch.rs`；supervisor 保留 model/`.envrc` preparation、process lifecycle 与 restart decisions。
  - 第四十二切片将纯时刻推进、错过触发策略、间隔解析和输入枚举校验移入 `database_agent_schedules/policy.rs`；SQLite state owner 保留事务、持久生命周期和 command wrappers。
  - 第四十三切片将 Pi event envelope 验证、有界序列化和持久字段 projection 移入 `database_agent_events/event_contract.rs`；event-log parent 保留事务与 replay/idempotency/binding checkpoint。
  - 第四十四切片将 outbound command envelope/nested session identity lockstep check 纳入既有 worker protocol owner；Host session authorization 与 database validation 留在 supervisor command path。
  - 第四十五切片将 Pi usage snapshot merge、partial/incomplete marker、美元成本至 billing ticks 换算和 legacy usage event projection 移至 `billing-usage.ts`；session event reducer 继续控制事件顺序、最新 usage 生命周期和 context-token 状态。
  - 第四十六切片删除 capability inventory 中重复的 agent Markdown 文件遍历和解析分支，复用 manifest 已使用的排序/限量扫描与错误/unsupported 分类入口。
  - 第四十七切片停止让 Settings inventory 调用完整 Pi policy manifest；一次 scoped config pass 同时形成全局/单 agent开关和 inline metadata，之后只执行其需要的文件 inventory projection。
  - 第四十八切片将 architecture guard 改为 TypeScript AST import 扫描，并以 self-tests 覆盖 dynamic/type/re-export/CommonJS 形式与规则边界。
  - 第四十九切片将 MCP preflight support 判定收回 Host MCP parser owner，通过受 workspace 授权的 Tauri inventory command 供 renderer 使用，并移除重复 TypeScript parser。
  - 第五十切片将 built-in subagent capability defaults 与 permission-mode intersection 归入已有 `subagent-policy.ts`；adapter 只投影 session/parent policy，worker 专项测试命令也覆盖该 owner test。
  - 第五十一切片将 Pi ModelRuntime 缓存、认证操作、模型目录 refresh/availability/auth projection、Host 凭据环境替换、目录序列化和模型 alias resolution 移至 `model-catalog-runtime.ts`；session adapter 只把配置策略应用到安全的 live-session 边界。
  - 第五十二切片将 8 个直接调用 `model-policy.ts` 的 tests 从混合 session-adapter suite 移到 `model-policy.test.mjs`；worker 与 root unit scripts 都显式运行 owner tests。
  - 第五十三切片将 request/resume/parent policy projection 与 isolation/capability normalizers 收进 `subagent-policy.ts`；session adapter 仍控制 session/worktree/resource I/O 和 task lifecycle，Host 保持最终授权。
  - 第五十四切片将独立的 Tauri command permission cross-check 收进有 fixture tests 的 owner；Pi compatibility script 保留原组合入口和完整错误汇总。
- 创建/修改的文件：
  - `packages/agent-worker/src/pi/resource-discovery.ts`
  - `packages/agent-worker/src/pi/session-adapter.ts`
  - `packages/agent-worker/src/pi/session-adapter.test.mjs`
  - `scripts/check-pi-compatibility.mjs`
  - `docs/architecture/pi-migration/README.md`
- 验证结果：
  - `pnpm test:agent-worker`: 140 passed
  - `pnpm test:unit`: 398 passed
  - `pnpm check`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `git diff --check`: passed
  - Vite emitted existing >500 kB chunk warnings; not caused or changed by this refactor.
  - 第二切片完成：模型策略解析/校验和 Pi Settings 投影移入 `model-policy.ts`；adapter 保留 Host 快照缓存、live session 刷新和生命周期编排。模型 identity 改为结构化类型，策略模块不依赖 PiSessionAdapter/Pi SDK。
- 第二切片验证：
  - `pnpm test:agent-worker`: 140 passed
  - `pnpm test:unit`: 398 passed
  - `pnpm check`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `git diff --check`: passed
  - `pnpm build` 仍报告已有的 >500 kB chunk 警告；本次变更未涉及 UI bundle 分割。
- 新增/调整文件：
  - `packages/agent-worker/src/pi/model-policy.ts`
  - `packages/agent-worker/src/pi/session-adapter.ts`
  - `packages/agent-worker/src/pi/session-adapter.test.mjs`
  - `scripts/check-pi-compatibility.mjs`
- 第三切片：Host workspace file tools
  - 将路径约束、gitignore 感知的读/搜/列目录、写/编辑/apply_patch 和终端输出归档读取抽到 `src-tauri/src/pi_tool_gateway/workspace_tools.rs`（1,091 行）；网关的 permissions、Host policy override、workspace mutation lock 和请求路由保持原位。
  - 兼容检查现将 `.gitignore` 扫描实现定位到该模块，并校验 Rust gateway 的模块接线。
  - `cargo test --locked --lib`: 283 passed；`pnpm check`、`pnpm lint`、`pnpm format:check`、`cargo fmt --check`、`git diff --check`: passed。
  - 全 Rust 单测运行时，macOS sandbox test 输出 `sandbox-exec: sandbox_apply: Operation not permitted` 环境诊断，但该测试及全套 283 项均通过。
  - 编译初次报告模块内一个未用 `Map` 导入；移除后复跑全 Rust 测试，无编译告警。
- 第四切片：Host tool-output archive
  - 将终端/MCP 输出归档上限、预览 capture、保留策略、分块读取及路径安全逻辑移至 `src-tauri/src/pi_tool_gateway/tool_output_archive.rs`。
  - `workspace_tools` 直接依赖 archive 子模块，避免共享消费者绕回父 gateway；父模块只 re-export 必需的 archive 接口。
  - Rust gateway 定向 35 项、全量 library 283 项测试、`cargo check --locked --lib` 和 `cargo fmt --check` 均通过。
- 第五切片：Host request/policy contract
  - 将 worker tool-request envelope 解析、操作分类、权限交互/身份投影、权限需求和 resolution envelope 放入 `request_policy.rs`。
  - 稳定工具名称由 request-policy 持有；原 `pi_tool_gateway::...` 调用路径通过显式 re-export 保持，Host dispatcher 仍掌握最终授权和执行。
  - 兼容静态检查曾因监控/调度常量从父文件迁出而失败；检查器已调整到读取 request-policy 所有者并校验模块接线，随后 `pnpm check` 通过。
  - 首次编译出现多余 re-export 的未使用导入警告；收窄 re-export，测试内引用子模块常量，最终 `cargo check --locked --lib` 无警告。
  - 全 Rust library tests：283 passed；`cargo check --locked --lib`、`cargo fmt --check`、`pnpm check`、`pnpm lint`、`pnpm format:check` 和 `git diff --check` 均通过。
- 第六切片：Host instruction-scope preflight
  - 将祖先 `AGENTS.md`/`CLAUDE.md` 加载、symlink/realpath 校验、目标路径去重和文件数/单文件/总字节上限移至 `instruction_scopes.rs`。
  - 将被 `workspace_tools` 与 instruction-scope 共用的词法相对路径检查归到 `workspace_paths.rs`；两个职责模块不再借用 gateway 父实现。
  - 网关继续通过原 `resolve_instruction_scope_request` crate 路径供 worker runtime 调用；renderer/worker 提供的目标路径仍只是路由元数据，Host 仍二次 canonicalize 并只提供指令上下文、不授予文件权限。
  - 首次编译发现 gateway 旧 `io::self` import 已不再使用，移除后 `cargo check --locked --lib` 无警告。
  - ToolGateway 定向 35 项、Rust library 283 项、`cargo check --locked --lib`、`cargo fmt --check`、`pnpm check`、`pnpm lint`、`pnpm format:check`、`git diff --check` 均通过。
- 第七切片：Host-managed subagent worktree
  - 将 `.melody/pi/worktrees` 的 managed path 推导、task ID 边界/hash、逐层 symlink 拒绝、detached `git worktree add` 和结果 canonicalization 移到 `subagent_worktrees.rs`。
  - 保留 worker runtime 调用 `pi_tool_gateway::resolve_subagent_worktree_request` 的 crate 路径；Host 仍独占 Git 命令、目标目录和最终 realpath 检查。
  - 新增两个模块测试覆盖 managed-root containment/hash 和 symlink-root 拒绝；ToolGateway 定向测试 35 passed。
  - 全 Rust library tests：285 passed；`cargo check --locked --lib` 无警告，`cargo fmt --check` 通过。静态/TS 门禁在此前切片通过，本切片仅改 Rust。
- 第八切片：Pi worker Host memory lifecycle
  - 将首轮 memory 注入去重、root session transcript 观察/边界、session close 保存、generation flush 与 session reset 清理状态迁到 `pi_worker_runtime/memory_lifecycle.rs`。
  - `PiWorkerInner` 仅持有一个 `HostMemoryLifecycle` component；worker supervisor 仍决定 turn、event 和进程关闭的调用时机，session identity 和 child-stream 排除规则保持一致。
  - 将 UTF-8 transcript 截断测试移至 component；`pi_worker_runtime` 专项 8 passed，memory lifecycle 专项 1 passed，全 Rust library 285 passed，`cargo check` 无 warning，`cargo fmt --check` 通过。
- 第九切片：Pi worker Host tool routing
  - 将工具 hooks、worker tool request 解析/回传、权限 resolution，以及持久化权限查询移至 `pi_worker_runtime/host_tool_routing.rs`；父 runtime 仍持有进程 supervision、事件去重与调用时机。
  - `persisted_permission_for_interaction` 作为唯一跨模块查询入口供事件读取器调用；数据库故障/非法决策仍保持 worker 的 ask 交互，不扩大权限。Host 的最终授权仍留在 `pi_tool_gateway`。
  - 更新 Pi compatibility checker，将 LSP 与 codebase bridge 的接线检查跟随实现所有者 `host_tool_routing.rs`，并保留父模块声明检查。首次静态检查失败是检查器仍假定实现位于父文件；移到职责模块后复验通过。
  - Rust `pi_worker_runtime` 专项 8 passed；`cargo test --locked --lib` 285 passed；`cargo check --locked --lib`、`cargo fmt --check`、`pnpm check`、`pnpm lint`、`pnpm format:check` 和 `git diff --check` 通过。格式检查首次发现脚本排版差异，Prettier 修复后通过。
- 第十切片：MCP remote transport
  - 将 remote HTTP/SSE 的 bounded response、HTTP/SSE 错误分类、JSON-RPC/SSE 解析、endpoint 校验、请求超时/取消和 remote connection protocol 移至 `src-tauri/src/pi_mcp_runtime/remote_transport.rs`（685 行）。
  - `PiMcpRuntime` 仍拥有 workspace/session/run 的 active-call tracking、连接缓存、配置刷新、跨 local/remote 类型替换和 workspace stop；新模块不接管 Host lifecycle 或工具授权。
  - 将 connection 的 workspace containment 与 spec equality 收进模块方法，父 runtime 不再读取 remote connection 内部字段。测试使用 test-only request/session accessors，不把低层 request API 暴露到生产调用面。
  - `pi_mcp_runtime.rs` 从 2,841 行降至 2,214 行；remote connection 行为定向测试 15 passed、Rust library 全量 285 passed、`cargo check --locked --lib` 无 warning、`cargo fmt --check` 通过。
- 第十一切片：MCP local stdio transport
  - 将 child process start/stop、受限继承环境、bounded JSON-RPC line framing、pending response routing、stdio notification 和本地 tool capability projection 移入 `stdio_transport.rs`（448 行）。
  - 父 runtime 不再读取 `McpConnection` 的 `spec` 字段；连接对外提供匹配规范与 workspace containment 查询，runtime 只负责连接生命周期编排。
- 第十二切片：MCP config normalization
  - 将 user/project config merge、MCP server value collection、local/remote config validation、header environment reference 解析和 status projection 移入 `mcp_config.rs`（523 行）。
  - 保留 crate 内 `pi_mcp_runtime::inspect_mcp_config` re-export；运行时通过 `load_mcp_entries` 使用规范化 entry，stdio/remote modules 消费已验证 specs。
  - `pi_mcp_runtime.rs` 目前 1,288 行（含原有 MCP 集成测试）；`mcp_config`、`stdio_transport`、`remote_transport` 各自拥有解析、local protocol 与 remote protocol。三类 MCP 测试仍共置在 runtime test module，便于覆盖它们如何接入统一缓存/取消。
  - 最终复验：MCP 定向测试 15 passed，Rust library 全量 285 passed，`cargo check --locked --lib` 无 warning，`cargo fmt --check`、`git diff --check` 通过；`pnpm check`、`pnpm test:unit`（398）、`pnpm lint`、`pnpm format:check` 和 `pnpm build` 全部通过。Build 保留既有 >500 kB chunk warning。
- 第十三切片：Pi worker tool contract 与 access policy
  - 将 Pi Host-gateway 稳定工具名和 `PI_GATEWAY_TOOL_NAMES` 移到 `tool-names.ts`，使 worker 事件屏蔽、Host 能力通告与工具声明共享一个合同所有者；`tool-gateway.ts` 通过 `export *` 保留旧导入路径。
  - 将 subagent capability intersection/tool allowlists 与 plan/ask session-mode 判定移到纯 `tool-access-policy.ts`；网关仍负责输入规范化、运行态请求、审批和 Host request 投递，Host 最终授权边界不变。
  - 将策略行为测试改为直接导入策略拥有者，并补充 gateway facade identity test；Pi compatibility checker 现在读取工具名/策略模块并验证 gateway 接线。
  - 最终复验：`pnpm test:agent-worker` 141 passed，`pnpm test:unit` 399 passed，`pnpm check`、`pnpm lint`、`pnpm format:check`、`git diff --check` 全部通过；`pnpm build` 通过，保持既有 >500 kB chunk warning。仅 TypeScript/静态检查器/测试/文档有改动，本切片未改 Rust。
- 第十四切片：Pi worker tool parameter schemas
  - 将 30 份命名 TypeBox 参数 schema 及 10 份原先 inline 的 browser 参数 schema 统一迁入 `tool-schemas.ts`；该模块也拥有被 schema/runtime 共用的 foreground/background timeout bounds。
  - `tool-gateway.ts` 继续组装原有 43 个 Host gateway tools 并执行 handler，但不再声明或构造参数 schema；旧公开 timeout 常量路径通过显式 re-export 保留。兼容检查读取 `tool-schemas.ts`，继续比较清单里的 scheduler fields / terminal max timeout。
  - 测试直接检查 schema owner 的限额与旧 gateway re-export；一开始漏移的 browser inline schemas 导致定向回归捕获，现已一并迁出。最终 `pnpm test:agent-worker` 142 passed，`pnpm test:unit` 400 passed，`pnpm check`、lint、format、diff check、build 通过；build 保留既有 >500 kB chunk warnings。该片未改 Rust。
- 第十五切片：Pi worker task result projection
  - 将 background-task snapshot 输出限长（64 KiB）与 Melody legacy `task`/subagent response text 格式从 `PiToolGateway` 移入纯函数模块 `task-results.ts`。
  - `PiToolGateway` 仍拥有 session-scoped `PiTaskController` 与 tool handler/request lifecycle；纯投影模块以结构化最小输入工作，不依赖 gateway 类、Pi SDK、数据库或 Host 状态。
  - 新增直接模块测试，覆盖超长输出的截断标记、源 snapshot 不变、background legacy text 和 foreground continuation marker。最终 `pnpm test:agent-worker` 143 passed，`pnpm test:unit` 401 passed，`pnpm check`、lint、format、diff check 和 build 全通过；build 保留既有 >500 kB chunk warnings。未修改 Rust。
- 第十六切片：Pi worker pending tool/interaction request lifecycle
  - 将 pending tool/interaction 状态、超时与 cleanup、tool/interaction resolution session/run 身份检查，以及 requested/finished/resolved 事件流程移入 `tool-request-lifecycle.ts`。`PiToolGateway` 通过组合组件实现原有 request/resolve API，不再直接持有 pending maps。
  - `gatewayError` 归到共享 `tool-errors.ts`，避免两模块各造一种错误形状。兼容门禁读取 lifecycle 所有者，检查事件/方法和 gateway wiring；完整既有网关测试仍通过旧 façade，覆盖重复/过期/身份不匹配、关闭、事件发射失败及权限交互。
  - 首次 worker test 运行发现 Node `--experimental-strip-types` 不支持构造器参数属性；构造器改为显式字段赋值后重跑通过。最终 `pnpm test:agent-worker` 143 passed、`pnpm test:unit` 401 passed，`pnpm check`、`pnpm lint`、`pnpm format:check`、`git diff --check` 和 `pnpm build` 通过；build 保留既有 >500 kB chunk warnings。未修改 Rust 或权限/协议语义。
- 第十七切片：Pi worker permission identity / response contract
  - 将 `permissionRawInput` 的最小稳定键投影与旧/新 Host interaction response envelope 解析移入纯 `tool-permission.ts`；gateway 仍决定何时请求用户并向 Host 投递原工具请求。
  - 新增直接模块测试，覆盖写文件/调度/MCP/Browser/Memory 身份剔除数据字段，URL query/fragment 不进入持久身份，以及大小写、嵌套 allow 与 reject response。静态兼容门禁读取合同 owner 并确认 gateway wiring；Host 仍是唯一最终权限裁决方。
  - 最终 `pnpm test:agent-worker` 145 passed、`pnpm test:unit` 403 passed，`pnpm check`、`pnpm lint`、`pnpm format:check`、`git diff --check` 与 `pnpm build` 全通过；build 保留既有 >500 kB chunk warnings。gateway 当前 1,381 行；未改 Rust、权限授权语义或协议。
- 第十八切片：Pi worker subagent/background task tools
  - 将 `spawn_subagent`、`run_background_task`、兼容 `task` 与六个 wait/output/kill tool definitions 迁入 `task-tools.ts`。该 owner 同时收纳 `PiTaskSnapshot`、session-scoped `PiTaskController` 和 spawn callback 合同；gateway 继续提供原 `createTools()`、过滤能力策略，并传入原 session 和授权检查闭包。
  - 将通用 text result 与 JPEG screenshot payload validation 归入 `tool-results.ts`，作为 task tools 和 gateway catalog 共用的 Host-result projection；output bounds/legacy task wording 仍归 `task-results.ts`，两者职责不同。
  - 兼容类型由原 gateway 路径显式 re-export；兼容门禁读取 task-tools owner，验证 gateway composition 与任务名。定向 gateway 测试 33 passed、worker 145 passed、unit 403 passed、`pnpm check`/lint/format/diff check/build 全通过；build 仍有既有 >500 kB chunk warnings。tool gateway 从 1,381 降至 1,008 行；未改 Host task registry、权限语义、wire protocol 或版本。
- 第十九切片：Host terminal process/task lifecycle
  - 将 terminal stdout/stderr bounded reader、archive-backed capture、timeout/kill supervision、sandboxed process construction、foreground/background execution、task registry/pruning、session/workspace ownership checks 与 worker shutdown cancellation 收入 `pi_tool_gateway/terminal_tasks.rs`。父 gateway 保留 Host authorization、跨写工具共享的 workspace mutation lock，以及 monitor-vs-terminal ID dispatch。
  - `run_terminal_with_policy` 仍由 Host resolver 在原权限与 policy 边界调用；稳定后台 task prefix 与 `cancel_background_tasks_for_workspace` 调用路径保留。更新 Pi compatibility checker 检查 terminal lifecycle owner 和模块接线。
  - gateway 从约 2,428 行降至 1,815 行，terminal lifecycle owner 为 660 行。终端/monitor/task-control 现有行为由定向 gateway tests 与全 Rust suite 覆盖；未修改权限、sandbox、任务协议或 release version。
  - 验证：`cargo test --locked --lib pi_tool_gateway::tests` 35 passed；全 Rust lib tests 285 passed；`cargo check --locked --lib` 无 warning；`cargo fmt --check`、`pnpm check`（含 Pi compatibility）、`pnpm lint`、`pnpm format:check`、`git diff --check` passed。此切片未改 TS runtime，未在此切片后重复 `pnpm test:unit`/`pnpm build`。
- 第二十切片：Host monitor tool adapter
  - 将 monitor 命令长度验证、Host `AppHandle` event delivery bridge、model-facing snapshot、monitor task-id recognition、bounded wait 与 monitor get/kill/wait controls 收入 `pi_tool_gateway/monitor_tools.rs`。
  - `pi_monitor_runtime` 继续拥有进程与通知流状态；monitor adapter 只映射已授权 ToolGateway 请求。父 gateway 仍负责 task-id 类型识别及 monitor/terminal 混合 wait 拒绝，两个状态 registry 不合并。
- 第二十一切片：Host scheduler tool adapter
  - 将 scheduler create/list/delete 参数解析、database access、session ownership checks 和 bounded schedule snapshot 收入 `pi_tool_gateway/scheduler_tools.rs`。数据库依旧是持久状态唯一 source of truth；父 resolver 仍在 adapter 被调用前执行 Host 授权。
  - 静态兼容检查改为读取 scheduler adapter 的实现字段，并验证 parent dispatch/wiring；测试保持原 gateway integration entry。当前 `pi_tool_gateway.rs` 为 1,533 行，monitor adapter 207 行、scheduler adapter 112 行、terminal lifecycle 660 行。
  - 验证：gateway 定向 tests 35 passed；全 Rust lib tests 285 passed；`cargo check --locked --lib` 无 warning；`cargo fmt --check`、`pnpm check`、`pnpm lint`、`pnpm format:check`、`git diff --check` passed。未改 TS runtime，unit/build 沿用第十八切片通过的累积证据。
- 第二十二切片：Pi runtime policy configuration projections
  - 将 terminal timeout/output、interactive question timeout、goal safeguards、gitignore visibility、`.envrc`、model network/catalog URL 与 sandbox profile projections 移入 `config_pi_policy.rs`，把 config merge/value selection 作为 parent 的共享底层 helper 留在原位。
  - `config_extensions.rs` 继续拥有 plugin/skill/prompt inventory、扫描与 manifest assembly；由原模块显式 re-export policy functions，保持 `config_runtime` 调用路径。Pi compatibility checker 从 policy owner 验证实现并断言 parent wiring。
  - `config_extensions.rs` 从 2,162 行降至 1,737 行，policy owner 450 行；修正一段原本误挂到 config merge helper 上的 resource-manifest 文档注释。
  - 验证：配置测试 27 passed；全 Rust lib tests 285 passed；`cargo check --locked --lib` 无 warning；`cargo fmt --check`、`pnpm check`、`pnpm lint`、`pnpm format:check`、`git diff --check` passed。此片未改 TS runtime；本片后未重复 `pnpm test:unit`/`pnpm build`。

## 测试结果

| 测试                                                                                                                                                                                                    | 输入                                     | 预期结果                                                                      | 实际结果                                               | 状态   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ------ |
|                                                                                                                                                                                                         |                                          |                                                                               |                                                        | 未运行 |
| `pnpm test:agent-worker`                                                                                                                                                                                | 当前 beta，第十八切片后                  | 145 passed                                                                    | 145 passed                                             | passed |
| `pnpm test:unit`                                                                                                                                                                                        | 当前 beta，第十八切片后                  | 403 passed                                                                    | 403 passed                                             | passed |
| `pnpm check` / `lint` / `format:check` / `build`                                                                                                                                                        | 当前 beta，第十八切片后                  | 全部通过                                                                      | 全部通过（build 有既有大 chunk warning）               | passed |
| `git diff --check`                                                                                                                                                                                      | 当前 beta 工作树                         | 无空白错误                                                                    | 无输出                                                 | passed |
| `cargo test --locked --lib pi_tool_gateway::tests`                                                                                                                                                      | 当前 beta 基线（第一、二切片前）         | 35 passed                                                                     | 35 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第十二切片后                  | 全部 Rust lib 单测通过                                                        | 285 passed                                             | passed |
| `cargo test --locked --lib pi_mcp_runtime::tests`                                                                                                                                                       | 当前 beta，第十二切片后                  | MCP config/local/remote transport 与 lifecycle 测试通过                       | 15 passed                                              | passed |
| `cargo test --locked --lib subagent_worktrees::tests`                                                                                                                                                   | 当前 beta，第七切片后                    | 安全边界测试通过                                                              | 2 passed                                               | passed |
| `cargo test --locked --lib pi_worker_runtime::tests`                                                                                                                                                    | 当前 beta，第八切片后                    | Worker protocol/runtime 单测通过                                              | 8 passed                                               | passed |
| `cargo test --locked --lib pi_worker_runtime::memory_lifecycle::tests`                                                                                                                                  | 当前 beta，第八切片后                    | Memory transcript 上限单测通过                                                | 1 passed                                               | passed |
| `cargo check --locked --lib`                                                                                                                                                                            | 当前 beta，第十二切片后                  | 编译无警告                                                                    | 通过，无警告                                           | passed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`                                                                                                                                             | 当前 beta，第十二切片后                  | 无格式差异                                                                    | 无输出                                                 | passed |
| `pnpm check` / `pnpm lint` / `pnpm format:check` / `pnpm test:unit` / `pnpm build`                                                                                                                      | 当前 beta，第十八切片后                  | 类型、架构静态门禁、lint、format、unit tests 和 build 通过                    | 全部通过；build 保留既有 chunk warning                 | passed |
| `cargo test --locked --lib pi_tool_gateway::tests`                                                                                                                                                      | 当前 beta，第十九切片后                  | Host gateway/terminal/task-control 测试通过                                   | 35 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第十九切片后                  | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check`                                                                                                                                                      | 当前 beta，第十九切片后                  | 无编译 warning 或格式差异                                                     | passed                                                 | passed |
| `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                                                                                                                   | 当前 beta，第十九切片后                  | 静态兼容、类型、lint、format 与 diff 检查通过                                 | passed                                                 | passed |
| `cargo test --locked --lib pi_tool_gateway::tests`                                                                                                                                                      | 当前 beta，第二十一切片后                | gateway、monitor、scheduler、terminal behaviors preserved                     | 35 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十一切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十一切片后                | 无 warning；兼容、格式和静态检查通过                                          | passed                                                 | passed |
| `cargo test --locked --lib config_runtime::tests`                                                                                                                                                       | 当前 beta，第二十二切片后                | config/policy/inventory compatibility tests pass                              | 27 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十二切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十二切片后                | 编译无 warning、所有静态兼容与格式检查通过                                    | passed                                                 | passed |
| `cargo test --locked --lib config_runtime::tests`                                                                                                                                                       | 当前 beta，第二十三切片后                | marketplace/config compatibility tests pass                                   | 27 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十三切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十三切片后                | 编译无 warning、兼容/静态/格式检查通过                                        | passed                                                 | passed |
| `cargo test --locked --lib config_runtime::config_marketplace::config_marketplace_native::tests`                                                                                                        | 当前 beta，第二十四切片后                | Marketplace native workflow tests pass                                        | 10 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十四切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十四切片后                | 编译无 warning、兼容/静态/格式检查通过                                        | passed                                                 | passed |
| `cargo test --locked --lib config_runtime::config_subagents::tests`                                                                                                                                     | 当前 beta，第二十五切片后                | Subagent definition/policy tests pass                                         | 6 passed                                               | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十五切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十五切片后                | 编译无 warning、兼容/静态/格式检查通过                                        | passed                                                 | passed |
| `cargo test --locked --lib pi_memory_runtime::tests`                                                                                                                                                    | 当前 beta，第二十六切片后                | Memory store/lifecycle behavior preserved                                     | 15 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十六切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十六切片后                | 编译无 warning、兼容/静态/格式检查通过                                        | passed                                                 | passed |
| `cargo test --locked --lib pi_browser_runtime::tests`                                                                                                                                                   | 当前 beta，第二十七切片后                | Browser tabs/snapshot/URL trust behaviors preserved                           | 12 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十七切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十七切片后                | 编译无 warning、兼容/静态/格式检查通过                                        | passed                                                 | passed |
| `cargo test --locked --lib pi_worker_runtime::tests`                                                                                                                                                    | 当前 beta，第二十八切片后                | Worker command/event protocol 与 supervisor behavior preserved                | 8 passed                                               | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十八切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十八切片后                | 编译无 warning、兼容/静态/格式检查通过                                        | passed                                                 | passed |
| `cargo test --locked --lib pi_worker_runtime::tests`                                                                                                                                                    | 当前 beta，第二十九切片后                | Worker env projection/runtime behaviors preserved                             | 8 passed                                               | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第二十九切片后                | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第二十九切片后                | 编译无 warning、兼容/静态/格式检查通过                                        | passed                                                 | passed |
| `cargo test --locked --lib config_runtime::tests`                                                                                                                                                       | 当前 beta，第三十切片首轮                | 配置、Pi resource projection 与兼容行为保持                                   | 27 passed                                              | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第三十切片                    | Rust lib 全部单测通过                                                         | 285 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第三十切片                    | 无 warning；Pi compatibility、类型、lint、格式和 diff 检查通过                | passed                                                 | passed |
| `cargo test --locked --lib marketplace_registry::tests`                                                                                                                                                 | 当前 beta，第三十一切片                  | Registry rollback 与 shared uninstall contract tests                          | 2 passed                                               | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第三十一切片                  | Rust lib 全部单测通过                                                         | 287 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第三十一切片                  | 无 warning；类型、兼容、lint、格式和 diff 检查通过                            | passed                                                 | passed |
| `pnpm test:unit` / `pnpm build`                                                                                                                                                                         | 当前 beta，第三十一切片                  | Full JS unit suite 与 production build                                        | 403 passed / build passed；既有 >500 kB chunk warnings | passed |
| `cargo test --locked --lib pi_model_config::tests` / `remote_model_catalog::tests`                                                                                                                      | 当前 beta，第三十二切片                  | Model projection 与 remote catalog cache tests                                | 16 + 2 passed                                          | passed |
| `cargo test --locked --lib`                                                                                                                                                                             | 当前 beta，第三十二切片                  | Rust lib 全部单测通过，含 monitor output drain regression                     | 289 passed                                             | passed |
| `cargo check --locked --lib` / `cargo fmt --check` / `pnpm check` / lint / format / diff check                                                                                                          | 当前 beta，第三十二切片及 monitor 修复后 | 无 warning；compatibility checker 跟随 remote catalog owner                   | passed                                                 | passed |
| `pnpm test:unit` / `pnpm build`                                                                                                                                                                         | 当前 beta，第三十二切片                  | Full JS unit suite 与 production build                                        | 403 passed / build passed；既有 >500 kB chunk warnings | passed |
| `cargo test --locked --lib pi_lsp_runtime::projection::tests` / `pi_lsp_runtime::tests`                                                                                                                 | 当前 beta，第三十三切片                  | 纯 LSP projection 和 runtime integration tests                                | 3 + 5 passed                                           | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第三十三切片                  | Rust lib 全部单测通过                                                         | 290 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / Rust fmt / `pnpm check` / lint / format / diff check                                                                                | 当前 beta，第三十三切片                  | 无 warning；projection owner/wiring 与格式静态门禁通过                        | passed                                                 | passed |
| `pnpm test:agent-worker`                                                                                                                                                                                | 当前 beta，第三十四切片                  | Worker 和子代理 sidecar storage tests                                         | 145 passed                                             | passed |
| `pnpm test:unit` / `pnpm build`                                                                                                                                                                         | 当前 beta，第三十四切片                  | Full JS unit suite 与 production build                                        | 403 passed / build passed；既有 >500 kB chunk warnings | passed |
| `pnpm check` / lint / `pnpm format:check` / `git diff --check`                                                                                                                                          | 当前 beta，第三十四切片                  | Worker typing、Pi compatibility wiring、lint/format/diff gates                | passed                                                 | passed |
| `cargo test --locked --lib pi_lsp_runtime::lsp_config::tests` / `pi_lsp_runtime::tests`                                                                                                                 | 当前 beta，第三十五切片                  | LSP config trust/path tests 与 runtime tests                                  | 2 + 3 passed                                           | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第三十五切片                  | Rust lib 全部单测通过                                                         | 290 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / Rust fmt / `pnpm check` / lint / format / diff check                                                                                | 当前 beta，第三十五切片                  | 无 warning；LSP config owner/wiring 与格式门禁通过                            | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib config_marketplace`                                                                                                                     | 当前 beta，第三十六切片                  | Marketplace native/registry/filesystem owners                                 | 15 passed                                              | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第三十六切片                  | Rust lib 全部单测通过                                                         | 293 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / Rust fmt / `pnpm check` / lint / format / diff check                                                                                | 当前 beta，第三十六切片                  | 无 warning；Marketplace filesystem owner 与类型/compatibility/format 门禁通过 | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_browser_runtime`                                                                                                                     | 当前 beta，第三十七切片                  | Browser runtime 与 screenshot geometry tests                                  | 12 passed                                              | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第三十七切片                  | Rust lib 全部单测通过                                                         | 293 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / Rust fmt / `pnpm check` / lint / format / diff check                                                                                | 当前 beta，第三十七切片                  | 无 warning；Pi compatibility、类型和格式门禁通过                              | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_browser_runtime`                                                                                                                     | 当前 beta，第三十八切片                  | Browser runtime、screenshot 和 bounded page/wait tests                        | 12 passed                                              | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第三十八切片                  | Rust lib 全部单测通过                                                         | 293 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / Rust fmt / `pnpm check` / lint / format / diff check                                                                                | 当前 beta，第三十八切片                  | 无 warning；Pi compatibility、类型和格式门禁通过                              | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_memory_runtime::store::search_index::tests`                                                                                          | 当前 beta，第三十九切片                  | 不可用或被篡改的 SQLite sidecar 回退到 Markdown chunks                        | 2 passed                                               | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第三十九切片                  | Rust lib 全部单测通过                                                         | 295 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                         | 当前 beta，第三十九切片                  | 无 warning；Pi compatibility wiring、lint、格式与 diff 门禁通过               | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_codebase_runtime`                                                                                                                    | 当前 beta，第四十切片                    | Codebase bridge, indexing policy, parser language and occurrence tests        | 8 passed                                               | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第四十切片                    | Rust lib 全部单测通过                                                         | 298 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                         | 当前 beta，第四十切片                    | 无 warning；Pi compatibility parser owner/wiring、lint、格式与 diff 门禁通过  | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_worker_runtime`                                                                                                                      | 当前 beta，第四十一切片                  | Supervisor, envrc, launch allowlist and exact binary candidate tests          | 10 passed                                              | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第四十一切片                  | Rust lib 全部单测通过                                                         | 299 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                         | 当前 beta，第四十一切片                  | 无 warning；launch owner/wiring、lint、格式与 diff 门禁通过                   | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib database_agent_schedules`                                                                                                               | 当前 beta，第四十二切片                  | Schedule state 与纯 policy tests                                              | 12 passed                                              | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第四十二切片                  | Rust lib 全部单测通过                                                         | 299 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                         | 当前 beta，第四十二切片                  | 无 warning；调度调用路径、compatibility、lint、格式与 diff 门禁通过           | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib database_agent_events`                                                                                                                  | 当前 beta，第四十三切片                  | Event contract projection/validation 与 transactional event log behavior      | 15 passed                                              | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第四十三切片                  | Rust lib 全部单测通过                                                         | 302 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                         | 当前 beta，第四十三切片                  | 无 warning；Pi compatibility、lint、格式与 diff 门禁通过                      | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_worker_runtime`                                                                                                                      | 当前 beta，第四十四切片                  | Worker supervisor、protocol affinity、frame/metadata checks                   | 10 passed                                              | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第四十四切片                  | Rust lib 全部单测通过                                                         | 302 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                         | 当前 beta，第四十四切片                  | 无 warning；protocol owner/wiring、lint、格式与 diff 门禁通过                 | passed                                                 | passed |
| `node --test src/domain/agent/billing-usage.test.mjs src/domain/agent/event-to-session-update.test.mjs`                                                                                                 | 当前 beta，第四十五切片                  | Usage merge、billing projection 与 reducer integration                        | 27 passed                                              | passed |
| `pnpm test:unit`                                                                                                                                                                                        | 当前 beta，第四十五切片                  | Full JS unit suite                                                            | 406 passed                                             | passed |
| `pnpm check` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `git diff --check`                                                                                                                    | 当前 beta，第四十五切片                  | Static/type, style and production build gates                                 | passed; existing large-chunk warnings                  | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib config_subagents::tests::inventory_uses_the_shared_markdown_scan_and_support_classification`                                            | 当前 beta，第四十六切片                  | Shared markdown inventory scan and support classification                     | 1 passed                                               | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第四十六切片                  | Rust lib 全部单测通过                                                         | 303 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                         | 当前 beta，第四十六切片                  | 无 warning；Pi compatibility、lint、格式与 diff 门禁通过                      | passed                                                 | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib config_subagents::tests`                                                                                                                | 当前 beta，第四十七切片                  | Subagent policy, parser, inventory scope/override tests                       | 8 passed                                               | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第四十七切片                  | Rust lib 全部单测通过                                                         | 304 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                         | 当前 beta，第四十七切片                  | 无 warning；Pi compatibility、lint、格式与 diff 门禁通过                      | passed                                                 | passed |
| `pnpm check:architecture`                                                                                                                                                                               | 当前 beta，架构门禁复核                  | Import AST self-tests plus current domain/Pi SDK dependency scan              | 3 passed; architecture boundaries intact               | passed |
| `node --experimental-strip-types --test src/domain/agent/capability-report.test.mjs`                                                                                                                    | 当前 beta，第四十九切片                  | Host MCP inventory authoritative-status contract                              | 42 passed                                              | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_mcp_runtime::mcp_config::tests`                                                                                                      | 当前 beta，第四十九切片                  | Partial inventory when one config scope has parse error                       | 1 passed                                               | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`                                                                                                                                        | 当前 beta，第四十九切片                  | Rust lib 全部单测通过                                                         | 305 passed                                             | passed |
| `pnpm test:unit`                                                                                                                                                                                        | 当前 beta，第四十九切片                  | Full JS unit suite                                                            | 407 passed                                             | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --check` / `pnpm check` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `git diff --check`                          | 当前 beta，第四十九切片                  | No Rust warnings; type/static/style and production build gates                | passed; build retains existing >500 kB chunk warnings  | passed |
| `node --experimental-strip-types --test packages/agent-worker/src/pi/subagent-policy.test.mjs`                                                                                                          | 当前 beta，第五十切片                    | Subagent policy defaults and permission-ceiling owner tests                   | 7 passed                                               | passed |
| `pnpm test:agent-worker`                                                                                                                                                                                | 当前 beta，第五十切片                    | Worker suite now includes subagent policy owner tests                         | 152 passed                                             | passed |
| `pnpm test:unit`                                                                                                                                                                                        | 当前 beta，第五十切片                    | Full JS unit suite                                                            | 408 passed                                             | passed |
| `pnpm check` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `git diff --check`                                                                                                                    | 当前 beta，第五十切片                    | Type/static/style and production build gates                                  | passed; build retains existing >500 kB chunk warnings  | passed |
| `pnpm test:agent-worker`                                                                                                                                                                                | 当前 beta，第五十一切片                  | Worker runtime and model-catalog owner tests                                  | 155 passed                                             | passed |
| `pnpm test:unit`                                                                                                                                                                                        | 当前 beta，第五十一切片                  | Full JS unit suite                                                            | 411 passed                                             | passed |
| `pnpm check` / `pnpm check:architecture` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `git diff --check`                                                                                        | 当前 beta，第五十一切片                  | Type, architecture, style and production build gates                          | passed; build retains existing >500 kB chunk warnings  | passed |
| `node --experimental-strip-types --test packages/agent-worker/src/pi/model-policy.test.mjs packages/agent-worker/src/pi/session-adapter.test.mjs`                                                       | 当前 beta，第五十二切片                  | Model-policy owner tests plus remaining session adapter tests                 | 54 passed                                              | passed |
| `pnpm test:agent-worker` / `pnpm test:unit`                                                                                                                                                             | 当前 beta，第五十二切片                  | Registered worker and full JS unit suites                                     | 155 / 411 passed                                       | passed |
| `pnpm check` / `pnpm lint` / `pnpm format:check` / `git diff --check`                                                                                                                                   | 当前 beta，第五十二切片                  | Type, static compatibility, lint, formatting and diff gates                   | passed                                                 | passed |
| `node --experimental-strip-types --test packages/agent-worker/src/pi/subagent-policy.test.mjs packages/agent-worker/src/pi/tool-gateway.test.mjs packages/agent-worker/src/pi/session-adapter.test.mjs` | 当前 beta，第五十三切片                  | Launch-policy owner, gateway re-export and adapter integration tests          | 82 passed                                              | passed |
| `pnpm test:agent-worker` / `pnpm test:unit`                                                                                                                                                             | 当前 beta，第五十三切片                  | Registered worker and full JS unit suites                                     | 159 / 415 passed                                       | passed |
| `pnpm check` / `pnpm check:architecture` / `pnpm lint` / `pnpm format:check` / `pnpm build` / `git diff --check`                                                                                        | 当前 beta，第五十三切片                  | Type, compatibility, architecture, style and production build gates           | passed; build retains existing >500 kB chunk warnings  | passed |

| `pnpm check:pi-compatibility` | 当前 beta，第五十四切片 | Tauri permission owner fixtures + complete Pi compatibility gate | 3 passed; compatibility passed | passed |
| `pnpm check` / `pnpm check:architecture` / `pnpm lint` / `pnpm format:check` / `pnpm test:unit` / `git diff --check` | 当前 beta，第五十四切片 | Type, compatibility, architecture, style, full JS unit and diff gates | unit 415 passed; all gates passed | passed |
| `node --test scripts/pi-model-policy-compatibility.test.mjs` | 当前 beta，第五十九切片 | Model policy snapshot owner fixtures | 5 passed | passed |
| `pnpm check` | 当前 beta，第五十九切片 | Types, worker checks, packaging, compatibility fixtures and real Pi gate | 21 compatibility fixtures passed; all checks passed | passed |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | 当前 beta，第五十九切片 | Full Rust library suite | 305 passed | passed |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` / `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 当前 beta，第五十九切片 | Rust library compiles without warnings and formatting is clean | passed | passed |
| `pnpm check:architecture` / `pnpm lint` / `pnpm format:check` / `pnpm test:unit` / `git diff --check` | 当前 beta，第五十九切片 | Architecture, lint, formatting, full JS unit and whitespace gates | 3 architecture fixtures; 415 unit tests; all gates passed | passed |

## 错误日志

| 时间戳     | 错误                                                                                                                                                   | 尝试次数 | 解决方案                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | worker TypeScript 检查发现 4 个抽取后遗留的未用 import                                                                                                 | 1        | 已删除 imports，待完整复验                                                                                                                                                  |
| 2026-10-10 | Pi compatibility checker 假定资源发现代码仍位于 session-adapter.ts                                                                                     | 1        | 更新检查目标到 resource-discovery.ts，保留 adapter wiring 检查                                                                                                              |
| 2026-10-10 | format:check 发现 session-adapter.ts 在 import 清理后需重新格式化                                                                                      | 1        | 已运行 Prettier，最终 format:check 通过                                                                                                                                     |
| 2026-10-10 | 工具名迁移到 request_policy.rs 后 compatibility check 仍在 pi_tool_gateway.rs 查找 monitor/scheduler 常量                                              | 1        | 检查器改读 request-policy 所有者并检查模块接线；`pnpm check` 通过                                                                                                           |
| 2026-10-10 | instruction-scope 实现迁出后 gateway 留下未用 `io::self`                                                                                               | 1        | 删除失效导入；cargo check、Rust tests 与其他门禁复验通过                                                                                                                    |
| 2026-10-10 | worktree 新模块测试未导入 `RELATIVE_ROOT`                                                                                                              | 1        | 补充测试子模块导入；worktree 专项、gateway 与全 Rust 测试通过                                                                                                               |
| 2026-10-10 | memory component 调用点最初将 Tauri `State::inner()` 结果误当成 worker inner state                                                                     | 1        | 根据 Rust 编译错误增加显式 `PiWorkerRuntime.inner` 字段访问；所有 Rust 测试通过                                                                                             |
| 2026-10-10 | Host tool routing 提取后兼容检查仍要求 LSP/codebase bridge 直接出现在父 runtime 文件                                                                   | 1        | 将检查转到 `host_tool_routing.rs` 并验证父模块声明；`pnpm check` 通过                                                                                                       |
| 2026-10-10 | `format:check` 发现兼容检查器改动未按 Prettier 格式化                                                                                                  | 1        | 运行 Prettier 后复验 `format:check` 通过                                                                                                                                    |
| 2026-10-10 | worker 首轮回归因网关移除 `isAgentSessionModeId` import 失败                                                                                           | 1        | 确认网关仍在审批前校验调用该函数，保留网关依赖；141 项 worker tests 通过                                                                                                    |
| 2026-10-10 | 首次 schemas 抽取漏掉 catalog 内 browser TypeBox schemas，并留下只用于 re-export 的 unused imports                                                     | 1        | 全量迁入 10 个 inline browser schemas；只在网关侧 re-export bounds，不保留未使用 imports；类型/静态门禁无告警通过                                                           |
| 2026-10-10 | request-lifecycle 初版使用 Node strip-only 不支持的构造器参数属性                                                                                      | 1        | 改用显式字段及构造器赋值；worker tests、完整门禁与 build 通过                                                                                                               |
| 2026-10-10 | task-tools 类型迁移后 `PiSubagentIsolation` 暂时同时在 gateway 本地声明与导入                                                                          | 1        | 删除重复 union 声明，改为从 task-tools 导入并由旧 gateway 路径 re-export；完整检查通过                                                                                      |
| 2026-10-10 | terminal lifecycle 移动后 gateway 测试缺少原顶层作用域带入的 `Stdio`                                                                                   | 1        | 为沙箱集成测试增加 `#[cfg(test)]` 专用导入；定向与全 Rust tests 通过                                                                                                        |
| 2026-10-10 | monitor/scheduler adapter 拆出后兼容 checker 仍从父 gateway 搜索 scheduler fields                                                                      | 1        | 改为从 `scheduler_tools.rs` 验证参数消费，并对 gateway dispatch/wiring 单独断言                                                                                             |
| 2026-10-10 | Host gateway 的 Rust lib check 因迁出 scheduler/monitor 实现后只剩测试使用 `json!` 导入                                                                | 1        | 将 macro import 限定为 `#[cfg(test)]`，最终 `cargo check --lib` 无 warning                                                                                                  |
| 2026-10-10 | Pi policy 提取后配置单测缺少原顶层 `env` import，且 policy pure helper 只在 test 使用                                                                  | 1        | 将测试 env import 移入 test module，sandbox precedence helper 使用 `#[cfg(test)]` import；最终 Rust suites 和 lib check 通过                                                |
| 2026-10-10 | Marketplace transport 首轮编译缺少独立模块的 `std::fs` import，且 SHA validator 仍留在 parent                                                          | 1        | 将 SHA 校验归入 transport owner、在 parent 保留内部导入路径并补 `std::fs`；cargo check 与全部 Rust tests 通过                                                               |
| 2026-10-10 | catalog 抽取后 parent 首轮 check 报告 unused transport/catalog imports                                                                                 | 1        | 仅导入实际跨模块边界的函数和类型；`resolve_beneath` 留作 catalog 私有 helper，cargo check 无 warnings                                                                       |
| 2026-10-10 | Markdown parser 抽取首轮 Rust check 缺少 `valid_mcp_tool_name`/`apply_agent_tool_ceiling` 导入且有未用 name bound import                               | 1        | 将两个 parent normalization 仍使用的函数显式设为 `pub(super)` 并导入，删除未用常量导入；最终 cargo check 无 warnings                                                        |
| 2026-10-10 | Memory store 首轮批量抽取因先替换文本再用旧 offset 删除区间而损坏 `pi_memory_runtime.rs`                                                               | 1        | 以尝试前干净的 beta 文件恢复该目标，再从不可变源预计算互不重叠的移除区间、断言后统一生成；memory 专项与全 Rust suite 均通过                                                 |
| 2026-10-10 | Browser URL policy 抽取首轮 library check 发现 `validate_local_preview_url` 仍由两个生产入口直接使用                                                   | 1        | 将函数作为正式跨模块 policy 接口导入 parent；cargo check 无 warning，full Rust suite 285 passed                                                                             |
| 2026-10-10 | Worker protocol 首轮 library check 发现 parent 缺少 `mod protocol` 声明                                                                                | 1        | 添加显式 module declaration 并更新静态 wiring check；cargo check 与 full Rust suite 通过                                                                                    |
| 2026-10-10 | `.envrc` loader 迁出后 compatibility checker 仍在 supervisor 文件中查找 `direnv` 实现 marker                                                           | 1        | 将实现 marker 定位至 `envrc.rs`，另行断言 parent wiring 和 allowlist argument；`pnpm check` 通过                                                                            |
| 2026-10-10 | `config_pi_resources.rs` 首轮 library check 使用了错误的兄弟模块路径，且 test-only re-export 包含未被跨模块测试使用的项目                              | 1        | 修正为经 `config_runtime` 父模块访问 siblings；收窄 test-only re-export 至现有测试真正消费的 surface；full Rust suite、cargo check 无 warning 通过                          |
| 2026-10-10 | Registry owner test 将 canonical repository path 与未 canonicalize 的 temp path 比较                                                                   | 1        | 预先 canonicalize fixture repo path 后断言受控 remove outcome；registry 专项与完整 Rust suite 通过                                                                          |
| 2026-10-10 | Remote catalog 抽取后 test build 暴露 parent 顶层 `env` import 仅供测试使用                                                                            | 1        | 保留测试模块自己的 `env` import、删除生产模块未用 import；定向测试与 cargo check 无 warning                                                                                 |
| 2026-10-10 | 全 Rust suite 暴露 monitor waiter 先于 stdout/stderr readers 写入最终快照的竞态                                                                        | 1        | waiter join 所有 reader threads 后才 finish；增强 completed snapshot assertion，目标测试连续 3 次和完整 289 项 suite 通过                                                   |
| 2026-10-10 | 首次 LSP projection 定向测试 filter 未匹配新子模块路径，导致 0 项测试运行                                                                              | 1        | 改用 `pi_lsp_runtime::projection::tests` 后确认 3 项 projection tests 实际运行并通过；完整 Rust suite 为 290 项                                                             |
| 2026-10-10 | LSP config 首次定向测试 filter 未包含 parent runtime module path，导致 0 项测试运行；移动 config imports 后 Rust test build 还报 unused imports        | 1        | 使用 `pi_lsp_runtime::lsp_config::tests` 确认 2 项真实测试通过，并删除 parent 只由 config 使用的 imports；`cargo check --lib` 无 warning                                    |
| 2026-10-10 | Marketplace filesystem owner 初次编译发现调用方直接读取 `CleanupDirectory` 私有 tuple field，`cargo check` 另报 parent 只在测试使用的 validator import | 1        | 提供受控 `path()` 读取并在测试中通过 catalog owner 限定 validator；完整 Rust lib 与 warning-free cargo check 通过                                                           |
| 2026-10-10 | Browser page owner 的首次 library check 发现 `json!` 只被测试使用                                                                                      | 1        | 将宏 import 限定到 `#[cfg(test)]`；最终 cargo check 无 warnings，完整 Rust suite 通过                                                                                       |
| 2026-10-10 | Pi worker launch 首轮编译发现 inherited env allowlist 未对父 supervisor 开放，且旧 parent import 只用于测试                                            | 1        | 将常量限定提升到 parent module scope并删除失效 import；Pi worker tests 与 warning-free cargo check 通过                                                                     |
| 2026-10-10 | Memory search-index 子模块首轮编译发现跨模块 re-export 可见性不足和漏导入 chunk bound                                                                  | 1        | 将 facade 接口限定到 `crate::pi_memory_runtime` scope、将内部 fallback 留在 store 调用，并导入共享 chunk bound；targeted/full Rust tests 和 warning-free `cargo check` 通过 |
| 2026-10-10 | Schedule policy 首轮 check 发现未使用的 `ScheduleAdvance` crate re-export                                                                              | 1        | 收窄父模块 re-export 到已有生产调用面实际使用的函数/常量；schedule tests 与 warning-free cargo check 通过                                                                   |
| 2026-10-10 | Event contract 首轮 check 发现事件 byte-bound constant 的 crate re-export 无生产消费者                                                                 | 1        | 将常量留在实际执行限界的 event contract owner，不保留无用内部 API；事件专项、full Rust tests 和 warning-free cargo check 通过                                               |
| 2026-10-10 | MCP inventory wiring gate 对 Rust re-export 的标识符顺序做了不必要的精确匹配                                                                           | 1        | checker 改为分别检查 module wiring 与 exported inspector，不依赖 import 排列；Pi compatibility gate 通过                                                                    |
| 2026-10-10 | launch-policy projection 初版漏掉 resumed request isolation 的旧 fail-closed validation                                                                | 1        | 恢复持久化边界解析前的 request validation 并增加 regression test；worker 159、unit 415 与完整 JS 门禁通过                                                                   |
| 2026-10-10 | compatibility-gate 结构探测命令因 root 未安装 `espree` 且 shell 插值展开报错而失败                                                                     | 1        | 不安装新依赖；改用仓库已有 TypeScript parser 和源码分段证据继续审计                                                                                                         |

| 2026-10-10 | compatibility-gate 结构探测命令因 root 未安装 `espree` 且 shell 插值展开报错而失败 | 1 | 不安装依赖；使用现有 TypeScript parser 对源码 AST 分段，继续审计 |
| 2026-10-10 | progress.md 两次增补 patch 使用了 Prettier 前的长表格行间距 | 2 | 改为按稳定标题分块增补，再读取当前汇总行，避免重复旧行上下文 |
| 2026-10-10 | package.json 超长 format command 的整行 patch 未匹配 | 1 | 改在 Pi compatibility gate 中 targeted-check 新脚本格式与 fixture tests，不重写全局脚本列表 |

## 五问重启检查（第五十三切片时）

| 问题           | 答案                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 我要去哪里？   | 继续审计未处理的大模块和跨模块依赖方向，确认下一处真实变化边界及其安全测试 seam；避免仅基于文件大小拆分                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 目标是什么？   | 清除结构性屎山，提升长期维护性而不牺牲行为和安全约束                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 我学到了什么？ | 见 findings.md；策略模块可依赖结构化 model identity，网关 request-policy 应拥有稳定工具名，Host 仍保留授权裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 我在哪里？     | 阶段 3：五十三个职责簇/架构边界切片已完成并通过匹配门禁，继续审计剩余依赖/验证热点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 我做了什么？   | session adapter 从 5,543 行降至当前 3,753 行，模型目录运行时单独归属 `model-catalog-runtime.ts`，model-policy direct tests 归属 `model-policy.test.mjs`，子代理 request/resume/parent launch projection 归属 `subagent-policy.ts`；session-adapter suite 主要覆盖会话与 runtime behavior。Host gateway 从 4,617 行降至 1,533 行，terminal/monitor/scheduler 分别归属职责模块；config extensions 从 2,162 行降至 1,067 行，新增 Pi policy/resource owners；Pi worker runtime 从 3,218 行降至 1,665 行，新增 memory lifecycle、Host tool routing、protocol、envrc 与 launch owners；Pi MCP runtime 从 2,841 行降至 1,288 行；tool gateway 从 2,654 行降至 938 行；`pi_memory_runtime.rs` 从 2,054 行降至 728 行，store 再拆分为 Markdown/tool owner 与 `search_index.rs`；`pi_codebase_runtime.rs` 从 1,322 行降至 1,020 行并新增 parser owner；`pi_browser_runtime.rs` 已分离 URL policy、screenshot 与 page tools；Marketplace native parent 从 1,812 行降至 1,381 行并新增 registry/filesystem owners；Pi model config 从 1,488 行降至 1,104 行并新增 remote catalog owner；LSP runtime 从 1,051 行降至 732 行，并形成独立 config 与 result projection owners；`database_agent_schedules.rs` 从 1,324 行降至 1,022 行，纯调度 policy 独立测试；`database_agent_events.rs` 从 843 行降至 677 行，并新增有界 event ingress contract owner；第四十五至六十切片还形成 billing usage、共享 Markdown inventory、Settings projection、AST 架构门禁、Host MCP inventory、subagent capability defaults、model catalog runtime、owner-local tests 与跨端 contracts 等职责 owner。当前 `check-pi-compatibility.mjs` 为 1,849 行，14 个 Host bridge groups 仍待依赖审计；下一具体候选是 Host 与 worker 的 `max_retries` 上限不一致。 |

> 上方阶段摘要保留早期进度快照；当前切片、测试数和工作区状态以本段为准。

## 当前重启信息（第六十九切片后）

- 阶段 3 已分片验证 69 个职责、架构边界和测试所有权切片，整体仍在进行；已验证切片不等于全仓结构债务目标完成。
- 第六十八片为 `memoryTools`/`webTools` 的数值 drift coverage：在各自 fixture-tested owners 中对比 6 项 memory 与 4 项 web manifest bounds 和真实 Host constants；当前十项值均一致，运行时和 manifest 未改。
- Memory/web owner 定向 14 项通过；Pi compatibility fixtures 总计 55 项且真实 checker 通过。完整 unit 420、`pnpm check`、architecture 3、lint、format、`git diff --check` 全通过；静态 checker/tests/docs 变更，无需重跑产品构建。
- worker schema 中 `maxLength` 与 Host Rust `.len()` byte limits 的单位不同，不把它们直接视为相同上限。本片添加 drift tests，不声称修复了真实数值偏差。
- 第六十七片将 inline `memoryTools` wiring gate 迁至 `scripts/pi-memory-tools-compatibility.mjs`；第六十六片将 `webTools` marker/wiring checks 迁至对应 owner。组合 checker 仍负责文件读取和诊断。
- 第六十六片已将 `webTools` inline checks 收入 `pi-web-tools-compatibility.mjs`，5 项 owner tests；manifest tool names、worker schema/Host route 与 HTTPS/bounded-response markers 由独立 fixture 覆盖。
- 第六十五片将子代理 resume/cwd/worktree trust boundary 与测试归入 `subagent-session-boundaries.ts`；`session-adapter.ts` 从 4,149 行降至 3,460 行，并保留原导出身份验证。
- 第六十九片将 `lspBridge` manifest mapping、Host runtime/config/projection markers 与 worker routing checks 迁入 fixture-tested `pi-lsp-compatibility.mjs`；聚合 checker 仍读取 snapshots 并拥有统一 diagnostics。9 项 owner fixtures 覆盖 source drift/wiring 与 no-policy no-op。
- Pi compatibility fixtures 共 64 项、真实 checker 通过；完整 unit 420、`pnpm check`、architecture 3、lint、format 均通过。本片只改静态 checker、fixtures、package gate 和规划文档；产品 build 未重跑，LSP runtime/授权/会话行为未改。
- 下一只读候选是 `codebaseIndex` 的 manifest/worker/Host/runtime/parser contract，已审计其现有 snapshots、marker 与三个数值上限；正在等待用户确认纯 fixture owner seam，确认前未改代码或测试。
- 其余 Host bridge groups 仍需按调用图/数据所有权继续审计；避免按行数机械拆分，也不把本次数值 coverage 当作全仓治理完成。
- 当前 branch/version：`beta` / `0.4.0-beta.2`；三处 release version 对齐。未 commit、push、publish 或 merge main。

## 第六十八切片：memoryTools 与 webTools 数值边界 drift checks

- 两个 owner 分别从真实 Host snapshots 解析 memory 六项和 web 四项 numeric constants，与 manifest 的 byte/count fields 比较；数值全对齐，未复制常量或修改 runtime/manifest。
- 两个漂移 fixtures 将 Host 声明改为不同数值并断言逐字段 diagnostics；workers 的 character-count `maxLength` 保持单位边界，不与 Host byte caps 混同。
- 14 个 owner tests、55 个 Pi compatibility fixtures 与真实 checker、`pnpm check`、420 个 unit tests、3 个 architecture tests、lint、format 和 diff check 通过。
- 第六十八切片仅改静态 checker、fixtures 与规划文档；beta/0.4.0-beta.2 保持，未 commit/push/publish/merge main。

## 第六十九切片：LSP compatibility contract owner

- 新增 `scripts/pi-lsp-compatibility.mjs`，独立核验 manifest LSP tools、worker schema 与 Host route、Host runtime/config/projection markers，以及两侧 owner/worker routing wiring。聚合 checker 仍持有文件读取、source snapshots、读取错误和 diagnostics 汇总。
- 用户确认 seam 后以单 fixture→单实现的 red→green 循环完成。9 项 fixtures 覆盖 aligned contract、各类 source marker/wiring 缺失和未声明 policy 时 no-op；既有诊断保持原文与触发范围。
- `pnpm check:pi-compatibility` 包含 64 fixtures 且真实源码 gate 通过；`pnpm check`、完整 unit 420、architecture 3、lint、format 通过。只变更静态工具链与测试，不需要重跑生产构建。
- 规划文档更新后仍需做最终 Prettier、`git diff --check`、branch/version/status 核验；阶段 3 和全仓结构债务目标继续进行。

## 第二十三切片：Marketplace Git transport 与 cache lifecycle

- 将 Git URL/ref/SHA 校验、来源身份、clone/head、Git 子进程、缓存锁、刷新/fallback 与 freshness 判断移入 `config_marketplace_transport.rs`；parent 仍拥有 plugin 发现、manifest/registry、安装/更新/卸载。
- 只通过窄 transport 函数接线；Host 文件/插件路径安全和 install identity 未改变，缓存内无重复状态 owner。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib`、marketplace/config_runtime 27 tests、全 Rust lib 285 tests、Rust fmt check、`pnpm check`、`pnpm lint`、`pnpm format:check`、`git diff --check` 全通过。该片只触及 Rust 与计划记录，未重跑 TS unit/build。
- 初次编译缺 `std::fs` 和 validator 作用域，按新 owner 补齐并再次跑完整 Rust suite；无 warning。
- 下一步：继续从调用图与重复状态审计剩余配置/市场代码，现有 registry/安装流程若未呈现独立变化原因，不做额外分层。

## 第二十四切片：Marketplace catalog 与 metadata contract

- 新增 `config_marketplace_catalog.rs`，拥有 marketplace index/manifest 解析、资源 path validation、skill/component metadata 与 local/remote candidate scan；native owner 仍组合 Host commands、registry、install/update/uninstall 和 transport。
- 将 `plugin_metadata` 七元素 tuple 改为命名 `PluginMetadata`，调用点按字段表达语义，不再依赖位置。
- 复验：Marketplace native 专项 10 passed，全 Rust lib 285 passed，`cargo check --locked --lib` 无 warning，`cargo fmt --check`、`pnpm check`、lint、format 和 diff check 通过。未改 TS runtime，未重跑 unit/build。

## 第二十五切片：Declarative subagent Markdown parser

- `config_subagent_markdown.rs` 现在拥有 frontmatter field contract、Markdown parser、tool list syntax 与 capability-ceiling projection；`config_subagents.rs` 继续协调 native/TOML/plugin/Markdown 来源并组装最终 Host policy manifest。
- 将 `MAX_MCP_TOOL_GRANTS` 和 Host MCP name validation 静态兼容检查迁至真实 parser owner；parent import/wiring 单独断言。bounded constants 共享导入，未复制。
- 验证：定向 subagents 6 passed、完整 Rust lib 285 passed、`cargo check` 无 warnings、Rust fmt、`pnpm check`、lint、format、diff check 通过。无 TS product source changes，未重复 unit/build。

## 第三十切片：Pi resource discovery 与 manifest projection

- 将 Pi Skill/command 根目录发现、bounded Markdown path scan、disabled/ignore projection、Settings skill inventory 与 `pi_resource_manifest` 收入 `config_pi_resources.rs`。通用插件 enablement/inventory、extension commands 和共享 config merge 仍由 `config_extensions.rs` 持有。
- 新 owner 复用 parent 的插件 inventory、merged config、extension name resolution 与 policy exports；旧 `config_extensions` crate 内调用面经显式 re-export 保留。兼容 checker 直接读取 resource owner 的真实 bounds/scanner/manifest，并断言 parent module wiring。
- manifest shape、skill/prompt roots 顺序、忽略与禁用 semantics、文件/总字节/路径数量上限和 canonical path checks 不变。父文件 1,737 -> 1,067 行，Pi resource module 699 行。
- 配置专项 27 passed，全 Rust lib 285 passed；`cargo check --locked --lib` 无 warning，`cargo fmt --check`、`pnpm check`、`pnpm lint`、`pnpm format:check`、`git diff --check` 全部通过。仅 Rust/compatibility checker 更新，未重跑 TS unit/build。

## 第三十一切片：Marketplace registry state owner

- 把 registry bounded JSON load/save、unknown-field-preserving document、installed plugin projection/path containment、stable install key、record mutation/rollback 和 shared repo removal outcome 抽入 `config_marketplace_registry.rs`；`config_marketplace_native.rs` 只保留 Host command lifecycle、copy/backup 和安全 filesystem deletion。
- 新模块用窄方法暴露 registry operations；uninstall filesystem targets 仍由 parent checks 执行。Registry tests 直接覆盖 rollback、未知字段保留、shared repository 的分次卸载状态。
- 验证：Marketplace native 专项 10 passed，registry tests 2 passed，完整 Rust lib 287 passed，`cargo check` 无 warning，Rust fmt、`pnpm check`、lint、format、`pnpm test:unit` 403 passed、`pnpm build` 与 `git diff --check` 通过。Build 输出既有 >500 kB chunk warnings。分支仍为 `beta`，版本 `0.4.0-beta.2`，没有 commit/publish/merge。

## 第三十二切片：Remote model catalog owner

- 把 remote endpoint/source precedence、remote-fetch policy、HTTPS validation、bounded network/JSON parsing、remote model normalization 与 exact-origin cache fallback 迁入 `pi_remote_model_catalog.rs`。`pi_model_config.rs` 保留用户/项目 merge、Pi provider/policy projection、stable alias 和最终 secret environment references。
- Remote catalog 通过 `resolve_remote_catalog` 返回 validated models 与 no-Debug configured API key；Pi-facing `models.json` 仍只由 Host model projection 生成，不把 secret 写入 catalog/cache。静态 compatibility checker 现在核验新 owner 和父模块调用。
- 验证：model config 16 tests、remote catalog 2 tests、全 Rust lib 289 passed，`cargo check` 无 warning，Rust fmt、`pnpm check`、lint、format、unit tests 403 passed、build、diff check 通过；build 有既有 >500 kB warnings。

## 全量验证中的 monitor output race 修复

- 全 Rust suite 首轮发现 monitor waiter 先将任务标记 Completed，stdout/stderr reader 还未处理已缓冲数据；最终 monitor snapshot 因此可能漏行。
- waiter 现在 join 两个 reader thread 后才发布 terminal outcome；回归测试验证事件和 final snapshot 均有两行，定向测试连续通过 3 次，全 Rust lib 289 passed。

## 第三十三切片：LSP result projection

- `pi_lsp_projection.rs` 现在拥有 location/file-URI projection、symbol tree 与 hover text formatting、结果排序/去重，以及多字节安全的 256 KiB output bound。`pi_lsp_runtime.rs` 保留 config/path validation、server selection、child process 和 JSON-RPC 生命周期。
- 将 projection tests 移到实现所有者，并让 compatibility checker 检查新 owner 的 limits/formatting functions 与 runtime module wiring；旧 LSP Host request/response 行为保持不变。
- Projection tests 3 passed，runtime tests 5 passed，全 Rust lib 290 passed；`cargo check`、Rust fmt、`pnpm check`、lint、format 和 diff check 通过。JS unit/build 无需重跑（本切片只触及 Rust 与静态 checker），最近一次仍为 403 passed/build passed。

## 第三十四切片：Pi subagent durable records

- 将 persisted subagent record 类型、hash-based sidecar path、bounded schema/MCP-grant validation、realpath containment、tagged load failures 和 temp+rename persistence 移入 `subagent-records.ts`。session adapter 留下 live task projection 与 protocol error translation。
- 统一 subagent type 与 thinking-level validators，避免 live session normalization 与 resume-record parsing 各自维护 enum allowlist；worker tests 从 storage owner 直接覆盖 load/parse/save、root containment 和 missing-record 行为。
- `session-adapter.ts` 从 4,420 行降至 4,149 行；新 owner 326 行。Worker tests 145 passed，full unit 403 passed，`pnpm check`、lint、format、production build 和 diff check 全通过；build 仍有既有 large-chunk warnings。

## 第三十五切片：LSP trusted config owner

- `pi_lsp_config.rs` 统一负责有界 user/project config load/merge、字段/transport/env/args checks、project trust、workspace/file path containment、server projection 和 file URI conversion；`pi_lsp_runtime.rs` 留下 process supervision 与 JSON-RPC lifecycle。
- 两项 config tests 移到新 owner；`pi_lsp_runtime.rs` 从 1,051 行降至 732 行，new config owner 338 行、projection 230 行。静态兼容 checker 现在分别验证 config/projection owner 和 runtime wiring。
- Config 2 passed，runtime 3 passed，全 Rust 290 passed；`cargo check`、Rust fmt、`pnpm check`、lint、format、diff check 通过。只改 Rust 和 checker，JS unit/build 沿用第三十四切片的 403/build pass。

## 2026-10-10：第七十切片 codebaseIndex owner

- 用户确认了纯 `checkPiCodebaseIndexCompatibility(policy, sourceSnapshots)` fixture seam；继续遵守 beta-only，不动 runtime、安全/授权语义、版本或发布状态。
- 按 TDD 新增 aligned fixture，先运行得到 owner 缺失的 `ERR_MODULE_NOT_FOUND` 红灯，再抽取纯 owner；首个测试转绿。
- 逐项加入 fixtures 验证 worker schema/Host route、Host runtime/parser markers、parser 与 worker routing wiring、三项既有 Host 数值漂移、worker tool mapping 与 no-policy；owner tests 7/7 通过。
- 聚合 checker 现在将 `manifest.hostBridges.codebaseIndex` 和既有 snapshots 传入纯 owner；worker/runtime/parser source reads 与统一 diagnostics 仍留在 parent。`package.json` 将新 owner/fixtures 纳入 Pi gate。
- 验证：Pi compatibility fixtures 总计 71 passed、真实 source checker passed；`pnpm check`、full unit 420、architecture 3、lint、`pnpm format:check`、`git diff --check` 与规划文档 Prettier check 通过。仅静态 checker、fixtures、package gate 和计划记录变化，无需重跑产品 build 或 Rust runtime tests。
- 仍在 `beta`，版本三处一致为 `0.4.0-beta.2`；没有 commit、push、发布或 main merge。全仓结构债务目标继续进行。

## 2026-10-10：后续热点只读复核

- 本轮 goal continuation 为前一轮 `#70` 的完成后继续：catchup 无未同步报告，当前工作树仍是 `beta...origin/beta`，release version trio 仍为 `0.4.0-beta.2`；保留已有大规模 dirty tree。没有运行或修改 product/runtime。
- 按 codebase-design 的 depth/seam 视角盘点大源文件与现有调用：未将 3,460 行的 `session-adapter.ts` 或 1,533 行且 tests 占大头的 ToolGateway 当作自动拆分目标。
- 当前更可信的核心候选为 `workspace_sandbox.rs` 的私有平台执行 owner：保留 terminal、monitor 与 Tauri preflight 共用的 Host 决策接口，不复制 fail-closed 策略。详细调用图与现有测试边界已记入 findings。
- Hooks compatibility seam 仍等待用户选择；未写任何 Hooks 或 sandbox 新测试/实现。下一步先检查该选择是否到达；若通过，实施已核准 Hooks owner 后再评估 sandbox，若未通过则继续只读审计/按已有选择推进。

## 2026-10-10：sandbox 平台验证面只读复核

- 当前 goal continuation 已重读 active plan 并核验工作树：仍在 `beta`，version trio 为 `0.4.0-beta.2`，规划 catchup 无未同步项。未重置、清理或提交现有工作。
- 核对 `.github/workflows/check.yml` 与 release matrix：Rust tests 仅在 Ubuntu PR/push-to-main check job 运行；macOS/Windows release targets 只构建，不运行 tests。
- 在当前 macOS checkout 运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_sandbox::tests`：7 passed。测试覆盖 command shape/shared decision/custom policy；真实 Landlock child test 只在 Linux `cfg` 下运行。无源码更改。
- 该验证面补充已记录在 findings；Hooks seam 仍未收到用户答案，未写新测试或实现。下一次在确认当前用户选择后再决定实现顺序。

## 2026-10-10：第七十一切片 Linux Landlock owner

- 将 Landlock ABI 探测、路径检查、规则集创建/释放和 child `pre_exec` enforcement 收入私有 `workspace_sandbox/landlock.rs`。父 `workspace_sandbox.rs` 保留 Host 决策、fail-closed policy 和共同 shell command seam；Landlock 只有 `preflight` / `install` 两个父模块操作，不引入新公开层或重复决策。
- 现有 Linux 子进程测试仍通过 `sandbox_decision` 与 `sandboxed_shell_command` 验证，不再由测试直接调用 ABI 内部函数。共享 policy、命令行为、可执行读写路径、只读/可写 overlap 拒绝、ABI 下限和 fork 后的不可逆限制逻辑保持原状。
- 验证：当前 macOS `cargo check --locked --lib` 通过，完整 Rust library tests 310 passed；`cargo fmt --check`、`pnpm check`（Pi compatibility 71 fixtures + real source checker）、`pnpm check:architecture`（3）、lint、format 与 `git diff --check` 通过。无产品 build、release、commit 或 main 同步。
- 限制：本机只安装 `aarch64-apple-darwin` Rust target，Linux-only module 与 Landlock child integration test 没有在本机编译/运行；测试报告不等同于 Linux enforcement 已验证。工作树继续在 `beta`，三个版本仍一致为 `0.4.0-beta.2`。
- 首轮生成迁移补丁有三处匹配问题但未覆盖原实现；重读原始块后完成迁移。局部 formatter 首次误用 Rust 2021 edition，改用 crate 的 Rust 2024 edition 后，整 crate 格式检查通过；错误记录已加到 task_plan。

## 2026-10-10：第七十二轮核心职责审计

- 本轮自动 goal continuation 以 #71 代码/验证完成作为前轮进展；重新核对 beta 工作树、版本三处和 planning catchup，仍保持 `beta...origin/beta` / `0.4.0-beta.2`，且无未同步 session report。
- 重新盘点 Rust 与 TypeScript 最大源文件，拒绝按行数继续切分。Marketplace native parent 的 source-resolution 职责簇比拆分 marketplace lifecycle 本身更有候选价值，证据和重复语义边界已记入 findings；尚未改 source/test。
- 一次只读源文件枚举命令使用了不存在的 zsh 子目录 glob，报 `no matches found`；改由 `rg --files` 读取实际布局完成盘点，无文件受影响。
- Hooks compatibility seam 仍无用户答复。本轮不以用户继续 goal 的自动提示替代那项明确确认，也不修改 Hook tests/runtime。

## 2026-10-10：Marketplace direct-source 验证界面复核

- 按职责与测试 surface 复核 Marketplace direct-source candidate：`parse_direct_source` 没有独立测试，`install_melody_plugin` 也没有命令级测试；唯一既有直接覆盖为 `resolve_direct_git_plugin_path` 的自动/显式 `#subdir` 与越界测试。
- 安装目录发现、Marketplace candidate transaction 与 direct input grammar 变化路径不同；transport URL/ref/SHA validation 已有其 owner，不应因相似字段而合并配置 source parser。
- 已向用户询问是否在私有 `plugin_source` owner interface 增加本地目录、subdir、GitHub shorthand/ref/SHA、越界与候选唯一性测试。首次异步问题字段名不合 schema，随后使用当前格式重发；等待明确选择前没有改 source/test。
- 当前 checkout 仍在 `beta...origin/beta`，版本 trio `0.4.0-beta.2`；保留完整累积工作树，无提交、发布或 main 同步。
- 继续只读复核 `pi_mcp_runtime.rs`：配置、stdio、remote protocol 已各由现有 owner 管理；parent 的缓存更替、工具调用、session/run cancel 与 workspace shutdown 属于共同 runtime lifecycle。将 `active_calls` 再封装成 map wrapper 会变浅，因此暂不拆分。

## 2026-10-10：剩余 config owner 只读复核

- 根据当前函数与调用面重看 `config_subagents.rs` 和 `pi_model_config.rs`：subagent Settings inventory 与 Pi policy manifest 有意共享 parser/precedence，但保持不同输出与成本；模型 provider/policy/credential slots 则在同一 Host projection 事务中写出，remote catalog 已独立。
- 目前没有证据支持继续将这两处拆成更薄的 adapter/format-helper。保留现有 owner，下一步仍以待确认的 Marketplace direct-source owner seam 为候选；用户当前答复尚未到达。
- 本轮无产品代码或测试修改。catchup 无未同步报告，工作树仍为 `beta...origin/beta`，三处版本 `0.4.0-beta.2`；保留全部累积改动。
- 同步检查 subagent prompt-file handling 后发现未见 `prompt_file`/`instructions_file` filesystem tests；该逻辑负责 canonical containment、symlink/file/size/control-character policy。将其记录为验证缺口，不在未设计/确认测试 seam 前迁动安全敏感路径处理。

## 2026-10-10：Pi worker reader-loop 与 fixture gate 复核

- 按 codebase-design 的 module depth / seam 标准复核了 Pi compatibility fixture gate 和 `PiWorkerRuntime` 的剩余职责；当前仍为 `beta...origin/beta`，三处 release version 均是 `0.4.0-beta.2`，规划 catchup 无未同步报告。
- 确认主 Pi compatibility gate 的 Prettier 和 fixture runner 覆盖全部 10 个 Pi owner/test pairs 与两个独立 helper/test pairs；主 source checker 导入并执行对应 owners；CI 另行运行 architecture gate。未发现遗漏，不把命令改为依赖 shell glob 的自动发现。
- 发现 `spawn_readers` 是仍值得评估的有序事件-ingestion slice：Host 接受事件后须先持久化，再发 UI，并且仅对新事件做 memory、dispatch、Hook 与工具/权限路由；失败和 EOF 又决定 generation cleanup。记录为候选但本轮未改 runtime/test，避免在没有覆盖副作用顺序的界面时抽成浅 transport module。
- 一次 `rg --files .agents .codex scripts` 使用仓库中不存在的 `.agents`/`.codex` 目录并返回错误；改用已安装 skill 绝对路径与实际 `scripts` 路径完成读取，无文件受影响。
- 本轮无产品源码/测试修改；Marketplace direct-source owner 测试 seam 仍待用户答复。无提交、push、发布或 main 同步。

## 2026-10-10：Marketplace direct-source owner 实施

- 用户批准在私有 `plugin_source` owner interface 覆盖本地目录/`#subdir`、GitHub shorthand/ref/SHA、路径越界及 plugin directory 唯一/歧义判定；测试不执行网络 clone。
- 按 TDD 先加入 owner-interface 本地目录测试并确认缺少接口的红灯，再将 direct-source enum/parser/finder/resolver 从 `config_marketplace_native.rs` 移至 `config_marketplace_plugin_source.rs`；parent 通过 owner 保留原调用，不改变 clone、安装事务、registry 或授权语义。
- 8 项 owner tests 覆盖 local path/subdir、local 和 Git path escape、GitHub repository/branch/SHA parse、唯一 nested plugin、多个 plugin 歧义；Rust library suite 317 passed，`cargo check --locked`、Rust fmt、`pnpm check:architecture` 和 `git diff --check` 通过。
- 没有 direct install command E2E、真实 clone 或桌面 Marketplace 验收；工作树继续位于 `beta`，版本 trio `0.4.0-beta.2`，不提交、不推送、不发布、不与 main 同步。全仓结构债务目标继续进行。

## 2026-10-10：下一安全测试 seam 只读设计

- Marketplace owner 完成后，重读 `config_subagents.rs` 的 `read_prompt_file` 调用和约束：相对路径按 base canonicalize/containment，拒绝 absolute、NUL、canonical target 越界、非文件、超限、无效 UTF-8 与非法控制字符；返回 trim 后文本。内部 `..` 与指向 base 内的 symlink 仍允许；外逃 symlink 会因 canonical target 越界而拒绝。
- 提出只把 file-resolution policy 抽为 parent-facing `prompt_file` owner 并从其接口测试；`with_file_instructions` inline/file fallback、manifest precedence、policy projection 与授权逻辑不动。用户确认前未改 subagent source/tests。
- 下一备选 `PiWorkerRuntime::spawn_readers` 仍只做只读记录：其持久化先于 UI delivery、重复事件不确认 dispatch、generation failure/EOF cleanup 的顺序需要 adapter seam/order tests，当前不抽成薄 reader wrapper。

## 2026-10-10：累积 beta 工作树全门禁复验

- 当前完整累计工作树重新通过 `pnpm check`（TS、agent contract/worker/package gates 与 Pi compatibility owners/fixtures）、`pnpm test:unit`（420）、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm check:architecture`（3）、Rust library suite（317）、`cargo check --locked`、crate-wide Rust formatting 和 `git diff --check`。
- 这确认当前 beta checkout 的构建与自动化门禁状态，不替代真实桌面、真实 Git clone、跨平台 sandbox enforcement 或发布验收；没有产品源改动、版本变化、提交、push、build 发布或 main 同步。
- 仍有未确认的 subagent `prompt_file` owner seam；当前没有将本地门禁通过误作全仓结构债务完成的证据。

## 2026-10-10：稳定架构指引补充

- 复核了当前 branch 与 package/Cargo/Tauri 版本三处配置（均为 `0.4.0-beta.2`），并核对架构改进计划原始结论的日期和作用范围。
- 更新 `docs/architecture-improvement-plan.md`，把 2026-08-23 的五项改进回顾与当前进行中的 Pi-only runtime 结构治理区分开，明确生命周期、Host 权限裁决、内部 owner 和跨端合同测试的责任边界。
- 同步输入请求先返回空答案；随后用户 item `584408713` 明确批准先前提出的 `prompt_file` seam。在批准到达前未触碰实现；批准后按下文完成一个受限 TDD slice。

## 2026-10-10：prompt-file owner 已完成

- 用户确认了私有 `prompt_file` owner/test 范围后，按 TDD 移动文件路径解析与安全读取逻辑；inline/file fallback、合并顺序、manifest precedence 和授权路径留在父模块且未改。
- 新增 12 个 owner-interface tests，覆盖相对与 canonical containment 边界、内外部 `..`/symlink、绝对路径、regular file、文件与文本上限、UTF-8/control chars 及输入引用长度。首次 red 是 owner 符号缺失的预期编译失败。
- 12 项定向 tests、完整 Rust lib suite 329/329、`cargo check --locked`、Rust fmt、`pnpm check`（含 71 Pi compatibility fixtures）、文档 Prettier 和 `git diff --check` 通过；planning catchup 无未同步报告。本切片只确认本地 macOS 构建/测试，不替代其他平台文件系统行为验收。
- 仍在 `beta`，三处 release version 为 `0.4.0-beta.2`；未 commit、push、publish 或同步 `main`。全仓目标继续进行。

## 2026-10-10：worker event acceptance seam 审计

- 核对当前 `spawn_readers` 后，确认它维持 SQLite 写入先于 UI 事件投递，且 duplicate 不能确认 Host dispatch；持久化失败要终止 generation，EOF/error 进入相应收尾。这个有序副作用链不适合仅按体积拆薄 wrapper。
- 发现可进一步隔离的纯状态 owner：bounded event-ID/payload cache 与 worker epoch/sequence acceptance，可通过小型 `accept(&Value)` 接口返回 New/Duplicate/ready transition。generation lookup、握手、SQLite、UI、Hook、权限与工具路由仍由 parent 持有。
- 当前没有 Tauri AppHandle mock harness；既有测试覆盖 protocol metadata validator 与 dispatch ledger，不覆盖 runtime event cache 的完整状态序列。已记录提议的测试用例并等待 seam 选择；本轮无源代码/测试修改。

## 2026-10-10：Browser session lifecycle seam 复核

- 当前仍为 `beta...origin/beta`，版本 trio `0.4.0-beta.2`。重读 runtime 与 parent tests 后更正此前笔记：浏览器已有 9 项 parent tests，定向 Rust test 当场通过 9/9；其中已覆盖 tab index、profile isolation helpers、bounds 与 URL/security policy。
- 新的结构候选不是再拆纯 tab index，而是索引/entry map 和 WebView effects 的生命周期协调。源码存在 close/select 先修改内存状态、后做可能失败的 view operation 的窗口；尚无可注入 WebView adapter 测试，故仅记为待验证风险，未宣称 bug 或改行为。
- 若实现，先由用户确认共同 session lifecycle interface、Tauri/in-memory adapter 及可观察失败一致性测试；保持 Host URL/popup policy、Pi routing 和其余副作用顺序不变。本轮只做 audit/docs，无运行时代码或测试变更；全仓目标继续 active。

## 2026-10-10：Pi-only renderer route audit

- 检查当前状态：Desktop engine setting 默认 Pi 并把旧 `legacy-acp` 持久值规范化为 Pi；`use-agent-bridge` 的 capability 风险硬阻断与 Pi worker 错误分支都不切 ACP；archive session 在任何 runtime subscribe 前返回。`sendAcp`/`subscribeToAcp` 的非 Tauri 路径是 deterministic browser-preview fixture。
- 发现前端仍暴露 `legacy-acp` client/engine override，并包含 Tauri ACP invoke/listen 分支；当前 `src-tauri/src/lib.rs` 无对应 ACP commands，Pi compatibility checker 也未把静态 manifest gate 延伸到真实 renderer routing。没有发现默认 Desktop 实际使用 ACP，也没有 `agent-client`/`app-settings-store` 测试文件；把此记录为 future-regression surface，不误报为当前 Pi runtime fallback。
- 已将更完整的 transport seam 与行为测试范围写入 `findings.md`/`task_plan.md`。按 TDD seam 约束，测试和接口尚待确认；本轮无 runtime/test 代码变化。

## 2026-10-10：PiSessionAdapter child lifecycle review

- 按 `codebase-design` 审查共享状态而非继续依据文件行数提取。当前 `TaskHandle` 继承 Pi session context，task map 由 root/child lookup、资源/模型刷新、close/cancel、nested task controls 和 event projection 共用，确认单独搬移 `spawnSubagent` 会留下分散状态 owner。
- 当前 adapter suite 28/28；已有 queue、closeAll 子任务清理、task ownership/wait 与 durable record tests，纯 policy/resume trust owners 另有独立覆盖；直接 spawn/continue 组合生命周期仍无测试。
- 已记录一个待论证的 `PiTaskRuntime` 方向，但它必须整体接管 map 与生命周期并注入真实需要的 Pi session/Host adapters；尚未确认有更深且更小的 interface，因此本轮不抽模块或新增测试。Pi identity 与 Host ToolGateway authorization 保持原路。

## 2026-10-10：Host sandbox profile owner audit

- `workspace_sandbox::tests` 当前 macOS suite 7/7 通过；只有 `aarch64-apple-darwin` target，不能据此声称 Linux Landlock child enforcement 已验证。terminal、monitor 都调用同一个 Host `sandboxed_shell_command`，Tauri preflight 先授权 workspace。
- 复核后不建议单独抽 Seatbelt string formatter；更深的 profile parsing/path rules 被 Seatbelt 与 Landlock 两类 platform enforcement 共同消费。已在 `findings.md`/`task_plan.md`记录显式注入 profile sources/paths 的 owner candidate 与需验证的 user-over-project precedence、deny/glob/network semantics。
- 没有改 sandbox implementation/tests；`sandbox_decision` 仍是唯一 Host fail-closed policy authority。接口 seam 尚未确认。

## 2026-10-10：Seatbelt 自定义只读路径安全复核

- 发现 `SandboxProfile.read_only` 注释与 Linux Landlock 都规定只读，但 macOS Seatbelt 生成器把每个此类路径写成 `(allow file-write* (subpath ...))`。该 loop 已存在于当前基线；尚未证明真实运行的子进程能成功写入。
- 在开发容器对临时目录执行最小 `/usr/bin/sandbox-exec` 探针时，外层沙箱返回 `sandbox_apply: Operation not permitted`。此结果不被当作策略拒绝证据，也不代表 Mac enforcement 实测。
- 已请求用户确认通过现有 `sandbox_decision` 命令 payload seam 验证只读与可写路径权限。继续检查后发现还必须覆盖只读子树嵌套在写子树中的情况；仅删直接 allow 会留下父路径许可。Linux 对任意这类 overlap 已 fail closed；候选 macOS 规则应在 allow 后添加更具体的只读 deny，显式写路径保留写许可。
- 再核对现有验证面后确认，该语义没有行为回归测试：macOS 测试只检查全局 write deny/workspace literal/device sink，自定义 profile fixture 没有 `read_only`；Pi compatibility 的 Sandbox block 仅检查少数结构 markers。payload-seam tests 应明确断言 disjoint read-only 不可写，并覆盖 nested 情况，避免误把静态 presence checks 当成权限语义验收。进一步检索发现 Seatbelt precedence 的二手解释相互冲突，本机 man pages 也未规定冲突语义；因此先前“deny 放在最后即可覆盖父 allow”的方案未验证，需优先评估跨平台共同拒绝 overlap，或等待真实 macOS enforcement acceptance。
- 用户确认到达前不写测试或改变 Host sandbox 行为。本轮只有审计与规划记录；本地 nested `sandbox-exec` 仍因外层环境限制未执行。
- 当前分支仍为 `beta`、release version trio 为 `0.4.0-beta.2`；`task_plan.md`、`findings.md`、`progress.md` Prettier 检查与 `git diff --check` 通过。新增一行后首次 Prettier 检查未通过，格式化 `task_plan.md` 后复验通过。

## 2026-10-10：Session Explorer 合同覆盖审计

- 用户再次提供仓库 beta/release 约束；重新确认当前工作仍须留在 `beta`，不得把 beta 同步/合并到 `main`，版本三元组不得漂移。本轮未改产品源码、测试或版本。
- 只读追踪 `sessionExplorer` manifest、agent contract validator、renderer bridge、Host fork database/dispatch、worker session adapter 与 UI gating。manifest 包含原生 entry anchor、Host authorization、分支持久化/恢复、bring-back bounds 与禁止自动提交等多层合同；Pi compatibility checker 当前没有读取该 manifest section。
- 现有局部测试已复跑：`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib database_agent_forks::tests` 2 passed；`node --experimental-strip-types --test packages/agent-worker/src/pi/session-adapter.test.mjs` 28 passed。覆盖 durable lineage/anchor/reference 与 Pi 分支恢复 artifact validation，但不覆盖 renderer acknowledgement、command-to-Host 全链路或 desktop failure injection。
- 补查发现 `src/domain/agent/explorer-branch.test.mjs` 已有 6 项纯行为测试（draft-only、显式发送展开、不可信 JSON 上下文、12,000 codepoint 截断）；定向复跑 6/6，通过且由 root `test:unit` 显式纳入。Host Rust、renderer TS 与 manifest 的当前 12,000 上限一致，但没有 cross-language drift fixture。此项更正了早先对 UI/domain 测试覆盖的遗漏，不改变全链路验证缺口判断。
- 将 pure `checkPiSessionExplorerCompatibility(contract, sourceSnapshots)` fixture owner 记为候选；它仅检测 manifest/source wiring drift，不能替代真实桌面验收。按 pre-agreed seam 纪律，未获确认前没有添加 tests 或运行时改动；先前 compaction owner seam 仍待用户明确选择。

## 2026-10-10：MCP transport manifest crosswalk

- 对当前 `hostBridges` contracts 做只读交叉核对，发现 `mcpTransports` 的 stdio/http/sse list 没有被主 checker 或 Pi compatibility owners 消费；`mcpInventory` 检查覆盖的是 Host inventory authority，不覆盖 transport list。
- 源码和 Rust 局部测试当前覆盖 stdio、streamable HTTP aliases 与 SSE，但这不能保护 manifest 对实现的 drift。未发现当前 runtime mismatch。
- 用户随后明确答复“按建议执行”；只新增静态兼容 owner 与 source fixtures，不改 runtime 或 authorization semantics。

## 2026-10-10：Pi migration handoff code map refresh

- 更新 `docs/architecture/pi-migration/handoff.md` §2.2–2.3，使 Pi worker 与 Rust Host 地图分别指出 parent orchestration 与已提取的 implementation/policy owners，避免后续维护者只从 parent 文件查找职责。
- 核对所列 owner 文件路径；将 Memory index 修为准确的 `src-tauri/src/pi_memory_runtime/store/search_index.rs`，并保持 Browser、LSP、MCP、marketplace、schedule/event、sandbox 路径精确。
- 同步 `task_plan.md` / `findings.md` 记录；本轮只改文档，没有运行时或测试源代码改动。handoff 与三份计划/审计文档的 Prettier 检查和 `git diff --check` 均通过。

## 2026-10-10：MCP transport manifest drift owner（第八十三切片，完成）

- 用户确认仅通过纯 source-snapshot fixtures 锁定 manifest `stdio/http/sse` 与 Host parser、stdio owner、remote HTTP/SSE owner wiring，不改 runtime 或授权语义。
- 按 TDD 先加 fixtures，红测先暴露 owner 缺失；后续 tracer bullet 又发现初版检查没有要求实际 HTTP request function，补上 `execute_remote_request`、`client.execute` 与 runtime call-site 标记后再转绿。
- 8 项新 owner fixtures 检查 canonical set/duplicates、HTTP/SSE variant mapping、stdio normalization、parent dispatch wiring、stdio command startup、remote HTTP execution 与 SSE bootstrap。Parser aliases 不会变成额外 manifest transports。
- 最终 `pnpm check:pi-compatibility` 通过（79 项 compatibility/permission fixtures + 实际 source checker）；`pnpm check`、`pnpm format:check` 和 `git diff --check` 通过。该 slice 只改静态 gate、测试、package script 与记录，不涉及 Rust/worker runtime、manifest values、权限或版本。
- 最终复核：仍在 `beta...origin/beta`，`package.json`、`src-tauri/Cargo.toml` 与 `tauri.conf.json` 均为 `0.4.0-beta.2`；没有 commit、push、publish、release 或 main 同步。

## 2026-10-10：Pi-only renderer 遗留 ACP bridge 复核

- 重新核对 app settings、session bridge 与 Host command table：Desktop 默认 Pi，旧持久值读取时归一成 Pi，归档会话在 runtime subscription 前退出，正常 Pi worker 故障路径明确失败且不切换 ACP。没有把 ACP 预览 fixture 或只读 archive/import 误称为 Desktop Agent runtime。
- 发现 `agent-client.ts` 注释仍称 ACP default / Pi opt-in，且 `melody-bridge-runtime.ts` 保留 Tauri `send_acp` invoke 与旧 ACP event listeners；当前 Host 没有对应 command 注册或事件 emit path。非 Tauri browser preview 确实依赖本地 ACP fixture，应保留。
- 提出在 bridge send/subscribe seam 做最小测试优先 fail-closed 收口，覆盖 Desktop 不再调用/监听已移除 transport、预览 fixture 仍工作，并修正文档性注释；只读归档、ACP→Pi import 与现有 Host security authority 不变。等待用户确认后再编辑 bridge runtime/tests。
- 本轮仅做文档与兼容门禁收尾和路由审计，没有运行时/测试源代码变更。`pnpm check:pi-compatibility` 79 项 fixtures + source checker、`pnpm check`、规划文档 Prettier 和 `git diff --check` 均通过。分支仍是 `beta...origin/beta`，三个版本仍是 `0.4.0-beta.2`。

## 2026-10-10：第八十四切片 Pi-only renderer ACP bridge fail-closed（完成）

- 用户明确批准在现有 `sendAcp`/`subscribeToAcp` seam 添加 Desktop fail-closed，同时保留浏览器预览 fixture、只读 archive/import 与 Host 权限裁决。按 TDD 先写 Desktop send 行为测试；首次红灯是 bridge owner 尚不存在，之后完成实现。
- 新增 `src/lib/melody-bridge-acp.ts`，单独拥有 deterministic browser-preview ACP fixture；Desktop send/subscribe 在旧 `send_acp` command 或 ACP event subscription 前明确拒绝，owner 不再 import Tauri `invoke`/`listen`。`src/lib/melody-bridge-runtime-context.ts` 负责 `isTauriRuntime`，既有 runtime/renderer exports 保持兼容。
- 新增 3 项公开 bridge-owner tests：Desktop send fail-closed 且零 invoke、Desktop subscribe fail-closed 且零 invoke、浏览器 preview initialize 返回原 deterministic model/fixture metadata。
- 修正 agent client、Pi projection/store 与 hook 中描述 ACP 默认、Pi opt-in 或 capability fallback 的过时注释；只读归档与 import adapter、会话行为、Host security authority 未改。handoff code map 补充新 owner 路径。
- 验证：定向 bridge tests 3/3，`pnpm test:unit` 423/423，`pnpm check`（内含 79 Pi/command-permission fixtures）、`pnpm check:architecture` 3/3、`pnpm lint`、`pnpm format:check`、`pnpm build` 通过；规划/交接文档与 `git diff --check` 最终复验通过。Vite 仅有既有大 chunk warnings。
- 当前仍是 `beta`，版本三处均 `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。全仓结构债务目标仍进行中。

## 2026-10-10：AgentWorkspace / Pi Explorer workflow 只读边界审计

- 在 `beta` 上盘点 `src/features/chat/agent-workspace.tsx` 与既有 actions/layout/view owners；确认不应仅凭剩余行数抽离 composition root。
- 追踪到根组件仍直接拥有 Pi Explorer fork query、branch creation/recovery、source draft reference 和相关 busy/error state。和已有纯 `explorer-branch.ts`、Host fork DB、worker native replay 做职责 crosswalk 后，将 renderer workflow coordination 识别为独立候选 seam。
- 记录了小接口与 production/in-memory adapters 的建议，以及需要保留的存储、fork、workspace activation/error 顺序。按 TDD skill 的 pre-agreed seam 要求，本轮未写 tests 或运行时代码；只更新审计/计划文档。
- 当前工作树仍保留既有 dirty changes；branch `beta`，版本 trio `0.4.0-beta.2`。未运行测试，未 commit/push/release/main sync。

## 2026-10-10：第八十五切片 Pi Explorer renderer workflow owner（完成）

- 用户批准将 Pi Explorer 的 renderer workflow coordination 提取为深模块；新增 `src/features/chat/pi-session-explorer.ts`，公开 `createPiSessionExplorer` interface，接收可替换的 bridge、workspace、draft、selection 和 error adapters。
- 新增 `use-pi-session-explorer.ts` 作为 production adapter；它绑定 Tauri bridge、Zustand workspace 与 composer draft 存储，并拥有 fork state、stale-load cleanup 与 recovery busy 状态。`AgentWorkspace` 复用原有 view callbacks，只保留 UI composition；从 830 行缩到 612 行。
- 7 项 interface tests 验证成功分支/prefix、native fork partial failure、并发切换保护、pending recovery 成功与失败、显式 source draft reference 和 draft storage failure。已加入 root `test:unit` 与 format/format-check 清单。
- 没有移动 Host database/auth semantics、worker native replay、归档行为或 session identity；原 branch insertion/activation/error 顺序保持。
- 最终验证通过：`pnpm check`、`pnpm lint`、`pnpm test:unit` 430/430、`pnpm check:architecture`、`pnpm build`、`pnpm format:check`、`git diff --check`；79 compatibility/permission fixtures 通过。Vite 仍提示既有大 chunk warnings。
- 当前仍为 `beta` 和 `0.4.0-beta.2` 版本 trio；未 commit/push/publish/release/main sync。全仓结构债务目标继续进行。

## 2026-10-11：第八十六切片 sandbox `read_only` 跨平台 fail-closed（完成）

- 用户选择共享 Host 校验并跨平台拒绝只读/可写路径重叠。TDD 首个 red test 证明 Seatbelt payload 曾对 disjoint `read_only` path 显式生成 `allow file-write*`；移除后第二个 red test 证明只读路径嵌套在 `read_write` 父子树时 macOS 仍返回 `Enforced`。
- `sandbox_decision` 现在在 OS dispatch 前统一检查路径相等或任一方向前缀重叠及隐式设备写 sink，返回现有 `PlatformBroken` unsupported decision。Seatbelt 不再为 `read_only` 添加写 allow；Linux Landlock 删除重复 overlap 判定，保留平台特有路径存在性/deny 检查。
- 3 项新增测试覆盖 SBPL disjoint read-only 不写许可、显式 read/write 三类 overlap，以及 `/dev`、`/dev/null`、`/dev/pts` 设备 sink 冲突。未假设 SBPL deny/allow 优先级，也未声称真实 macOS child enforcement 已验收。
- 验证：Rust lib 332/332，cargo check 无 warning、cargo fmt check、`pnpm check`（含 79 compatibility/permission fixtures）、`pnpm check:architecture` 3/3、lint、format check 与 `git diff --check` 通过。完整 Rust 测试中 sandbox 子测试输出 `sandbox_apply: Operation not permitted` 环境警告，但套件通过；本机没有 Linux target，真实 Landlock enforcement 仍待 Linux runner。
- 更新 `implementation-plan.md` 的沙箱平台状态与 Pi-only 运行时描述，避免继续声称 Linux/Windows 回退 ACP 或 ACP 是默认 Desktop runtime。当前仍在 beta，版本 trio `0.4.0-beta.2`，没有发布/合并/提交。

## 2026-10-11：Worker event cache 与 Web response projection 只读复核

- 自动续接未包含上一轮待确认的 `PiWorkerEventAcceptance` 测试 seam 选择；遵守 TDD 约束，本轮未新增测试或改动 runtime。
- 复核 worker frame cap（1 MiB）、generation cache（最多 4096 个完整 `Value`）及持久化顺序：事件 Value 在 SQLite 单事件 byte validation 前已复制入 cache，理论 payload retention 可达约 4 GiB，尚未计入对象开销。现有 SQLite owner 对重复 event ID 精确比较 JSON；`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib database_agent_events::tests` 12/12 通过，包括 changed-payload rejection。将聚合内存上限记为独立风险，不改现有缓存/重放行为。
- 只读盘点 `pi_web_runtime.rs` 后，发现其同处持有 Host config/SSRF policy、HTTP work、search citations projection 与 HTML→text projection。当前职责候选限于纯 bounded response projection；Host 授权、credentials、URL policy、redirects 与网络 I/O 留在 Host。定向 `pi_web_runtime::tests` 5/5 通过；没有确认新 seam，不迁移实现。
- 更新 `findings.md` 记录以上两项风险/候选。`pnpm exec prettier --check findings.md` 与 `git diff --check` 通过；工作树仍在 `beta`，版本 trio `0.4.0-beta.2`。未 commit/push/publish/release/main sync。

## 2026-10-11：Config extension/catalog command dependency direction

- 只读调用图发现 `config_extensions` 通过 `plugin_capability_from_directory` 依赖 `config_plugin_details`，而 `config_plugin_details::get_melody_skill_details` 又反向调用 `config_extensions::pi_skill_catalog_paths`。反向边只因 Skill details command 将目录详情解析与当前 Pi catalog eligibility 混在 plugin-details owner。
- 将 `get_melody_skill_details` 与 `delete_melody_skill` 两个 Skill lifecycle commands 移至 `config_extensions`；Skill parsing/path helpers 和 `get_melody_plugin_details` 留在 `config_plugin_details`。`config_runtime` 的 re-export 及 `lib.rs` 注册 command 名称保持不变，Skill workspace authorization、canonicalize、catalog-membership、detail resolution 和 delete path validation 顺序原样保留。
- 没有新增测试；使用既有界面验证：`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 无 warning、`config_runtime::tests` 27/27、完整 Rust lib 332/332、`cargo fmt --check`、`pnpm check`（79 Pi/permission fixtures）通过。首轮 fmt check 暴露文件尾部空白并已由 `cargo fmt` 修复。
- 当前 `config_plugin_details.rs` 不再依赖 `config_extensions`；该直接 sibling cycle 已消除。`task_plan.md`、`progress.md`、`findings.md` 与 `handoff.md` code map 均已同步，待最终格式检查；保持 `beta`、版本 trio `0.4.0-beta.2`，无提交/发布/main 同步。

## 2026-10-11：Agent Session deletion lifecycle owner

- 调用图发现 database session/project modules 各自只为 `delete_session` / `delete_project` 引入 `PiWorkerRuntime` 与 Pi artifact-store 依赖，而 `PiWorkerRuntime` 又依赖 database 做 event/session persistence；这使 SQLite owners 反向负责 Host runtime lifecycle。
- 两个同名 Tauri commands 已移入 `src-tauri/src/agent_session_lifecycle.rs`，作为协调 Pi worker stop、确切 JSONL artifact cleanup 与 SQLite purge 的 Host use-case owner。`database_sessions.rs`、`database_projects.rs` 继续拥有 record/query/transaction helpers，不再 import worker 或 artifact storage；`lib.rs` 仍注册相同 renderer-facing command names。
- 两个 handlers 按原顺序整体迁移：引擎绑定检查、Pi-only workspace stop、逐会话 artifact cleanup、数据库 purge 顺序及 cleanup failure 保留数据库记录语义均未改。没有新增 tests 或改变授权/路由。
- 迁移前后 `database::` tests 均 55/55；当前完整 Rust lib 332/332、无 warning Cargo check、Rust fmt、`pnpm check`（79 compatibility/permission fixtures）、lint、format check 和 diff check 通过。架构 gate 与新增规划文档格式仍待最终检查。
- 最终 `pnpm check:architecture`（3/3）、Prettier（task plan/progress/findings/handoff）与 `git diff --check` 通过。当前仍为 `beta`，版本 trio `0.4.0-beta.2`；未 commit/push/publish/release/main sync。仅本 slice 完成，全目标仍在阶段 3。

## 2026-10-11：共享 Pi output archive owner

- `pi_mcp_runtime` 原本为 `archive_tool_output` 与 MCP prefix import `pi_tool_gateway`，但 archive implementation 同时负责 terminal stream capture 与 workspace tool archive reading。此调用关系将跨 runtime 共享的 Host 文件能力藏在 gateway 子模块里。
- 将 `pi_tool_gateway/tool_output_archive.rs` 移到根级 `pi_tool_output_archive.rs`；ToolGateway parent、terminal tasks、workspace tools 与 MCP runtime 现在都从 shared owner 直接依赖。MCP 对 ToolGateway 的 module dependency 已移除，archive format、大小/保留上限、路径检查与 response text 不变。
- 没有新增测试；gateway 现有 output-archive suite 35/35，MCP output/archive suite 15/15，最终完整 Rust lib 332/332、无 warning Cargo check、Rust fmt check 通过。
- 最终 `pnpm check`（含 79 compatibility/permission fixtures）、`pnpm check:architecture`（3/3）、lint、format check、规划文档 Prettier 与 `git diff --check` 通过。保持 `beta` 与版本 trio `0.4.0-beta.2`；无提交、发布或 main 操作。总体治理目标继续进行。

## 2026-10-11：Pi web response projection owner（第八十九切片）

- 从 `pi_web_runtime.rs` 拆出纯文本 projection：`pi_web_runtime/projection.rs` 现在集中 bounded UTF-8 truncation、HTML entity/text projection 与 Search citation formatting；Host web policy、凭据/headers、SSRF/redirect policy 和 HTTP I/O 留在 runtime。
- 既有 `pi_web_runtime::tests` 5/5，通过直接调用 projection module interface 继续验证 HTML/entity extraction 与 citation 去重；行为和调用顺序未改。
- 当前完整 Rust lib 336/336、warning-free Cargo check、Rust fmt、`pnpm test:unit` 430/430、`pnpm check` 79 compatibility/permission fixtures、architecture 3/3、lint 和 format check 通过。Pi migration handoff code map 已列出新 owner。

## 2026-10-11：PiWorkerEventAcceptance generation-local owner（第九十切片）

- 用户确认 `PiWorkerEventAcceptance::accept(&Value)` seam 与五类测试；按 TDD 先新增 owner tests，首轮编译红灯因接口不存在，随后实现 acceptance state owner。
- `event_acceptance.rs` 现在拥有 worker generation 内的精确 event payload cache、epoch/monotonic sequence state 与 4096 项 FIFO eviction。runtime 继续负责 generation lock、ready/handshake、事件 persistence/delivery；cache miss 的 duplicate 仍交由 SQLite runtime reader 仲裁。
- 新增 5 项测试覆盖首次接受、相同/不同 payload event ID 重放、epoch/sequence 违规及 eviction 后的 DB 仲裁路径。Pi protocol checker 与 handoff code map 同步追踪新 owner。
- 验证：新 owner 5/5、完整 Rust lib 336/336、warning-free Cargo check、Rust fmt、`pnpm test:unit` 430/430、`pnpm check` 79 fixtures、architecture 3/3、lint/format checks。按批准范围保留 cache 按 item count 而非 bytes cap 的既有资源行为；未提交、发布或操作 main。

## 2026-10-11：BrowserSessionLifecycle 与 WebView effect ordering（第九十一切片）

- 用户选择保留现有 side-effect 顺序并测试。`pi_browser_runtime/session_lifecycle.rs` 现在统一拥有 tab ID/index、8-tab cap、entry map 与 open/select/close state transitions；`TauriBrowserTabAdapter` 负责 WebView create/select effects/close，in-memory adapter 在同一 interface 上注入失败。
- 三项新增测试证明：view 创建失败时 open 回滚 reservation；close effect 失败后 entry 已移除且邻接 tab 已 active；select effect 失败后新 active id 保留。`pi_browser_open` 的 `ensure_active_entry` 创建失败仍按历史行为保留 reservation。Host URL/popup/preview checks、Tauri commands 与事件 emit 顺序未改。
- Pi compatibility gate 现在核对 lifecycle owner 与 runtime adapter wiring。验证：Browser tests 15/15、完整 Rust lib 339/339、warning-free Cargo check、Rust fmt、`pnpm test:unit` 430/430、`pnpm check` 79 fixtures、architecture 3/3、lint、format check、build 与 `git diff --check` 全通过；Vite 保留既有 >500 KiB chunk warnings。
- 当前仍在 `beta`，三处 release version `0.4.0-beta.2`；未提交、推送、发布、同步或合并 `main`。完成本 slice，但全仓目标继续处于阶段 3。

## 2026-10-11：Pi resource manifest composition root（第九十二切片）

- 用户批准后，将完整 Pi resource manifest composition 从低层 resource child 移到 `config_runtime::pi_resource_manifest`；`config_pi_resources.rs` 仅拥有 skill/prompt resource projection 与 gitignore snapshot。保留 subagent、question-timeout、goal 三部分的求值顺序，调用方和序列化字段未变，resource owner 不再依赖 `config_subagents`。
- 更新 Pi compatibility checker 验证 owner 依赖方向和 runtime facade composition。全 Rust lib 339/339、Cargo check 无 warning、Rust fmt、`pnpm check` 79 fixtures、unit 430/430、architecture 3/3、lint、format、build 与 diff check 通过。
- 全量 Rust 测试第一次发现 Browser select test 偶发依赖 `HashMap` 遍历顺序。只放宽该 test 的顺序假设；未排序或改变生产 effects。重跑完整 Rust suite 通过。
- 当前仍在 `beta`，版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。完成本 slice，全仓治理仍在阶段 3。

## 2026-10-11：Hooks compatibility contract owner（第九十三切片）

- 用户确认纯 `checkPiHooksCompatibility(policy, sourceSnapshots)` seam 后，将原先内联于 `check-pi-compatibility.mjs` 的 Hooks cross-end assertions 提取到 `scripts/pi-hooks-compatibility.mjs`；主 checker 继续负责 source reads 与诊断汇总。
- 新 owner 保留 Host runtime marker、Host config Hook 清单预检、worker tool-routing/lifecycle wiring 和原诊断文字，继续比对 manifest 的七项既有 Hook bounds；无 `hooks` policy 时维持 no-op。未改 Hook runtime/execution、安全权限裁决，也未新增限制或数值。
- `scripts/pi-hooks-compatibility.test.mjs` 新增 7 项 source-snapshot fixtures。预期 red 首轮因 owner module 尚不存在而 `ERR_MODULE_NOT_FOUND`；实现后 owner fixtures 7/7 通过。package `check:pi-compatibility` 纳入新 owner 和测试文件的 Prettier/Node test 命令。
- 验证：`pnpm check:pi-compatibility` 86/86 compatibility/permission fixtures、`pnpm check`、`pnpm check:architecture` 3/3、`pnpm test:unit` 430/430、lint、`pnpm format:check`、`pnpm build`、完整 Rust lib 339/339、warning-free `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib`、`cargo fmt --check` 和 `git diff --check` 通过。Vite 仍报告既有 >500 KiB chunks。
- 保持 `beta` 和 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。第九十三切片完成，阶段 3 与全仓长期结构治理仍在进行。

## 2026-10-11：SessionAdapter 直接依赖任务合同 owners（第九十四切片）

- 发现 `PiSessionAdapter` 通过 `tool-gateway.ts` aggregator 引用 task-controller/snapshot、subagent-capability 与 isolation types；这些纯类型的定义 owners 分别是 `task-tools.ts`、`tool-access-policy.ts` 和 `subagent-policy.ts`。
- 将 `session-adapter.ts` 的 type-only imports 路由到这些 owners。Gateway 的兼容 re-export 与所有 runtime values/imports 保留，未改运行时代码、session/task lifecycle、Host authorization 或 wire shape。
- 这是依赖方向收敛而非拆文件：没有新增 behavior test；现有 `pnpm test:agent-worker` 164/164、`pnpm test:unit` 430/430 覆盖保持通过。`pnpm check`（含 86 compatibility/permission fixtures）、lint、format check、production build 和 `git diff --check` 通过；Vite 仍有既有 >500 KiB chunk warnings。
- 当前 branch `beta`，release version trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。此小切片完成，全仓目标继续。

## 2026-10-11：Subagent resume boundary 直接依赖 task status owner（第九十五切片）

- `subagent-session-boundaries.ts` 原从 `tool-gateway.ts` 聚合入口导入 type-only 的 `PiTaskStatus`；定义属于 `task-tools.ts`。改成直接引用定义 owner，未改变 `PiTaskStatus`、Host 权限、恢复规则或 runtime 行为。
- 验证：worker suite 164/164、worker TypeScript build、`pnpm check:architecture`（3/3）、Prettier 和 `git diff --check` 通过。未新增测试，因为没有运行时或公开行为变化。
- 当前仍在 `beta`，版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync。全仓结构治理目标继续。

## 2026-10-11：Config write core 与 Pi refresh orchestration 解耦（第九十六切片）

- `config_core.rs` 原由公开 `update_melody_config` command 写 TOML 后直接调用 `PiWorkerRuntime` 刷新模型与资源，令 storage/core owner 反向依赖运行时。
- 将既有 command composition 移至 `config_runtime.rs`。renderer command 名与注册、workspace authorization、配置写入、仅模型配置变化时的 best-effort model refresh、每次写入后的 best-effort resource refresh及其顺序均保持不变；`config_core.rs` 不再引用 `PiWorkerRuntime`。
- 验证：完整 Rust lib 339/339、Cargo check、Rust fmt check、`pnpm check:pi-compatibility` 86/86、`git diff --check` 通过；无新增行为测试。
- 当前仍在 `beta`，版本 trio `0.4.0-beta.2`；无提交、推送、发布或 main 同步。全仓治理继续。

## 2026-10-11：Pi Explorer bring-back 语义与兼容清单对齐（第九十七切片）

- 用户确认保留 branch-reference 产品语义。`PiSessionExplorer.bringBack` 继续把显式 `&session:<branch-id>` 写入源会话 keyed 草稿，并仅在写入成功后选择源会话；不复制结论正文，也不自动提交。
- 将 Pi compatibility manifest 从锚点后 assistant text 模式改为 `explicit-branch-session-reference-appended-to-session-keyed-local-draft`，移除仅服务于未调用结论正文实现的 `bringBackMaxCodepoints`。删除没有产品调用点的 `appendExplorerConclusionToDraft`、相关 codepoint 上限和三个孤立单测；保留 Explorer interface tests 验证引用写入、持久化失败和选择顺序。
- 验证：Explorer 定向 10/10、完整 unit 427/427、`pnpm check`（86 compatibility/permission fixtures）、lint、format check、production build、完整 Rust lib 339/339、warning-free Cargo check、Rust fmt 和 diff check 均通过。Vite 仍报告既有大 chunk warnings。
- `pnpm format:check` 首次在两个被删减文件发现 EOF 多余空行；Prettier 修复后重新通过。全过程仍在 `beta`，三处版本为 `0.4.0-beta.2`，无 commit/push/release/main sync；全仓结构目标继续。

## 2026-10-11：共享插件 agent 文件扫描（第九十八切片）

- 新审计发现 Pi subagent manifest 与 Settings agent inventory 对 enabled plugin `agents/*.md` 独立执行相同的 bounded file enumeration 和 Markdown parse；最终产物确实不同（manifest 的 bare-name precedence 与 Settings qualified identity），不能共享最终 projection，但应共享输入记录。
- 新增 `visit_plugin_agent_definitions` streaming interface，将 scope/plugin/path metadata 与解析记录一致地交给两个 projection owners；不聚合文件正文到新的 collection、不新增 facade/module。测试验证排序、来源字段和 unsupported 分类；既有 manifest test 继续覆盖 qualified/bare alias。
- 新测试初次错误地把已映射到 `read-write-execute` 的 Bash tool list 作为 unsupported fixture；改成动态 Hook 并修正 expected `hooks` 后 targeted test 1/1 通过。
- 验证：完整 Rust lib 340/340、warning-free Cargo check、Rust fmt、`pnpm check` 86 compatibility/permission fixtures、lint、format check、diff check 通过。未改 TS，不重跑 build/unit；最近 #97 的 JS 427 tests 和 build 已通过。
- 分支仍为 `beta`、版本 trio `0.4.0-beta.2`；无提交、推送、发布、main 同步。全仓结构治理继续。

## 2026-10-11：Subagent Markdown parser tests 回归实现 owner（第九十九切片）

- 两项 frontmatter/Markdown parser/capability-ceiling tests 原放在 `config_subagents.rs`，但只调用 `subagent_markdown::parse_agent_markdown`；移入实现 owner `config_subagent_markdown.rs::tests`。依赖用户/project/plugin precedence 和 manifest/Settings projection 的 tests 继续留在 parent。
- parser owner tests 2/2，完整 Rust lib 340/340，warning-free Cargo check、Rust fmt、`pnpm check` 86 fixtures、lint、format check 和 diff check 通过。Rust-only test movement；最近 #97 已验证的 JS 427 与 production build 保持适用。
- `config_subagents.rs` 1,212 → 1,128 行；Markdown parser owner 687 行（含 moved tests）。保持 `beta` 和 `0.4.0-beta.2` trio，无 commit/push/publish/release/main sync；全仓目标继续。

## 2026-10-11：Subagent record tests 回归持久化 owner（第一百切片）

- `session-adapter.test.mjs` 中的 durable record 用例只直接调用 `subagent-records.ts` 的路径、解析和读写接口，没有验证 session-adapter lifecycle；将既有用例原样迁移到 `subagent-records.test.mjs`。
- 两个执行入口（worker package suite 和 root unit suite）都显式登记新 owner test；session adapter integration cases 仍留在原 suite。更新 `handoff.md` 测试归属说明。
- 验证：owner 1/1、worker 164/164、完整 unit 427/427、`pnpm check`（86 compatibility/permission fixtures）、lint、format check、`git diff --check` 通过。只改 test ownership/manifests/docs，未改 runtime；未重跑 product build。
- 当前仍在 `beta`、release version trio `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。阶段 3 与全仓结构治理继续。

## 2026-10-11：ToolGateway direct tests 回归职责 owners（第一百零一切片）

- 五个只直接调用 owner API 的测试从 `tool-gateway.test.mjs` 分别迁入 `task-results.test.mjs`、`tool-permission.test.mjs` 与 `tool-access-policy.test.mjs`；`ToolGateway` export/dispatch/catalog/createTools 集成测试继续留在 gateway suite。
- 两个 test manifests 显式纳入三个 owner suites。定向 owner+gateway 32/32、worker suite 164/164、完整 unit 427/427、`pnpm check`（86 compatibility/permission fixtures）、lint、format check 与 `git diff --check` 全通过。未改 runtime/security policy，无需重跑 build。
- 当前仍为 `beta`，release version trio `0.4.0-beta.2`；没有提交、推送、发布或 main sync。整体结构治理阶段 3 继续。

## 2026-10-11：MCP runtime 测试边界审计

- 初始审计确认 `pi_mcp_runtime.rs` 同时包含 Host runtime 与直接调用子模块 API 的测试；逐个追踪构造入口后，修正了 stdio 和 remote list/call 测试原先的 integration 分类。

## 2026-10-11：MCP 解析/传输测试回归实现 owner（第一百零二切片）

- 将 config parser 2 项、stdio connection 2 项与 remote HTTP/SSE 8 项既有测试从 `pi_mcp_runtime.rs` 移入 `mcp_config.rs`、`stdio_transport.rs`、`remote_transport.rs`。保留原断言和行为，不改 runtime 实现。
- 父模块留下 MCP result-text、archive projection 与 `PiMcpRuntime::stop_workspace` 测试；request reader helper 移到 remote transport test owner。
- MCP 定向 tests 16/16、完整 Rust lib 340/340、warning-free Cargo check、Rust fmt、`pnpm check`（86 compatibility/permission fixtures）、lint、format check、diff check 通过。未改 TS/产品运行时代码，无需重新运行 JS build/unit。
- 保持 `beta`、版本 trio `0.4.0-beta.2`，无 commit/push/publish/release/main sync；阶段 3 与全仓目标继续。

## 2026-10-11：Marketplace 直接测试回归职责 owner（第一百零三切片）

- 将 marketplace catalog 的相对路径/扫描 2 项、registry provenance/path-containment 2 项和 Git transport SHA validation 1 项既有测试移到对应 owner。安装/刷新编排和版本提示测试继续留在 native parent。
- 初次 targeted compile 报 owner 测试 `use super as ...` 路径无法解析，且 registry test 多导入未使用的 `Value`；修为 `super::validate_relative_path` 并清理 import 后 22 个 marketplace tests 通过。
- 完整 Rust lib 340/340、warning-free Cargo check、Rust fmt、`pnpm check`（86 compatibility/permission fixtures）、lint、format check 与 `git diff --check` 均通过。未改生产运行时或行为。
- 当前仍在 `beta`，版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync，阶段 3 继续。

## 2026-10-11：Pi extension policy/resource 测试边界审计

- 已区分三项纯 policy/resource owner tests 与配置扩展 orchestration/inventory integration tests；迁移范围仅限既有 sandbox precedence、Skill ignore scan-root tests，不新增断言或运行时 seam。

## 2026-10-11：Pi extension policy/resource tests 回归 owner（第一百零四切片）

- `resolve_sandbox_profile` precedence test 移至 `config_pi_policy.rs`；Skill ignore path/native scan 与 plugin Skill scan-root tests 移至 `config_pi_resources.rs`。扩展 inventory/enablement integration tests 仍归 parent。
- 定向 config-extension tests 11/11、完整 Rust lib 340/340、warning-free Cargo check、Rust fmt、`pnpm check`（86 fixtures）、lint、format check、diff check 全通过。第一轮编译提示 owner 缺少 local plugin fixture helper，修复后完成。
- 未改产品运行时代码或安全/权限策略；仍在 `beta`，版本 trio `0.4.0-beta.2`，无 commit/push/publish/release/main sync。

## 2026-10-11：Pi 附件 policy owner（第一百零五切片）

- 用户选择保留 `PiSessionAdapter` 导出作为测试入口；按此将 model input 模态判断、单附件有界 data URL 解码与附件限额移到 `attachment-policy.ts`，旧 helper exports 与现有断言不变。
- Pi turn 的总字节累计、验证顺序、幂等声明、prompt 构造与 session lifecycle 不动；未新增或改写测试。
- 定向 adapter 27/27、worker 164/164、完整 unit 427/427、`pnpm check`（86 fixtures）、lint、format check、production build 与 diff whitespace check 均通过。构建保留既有 >500 kB chunk warnings。
- 仍在 `beta`，版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync，阶段 3 继续。

## 2026-10-11：Pi turn policy owner（第一百零六切片）

- 在用户选定的既有 adapter 测试 seam 下，将 reasoning/session-mode normalization、turn config snapshot validation 与 active-run/cancel identity guards 移入 turn-policy.ts；adapter 仅保留兼容 helper exports 并负责生命周期调用时序。
- 不修改测试断言、协议、Host authorization 或 turn sequencing。adapter 27/27、worker 164/164、完整 unit 427/427、pnpm check（86 fixtures）、lint、format check、build 与 diff check 通过；build 仅有既有大 chunk warning。
- 当前仍在 beta，版本 trio 0.4.0-beta.2；无 commit/push/publish/release/main sync。阶段 3 和全仓目标继续。

## 2026-10-11：Pi 原生会话持久化策略 owner（第一百零七切片）

- 将确定性、opaque 的 native-session 文件名推导，以及 persisted fork 的 source path、leaf anchor、entry 存在性匹配移至 `session-persistence-policy.ts`。
- PiSessionAdapter 保留 `piSessionFileFor` 兼容导出和既有 `pi.fork_target_mismatch` error mapping；用户已确认的 adapter 测试入口与原有 assertions 不变，没有新增 seam。
- 不改变 session root、路径输入、fork creation/recovery 顺序、错误 code/message/scope、Host authorization 或 Pi-only runtime。
- 验证：baseline 2/2、adapter 27/27、worker 164/164、完整 unit 427/427、`pnpm check`（86 fixtures）、architecture gate（3/3）、lint、production build 与 targeted whitespace check 通过；build 仍有既有 >500 kB chunk warnings。
- 仍在 `beta`，版本 trio `0.4.0-beta.2`；无 commit/push/publish/release/main sync，阶段 3 继续。

## 2026-10-11：Pi 子代理运行时生命周期 owner（第一百零八切片）

- 将子代理 task registry、层级与持久化恢复、wait/cancel/continue、child event 状态、resource/model refresh、root cancellation、shutdown cleanup 和 spawn lifecycle 移入 PiSubagentRuntime。PiSessionAdapter 保留 root session lifecycle、公共 worker command/event protocol、共享 ToolGateway 和 Host policy authority。
- 保持逻辑 childSessionId、taskId、root ownership、event projection、Host authorization 与 Pi-only runtime；Pi native SessionManager 使用独立 random UUID，修复公开 worker 测试发现的冒号分隔逻辑 ID 被 Pi SDK 拒绝问题。
- 移除两个直接写 adapter.tasks / 调用私有 wait/cancel 方法的测试，用真实 worker command/event 集成覆盖错误 owner cancel 拒绝、authorized task.cancel、task.wait 终态与 active child shutdown cleanup；未新增 runtime-private test seam。
- 将静态 Pi SDK import/type owner 移到 session-runtime-types.ts；同步 packaging checker 和 Pi compatibility checker 中的静态入口与职责归属断言。
- session-adapter.ts 从 3,459 行缩到 1,984 行；新增 subagent-runtime.ts 为 1,284 行。两者合计减少约 191 行，主要收益是 task/lifecycle 状态所有权及接口边界收敛，而非机械减行。
- 验证：worker package tests 163/163；完整 unit 427/427；pnpm check、lint、全仓 format:check、production build、architecture gate、Pi compatibility/packaging checks 和 git diff --check 均通过。Build 保留既有 >500 kB chunk warnings。未改 Rust source，本切片未单独重跑 Rust lib tests。
- 当前仍在 beta，package/Cargo/Tauri release version 均为 0.4.0-beta.2；无 commit/push/publish/release/main sync。全仓治理阶段 3 继续。

### 第 108 切片工具错误记录

| 错误                                                                                               | 尝试次数 | 解决方案                                                                        |
| -------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------- |
| 首次全量 worker shutdown 测试在最后 task.changed 后注册 close listener，错过快速发出的 close event |        2 | 在发送 runtime.shutdown 前创建 close promise，再等待 child 终态和进程退出       |
| Pi compatibility checker 仍假设 subagent policy/record owner 位于 session-adapter                  |        1 | 将断言更新为 subagent-runtime，并维持 aggregation checker 检查真实 owner wiring |
| packaging checker 仍要求 Pi SDK 静态 import 留在 session-adapter                                   |        1 | 改为检查 session-runtime-types 静态 SDK owner，并重跑 pnpm check                |

## 2026-10-11：Pi Host session command preflight owner（第一百零九切片）

- 将 renderer command parsing、registered workspace authorization、active worker workspace 检查、Pi session/open/import/migration database validation 与 durable fork intent 移入 `src-tauri/src/pi_worker_runtime/session_commands.rs`。`PiWorkerRuntime` 保留 process supervision/dispatch；Tauri command 继续负责 MCP/monitor cancellation、memory injection 等跨运行时副作用和 pipe forwarding。
- 保持原有检查顺序及错误语义：先检查 session identity/解析与登记路径，再查 active worker cwd；fork 在 Host 持久化 pending lineage 后仍执行第二次 generation lookup 与 source binding check，之后才允许 command forwarding。
- 以 `preflight` interface tests 覆盖 session identity/workspace/engine binding、open 产品身份与 ACP 拒绝、import migration journal identity、fork workspace 拒绝/无副作用，以及授权后 durable intent 与两次 generation lookup。兼容 gate 改为验证新 owner 内容、supervisor wiring 与真实 runtime adapter。
- 验证：session-command tests 4/4、完整 Rust lib 344/344、`cargo check --all-targets`、Rust fmt check、`pnpm check`（86 fixtures）、lint、format check、architecture gate 与 Pi compatibility gate 通过；本切片仅修改 Rust/检查器/文档，无 UI runtime 变化。收尾 `git diff --check` 通过，当前分支为 `beta`，三处版本均为 `0.4.0-beta.2`。
- 当前仍在 `beta`，package/Cargo/Tauri release version 均为 `0.4.0-beta.2`；保留工作区中的未提交重构，不做 commit/push/publish/release/main sync。阶段 3 和全仓治理继续。

### 第 109 切片工具错误记录

| 错误                                                                      | 次数 | 处理                                                              |
| ------------------------------------------------------------------------- | ---: | ----------------------------------------------------------------- |
| 初次 fork owner fixture 注册后仍以非 canonical 临时目录作比较，测试未通过 |    1 | 使用 registry 返回的 canonical workspace 根作为运行时 cwd fixture |
| 测试辅助 `Result` alias 遮蔽了 Rust 标准库双泛型形式，导致测试编译失败    |    1 | 对该返回类型显式使用 `std::result::Result`，重跑 owner 与完整测试 |

## 2026-10-11：Host Pi model policy projection owner（第一百一十切片）

- 从 `src-tauri/src/pi_model_config.rs` 提取纯策略 projection 到 `src-tauri/src/pi_model_config/model_policy.rs`：该 owner 决定 per-model/global retry 与 timeout precedence、model/session/default auto-compaction threshold，以及与 Pi worker 相同的 retry/timeout/threshold bounds。
- `pi_model_config.rs` 继续组合用户/项目配置、remote/local models、provider identity、credential references 与 models/policies 文件写入；新 owner 不接触文件系统或凭据。Policy 投影返回必需的策略值，移除了因默认阈值总是落到 85 而永远不可能为空的结果分支；生成的版本化 JSON 字段与内容保持不变。
- owner tests 3/3 覆盖 model/global/session/default precedence、10,000 retry 与 timeout 上限接受/拒绝、0–100 compaction threshold 校验。原模型目录合成、策略文件序列化、invalid retry 时不落盘等 integration tests 保留在 parent。
- 将 `check-pi-compatibility.mjs` 的 Host policy source snapshot 改为读取新 owner；独立兼容检查继续对齐 manifest/worker fields、bounds 和 writer path，并增加 composer 接线 fixture。handoff/README/architecture plan 已同步 owner map 与三项策略字段。
- 验证：完整 Rust lib 347/347、`cargo check --all-targets` 无 warning、Rust fmt、`pnpm check`（86 fixtures）、`pnpm test:unit` 427/427、lint、format check、architecture gate、Pi compatibility fixtures 及真实 Pi compatibility gate 通过。UI/runtime 未改，不重跑 Vite build。
- 仍在 `beta`，package/Cargo/Tauri 版本一致为 `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。阶段 3 和全仓治理继续。

### 第 110 切片工具错误记录

| 错误                                                                | 次数 | 处理                                                        |
| ------------------------------------------------------------------- | ---: | ----------------------------------------------------------- |
| 首次 rustfmt check 仅发现新 owner 文件排版与 crate formatter 不一致 |    1 | 对 Rust crate 执行 `cargo fmt`，再运行全 crate format check |

## 2026-10-11：macOS Seatbelt command adapter（第一百一十一切片）

- 将 macOS `sandbox-exec` 可用性检查、SBPL 生成及完整 wrapper command 构造收敛到 `workspace_sandbox/seatbelt.rs` 的单一 `command(profile)` 接口；这不是单独搬动浅层字符串 formatter。共享 Host profile 校验、Unsupported/fail-closed 决策、`sandboxed_shell_command` 唯一执行入口与 Linux Landlock 均保持原 owner。
- 保持原有 executor 路径、错误文本、`-p` argv、writable diagnostics、设备 write sinks、全局 write deny、精确 deny 顺序及路径 literal escaping。Host 仍只将已解析 profile 交给平台 adapter；adapter 的错误仍映射为既有 `PlatformBroken`。
- Seatbelt owner interface tests 2/2 覆盖可写/只读投影、device sinks、deny 规则、规则顺序和 literal escaping；Host `workspace_sandbox::tests` 9/9 保留共用决策及 fail-closed coverage。Pi compatibility checker 现在沿 parent call wiring 读取实际 Seatbelt owner，而不是要求 executor literal 留在 parent。
- 验证：完整 Rust lib 348/348、`cargo check --all-targets --locked`、Rust fmt、`pnpm check`（Pi compatibility/permission fixtures 87/87）、`pnpm test:unit` 427/427、lint、format check、architecture gate 3/3、真实 Pi compatibility gate 和 `git diff --check` 通过。本机 nested `sandbox-exec` 环境限制和 Linux Landlock 真机验收边界仍同前；本切片只改变模块归属，不声称真实 macOS child enforcement 已新验收。
- 没有 UI runtime 修改，因此未运行 Vite build。仍在 `beta`，release version trio 保持 `0.4.0-beta.2`；无 commit/push/publish/release/main sync，全仓治理继续。

### 第 111 切片错误记录

| 错误                                                                                      | 次数 | 处理                                                                               |
| ----------------------------------------------------------------------------------------- | ---: | ---------------------------------------------------------------------------------- |
| 新 Seatbelt owner test 的 `profile` 局部变量遮蔽同名函数，首轮 Rust 编译失败              |    1 | 将 fixture 局部变量改为 `sandbox_profile`，重跑 owner/Host tests 和完整 Rust suite |
| 首轮 Rust fmt 与 Prettier 检查发现 owner/parent Rust 格式及 compatibility script 排版差异 |    1 | 用 crate formatter 与 Prettier 格式化实际变化文件，再重跑全套格式检查              |

## 2026-10-11：Pi web projection test ownership（第一百一十二切片）

- `pi_web_runtime/projection.rs` 已拥有 bounded UTF-8 text、HTML/entity projection 与 Search citation formatting，但两个只调用这些 owner functions 的 behavior tests 仍放在 `pi_web_runtime.rs`。将它们移动到 projection owner；Host config、credential/header、URL/SSRF policy、HTTP response handling tests 留在 runtime。
- 通过同一 projection interface 增加 `bounded_text` 的边界 characterization：短文本原样返回；包含多字节字符的长文本先按 UTF-8 字符边界截断 body，再附加现有 truncation marker。没有改变截断逻辑、输出字节上限定义或 web runtime 行为。
- 验证：projection tests 4/4，`pi_web_runtime::tests` 3/3，完整 Rust lib 350/350，`cargo check --all-targets --locked`、Rust fmt、`pnpm check`（87 compatibility/permission fixtures）、`pnpm test:unit` 427/427、lint、format、architecture gate 3/3、Pi compatibility gate 与 `git diff --check` 通过。只改 Rust tests/docs，未改 UI/runtime adapter，不运行 Vite build。
- 保持 `beta` 和三处版本 `0.4.0-beta.2`；未提交、发布或同步 `main`。阶段 3 的全仓结构治理继续。

### 第 112 切片工具错误记录

| 错误                                                                                 | 次数 | 处理                                                         |
| ------------------------------------------------------------------------------------ | ---: | ------------------------------------------------------------ |
| 初次 `cargo fmt --check` 仅发现新 UTF-8 boundary assertion 与 crate formatter 不一致 |    1 | 运行 `cargo fmt` 并重跑 owner/parent tests 与全 Rust suite   |
| task-plan patch 锚点未匹配 Prettier 换行后的当前内容，修改未应用                     |    1 | 读取精确段落后重试；随后通过 touched Markdown Prettier check |
| touched-docs Prettier check 两次发现新 `progress.md` 行/工具错误表的排版差异         |    2 | 运行 Prettier 并重跑 touched-docs 与仓库格式检查             |

## 2026-10-11：Pi compaction compatibility contract owner（第一百一十三切片）

- 将原先内嵌在 `check-pi-compatibility.mjs` 的 compaction/manifest source-snapshot rules 收入 `scripts/pi-compaction-compatibility.mjs`；聚合器继续负责 worker 文件读取、missing-source diagnostics 与总体汇总。
- Owner 通过 `(contract, sourceSnapshot) -> diagnostics` 检查 manifest entry point、双阶段压缩 markers、每个 task-digest source 的 extension reconstruction owner，以及 digest-only failure fallback。新增 6 项 interface fixtures；`package.json` 的 `check:pi-compatibility` 显式格式化、运行这些 tests 并执行真实兼容门禁。
- 不改 `compaction-extension.ts`、Host 权限裁决、worker runtime/API、wire contract 或用户可见语义；同步 `task_plan.md`、`findings.md`、architecture plan 与 migration handoff。
- 验证：owner tests 6/6，真实 Pi compatibility gate 通过，`pnpm check`、完整 unit 427/427、lint、`pnpm format:check`、architecture gate 3/3 与 `git diff --check` 通过。纯脚本/文档改动，无需 Rust 或 Vite build。
- 仍在 `beta`，package/Cargo/Tauri release version 保持一致 `0.4.0-beta.2`；无 commit/push/publish/release/main sync。全仓结构治理继续处于阶段 3。

## 2026-10-11：Pi-only renderer route convergence（第一百一十四切片）

- 删除 renderer `AgentClientEngine`、per-session engine override Map 和 settings-derived configured client。`agentClientForRuntime()` 唯一决定 Tauri Desktop→Pi、browser preview→deterministic ACP fixture。
- `use-agent-bridge` 按 runtime 安装对应订阅；`beginAgentSession` 对 Desktop 使用 product session ID，browser preview 保留 ACP fixture ID。workspace stop/delete 与 subagent continuation 从 runtime 推导；Pi Explorer 不再以 persisted engine preference 为门槛。
- `agentEngine` 持久化字段保留为旧设置兼容/归一化数据，不再选择 runtime。归档检测仍先于 runtime connect，旧会话仍通过 `beginArchivedSession` 只读展示；ACP→Pi import 继续使用原 binding/import-journal 安全路径。未修改 Host permission、worker command handling、wire protocol 或 Pi worker runtime。
- 用户确认的实际入口是 `agentClientForRuntime()` 与 `beginAgentSession()`；新增 Vite SSR Node integration tests 覆盖旧 `legacy-acp` 偏好下 Desktop 路由、预览路由及两类 session identity。新增测试 4/4、既有 Explorer tests 7/7。
- 验证：归档、ACP import、legacy adapter、Pi Explorer 与 routing owner 定向 tests 35/35；`pnpm test:unit` 431/431，`pnpm check`（93 个 Pi compatibility/permission fixtures 加真实源码 gate），`pnpm check:architecture` 3/3，`pnpm lint`、`pnpm format:check`、`pnpm build`、文档 Prettier 和文档同步后的 `git diff --check` 均通过。Vite 仍报告既有 >500 KiB 按需 chunk warning。
- 当前仍在 `beta`，package/Cargo/Tauri 版本统一为 `0.4.0-beta.2`；没有 commit、push、测试发布、release 或 main sync。全仓结构治理继续处于阶段 3。

## 2026-10-11：renderer Agent store 运行态命名边界（第一百一十五切片）

- 将 `AgentStore` 活动运行态字段从 `acpSessionId/acpPhase/acpCursor` 改为 `runtimeSessionId/runtimePhase/eventCursor`，并将生命周期类型命名为 `AgentSessionPhase`。规范事件 patch、session open/reset、pending prompt 路由、UI 投影和持久化快照消费端均随新运行态字段更新。
- `beginAgentSession` 输入改称 `sourceAcpSessionId/sourceAcpCursor`，用于明确这是旧记录/导入来源；Desktop Pi 仍使用产品 session ID，browser preview fixture 仍使用 ACP source ID。`use-session-persistence` 是唯一游标命名转换点：runtime `eventCursor` 写回既有 `acpCursor` 持久字段。
- 归档、导入计划、SessionRecord、legacy adapter 和存储字段未改名；没有数据库迁移、JSON archive 形状或 wire protocol 变化，也没有权限/Host 行为变化。
- 增强现有 `beginAgentSession()` Vite SSR integration test：返回 Pi binding 并观察实际 `send_pi_agent_command` `session.open` envelope，锁定 envelope session ID、nested session ID 和 product session ID 都是 Desktop product ID。既有路由测试 4/4；projection direct-owner assertions 继续覆盖 event cursor/runtime phase。
- 本轮验证：首次 `pnpm format:check` 只标出 `agent-store-runtime.ts` 与 `agent-store-session.ts`，运行 Prettier 后通过；`pnpm check` 93 compatibility/permission fixtures + real source gate、完整 unit 431/431、architecture 3/3、lint、`pnpm format:check`、`pnpm build`、`git diff --check` 均通过。Build 留有既有 >500 KiB 按需 chunk warnings。
- 当前分支 `beta`，`package.json`/Cargo/Tauri 版本统一为 `0.4.0-beta.2`；没有 commit、push、测试发布、release 或 main sync。全仓结构债务治理仍在阶段 3。

## 2026-10-11：Pi provider error projection owner（第一百一十六切片）

- 将有界 provider 错误文本清理、credential redaction、限流分类和既有 `AgentError` projection 移入 `packages/agent-worker/src/pi/session-errors.ts`；adapter 保留 active-run error state、后续成功清除和终态事件顺序。
- 移除直接读写 adapter 私有 session map、直接调用 `onPiEvent` 的 provider-error tests，改由公开 worker command/event protocol 做一项集成测试：实际观察到 503 后 assistant error message、后续成功 response 和 error-free terminal event；持续 400 rate-limit response 映射到既有终态 error 且不泄漏 Bearer/API key 示例。
- 首轮 fixture 只发送一次 HTTP 400，Pi SDK 按既有 retry 行为继续请求并命中默认成功 response；改为提供连续错误响应后，端到端终态断言通过。Production behavior 未作 retry-policy 改动。
- 验证：worker suite 163/163；`pnpm test:unit` 430/430；`pnpm check` 含 93 个 compatibility/permission fixtures 与真实 source gate；architecture gate 3/3；lint、`pnpm format:check`、`pnpm build`、`git diff --check` 均通过。Build 仍报告既有 >500 KiB chunks。
- 初次并行运行 worker/full unit 时结果非零；可见的 unit 失败是无关 source adapter interval 断言（预期 25 ms、实测 23 ms）。随后独立串行重跑 worker 与 full unit 均通过，未修改该 timing-sensitive test。
- 保持 `beta` 和 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。全仓结构治理继续处于阶段 3。

## 2026-10-11：下一切片职责审计续行（未改源代码）

- 恢复后重读阶段计划、近期进展/发现并运行 session catch-up；catch-up 无未同步上下文。当前工作树仍为 `beta...origin/beta`，保留已有未提交结构重构。
- 复核 `pi_model_config.rs` 的函数和调用图：已有 policy 与 remote catalog 子 owner；唯一产品调用点是 `PiWorkerRuntime::prepare_pi_models_with_remote`，但父模块仍将配置读取/合并、provider/model normalization、Pi 文件投影和 auth credential reference projection 编排在同一模块中。
- 完整阅读 projection/auth flow、现存测试与 checker 引用后，曾评估 slice 118；其源码尚未修改。`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_model_config::tests` baseline 为 17/17。随后收到用户对 slice 117 MCP inventory compatibility seam 的明确确认，故切换当前工作到已确认的 slice 117；model-projection 方向暂缓。
- 按确认的 `checkPiMcpInventoryCompatibility({ inventory, sources })` seam 添加纯 fixture owner；覆盖缺失/错误 Host authority、owner re-export/implementation、Host workspace authorization、Tauri registration/permission、renderer bridge/preflight 与 capability report 的 Host status/no-duplicate-parser 约束。测试先因 owner module 不存在按预期红灯，实现后 6/6 通过；新增反例让无关函数保留同名 auth/owner markers，发现全文件匹配会误过。将 Host 检查限制到 command body 并要求 authorization 先于 owner call，反例先红后绿。一次 matcher 不接受无显式 return-type 的 fixture，引发三个附带失败；扩宽为可选 return annotation 后以生产形状 fixture 6/6 通过。
- 总检查器已将原 inline predicates 改为 source-snapshot assembly + `checkPiMcpInventoryCompatibility` 调用；读取失败仍由聚合器报告，missing/malformed manifest inventory 由 owner 明确报错。`package.json` 的 `check:pi-compatibility` 已纳入 owner/test 文件，初次 Prettier 和 compatibility gate 通过 99/99；Host command-order checker 随后加强，需复跑。
- 增强后再次运行 `pnpm check:pi-compatibility` 通过（99/99 + real source gate），`pnpm check` 也通过。首轮完整 unit 430 项中 429 pass，唯一失败是既有 `research-source-adapter.test.mjs` 的 timer interval 24 ms vs 25 ms；按前一切片记录属于 timing-sensitive test，本轮先隔离复核，不做无关改动。
- 独立运行 `research-source-adapter.test.mjs` 6/6 通过后，串行重跑完整 `pnpm test:unit` 430/430 通过；不改动其 interval 断言。

## 2026-10-11：MCP inventory cross-layer compatibility owner（第一百一十七切片完成）

- 完成 fixture-tested `scripts/pi-mcp-inventory-compatibility.mjs`，并让 aggregate checker 继续负责读取 snapshots、读取失败 diagnostics 与总诊断汇总。Host command fixture 限定目标 command body，验证 workspace authorization 先于 inventory owner 调用；renderer bridge/preflight 与 capability report 必须消费 Host-validated inventory/status。
- 同步 `task_plan.md`、`findings.md`、`docs/architecture-improvement-plan.md` 和 migration handoff。三次组合/长行补丁因 findings 长行上下文不匹配而未应用；改为按短 heading/局部 hunk 更新后成功，未覆盖已有工作。
- 最终当前工作区复验：`pnpm check`（99 compatibility/permission fixtures 与真实 source gate）、`pnpm lint`、`pnpm test:unit`（430/430）、完整 Rust lib（350/350）、marketplace focused tests（26/26）、`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib`、`cargo fmt --all --check`、`pnpm format:check`、`pnpm check:architecture`（3/3）、`pnpm build`、规划文档 Prettier 和 `git diff --check` 全通过。Build 保留既有 >500 KiB chunk warnings。
- 本切片只增强静态兼容合同检查，不改 MCP runtime、Tauri 实际权限、Host 校验或 renderer 决策；仍处于 `beta`，无 commit/push/publish/release/main sync。

## 2026-10-11：Pi model configuration projection owner（第一百一十八切片）

- 从 `src-tauri/src/pi_model_config.rs` 抽出纯模型配置 projection 到 `src-tauri/src/pi_model_config/model_projection.rs`：scope merge、remote model overlay、provider/model normalization、sampling/input projection、credential references 与 per-model policy composition 归到该 owner；parent 仍负责 config read、remote catalog resolve、文件写入和 resolved credential injection。
- 保持 `prepare_pi_models_with_remote` / `PreparedPiModels`、生成模型与策略文件字段、scope precedence、stable provider IDs、错误语义和 Host credential lifecycle 不变。`pi_remote_model_catalog.rs` 与 `model_policy.rs` 继续分别拥有 remote transport/cache 与 request-policy validation。现存 tests 继续经 parent compatibility imports，没有新增/修改 test seam。
- Compatibility checker 改为验证 parent wiring 与 `model_projection.rs` 到 policy owner 的调用关系，并读取新 projection owner snapshot。同步 task plan、findings、architecture improvement plan、Pi migration handoff 和 README model ownership 文档。
- 验证：focused model-config tests 17/17、完整 Rust lib 350/350、`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib`、`pnpm check`（99 compatibility/permission fixtures + real source gate）、lint、format check、Rust fmt check、architecture gate 与 `git diff --check` 通过。没有重跑 full JS unit/build（Rust-only source/static-gate slice）。
- 工具错误：第一轮 extraction script 因 BTreeMap import marker 重复命中而安全停止，未写文件；更精确的 import block 后续成功。文档 patch 的失败均未写入文件：wrapper 首轮因未转义 backticks 解析失败；task-plan checklist hunk 漏了 literal dash；README 插入 hunk 漏了 context prefix；错误表插入先漏 context prefix、再锚定到 findings 中而非 task_plan 的 heading。核对实际文件后改用普通字符串数组和较小、精确的 hunk。
- 保持 `beta`、`package.json`/Cargo/Tauri 版本均为 `0.4.0-beta.2`；不 commit/push/publish/release/main sync。全仓目标仍处于阶段 3，不视为完成。

## 2026-10-11：Browser tab-index test ownership（第一百一十九切片）

- 将 `BrowserTabIndex` 的两项既有直接行为 tests 原样移到 `pi_browser_runtime/session_lifecycle.rs` 的 owner-local test module；移除 parent 的 `cfg(test)` 子模块导入。没有改 assertions、runtime code、接口或 seam；parent 继续测试 WebView/security behavior。
- 测试迁移前/后 `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pi_browser_runtime::` 均为 15/15；迁移后完整 Rust lib suite 为 350/350。
- 一次 findings 更新 hunk 首轮因未对 literal Markdown bullet 加 patch prefix 未应用；没有写入，补上 marker 后成功。后续需完成 touched-doc formatting、Rust fmt check 与 diff check。
- 一次 findings 更新 hunk 首轮因未对 literal Markdown bullet 加 patch prefix 未应用；没有写入，补上 marker 后成功。
- 仍在 `beta`，版本 trio `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。全仓治理继续。

## 2026-10-11：Session-isolated browser WebView creation owner（第一百二十切片）

- 将 platform WebView/profile construction 与 navigation/constrained-popup callbacks 从 `pi_browser_runtime.rs` 抽入 `pi_browser_runtime/view_creation.rs`；parent 继续负责 command/security policy、adapter composition、session orchestration、bounds 与 tool dispatch。URL destination policy 和 tab lifecycle 分别留在既有 owners。
- 原有 profile-label 与 platform-isolation assertions 原样迁到新 owner，没有改变 runtime behavior、接口或 test seam。Browser-scoped tests 15/15、完整 Rust lib 350/350、`cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets` 和 `pnpm check`（99 fixtures + real source gate）通过。
- 文档 patch 首轮模板字符串因 Markdown backtick 解析失败未应用；parent patch 上下文也曾引用 slice 119 已删除的 test-only import；均在读取当前文件后以小范围 hunk 修正。保持 `beta` 与 `0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。

## 2026-10-11：Pi worker direct test ownership（第一百二十一切片）

- 将 parent `pi_worker_runtime.rs` 中只覆盖 `protocol.rs` framing/command validation、`envrc.rs` environment projection 与 `launch.rs` inherited environment allowlist 的五项既有 tests 原样移入各自 owner；supervisor parent 保留未绑定 product session runtime event 的分类测试。
- 定向 `pi_worker_runtime::` suite 迁移前后均为 22/22，完整 Rust lib 350/350；`cargo fmt` 完成。该测试归属变化没有修改 production runtime、assertions 或 Host/worker boundary。
- 测试迁移令旧 Pi compatibility predicate 暴露出依赖 parent test marker 的位置耦合；predicate 已改为检查真实 `launch.rs` snapshot，`pnpm check`（99 fixtures + source gate）、format 与 diff checks 通过。
- 一次 test-module patch 留下了多余的 `#[test]` marker，静态检查在执行测试前发现并修正。保持 `beta`、`0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。
- 另一次首次 `pnpm check` 因同一旧 marker 假设失败；调整 checker 到 `workerLaunch` snapshot 后重跑通过。保持 `beta`、`0.4.0-beta.2` 版本 trio；无 commit/push/publish/release/main sync。

## 2026-10-11：Browser URL policy test ownership（第一百二十二切片）

- 将 parent 中直接调用 URL trust、loopback preview 与 popup-destination predicates 的三项既有 tests 原样移到 `browser_policy.rs`；真实 Tauri capability 与 `BrowserBounds` tests 留在 parent。
- 原 checker 因同一 URL-policy validator marker 在 parent tests 中而失去命中。增加 `page_tools.rs` 与 `screenshot.rs` source snapshots，并验证两处真实 URL validation owner wiring，避免降低已有 snapshot safety coverage。
- Browser-scoped Rust suite 迁移前/后 15/15，完整 Rust lib 350/350；`pnpm check`（99 fixtures + real source gate）、Rust fmt、`git diff --check` 通过。没有改变 runtime URL/security policy、浏览器 IPC capability、Host authority、接口或 assertions；仍在 `beta`，无 commit/push/publish/release/main sync。

## 2026-10-11：Normalized message stream projection owner（第一百二十三切片）

- 将 normalized `message.delta`、`thought.delta`、`message.started` 与 `message.completed` 的 timeline 转换、message/part offset continuity、assistant streaming-row reconciliation 和完成后的 message-scoped state cleanup 移至 `src/domain/agent/message-projection.ts`。
- `projectAgentEvent` 继续负责 event/session envelope 验证、内部工具过滤、全事件 dispatch 和最终 state patch；保留原 public reducer interface，不新增测试 seam 或修改 assertions。`session-projection-updates.ts` 仍负责共享 timeline update 操作。
- 定向 reducer tests 24/24，完整 `pnpm test:unit` 430/430；`pnpm check` 通过 TypeScript、agent contract/worker/package gates、99 compatibility/permission fixtures 与真实 Pi source gate。
- 首轮 `pnpm check` 发现一项只因代码移动而多余的 `AgentAssistantMetadata` import，删除后重跑通过。lint、architecture tests 3/3、production build、repository/prettier planning-doc checks 与 `git diff --check` 均通过；build 保留既有 >500 kB chunk warnings。
- 仍在 `beta`，`package.json`/Cargo/Tauri version trio 为 `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。全仓治理继续处于阶段 3。

## 2026-10-11：Pi config policy direct-test ownership（第一百二十四切片）

- 将 `config_runtime.rs` 中六项只直接验证 Pi terminal、question-timeout、goal-safety policy projection 的既有 tests 原样移入 `config_pi_policy.rs::direct_policy_tests`；sandbox-profile precedence test 已属于该 owner，保持不变。
- Parent 继续覆盖 config command/manifest assembly 与 marketplace/plugin/extension integration；无 runtime、assertion、Host authorization 或 test-seam 变化。
- 迁移前 `config_runtime::tests` 27/27；迁移后 `config_` suite 85/85、完整 Rust lib 350/350，`cargo fmt --all --check` 通过。首次 fmt check 的两处机械格式差异由 `cargo fmt` 修正。
- 仍在 `beta` 与版本 trio `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。全仓治理继续处于阶段 3。

## 2026-10-11：Pi configuration capability policy owner（第一百二十五切片）

- 将 config snapshot 形状读取和 Pi compatibility policy classification 从 `capability-report.ts` 拆到纯 `config-capability-policy.ts`，提供一次带命名字段的策略投影，覆盖 sandbox、codebase glob、外部认证/OIDC、subagent definitions、terminal/question timeout、LSP presence、semantic memory 和高级 goal orchestration。
- `capability-report.ts` 保留诊断排序、文案、Host inventory 汇总和 block/degradation 合成；MCP inventory 仍由 Host 提供并作为支持裁决权威。现有 public report seam 与测试 assertions 保持不变。
- `capability-report.ts` 从 852 行降至 483 行。定向 tests 42/42、完整 unit tests 430/430、`pnpm check`（99 fixtures + source gate）、lint、architecture tests 3/3、format check、Vite build 与 `git diff --check` 通过；bundle chunk warning 仍是既有状态。
- 仍在 `beta` 与版本 trio `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。

## 2026-10-11：Worker resource/policy snapshot owner（第一百二十六切片）

- 将 worker launch environment policy parsing 和 Host resource-manifest validation/normalization 移到 `resource-policy-snapshot.ts`；owner 输出受限 workspace roots 与当前 policy snapshot。`resource-discovery.ts` 保持实际 Skill/Prompt path discovery；Pi runtime policy normalization 复用 `goal-extension.ts` 与 `subagent-policy.ts`。
- `session-adapter.ts` 从 1,928 行降至 1,753 行，只保留共享策略状态、root/child session lifecycle 与 Host refresh 应用/有序 reload。Host omission clearing、cwd/root trust checks、错误分类与已有 message 保持不变。
- 原 adapter/resource-discovery tests 29/29，question-timeout compatibility fixtures 5/5，worker suite 163/163，full unit 430/430；`pnpm check` 99 fixtures + source gate、lint、architecture tests 3/3、format check、Vite build 与 diff check 均通过。Vite bundle warning 仍是已有 >500 kB chunks。
- branch/version remain `beta` / `0.4.0-beta.2`; no commit, push, publish, release, or main sync.

## 2026-10-11：Resource policy snapshot seam（第一百二十七切片完成）

- 当前树通过 `resource-policy-snapshot.ts` 与 `resource-discovery.ts` 复核：资源根信任计算会在策略快照已收到显式 environment 参数时继续读取全局 `process.env`。这是一个隐藏依赖，也使 owner tests 难以隔离环境。
- 已让 `normalizePiResourceRoots` 及私有 root source helpers 接收显式 environment（默认仍为 `process.env`），并由 snapshot normalizer 转发同一输入；已创建 owner-local 测试覆盖启动策略解析、Host roots、可选 Host policy omission 与无效 workspace/策略。
- `resource-policy-snapshot.test.mjs` 四项 owner tests 已加入 worker 与 root `test:unit` manifests。测试通过自定义 `MELODY_HOME` 与 `HOME` 下的嵌套 Skill/Prompt roots，确保 root trust 确实使用显式环境输入，而不是被 workspace roots 或测试进程的 `process.env` 偶然放行。
- 验证通过：定向 owner 4/4，worker 167/167，全量 unit 434/434，`pnpm check`（99 个 compatibility/permission fixtures + 真实 Pi source gate）、architecture 3/3、lint、format、Vite production build、`git diff --check`；构建仍有已存在的 >500 kB chunk warnings。兼容 source gate 新增对显式环境贯穿的检查。
- 首次 Prettier 检查只报 `resource-discovery.ts` 新参数换行，格式化后检查通过。运行时 root policy 与默认 `process.env` 行为未改变。最终状态：`beta...origin/beta`，package/Cargo/Tauri 均为 `0.4.0-beta.2`，`git diff --check` 与规划文档/源码 Prettier 检查通过；无 commit/push/publish/release/main sync。切片 127 完成，全仓目标仍在阶段 3。

## 2026-10-11：继续审计剩余 Host/worker owners（第一百二十八切片进行中）

- 按仓库 workflow 复核当前为 `beta...origin/beta`；保留既有大量未提交/未跟踪结构重构。`session-catchup.py` 未输出待同步报告。未进行 commit、push、publish、release 或 main 同步。
- 检查 `pi_tool_gateway.rs` 后拒绝单纯按文件体积拆分：生产部分主要是既有 owner 的 Host dispatch/composition，剩余大部分是 gateway integration tests；拆它可能只是搬测试或增加浅层转发。
- 检查 `config_subagents.rs` 后暂不继续拆分：它承接 scope/source resolution 和两个不同的 Host projection；Markdown parser、prompt file 与共用 agent-file scanning 已归入子 owner，目前尚无足够证据证明剩余投影层存在重复语义。
- 继续检查 renderer store：`agent-store.ts` 中 `resolvePlan` / `resolvePermission` / `resolveQuestion` 仍集中负责同一类用户交互收尾状态与 Host resolution，且可沿用 `AgentStoreAccess` 现有 seam；相邻 session/submit/receive 行为已使用同模式 owner modules。把它记录为本切片首选候选，下一步确认 `AgentStore` 调用兼容与现有测试边界，再决定是否抽出交互 owner。
- 测试边界核对：`AgentStore` 已暴露稳定的三项 public actions，`AgentStoreAccess` 是现有 session/submit owner 的生产 get/set interface；当前 store test 只覆盖 runtime routing 和 session open，不直接验证这三种 interaction responses。选定新 owner 模块被生产 store 组合调用，并以 `AgentStoreAccess` 合同添加 owner-local 行为 tests，不添加 test-only private seam。
- 本切片不改变 UI callback、store action signatures 或 Host command protocol。保留 plan optimistic rollback；permission project-rule-before-command 顺序、背景/root timeline 归属和 Pi root identity；question wire mapping 与成功后才更新本地状态。
- 实施：新增 `src/stores/agent-store-interactions.ts` 接管三个 production resolution handlers，`agent-store.ts` 只传入既有 `{ get, set }` 并保留 public action names/signatures。新增 owner tests 4/4 通过：plan settlement、Host send 失败回滚、背景 permission 更新并以 root session 送出，以及 question 的 `partial_answers` wire mapping 和 Host ack 后更新。全量 gates 与最终 branch/version/diff 复核待跑。
- 完整 suite 排除新测试的基线通过 434/434 且无 warning；新旧 SSR 测试并行单独运行 8/8 也无 warning，但包含其他测试时增加第二个 Vite SSR server 会出现 24678 warning。已把四项 interaction 行为 tests 移到既有 `agent-session-routing.test.mjs`，共享同一个 Vite server；定向文件 8/8 通过且无 warning。新 owner test 单独文件已移除，root package test/format 清单不再增加第二个 SSR test server；重跑全量套件待完成。
- 最终验证：完整 `pnpm test:unit` 438/438 且无 WebSocket warning；`pnpm check` 通过，含 TypeScript、agent contract/worker/package、99 compatibility/permission fixtures 与真实 Pi source gate；`pnpm lint`、architecture 3/3、`pnpm format:check`、`pnpm build` 和 `git diff --check` 均通过。Vite build 仍报告既有 >500 kB chunks。
- 最终复核仍在 `beta...origin/beta`，`package.json`、`Cargo.toml`、`tauri.conf.json` 均为 `0.4.0-beta.2`。保留工作树中的其他累计重构；没有 commit、push、publish、release 或 main sync。切片 128 完成，全仓治理继续在阶段 3。

## 会话：2026-10-11

### 第一百二十九切片：Renderer 会话配置选择 owner（完成）

- 从 `agent-store.ts` 抽出 `selectModel`、`selectReasoningEffort`、`selectSessionMode` 与 `selectPermissionMode` 的 production implementation 到 `src/stores/agent-store-configuration.ts`。Store 保留原公开 `AgentStore` actions，并通过既有 `AgentStoreAccess` `{ get, set }` seam 委派；没有引入测试专用入口。
- 有意保持 ACP response-ID handlers 与 Pi normalized configuration/error event reconciliation 分别留在它们的 transport adapters，避免把协议解析合并到 renderer action owner。原逻辑的 preview 与 no-runtime 分支、模型对应的 reasoning/context usage、`configRevision`、请求 ID、pending patches、permission-mode optimistic update/error rollback 和每项错误状态均保持。
- 在既有 `agent-session-routing.test.mjs` / 单一 Vite SSR server 加入 3 项配置 owner 行为测试：preview/下一个会话状态、四类 live revision-bound command envelopes 与 pending 状态、各 action command failure recovery。首轮测试使用了非法 `AgentPermissionMode` 值 `allow`，按实际 enum 改为 `auto` 并复跑通过；错误已记录在 task plan。
- 定向 store SSR suite 11/11、全量 `pnpm test:unit` 441/441、`pnpm check`（99 compatibility/permission fixtures + Pi source gate）、lint、architecture tests 3/3、`pnpm format:check` 与 `pnpm build` 均通过。Build 保留现存 >500 kB chunk warning。
- `format` / `format:check` manifests 已加入新 owner，防止后续新增模块漏出格式门禁。
- 最终复核：`git diff --check` clean；当前为 `beta...origin/beta`，`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 均为 `0.4.0-beta.2`。累计工作树仍有 179 个 tracked/untracked status entries；本切片只增加配置 owner、既有 SSR suite 中的行为覆盖与格式 manifest，所有其他已累积 beta 改动均保留。没有 commit、push、publish、release 或 main sync；全仓结构债治理目标继续处于阶段 3。

## 会话：2026-10-11

### 第一百三十切片：Pi 子代理生命周期 owner（完成）

- `PiSubagentRuntime` 通过新必需的 `loadPiSdk` 依赖获得 Pi SDK；`PiSessionAdapter` 复用已有静态 loader 注入，不改变 Pi-only 路由、Host 工具授权或 task wire events。
- 新 owner suite 以公开 `PiSubagentRuntime` / `PiTaskController` 接口和最小 SDK fake 验证 child lifecycle、完成快照/事件、session/root 归属与跨 root 拒绝；保留原 worker smoke lifecycle integration tests。
- 验证：owner test 1/1、worker suite 168/168、完整 unit 442/442、`pnpm check`（99 compatibility/permission fixtures）、lint、architecture 3/3、format check、production build 与 `git diff --check` 均通过。构建仍显示既有 >500 kB chunks。
- 复核仍在 `beta...origin/beta`；package/Cargo/Tauri 三处版本均为 `0.4.0-beta.2`。累计 beta 工作树和无关重构均保留，无 commit/push/publish/release/main sync；全仓治理继续处于阶段 3。
- 工具错误均已记入 `task_plan.md`：首轮 owner error wrapper 断言不匹配、Prettier 首检和未匹配的计划/进度 patch；均已针对性修正/复核。

## 会话：2026-10-11

### 第一百三十一切片：Pi codebase request contract owner（完成）

- 按当前 beta 工作树重读 planning/findings/progress 并执行 session catch-up；无 catch-up report。修正 slice 130 completion entry 的排序，使其位于 slice 129 之后，并移除重复粘贴的旧 slice 128 审计 bullet。
- 将 `pi_codebase_runtime.rs` 中 worker argument/workspace path contract 收入 `pi_codebase_runtime/request.rs`。新的 `parse_request(root, arguments)` 输出 canonical workspace、operation、文件、位置、query 和 definition 参数；Host envelope parsing/tool allowlist、`pi.codebase_tool_failed` envelope、config policy、index/cache refresh/query 与结果投影仍归 parent。
- 保留旧验证顺序、错误文案、位置/query/path bounds 与 canonical symlink containment；`CodebaseIndex::refresh` 复用 request owner 的 canonical workspace helper，避免重复 root policy。
- 新 request owner tests 4/4、`pi-codebase-index-compatibility.test.mjs` source fixtures 8/8 已通过；聚合 `pnpm check:pi-compatibility` 与全量门禁完成：Rust library 353/353、TypeScript unit 442/442、`pnpm check`（100 compatibility/permission fixtures）、lint、architecture 3/3、format check、Cargo check/fmt、Prettier 与 `git diff --check` 均通过。
- 复核仍在 `beta...origin/beta`，package/Cargo/Tauri 版本一致为 `0.4.0-beta.2`；没有 commit/push/publish/release/main sync。slice 131 完成，阶段 3 与全仓结构性治理继续进行。

### 第一百三十二切片：Pi codebase index/cache owner（完成）

- 继续基于当前 beta 工作树审计：`pi_codebase_runtime.rs` 已把 parser 与 request contract 分别交给独立 owner，但仍将文件 walk/fingerprint、index/cache lifecycle 与 Host 请求/配置/输出路由组合在一起。
- 已选定将 per-workspace registry、bounded scan、refresh/rebuild 和 symbol/location query 收进 `pi_codebase_runtime/index.rs`；parent 继续负责 project indexing policy、Host envelope 与最终 JSON/error composition。权限边界和文件 path containment 不改变。
- `pi_codebase_runtime/index.rs` 现独自拥有 fingerprint/file state、workspace cache/idle eviction、bounded refresh/rebuild 和 symbol/location projection；parent 通过单一 `with_index` 闭包接口调用，不再直接持有缓存或索引实现。
- owner tests 覆盖 changed-file refresh、definition/reference/document/workspace query、100-result cap、超过 2 MiB 的 source skip 与 Unix symlink no-follow；parent request/error integration test 仍在。
- 验证：codebase runtime focused tests 14/14、兼容 fixtures 9/9、全 Rust library 356/356、全量 unit 442/442、`pnpm check`（101 compatibility/permission fixtures）、lint、architecture 3/3、format/Prettier、Cargo check/fmt 与 `git diff --check` 均通过。
- 复核仍在 `beta...origin/beta`，package/Cargo/Tauri 均为 `0.4.0-beta.2`；无 commit/push/publish/release/main sync。未改 UI/打包配置；slice 132 完成，阶段 3 与全仓结构性治理继续进行。

## 会话：2026-10-11

### 第 133 切片前：全仓架构门禁与残余 owner 审计

- 使用 `codebase-design` 的深模块/窄接口/测试跨 seam 原则与文件规划技能恢复工作；重读 task plan、近期 findings/progress 和当前工作树。session-catchup 无额外记录。
- 当前 `check-architecture.mjs` 只检查 domain 反向依赖和 worker 中 Pi SDK import 位置，不构建内部依赖图；下一步先用 TypeScript 实际 module resolution 查 production cycles，避免用未解析的正则给系统加误报门禁。
- 当前仍有多个大模块，但已有 owner 提取使 `session-adapter.ts`/`pi_tool_gateway.rs` 多数实现已下沉；继续前先核实职责，而非按行数拆分。

### 第一百三十三切片：Agent contract runtime cycle 与依赖图门禁（完成）

- 依据 TypeScript compiler resolver 的全图审计发现 agent-contract barrel/validator 唯一运行时 SCC；确认其他 research SCC 仅由类型导入构成。
- 已把 `AGENT_PROTOCOL_VERSION` 移至独立 owner，公开 barrel 继续导出同一常量，validator 的运行时依赖直接指向该 owner、合同 shapes 改为显式类型导入。
- 已扩展 architecture checker：覆盖 `src` 与 `packages` 下生产 TS/JS 模块，排除测试/声明文件和纯类型边，保留静态值导入、值 re-export、require 与动态 import；依赖解析采用 TypeScript 当前配置，继续运行 domain 与 worker 边界检查。
- Architecture owner tests 覆盖 type-only exclusion、value/dynamic/CommonJS edges、直接/三节点间接 cycles、自环和无环图；最终架构门禁 5/5，生产模块图无 runtime cycles。
- 最终回归通过：`pnpm check`（含 root/contract/worker TypeScript、packaging 与 Pi compatibility/permission fixtures）、`pnpm test:unit` 442/442、`pnpm lint`、`pnpm format:check`、`pnpm build` 和 `git diff --check`；规划、发现、进度与新增 owner fixtures 的 Prettier 检查通过。构建仍有既有 >500 kB chunk warnings。
- 此切片只调整 contract owner、JS/TS architecture checker 和验证文档；Host 授权路径与 Pi-only runtime 没有改动，compatibility fixtures 保持通过。
- 复核仍为 `beta...origin/beta`，HEAD `4eddef67`；`package.json`、`Cargo.toml`、`tauri.conf.json` 版本一致为 `0.4.0-beta.2`。累计工作树改动完整保留；没有 commit/push/publish/release/main sync。slice 133 完成，全仓结构性治理继续进行。

### 第 134 切片前：Pi resource scanner owner 审计（完成）

- 当前最大 worker owner 候选中，`resource-discovery.ts` 除共用 root trust/Host manifest validation 外，还实现 recursive Skill traversal 和 flat prompt Markdown selection；两者有独立的 change surface 与输入 bounds。
- 已选择 slice 134：只提取 Skill 与 prompt 扫描 pipeline；共享 root membership、symlink/canonical path、Host env snapshot 与 plugin-root policy 不移动、不复制。现有 tmpdir fixtures 已验证关键行为，compatibility checker 需随真实职责 owner 一并拆分。

### 第一百三十四切片：Pi Skill / prompt discovery owners（完成）

- 将递归、depth/byte-bounded、支持 Host ignore prefixes 的 Skill scanner 移入 `skill-discovery.ts`；将只接受 direct-child Markdown、按 disabled stem 和 byte/path bounds 过滤的 prompt scanner 移入 `prompt-discovery.ts`。
- `resource-discovery.ts` 保持共享 root owner：Host worker environment root specs、project/user/plugin root construction、trusted membership、canonical/symlink checks、ignore-prefix normalization 和 explicit environment snapshot validation 仍只在此处实现。
- 更新 session adapter 直接依赖 Skill/prompt owners，resource policy snapshot 继续经 root owner；更新 `check-pi-compatibility` 与 manifest compatibility assertions 分别读取三个真实所有者，锁住 env fields、limits、plugin/ignore/path rules。
- 资源 owner 与 snapshot targeted tests 10/10；`pnpm check:pi-compatibility` 101/101；`pnpm check:architecture` 5/5 且 production graph 无 cycles。
- 完整回归通过：`pnpm check`、`pnpm test:unit` 442/442、lint、format check、生产 build 和 `git diff --check`；构建只有既有 >500 kB chunk warnings。Host 授权流程、PI-only runtime、resource bounds/path semantics 不变。
- slice 134 期间 worker 类型检查先发现一个未使用的 prompt import 和一个错误环境变量引用，Pi compatibility fixture 首轮缺少 Skill owner `realpathSync` marker；均已修复并由最终全量 gates 覆盖。
- 最终复核仍为 `beta...origin/beta`、HEAD `4eddef67`；三处发布版本一致为 `0.4.0-beta.2`，累计工作树现有 77 个 tracked modifications 与 108 个 untracked artifacts 均保留。没有 commit/push/publish/release/main sync；全仓治理继续 in_progress。

### 第一百三十五切片：goal module 实际 owner 审计（开始）

- 续接前复核当前 authoritative tree：仍为 `beta...origin/beta`、HEAD `4eddef67`，发布版本三处一致 `0.4.0-beta.2`；既有大量 tracked/untracked 工作保持原状，catch-up 脚本无待同步报告。
- 重读阶段计划与发现后，确认 `goal-extension.ts` 内存在独立的 state/policy 纯逻辑、guard projection 与 Pi lifecycle 注册；真实调用者分别是 resource policy snapshot、compaction extension 和 session adapter。选择按真实 caller/变更理由拆 owner，而非按文件长度机械切割。
- 完成 slice 135：domain state/policy operations 与 deterministic guards 分别移至 `goal-state.ts`、`goal-guards.ts`，Pi event/tool lifecycle 留在 `goal-extension.ts`；compaction 与 policy snapshot 接入 state owner，compatibility source markers 随实际职责更新。
- 测试边界同步拆开：新增 state 与 guard owner tests，adapter suite 保留三项既有 integration 并新增 command lifecycle delegation test；worker/root manifests 已更新。
- 首轮定向验证暴露 compaction compatibility helper 仍假定 goal reconstruction 位于 `goal-extension.ts`，修正为 state owner 后 fixtures 101/101 通过；随后 final unit 446/446、`pnpm check`、lint、worker/touched Prettier、architecture 5/5、build 和 `git diff --check` 全通过。首次格式检查的四个文件已按格式化命令修复。
- 最终复核在 `beta...origin/beta`、HEAD `4eddef67`，版本 trio `0.4.0-beta.2`。累计保留原工作树，81 个 tracked modifications 与 112 个 untracked paths；无 commit/push/publish/release/main sync。slice 135 complete，全仓治理目标继续 in_progress。

## 当前会话：slice 136 开始

- 用户重申 `AGENTS.md` 工作流：仅 beta 开发、不得擅自 main 同步/正式发布、三个版本必须一致；当前复核仍为 `beta...origin/beta`、HEAD `4eddef67`、版本 `0.4.0-beta.2`。
- 重读 `codebase-design`、`planning-with-files-zh` 与项目计划/发现/进度；memory 的 MelodyWork 范围与 Pi-only/Host authority 提醒也已核对。
- session-catchup 直接执行因无执行权限失败；改用 `python3` 调用后成功且无待同步报告。首次规划 patch 锚点猜测失败且未改文件，随后读取准确尾部并记入 slice 136 错误表。
- 只读审计发现 session adapter lifecycle tests 直接写入内部 session map；选择窄 `loadPiSdk` 注入作为下一个候选 seam，先用公开 open/submit/cancel 测试证明覆盖能力，不注入通用 ports、不触碰 Host authority。
- 先按 TDD 添加可选 loader 红测：旧构造函数忽略注入并用生产 SDK 开会话，断言因此按预期失败；随后 constructor seam 实现后同测转绿。
- `PiSessionAdapter` 现在接受可选 `loadPiSdk`，默认路径完全保持原 loader；`openInternal`/fork 和 child runtime 共用该依赖。新增 fake session harness 仍使用真实 Pi SDK 的 session manager、resource loader 与 settings manager，仅替换 session 创建 adapter，并把模型文件/网络环境限制在临时目录和离线模式。
- 通过公开接口重写七组测试：Host resource refresh、active-run defer、Host model credential settings refresh、configure transaction、stale steer vs cancel、cancel-before-replacement 与 concurrent cancel coalescing。测试不再写 session map 或篡改 runFinished；model-catalog runtime stub 仍留在 credential integration test。
- 初轮 session adapter 测试 21/24：三处 run event 断言包含了 open lifecycle 事件；过滤 `run.*` 后定向 suite 24/24、worker typecheck 通过。
- 最终验证：worker 173/173、完整 unit 447/447、Pi compatibility 101/101、architecture 5/5、`pnpm check`、lint、format、production build 和 `git diff --check` 全通过。Build 有既有 >500kB chunk warnings。
- 最终复核仍在 `beta...origin/beta`，HEAD `4eddef67`，版本 trio `0.4.0-beta.2`；未触碰 main/发版/commit/push/publish。切片 136 完成，全仓长期可维护性目标继续 in_progress。

## Slice 138: Host sandbox profile resolution owner

- Moved `SandboxProfile`, canonicalization, state/temp directory selection, built-in aliases, custom TOML parsing and precedence, and deny path/tilde/glob projection into `src-tauri/src/workspace_sandbox/profile.rs`. Parent keeps Host fail-closed policy, read-only/read-write/device overlap checks, platform selection, Tauri authorization/preflight and common shell-command assembly.
- Preserved the parent `resolve_profile` re-export and platform adapters' `SandboxProfile` path. Profile resolution now snapshots process values once, with early return for missing/off profiles before reading the environment.
- Added three owner tests with explicit private environment snapshots and temporary user/project config. Parent decision tests now use normalized profile fixtures for glob/overlap cases; no sandbox test reads actual user configuration.
- Rust checks: sandbox subtree 12/12, full library 357/357, `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` clean, Rust format check passed.
- Project checks: `pnpm check` passed with 101 Pi/Tauri compatibility fixtures; `pnpm test:unit` 449/449; architecture 5/5; lint, format check and build passed. Build has existing >500 kB chunk warnings.
- Initial profile tests exposed a macOS `/tmp` alias mismatch in fixture paths; canonicalizing each fixture workspace fixed the test without changing production path semantics. A few patch-anchor attempts failed safely; no unrelated files were touched.
- Platform evidence is bounded: Seatbelt command shape/profile projection tested; sandbox execution remains blocked by the outer environment, and Linux Landlock integration was not run on this macOS host.
- Final source rerun caught a forwarding type mismatch in the new early-return wrapper (`&str` versus `Option<&str>`); wrapped it with `Some(...)`, then Rust 357/357, cargo check, formatting, `pnpm check` and diff checks passed. Final repo check remains `beta...origin/beta` at `4eddef67` with all three release versions aligned at `0.4.0-beta.2`.

## 2026-10-12：继续 owner 审计（第 139 切片进行中）

- 重读 `codebase-design`、其 `DEEPENING.md` 与 `planning-with-files-zh`；关键约束仍是用窄 interface 测行为、避免新增浅层转发，并同步维护三个规划文件。项目 memory 再次核对 Pi-only/Host authority、beta 约束与 #138 sandbox owner 的验证边界。
- 当前 branch 为 `beta...origin/beta`，HEAD `4eddef67`，package/Cargo/Tauri 版本一致 `0.4.0-beta.2`；session catch-up 无输出。81 个既有 tracked modifications 和累积 untracked work 全部保留。
- 精读 `PiWorkerRuntime::spawn_readers` 及相关 owner，确认 reader 的持久化-before-delivery、duplicate/dedupe、dispatch ack、Host permission/tool 路由和 generation teardown 顺序。由于其要协调多个既有 owner、没有窄的二适配器 interface，本轮拒绝迁移源代码，记录为当前不拆分候选。
- 首两次规划补记因 Markdown 反引号字面转义和跨文件 progress 锚点未命中而安全失败，均未改动规划文件；第三次改用每个文件真实尾行作为锚点并依次追加。
- 下一步继续审计 Pi compatibility 聚合脚本与已经提取的 fixture owners；只在发现脚本还拥有真实重复行为、且新 interface 能减少 callers/tests 必须知道的事实时才选新 slice。

- Final audit-note verification: Prettier formatting/check and `git diff --check` passed for the planning update; `rg '^+'` found no accidental leading diff prefixes. Reconfirmed `beta...origin/beta`, HEAD `4eddef67`, and all three versions `0.4.0-beta.2`. No source or tests changed.

- 最终候选排序的第一次 patch 因 raw-template 反引号语法错误未执行；随后目标路径多写了一级 `Project` 被拒绝。两次均未触碰文件；用反引号占位符和校正后的当前工作区路径重新应用成功。

## 第 139 切片：候选排序更新

- 当前 manifest 明确 `worker.engine=pi`、`runtimeFallback=none`；session adapter 的实际 `PI_CAPABILITIES` 声明 engine/version/protocol/tools/limitations/diagnostics，聚合器会通过 Node 子进程真实导入并比较工具集合。
- 当前搜索未发现 compatibility checker 自身的 fixture suite；worker 层测试覆盖实际能力与工具行为，但不覆盖该 migration manifest gate 对声明漂移/ACP fallback 的诊断。
- 将纯 Pi runtime/capability contract 列为优先只读候选，高于 generic gateway wiring。保留真实能力对象 probe 在聚合器。遵循用户“继续只审计”，不写测试或源码。

## 第 139 切片审计收尾

- 复核 `config_marketplace_native.rs`（1114 行）后暂不拆分：剩余命令编排共享已抽出的 catalog/transport/registry/filesystem/plugin-source owners；`install_snapshot` 的真实临时目录事务有成功路径 integration tests，单独搬成 50 行 owner 尚无新增 leverage。
- 复核 `pi_monitor_runtime.rs`（947 行）后不拆分：这是一个完整 Host monitor lifecycle owner，process/limits/events/ownership/cancel/snapshots 共享一个 registry，ToolGateway adapter 已在 `monitor_tools.rs` 分离；现有测试覆盖 sandbox、自动限流停止和 cancel/tail。
- slice 139 只读审计完成：`spawn_readers` 不形成窄 owner；兼容脚本内部 Pi runtime/manifest capability policy 是当前最高优先候选，generic ToolGateway wiring 次之。按用户选择未写任何 tests/源码，只维护规划证据。
- 阶段 3 与长期全仓结构治理仍 in_progress；下一次继续基于当前 authoritative tree 审计候选，不把候选排序当作完成目标。

## 第 139 切片：Pi-only runtime capability contract audit

- Read the full inline gate. It verifies package/manifest versions, advertised engine/protocol/tools, live `PI_CAPABILITIES` tool set, `runtimeFallback=none`, absence of ACP/legacy fallback claims, and accurate Browser limitations.
- The gate is mixed with one real Node subprocess; any later extraction should leave that live capability probe in the aggregate workflow and move only pure policy checks behind a fixture-tested seam.
- This is currently a stronger semantic candidate than gateway wiring, pending manifest and existing-test coverage audit. The user asked for continued audit only; no implementation or tests were started.

## User direction: continue audit only

- User asked to continue read-only audit instead of implementing the generic ToolGateway seam. Deferred all tests and source changes.
- Next inspect the Pi runtime/manifest/capability block as a separate candidate and compare its real caller inputs, policy cohesion, and test seam.

## Slice 139：generic ToolGateway seam selected, awaiting confirmation

- Reviewed the complete generic gateway ownership block and downstream snapshot uses. The reusable group validates Host module/dispatch ownership and worker gateway composition/owner imports; feature-specific manifest checks remain elsewhere.
- Proposed fixture seam takes grouped Host and worker source snapshots and returns compatibility diagnostics. Top-level source reads/error handling and real worker capability execution stay in the aggregate gate; existing per-feature compatibility owners remain untouched.
- Read TDD skill and required references plus `CONTEXT.md`; project terms use Agent Session and source-snapshot gates. The skill explicitly requires confirming test seams before writing tests, so implementation is paused for user input. No source code or tests changed.

## 第 139 切片：compatibility aggregator audit update

- Initial scan confirms scripts/check-pi-compatibility.mjs is a 2,300-line executable that imports 14 feature/contract checkers but still owns many direct source reads and inline cross-owner marker checks.
- Next candidate to inspect is the remaining generic worker/Host ToolGateway wiring group: likely common tool identity, schema/request-policy ownership and Host gateway dispatch, excluding feature-specific checkers that already have owner-local fixtures. No source changes or candidate commitment yet; inspect the full block and call/test surface first.
- A planning update script first had a JavaScript syntax error before execution; then a generated patch wrote literal plus prefixes into the newly appended notes. Corrected all three files immediately with an exact source-derived patch; no source files were touched.

## 2026-10-12 — Pi runtime capability gate audit (read-only)

- Revalidated `beta...origin/beta`, HEAD `4eddef67`, and package/Cargo/Tauri `0.4.0-beta.2`; `session-catchup.py` returned no unsynchronized report. Preserved the accumulated dirty worktree.
- Audited the current 1,924-line compatibility entrypoint, manifest/package inputs, CI invocation, 16 existing owner fixture suites, and the actual `PI_CAPABILITIES` probe. Ranked a narrow pure structured-data policy checker above the generic ToolGateway wiring markers; keep real runtime probing and aggregate filesystem/error handling at the entrypoint.
- Bound the evidence: capability-set parity checks declarations, not runtime tool registration or Host authorization/sandbox enforcement. No source or tests changed, consistent with the user’s audit-only direction.
- Repaired the earlier misplaced Slice 139 addenda in task_plan.md/findings.md/progress.md. An initial combined patch failed its expected-context match without changing files; switching to exact-block removal followed by EOF insertion succeeded. Prettier and `git diff --check` pass after formatting.

- Ran `pnpm check:pi-compatibility` as an existing read-only gate: formatting clean; 101/101 fixture tests passed; final `Pi compatibility and Tauri command permission checks passed.`

- The final appended gate result initially triggered Prettier warnings in task_plan.md/findings.md; ran Prettier --write and rechecked clean.

## 2026-10-12 — Pi tool-registration parity audit (read-only)

- Current-state crosswalk: root session supplies subagent/task-controller dependencies to `PiToolGateway.createTools`; the resource loader registers goal and (outside read-only capability mode) todo extensions. `PI_CAPABILITIES.tools` and event mapping share the static `PI_GATEWAY_TOOL_NAMES` list.
- Ran a no-write Node probe: root-shaped `createTools` returned 42 unique names, exactly equal to the 42-name list. The separately tested extension registrations (`todo_write`, `update_goal`) make the composed capability union 44 names, exactly equal to the advertised list. Targeted owner suites passed 37/37.
- No current owner test compares the full registered root tool union to `PI_CAPABILITIES.tools`; source-marker checks in the migration gate do not establish runtime registration parity. Re-ranked this composition-level test boundary above pure manifest-policy extraction; no code/tests changed due audit-only direction.

- Further seam check: local Pi SDK declarations expose loaded extension tool maps, and the existing `PiSessionAdapter` harness already injects `createAgentSession` while retaining the real `DefaultResourceLoader`. Capturing SDK options can test the actual root registration union without a new production port.
- Lookup note: root-level `require.resolve` could not see the worker-local Pi dependency; resolving through `packages/agent-worker/node_modules` worked. A broad scan included bundled source maps and truncated; narrowed to exact `.d.ts` declarations. No repository code changed.

- Confirmed the remaining root-injected extension factories (instruction-scope and compaction) do not call `registerTool`; only todo and goal add model tools. With built-in tools disabled in the root Pi session, the proposed full-set assertion can use the public gateway list plus loaded extension tool maps.

## 2026-10-12 — Slice 140: root Pi tool registration parity contract

- Revalidated `beta...origin/beta`, package/Cargo/Tauri versions `0.4.0-beta.2`, and `session-catchup.py` (no unsynchronized report); preserved the existing dirty tree.
- Extended the existing session-adapter test harness to capture only the `createAgentSession` options already crossing its injected SDK seam. Added a root-session test that reads the real loaded `DefaultResourceLoader` extension tool maps, combines them with `customTools`, rejects duplicate names or extension-load errors, and compares the set to both `options.tools` and `PI_CAPABILITIES.tools`.
- The focused session-adapter suite passed 25/25; full worker suite 176/176; full unit suite 450/450; `pnpm check` passed with 101/101 compatibility/permission fixtures and the live aggregate gate; architecture tests 5/5; lint, Prettier, build, and `git diff --check` passed. Build retains existing >500 kB chunk warnings.
- Evidence is limited to the Pi SDK options supplied by Melody plus the real loader's public extension declarations; `createAgentSession` remains fake in this harness, so this does not execute a provider turn or inspect Pi's post-construction internal registry. Existing owner tests cover individual extension registration.
- No Rust source changed; no version changes, commit, push, release, or main sync. Full structural-debt goal remains active/incomplete.

## 2026-10-12 — Slice 141: Pi compatibility gate input validation

- The user confirmed the CLI integration test seam. Wrote a regression first; its red run reproduced exit 0 when `packages/agent-worker/package.json` read as valid JSON `null`.
- Added `readJsonObject` so the manifest and worker package roots must be non-null, non-array objects. Invalid/missing manifests now flow to the final aggregate failure report instead of crashing at the earlier `hostBridges` scan.
- Added five CLI integration cases: worker package `null`/`false`, manifest array/`null` roots, and malformed manifest JSON. The tests replace one file read in memory and keep the real runtime capability probe.
- Added the entrypoint tests to `check:pi-compatibility` formatting and test lists. The focused gate passed 106/106 fixtures and the live aggregate check; `pnpm check`, `pnpm test:unit` (450), `pnpm lint`, `pnpm format:check`, and `pnpm check:architecture` (5) passed. These script-only changes did not require a production bundle build.
- No Pi runtime semantics, Host permission authority, release versions or product behavior changed. Preserved the existing dirty beta tree; no commit, push, publish, release or main sync. The full structural-debt objective remains active/incomplete.

## 2026-10-12 — Slice 142: subagent configuration owner audit

- Rechecked the authoritative checkout: `beta...origin/beta`, all three release declarations at `0.4.0-beta.2`, and no planning session catch-up report. The pre-existing dirty tree remains untouched.
- Audited `config_subagents.rs` source groups, consumers, parser/prompt subowners and tests. The module's size reflects multiple projections of the same subagent-config domain; the parsing and plugin visitation paths are already shared, while Pi policy and Settings inventory deliberately return different data.
- Kept workspace authorization in `list_melody_agent_definitions` and found no safe, deep extraction that reduces duplication without either discarding Pi policy payloads or making Settings compute unused policy. No code/test changes this slice.
- One status command had a shell-quoting error; version verification was rerun with direct source reads. Candidate audit is complete; next continue the structural review with an independent runtime owner, preserving the full goal and beta-only constraint.

## 2026-10-12 — Slice 143: Pi worker reader-loop audit

- Inspected the current worker reader implementation and owner-local tests. The critical event path spans generation acceptance/readiness, Host workspace validation and event-log persistence, memory/schedule observation, async Host hook and permission/tool routing, then renderer delivery.
- Existing tests cover protocol/event acceptance as pure owners but not the reader's side-effect order or generation failure path. A broad search found no Tauri mock-app harness or controllable worker fixture in the current Rust tree; an initial scan referenced a nonexistent `src-tauri/tests` path and was corrected.
- The user selected a narrow event coordinator + fake port. A six-case regression suite was written first and failed against the placeholder, then the implementation was added without changing Host authorization, persistence policy, worker protocol, or runtime routing.
- The implemented owner covers persistence-before-publication, both duplicate paths, old replay arbitration, sequence/unknown-session rejection, storage failures, and invalid protocol acceptance. Full Rust library tests pass 366/366; nine focused tests, `cargo check --lib`, Rust format, planning-doc format, and `git diff --check` pass. This remains adapter-level contract evidence, not live renderer/process integration.
- No commit, push, release, or main sync. Slice 143 audit and slice 144 implementation are complete; full structural-governance goal remains active.

## 2026-10-12 — Slice 145: database session/project cleanup audit

- Compared the session-scoped cleanup helper with project deletion SQL and their lifecycle callers/tests. Both own the same agent-state families, but duplicate the table cleanup policy with different scope predicates.
- Found a concrete candidate to centralize SQLite-only cleanup while preserving caller-owned transactions, permission-rule behavior, process shutdown, and Pi JSONL deletion. Existing tests cover only a subset of the dependent rows.
- The user selected extraction of a shared cleanup owner. The implementation will keep transaction control, project-only permission rules, parent-record deletion, worker shutdown and Pi artifact cleanup with their existing owners.
- Revalidated `beta...origin/beta` and all three release declarations at `0.4.0-beta.2`; retained the existing dirty tree. Added four direct owner-interface tests over all seven dependent row families, cross-scope fork lineage, permission-rule ownership and caller-controlled rollback. The fixture disables SQLite foreign-key enforcement to exercise legacy orphan cleanup.
- TDD red baseline: all four tests fail against no-op owner functions because rows remain; the failure occurs at the first timeline-row assertion, as expected. The initial glob visibility warning was resolved with an explicit crate-private re-export.
- Implemented `database_agent_cleanup.rs`, moved both seven-statement cleanup policies into it, preserved the existing crate-level session helper path with explicit `pub(crate)` re-export, and wired project deletion to the sibling owner. Project-only permission cleanup, parent-row deletes, transaction/commit, worker shutdown and Pi-file lifecycle remain in their prior owners.
- Removed the former session-local helper test after replacing it with owner-interface coverage; retained project deletion integration coverage. Focused Rust owner suite now passes 4/4, including scope isolation, both fork endpoints, permission-rule non-ownership and rollback for both helpers. The expected red baseline and temporary no-op glob visibility warning are recorded above; the warning is resolved.
- Full Rust library suite passes 369/369 (365 other library tests plus the four new owner tests). Next verify warning-free `cargo check`, Rust/doc formatting, diff integrity, and the final branch/version/worktree state.
- `cargo check --locked --lib` passes. Initial final checks found only mechanical formatting issues in the new Rust file/import order, the plan table, and a trailing blank line; targeted formatters corrected them. Diff review also verified the separate lifecycle extraction already present in the dirty tree was preserved.
- Final checks are green: Rust library suite 369/369, focused cleanup owner suite 4/4, `cargo check --locked --lib`, `cargo fmt --all -- --check`, Prettier on all three planning documents, and `git diff --check`. `beta` and the three `0.4.0-beta.2` declarations remain unchanged; no commit, push, publish, release, or `main` sync. Slice 145 is complete, while the full repository-governance objective remains active.

## 2026-10-12 — Slice 146: next core runtime owner scan

- Final verification is green: `pnpm check`, worker tests 180/180, root unit tests 454/454, compatibility tests 107/107, lint, `pnpm format:check`, `pnpm build`, and `git diff --check`. Branch remains `beta...origin/beta` and package/Cargo/Tauri versions are all `0.4.0-beta.2`.
- Next candidate audit: compare duplicate legacy billing-usage parsing in `session-projection-updates.ts` with the existing `domain/agent/billing-usage.ts` owner. I asked the user to confirm this seam before writing tests, as required by the TDD workflow; no code/test change for slice 147 has begun. Timeline mutation/context window usage stay with the projection owner.
- The owner is wired without moving Pi/Host task routing or Host authorization. Worker tests passed 180/180; root unit tests 454/454; lint, Prettier, and `git diff --check` passed. The first root `pnpm check` caught a stale parent import and an old event-pipeline checker assumption; the import is removed, and the checker now targets `event_pipeline.rs` with a CLI regression test (107 compatibility tests pass). Re-run the complete root check after these fixes.
- Added direct fake ToolGateway/context tests and extracted `HostTaskControl` plus snapshot validation. The initial no-op baseline failed all four tests as expected. After implementation, three passed; one test incorrectly treated the previously accepted empty array as malformed, so it now asserts the existing empty-array behavior and reserves errors for invalid JSON/objects/status.
- Recovered the active governance plan and confirmed session catch-up is empty. Current tree remains `beta...origin/beta`, with package/Cargo/Tauri versions aligned at `0.4.0-beta.2`.
- A current LOC scan surfaced `session-adapter.ts` (1,770), `pi_tool_gateway.rs` (1,531), and `subagent-runtime.ts` (1,286) as candidates only. Next inspect call graphs, current owner splits, and tests before selecting or rejecting a seam.
- A structure scan shows `pi_tool_gateway.rs` is mostly a substantial embedded test suite after line 375 and already has eight child owners, so its raw line count is misleading. `session-adapter.ts` is a single main consumer-facing facade with many extracted policy/resource/lifecycle owners; `subagent-runtime.ts` also has existing policy/records/boundary/task owners. Continue with method-level ownership review, not a size-driven move.
- Method-level review found a narrower `PiSubagentRuntime` seam: host terminal task-control requests and response parsing are mixed into the Pi child-task runtime, while actual process state and final authorization remain in Host `ToolGateway`. The large `spawnSubagent` workflow itself appears cohesive; next verify parser callers and direct test placement before deciding whether to extract only the Host adapter.
- Confirmed the snapshot parser is used by the Host bridge and has direct assertions only in the much larger `session-adapter.test.mjs`; `session-adapter.ts` and `subagent-runtime.ts` re-export it for compatibility. Both `packages/agent-worker/package.json` and root `package.json` use explicit test file lists. Selected a Host task-control adapter seam, keeping task-provider routing and mixed Pi/Host validation in `PiSubagentRuntime`; next build direct fake-gateway tests before moving implementation.
- An initial combined patch failed to match the long root `test:unit` manifest line; verification confirmed it applied no files. This failure is recorded in the plan; continue with smaller isolated edits to preserve pre-existing package-script changes.

## 2026-10-12 — Follow-up audit: Composer and agent-store owners

- 基于最新转换表向用户提交了新的单项 seam 选择：优先 Workspace Surface 状态 owner、优先 billing parser，或继续审计。首个异步问题调用参数字段不符合工具 schema，未提交；改为 `title` 与 `options` 后成功提交，等待用户明确选择后再写测试。
- Revalidated the authoritative checkout as `beta...origin/beta`; `package.json`, Cargo and Tauri versions remain aligned at `0.4.0-beta.2`. Preserved the existing dirty tree.
- Compared the single-consumer `agent-composer.tsx` with the existing store architecture. Composer's UI state and controls form one interaction owner and already delegate draft persistence/model grouping; the agent store is already a facade over session, receive, submit, Pi, interaction and configuration owners. No extraction was selected because a new module would likely expose a broad/shallow props or state interface.
- Audited `use-agent-bridge.ts` and its only caller. It coordinates archive detection, capability preflight, event subscriptions, worker startup, session open and teardown in an ordering-sensitive flow; the available nearby tests do not yet cover that lifecycle through an injectable interface. Marked it as a stronger follow-up candidate, but deferred code/test edits until its seam is explicitly agreed.
- Audited `agent-workspace-actions.ts` with its only caller and parent view state. It combines cross-surface transitions for Settings, workspace tabs, Research, New Task, and session history; those transitions mutate independently-owned booleans that the view resolves by precedence. A pure surface-transition owner could centralize this invariant more deeply than splitting callbacks, but its state/action contract needs user confirmation before writing tests.
- Verified the exact precedence and exceptions: `primaryViewKey` is `new-task > workspace-start > research > conversation`; opening Settings or Research does not always clear `newTaskOpen`, while changing workspace mode does. Research `skills` routes through Settings. Therefore a simple exclusive-surface union would alter current behavior; any reducer/test seam must encode the observed transition table first.
- Confirmed `agent-workspace.tsx` uses `primaryViewKey` for the motion key while `agent-workspace-view.tsx` independently repeats the screen-selection priority. Settings is a stage-level override and WorkspacePanel is an independent overlay. A pure `resolveWorkspaceSurface` projection could be the smallest shared interface that prevents render/key drift while retaining hidden underlying state; whether to expand it into a full transition owner remains a seam choice.
- Revisited the pending billing-parser seam. No user selection was present in this turn; no source or test files changed. The full structural-governance goal remains active.
- A zsh glob in the exploratory LOC command did not match `*.tsx`; it produced no required count and changed no files. The failure is recorded in `task_plan.md`; the audit relied on `rg` source/call graphs instead.

## 2026-10-12 — Current accumulated-work verification

- Revalidated the existing large `beta` worktree, aligned `0.4.0-beta.2` versions and empty planning session-catchup. No source/test edits were made during this verification.
- `pnpm test:unit` passed 454/454; `pnpm test:agent-worker` passed 180/180; `pnpm check` passed; `pnpm check:architecture` passed 5/5 fixtures plus live graph checks; lint, format and build passed.
- Rust library tests passed 369/369; `cargo check --lib`, `cargo fmt --all -- --check`, and `git diff --check` passed. Vite completed with existing >500 KB chunk warnings. This is broad regression evidence for the accumulated dirty tree, not desktop/target-platform acceptance or proof that all structural debt is gone.
- The Workspace Surface seam question remains pending; this validation establishes the baseline while continuing the broader audit, and does not mark the objective complete.

## 2026-10-12 — Workspace store audit

- Inspected the current 411-line store, its direct UI action consumer, state readers, deletion dialog, and workspace record types. Project/session operations form one aggregate because selection, per-project caches, fallback-session creation, and loading/error state are shared.
- Found no owner-local store tests. `selectProject` has an observable stale-completion risk when session data is uncached or empty: a slower earlier selection can unconditionally write after a later selection. Recorded as a testable behavior candidate, not a confirmed user-requested bug fix.
- Existing store diff contains prior Pi-only runtime/cleanup edits; preserved it. No source/test files changed in this audit. The seam-choice question remains pending; beta/version state remains as verified above.

## 2026-10-12 — Pi session bridge audit

- Rechecked the current 357-line `use-agent-bridge.ts`, `agent-store-session.ts` entry points, and tests. The hook already guards most stale continuations and stream callbacks, so a broad split would risk replacing one lifecycle with a shallow callback layer.
- Found one concrete gap: rejected `getPiCapabilityReport()` work writes blocking diagnostics and failed status without checking whether its React effect was disposed. A stale preflight can therefore surface an old session error after navigation. Recorded the ordered connect lifecycle as a stronger candidate than extracting isolated helpers.
- Verified test constraints from `package.json`: the root suite is an explicit Node native-test manifest and has no React hook renderer/DOM test dependency; no hook lifecycle test exists. A no-dependency path would test the connection coordinator through a small production/fake adapter interface, but that seam remains unconfirmed.
- No source/tests changed. The workspace-store latest-request seam question remains pending. Branch stays on `beta`, versions remain aligned at `0.4.0-beta.2`; the unsupported async-question field error was corrected and the question accepted.

## 2026-10-12 — Host/Pi authorization routing audit

- Traced accepted worker events through `event_pipeline.rs`, `host_tool_routing.rs`, and `pi_tool_gateway.rs`. Current source keeps workspace authorization, descendant checks, enforceable Host hooks, persisted deny/allow lookup, domain-specific permission checks, and ordinary tool policy at the Host side. No extracted owner bypass was found in this trace.
- Confirmed verification gap: `pi_tool_gateway.rs` has direct tests and `event_pipeline.rs` has fake persistence/order tests, but the 683-line `host_tool_routing.rs` has no direct test module; lower-level suites do not prove the combined authorization/dispatch sequence.
- Recorded the Host router as the highest-value structural testability candidate while preserving Host authority. No code or test change made pending an explicit interface/seam choice. `git status` remains beta with accumulated uncommitted files; branch/version trio verified earlier this turn.
- The generic two-axis code-review skill could not be applied faithfully because it requires a user-specified commit/branch fixed point and this worktree has only uncommitted/untracked changes at `beta == origin/beta`; performed a bounded current-source trace instead.

## 2026-10-12 — Pi ToolGateway request-policy test ownership

- Moved eight existing tests for request-policy parsing/classification and permission projection from pi_tool_gateway.rs into request_policy.rs. Assertions remain equivalent; production code and Host authorization are unchanged.
- Verification: request-policy 8/8, Pi ToolGateway 37/37, full Rust library 369/369, cargo check warning-free, cargo fmt --check passed.
- This Rust-only test relocation does not change frontend/runtime behavior; root unit/build were not rerun. Previous cumulative root unit/build gates remain the latest evidence for those unchanged areas.
- Open work remains: Host/Pi routing integration lacks a narrow selected test interface; the workspace-store latest-request seam still awaits user choice. The billing-usage parser candidate was later resolved in Slice 149 through the existing `applySessionUpdate` interface.
- No commit, push, release, or main synchronization; branch remains beta. Recheck current branch/version state after this documentation update.

## 2026-10-12 — Host routing seam audit

- Revalidated current beta dirty worktree, aligned 0.4.0-beta.2 versions, and clean diff whitespace state before this audit; preserved all accumulated changes.
- Re-read the current Host routing path. It validates the active root and descendant cwd before instruction preflight, then runs enforceable PreToolUse before persisted permissions, tool-specific permission gates and domain dispatch; resolution write precedes observational post-hooks.
- Confirmed that existing request-policy tests and event-pipeline fake-port tests do not cover the combined Host order. The highest-value candidate remains a Host routing coordinator exercised through production and recording adapters, with WorkspaceRegistry and persisted Host policy authority unchanged.
- No test or interface was added because the TDD skill requires the exact seam to be confirmed first. Asked the user to choose the Host coordinator, the previously proposed workspace-selection latest-request contract, or audit-only continuation.
- No release, commit, push, or main sync. All version declarations remain aligned on beta.

## 2026-10-12 — PiSessionAdapter residual audit

- Revalidated current dirty beta worktree and preserved accumulated changes; no code edits were made.
- Audited session-adapter ownership: 1,770 production lines compose already-separated ToolGateway, model catalog, subagent, policy, resource, persistence, and attachment owners; 1,198 lines of tests exercise the stable adapter interface.
- Root/child resource refresh shares Host policy snapshot semantics and defers mutation during active runs. Further extraction would currently require a wider callback interface or risk splitting that invariant. Pi event mapping is already separated; remaining event/run-state transitions stay coherent with the adapter lifecycle.
- Recorded the no-split decision in task_plan/findings. Host routing seam prompt remains unanswered; audit continues rather than treating silence as approval.

## 2026-10-12 — Slice 148: Pi session resource-loader owner

- Extracted the per-session Pi resource-loader implementation into `session-resource-loader.ts`: loader setup, disabled ambient discovery, first-party extension composition, scoped instruction seeding, and mutable Host-projected Skill/prompt path refresh.
- Kept `PiSessionAdapter` as the root/child factory and Host policy owner; kept root/child refresh order, active-run deferral, event/run-state coordination, and the public command/event interface unchanged. No Host authorization or Pi-only runtime routing changed.
- Updated `check-pi-compatibility.mjs` to check the new owner and adapter wiring; added two CLI-level regression tests. The first aggregate check correctly exposed the stale old-owner assumption, and passed after the checker followed the moved implementation.
- Verification: adapter 25/25, worker 180/180, root unit 454/454, compatibility 109/109, `pnpm check`, lint, format, production build, and `git diff --check` all pass. Build reports the existing large-chunk warning; no desktop/target-platform validation was claimed.
- Branch remains `beta`; `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` remain `0.4.0-beta.2`. No commit, push, release, publish, or `main` sync. Whole-repository goal remains active.

## 2026-10-12 — Resource-scanner owner-map reconciliation

- Corrected the stale scanner checklist and Pi migration handoff: shared Host root/path trust stays in `resource-discovery.ts`; Skill and prompt traversal belong to their existing dedicated scanner owners.
- Preserved the established combined direct-interface test suite and removed two temporary duplicate test drafts. No runtime code changed.
- Verification: `resource-discovery.test.mjs` 6/6; `pnpm check:pi-compatibility` 109/109 fixture tests and source checks; Prettier and `git diff --check` pass. Branch/version invariants remain `beta` / `0.4.0-beta.2`.
- Overall structural-governance goal remains active; this reconciliation does not claim whole-repository completion or desktop acceptance.

## 2026-10-12 — Billing usage normalization owner

- Moved camel/snake-case `AgentBillingUsage` decoding and validation from `session-projection-updates.ts` into the existing `agent/billing-usage.ts` owner. The parent still decides when turn-completion analytics are stamped and where they land in the timeline.
- Preserved the existing `applySessionUpdate` behavior interface and both existing test suites; no private parser seam or behavior change was added. Baseline focused tests passed 27/27 before the move.
- Post-change verification passed: `pnpm test:unit` 454/454; `pnpm check` (including TypeScript and Pi compatibility 109/109); `pnpm check:architecture` (5/5 fixtures plus live graph); `pnpm lint`; `pnpm format:check`; and `pnpm build`. Build completed with the existing >500 kB chunk warning.
- Branch and version invariants remain `beta` / `0.4.0-beta.2`; no desktop acceptance, release, publish, commit, or `main` sync is claimed.

## 2026-10-12 — Tool activity input/text owner

- Consolidated Host gateway input unwrapping and tool command/output text projection in the existing `tool-activity.ts` owner, alongside semantic activity extraction. `session-projection-updates.ts` no longer parses that payload shape itself and retains row lifecycle merge and timeline mutation.
- Added one owner-interface test covering nested Host gateway arguments plus content-block text precedence. Existing `applySessionUpdate` and `projectAgentEvent` integration tests continue to verify timeline behavior. Red baseline failed on the missing export; after implementation the focused projection/tool suite passed 55/55.
- Full verification passed: `pnpm test:unit` 455/455; `pnpm check` including Pi compatibility 109/109; `pnpm check:architecture` 5/5 plus live graph; lint, format, and production build. Build retains the existing >500 kB chunk warnings.
- This is a TypeScript domain projection change only; Pi-only runtime routing and Host security authority are untouched. Branch/version remain `beta` / `0.4.0-beta.2`; no commit, publish, or `main` sync.

## 2026-10-12 — Planning reconciliation and continuation check

- Reconciled `task_plan.md` with the already-recorded Slice 149 and 150 evidence in `findings.md`/`progress.md`; clarified that the earlier billing-parser seam was resolved through the existing `applySessionUpdate` interface while Workspace store and Host router seam choices remain open.
- Re-ran Prettier check for `task_plan.md`, `findings.md`, and `progress.md`, plus `git diff --check`; both passed. Confirmed the checkout remains `beta...origin/beta` and all three release-version declarations remain `0.4.0-beta.2`.
- No source behavior changed, and no release/publish/commit/merge/main synchronization occurred. The full structural-governance goal remains active and incomplete.

## 2026-10-12 — Workspace primary-view ownership audit

- Revalidated the current beta worktree, package/Cargo/Tauri version alignment, planning tails, and existing accumulated diff. No source changes were made.
- Confirmed `agent-workspace.tsx` computes the animated `primaryViewKey`, while `agent-workspace-view.tsx` separately repeats the same New Task > workspace-start > eligible Research > conversation conditions for content rendering. Settings remains a higher-level override and WorkspacePanel an independent overlay.
- Recorded a narrow candidate that would share only the view-key projection and preserve every state transition/hidden flag. No new tests or source edits until the user confirms this test seam; the broader state reducer is not selected.
- The workspace store's stale-selection and Host router integration seams also remain unselected. Continue the full audit; do not treat this candidate or prior slices as completion of the repo-wide objective.

## 2026-10-12 — Pi-only fallback-language consistency

- Wider source and migration-doc search found two additional active comments claiming that subagent inventory shadowing and rich semantic Memory consolidation could fall back to ACP. Current code instead uses precedence-based effective inventory and reports configured vector/dream Memory as unavailable in Pi.
- Updated the shared AgentGoalPolicy, subagent inventory, and Pi memory comments. Kept the deprecated `fallbackEngine` field unchanged for compatibility and preserved explicitly historical migration text.
- Added a supersession note to the dated 2026-10-05 acceptance snapshot: its ACP fallback statement for embedding/vector/dream was replaced by the 2026-10-11 Pi-only decision. Historical test counts remain untouched.
- Verification passed: root `pnpm check` (including TypeScript, agent-contract, packaging and Pi compatibility 109/109), `pnpm format:check`, and `git diff --check`. Full unit/build not rerun because the source edits are comments and the acceptance edit clarifies a dated record.
- Workspace primary-view test seam remains pending user confirmation; repo-wide governance remains active and incomplete.

## 2026-10-12 — Context-usage ownership audit

- Revalidated the accumulated worktree on `beta`, the aligned `0.4.0-beta.2` package/Cargo/Tauri versions, and clean diff whitespace state; preserved all existing uncommitted changes.
- Traced `parseSessionContextUsage` from `session-projection-updates.ts` into both `applySessionUpdate` and `agent-store-parsing.contextUsageFromResult`; compared its responsibilities with context restoration in `session-projection-persistence.ts` and billing normalization in `billing-usage.ts`.
- Recorded a candidate ownership seam and a bounded testing gap. Scope remains uncertain because context usage spans wire decoding, result precedence, and persisted timeline behavior; no source or test changes were made and no new test interface was assumed.
- Continuation revalidation: planning catchup reported no unsynchronized session state; the current `session-projection-updates.ts` diff matches the already-recorded billing/tool-text ownership slices, while `agent-store-parsing.ts`, the projection facade, and its integration test remain unchanged. No overlapping edit was made.
- A separate Rust test-ownership audit found that `workspace_tools.rs` is an extracted 1,091-line owner without a local test module, while the small `pi_tool_gateway.rs` facade still contains many workspace-operation tests. Recorded a candidate to classify those tests before any move, explicitly keeping Host authorization/dispatch coverage at the facade.
- Re-read the context-usage callers and current test files. Kept the existing parser in the projection owner: extracting only the 48-line normalizer would be shallow, while combining result precedence, model fallback, and timeline persistence would make a broad interface. Confirmed existing `agent-session-routing.test.mjs` and `melody-bridge-acp.test.mjs` already exercise Desktop Pi-only routing and browser-preview fixture behavior through the established interfaces.
- Asked whether to relocate only workspace-tools owner-behavior tests while retaining facade-level Host authorization/dispatch tests. The first asynchronous question call used an unsupported field and was rejected; the corrected question was accepted. No answer has arrived in this turn, and no tests have been moved.
- Current-state verification: `pnpm test:unit` passed 455/455; `pnpm check` passed (including Pi compatibility 109/109); `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` passed 369/369, with the focused `pi_tool_gateway::tests` baseline at 27/27. Planning-file Prettier and `git diff --check` also pass. No runtime code changed in this turn.
- No release, commit, push, publish, merge, or `main` synchronization. The broader structural-governance goal remains active and incomplete.
- Verification after the planning update: `pnpm exec prettier --check task_plan.md findings.md progress.md` and `git diff --check` both passed; current branch and all three release-version declarations still match `beta` / `0.4.0-beta.2`.
- Tool error: an initial planning-record patch used an outdated `progress.md` tail anchor and failed without applying; reread current tails and reapplied with the exact current line.

## 2026-10-12 — PiSessionAdapter seam and plan-status reconciliation

- Revalidated the previously selected PiSessionAdapter command/event test seam against current files: the public lifecycle tests do not access private session/task maps or private wait/cancel methods; the boundary owner has its own focused tests and runtime imports.
- Reconciled stale `(进行中)` headings for slices 127, 128, 130, 136, 137, and 138 with their fully checked lists and explicit completed status lines. Relabeled Slice 139's worker stdout item as a completed read-only audit while keeping the overall structural-governance phase active.
- No source code or tests changed. The separate ToolGateway workspace-test ownership seam remains awaiting the user's answer; Host authorization/dispatch tests stay at the facade.
- Final record checks after reconciliation: planning files pass Prettier and `git diff --check`; the remaining unchecked items are the broad continuing objective and still-unselected seams, not stale completed slices.

## 2026-10-12 — Pi persisted-fork owner (Slice 151)

- Revalidated current checkout on `beta...origin/beta`, aligned `0.4.0-beta.2` version trio, and preserved the accumulated dirty worktree.
- Audited the remaining `PiSessionAdapter` responsibilities. Kept refresh and event/run-state coordination in the facade; extracted the cohesive persisted branch workflow to `session-fork-runtime.ts` behind the established `PiSessionAdapter.fork()` command/event seam.
- Added an end-to-end command-interface test covering persistent branch creation, independent native-session path, unchanged source leaf, and target `session.opened` event. Pre-extraction adapter baseline passed 26/26; post-extraction adapter suite passed 26/26, worker suite 181/181, root unit suite 456/456, `pnpm check` including Pi compatibility 109/109, architecture 5/5, lint, format check, production build, and `git diff --check`.
- Tool errors: initial broad patch did not match the current method block and made no change; smaller patches succeeded. The first focused test run failed because Node's strip-only TypeScript mode rejects parameter properties; explicit assignment fixed it. Prettier reported an adapter import-format difference, then the final formatting check passed.
- No commit, push, publish, release, main synchronization, or version change. The broad structural-governance objective remains active/incomplete.

## 2026-10-12 — Pi session-import transaction owner (Slice 152)

- Revalidated current dirty checkout on `beta...origin/beta`, aligned `0.4.0-beta.2` release declarations, and preserved all pre-existing changes.
- Audited the Host-to-Pi import workflow: `session-import.ts` already owns plan validation and atomic JSONL writes, while `PiSessionAdapter` still mixed replacement lifecycle, backup materialization, reopening, and Host journal event ordering. Extracted that transaction to `session-import-runtime.ts`; the adapter retains its public command seam, source-session queue, and original close/open paths.
- Added a characterization test through `PiSessionAdapter.importSession()` before extraction, then reran it afterward. It verifies explicit backup, fresh native ID, no `session.closed`, and `session.imported` -> `session.opened` -> `runtime.warning` order. The initial fixture failed because it had not persisted a preexisting native file; adding one valid user entry made the baseline valid.
- Validation: adapter suite 27/27, worker suite 182/182, root unit suite 457/457, `pnpm check` including Pi compatibility 109/109, architecture 5/5, lint, format, production build, and `git diff --check` all pass. Build retains the existing >500 kB chunk warning.
- Tool errors: first combined docs patch did not match task-plan context and made no changes; per-file patches succeeded. The initial backup assertion failed on an empty fixture as described above; formatter and all final gates passed after correction.
- No commit, push, publish, release, main synchronization, or version change. The broad objective remains active/incomplete; outstanding user-selected seam questions remain open.

## 2026-10-12 — Pi session configuration transaction owner (Slice 153)

- Revalidated the dirty beta checkout and aligned `0.4.0-beta.2` version trio; preserved accumulated changes. The already-selected `PiSessionAdapter` command/event seam and existing atomic-configuration test passed 27/27 before extraction.
- Moved the full `session.configure` transaction from `PiSessionAdapter.configureInternal()` to `session-configuration-runtime.ts`. The facade retains its public command and per-session lifecycle queue; model resolution/settings lookup, complete validation-before-mutation, local projection, revision commit, and acknowledgement now sit in the configuration owner.
- The adapter suite passed 27/27 after extraction; worker tests 182/182; root unit tests 457/457; `pnpm check` including Pi compatibility 109/109; architecture 5/5; lint, format, production build, and `git diff --check` passed. Build retains the existing >500 kB chunk warning.
- Updated `docs/architecture/pi-migration/handoff.md` ownership map. No Host authorization, Pi runtime routing, version, or external release state changed. Branch remains `beta`; no commit, push, publish, release, or main sync. Full repo-governance goal remains active/incomplete and the other unconfirmed test seams remain open.
- Tool errors: the initial aggregate plan patch and first aggregate adapter extraction patch did not match current context and applied nothing; re-read exact file tails/source and succeeded with smaller plan and source patches.

## 2026-10-12 — Pi attachment turn-input preparation owner (Slice 154)

- Revalidated the dirty `beta...origin/beta` worktree, aligned `0.4.0-beta.2` version trio, and existing `PiSessionAdapter` command/event seam. Added an aggregate-overflow characterization through `submit()` and first verified it against the original implementation.
- Moved model modality validation, each bounded decode, the 25 MiB aggregate check, and text/image prompt projection into `attachment-policy.ts` as `preparePiTurnAttachments()`. The adapter retains compatibility exports and owns configuration checks, idempotency, run acceptance, prompt execution, and event order.
- Added a public submit test for text attachment placement and image block delivery. Adapter tests 29/29; worker tests 184/184; root unit 459/459; `pnpm check` including Pi compatibility 109/109; architecture 5/5; lint, format, production build, and `git diff --check` all pass. Build retains existing >500 kB chunk warnings.
- The first root-unit run overlapped other checks and one Research source-adapter timing assertion saw 24ms instead of 25ms; the isolated assertion passed, then the complete root suite passed when run alone. No Research code changed.
- Updated `docs/architecture/pi-migration/handoff.md`. No Host authorization, Pi-only runtime, version, or external release state changed. Still on `beta`; no commit, push, publish, release, or `main` sync. The repo-wide structural-governance goal remains active/incomplete; other unconfirmed seams remain open.

## 2026-10-12 — Pi session close lifecycle owner (Slice 155)

- Revalidated and used the existing `PiSessionAdapter.close()` command/event seam. The adapter baseline passed 29/29; a new running-session close characterization then passed against the original implementation, checking Pi abort and the single cancelled `run.finished` followed by `session.closed`.
- Extracted the existing close transaction into `session-close-runtime.ts`. The adapter still serializes lifecycle commands, and the import runtime uses the same close owner with lifecycle emission suppressed to preserve Host binding handoff.
- Post-extraction validation: adapter 30/30, worker 185/185, root unit 460/460, `pnpm check` including Pi compatibility 109/109 and worker packaging, architecture 5/5, lint, format, production build, and `git diff --check` all pass. Build retains the >500 kB chunk warning.
- Audited the workspace-tools test candidate: current tests assert the combined Host gateway contract through `resolve_request` (Host path/gitignore/permission decisions, envelopes, mutation ordering, and output behavior), so kept them at the gateway seam. No Host routing or authorization path changed.
- Updated the Pi migration handoff and governance records. The branch remains `beta` with aligned `0.4.0-beta.2` declarations; no commit, push, publish, release, or `main` synchronization occurred. Full structural-governance objective remains active/incomplete.

## 2026-10-12 — Persisted Pi subagent resume interface coverage (Slice 156)

- Audited the existing `PiSubagentRuntime` seam and found a verification gap between safe sidecar parsing and runtime resume/reopen. Added an owner-interface test using a real temporary sidecar/transcript and the existing injected Pi SDK adapter.
- The test verifies stable task identity, reuse of the stored Pi transcript, saved model/reasoning, continuation prompt, and terminal event metadata. No production code or Host security/runtime route changed.
- Validation: focused resume test passed; `pnpm check` (Pi compatibility 109/109), root unit 461/461, worker 186/186, lint, format, and `git diff --check` passed. The test fixture was corrected to use a real canonical temporary workspace after initial path-precondition and macOS temp-path alias failures.
- Branch/version remain `beta` / `0.4.0-beta.2`; no commit, push, publish, release, or `main` synchronization. The full repository-governance goal remains active/incomplete with the previously unconfirmed Workspace-store, Host-router, and view-projection seams still open.

## 2026-10-12 — Config facade test ownership (Slice 157)

- Revalidated the accumulated `beta...origin/beta` worktree, aligned `0.4.0-beta.2` release trio, and clean diff whitespace before editing.
- The 21 tests in `config_runtime.rs` directly exercised helpers owned by six child modules rather than the facade's commands/composition. Moved the same test functions unchanged to `config_extensions`, `config_marketplace_sources`, `config_plugin_details`, `config_pi_resources`, `config_core`, and `config_marketplace_native` owner-local test modules. The production facade remains unchanged.
- Baseline facade suite passed 21/21. Post-move Rust library suite passed 369/369; `cargo check --locked --lib` passed without warnings; `cargo fmt --check` and `git diff --check` passed. Initial full test exposed stale test-only re-exports; narrowed them to the one extension-owner test still requiring it, then reran all checks.
- No JS/production build was needed for this test-location-only change. No Host authorization, runtime routing, persistence, protocol, release version or external state changed. Branch/version remain `beta` / `0.4.0-beta.2`; no commit, push, publish, release or main sync. Overall structural-governance goal and unresolved user-selected seams remain open.

## 2026-10-12 — Pi Hook config/execution owner split (Slice 158)

- Revalidated beta workflow constraints; kept the Host workspace authorization and Hook dispatch coordinator outside the split. The distinct preflight and execution callers justified separate owners: bounded untrusted-file qualification/snapshot vs. Host payload/matcher/command execution.
- Created `pi_hook_runtime/hook_config.rs` and `hook_execution.rs`; reduced `pi_hook_runtime.rs` to a crate-level facade while retaining original crate import paths. Direct parser and matcher tests moved next to those owners; the end-to-end PreToolUse denial test still exercises the facade.
- Compatibility checks now read both owners and verify facade re-exports, parser-to-execution wiring, preflight/worker route and per-owner numeric limits. Hook fixtures pass 8/8.
- Validation: Hook focused Rust tests 3/3, Rust library tests 369/369, warning-free `cargo check`, `cargo fmt --check`, `pnpm check` (109 Pi/Tauri compatibility fixtures), root unit 461/461, lint, `format:check`, and `git diff --check` all pass. No frontend build was needed for this Rust/script/docs-only change.
- The pre-tool hook remains after workspace authorization and before persisted permission/gateway; post/failure hooks remain observational after resolution delivery. No Host authorization, Pi-only selection, wire shape, versions, or external state changed. Branch/version remain `beta` / `0.4.0-beta.2`; no commit/push/publish/release/main sync. Overall structural-maintenance goal remains active/incomplete; unconfirmed Workspace-store, Host-router, and view-projection seams remain unselected.

## 2026-10-12 — Pi monitor bounded-output owner (Slice 159)

- Revalidated the active beta checkout and preserved accumulated changes. Audited `pi_monitor_runtime.rs` and isolated line admission/truncation/tail retention from task registry, Host session ownership, sandboxed process lifecycle, and event coordination.
- Added `pi_monitor_runtime/output.rs` with `MonitorOutput`; moved the existing window/lifetime quota and UTF-8 truncation tests to this owner. Existing `start_monitor`/snapshot process tests stayed at their prior runtime interface. No Host authorization, workspace permission, sandbox decision, task ownership, or event ordering changed.
- Baseline monitor tests 6/6; after extraction runtime integration 4/4 and output policy 2/2. Full Rust tests 369/369; warning-free Cargo check, Rust fmt check, `pnpm check` (110 compatibility fixtures), lint, format, and `git diff --check` passed. Frontend unit/build was not rerun because this slice changes only Rust runtime ownership and no frontend source.
- Updated the Pi migration handoff owner map and governance records. Existing accumulated uncommitted changes remain preserved; beta/version alignment is rechecked after documentation formatting. No commit, push, publish, release, or `main` synchronization. Overall structural-maintenance goal remains active/incomplete.
- Tool errors: one compile attempt found a stale `#[test]` attribute on the cleanup helper after test relocation; removing the attribute fixed the compile. Cargo check then identified a test-only constant imported in production; narrowed it behind `cfg(test)` and reran with no warnings. An import-order patch context initially did not match rustfmt output and was retried against the current source.

## 2026-10-12 — Pi subagent policy normalization owner (Slice 160)

- Revalidated the beta checkout and accumulated dirty state. Split bounded Host policy/alias normalization from policy selection and launch projection into `subagent-policy-normalization.ts` and `subagent-policy.ts`; retained the established facade exports and changed internal consumers to depend on the normalization owner directly.
- Updated the aggregate compatibility gate to inspect each owner and preserve MCP Host-worker bound checks across their actual source files. Host authorization remains authoritative; Pi-only runtime, error shape, grants/ceilings, and launch/resume flow are unchanged.
- Baseline policy tests 13/13 and compatibility fixtures 6/6. After extraction: worker 186/186, root unit 461/461, `pnpm check` (110 Pi/Tauri fixtures), architecture checks, lint, format, production build, and `git diff --check` passed; build retains the existing >500 kB chunk warnings.
- Updated task plan, findings, progress, and Pi migration handoff owner map. Work remains uncommitted on `beta`, version remains `0.4.0-beta.2` across package/Cargo/Tauri. No commit, push, publish, release, or main sync; whole-repository goal remains active/incomplete.

## 2026-10-12 — Pi subagent task-command event projection (Slice 161)

- Revalidated the existing PiSubagentRuntime command/event seam and added a pre-refactor characterization for `waitTask` and `cancelTask`; both paths emitted the same completed-task response envelope with the same stable payload.
- Replaced the duplicate `task.changed` payload construction with one private `emitTaskCommandResult` owner method. Wait/cancel behavior and event ordering remain at their original command methods.
- Validation: runtime 3/3, worker 187/187, root unit 462/462, `pnpm check` (110 Pi/Tauri fixtures), architecture 5/5, lint, format, build, Rust library 369/369, warning-free Cargo check, Rust fmt and diff check passed. Build retains existing >500 kB chunk warnings.
- No task lifecycle, Host authorization, Pi-only runtime, or worker protocol behavior changed. Work remains on beta, uncommitted, and the full repository goal remains active.

## 2026-10-12 — Workspace patch owner tests (Slice 162)

- Acting on the user's confirmation to move owner tests only, relocated the two existing tests that directly call `workspace_tools::apply_patch` into `workspace_tools.rs`; their assertions and behavior remain unchanged.
- Read authorization, search/list/gitignore, Host policy and symlink cases remain in `pi_tool_gateway.rs` where they exercise gateway dispatch or Host authorization integration.
- Workspace owner tests 2/2 and full Rust library tests 369/369 passed; cargo check has no warnings, Rust fmt passes, and the full TypeScript/test/check/lint/format/build/architecture gates passed (root unit 462, worker 187, compatibility fixtures 110). Build retains existing chunk warnings.
- No production file or authorization path changed. Branch/version remain `beta` / `0.4.0-beta.2`; no commit, push, release, publish, or main sync.

## 2026-10-12 — Pi Session event lifecycle owner (Slice 163)

- Revalidated the preserved `beta...origin/beta` worktree and existing PiSessionAdapter command/event seam. Audited `openInternal()` and kept it in the adapter because session creation composes model catalog, ToolGateway, subagent, resource, persistence and live session-context dependencies; the event bridge was a narrower owner with three stable dependencies.
- Added an `agent_settled` command-interface characterization before extraction; it verifies exactly one `run.finished(pi_settled)` with the established root/session/run identity. Extracted Pi event-tail serialization/recovery, provider-error capture, message mapping/anchor enrichment, subagent observation and settled/context projection into `session-event-runtime.ts`; root adapter subscriptions and child subagent sessions share that projector, while each runtime keeps its existing queue.
- The first full worker run exposed the missing child-session delegation: two smoke tests timed out waiting for task cancellation/shutdown events. The direct child event callback was reconnected to the owner's `handle()` path; both isolated cases then passed. The test process initially remained alive after reporting its failure and was interrupted after the failure details were captured; no source/test data was lost.
- Validation after correction: adapter tests 31/31, full worker tests 188/188, root unit 463/463, `pnpm check` including 110 Pi/Tauri compatibility fixtures, architecture 5/5, lint, format, production build, and `git diff --check` passed. Build retains the existing >500 kB chunk warning. Rust code was untouched; no Cargo run was needed.
- Updated the Pi migration handoff owner map, task plan, findings and progress records. Host authorization/permission, Pi-only runtime selection, event identities/order/error contracts, and wire shape remain unchanged. The Workspace-store, Host-router and shared Workspace view-projection seams remain unselected. No commit, push, publish, release, version change or `main` sync.
- Tool errors: Node strip-only initially rejected a parameter property in the new owner; replaced it with explicit assignment and Prettier formatting. First documentation handoff patch used an outdated line anchor and applied nothing; reread the current paragraph and reapplied at the exact owner-map line.

## 2026-10-12 — Marketplace install transaction owner (Slice 164 complete)

- Revalidated active `beta...origin/beta`, the preserved accumulated dirty worktree, and aligned package/Cargo/Tauri versions at `0.4.0-beta.2`; planning session catch-up exited 0 with no report.
- Audited the 1,225-line `config_marketplace_native.rs` after its existing catalog/transport/filesystem/registry/source owners. `install_snapshot` is the shared filesystem+registry commit/rollback transaction at five production call sites across Marketplace/direct install and update. Kept Host authorization, source selection, clone acquisition, and command ordering in the existing command owner.
- Added `registry_commit_failure_restores_the_previous_plugin_snapshot` through the existing transaction test surface. A directory at `registry.json` deterministically makes the post-replacement atomic commit fail; baseline behavior restored the previous target and cleaned staging/backup/temp files. Focused Rust test passed 1/1 before extraction.
- Moved only staged copy/replace, registry commit/rollback, and backup cleanup into `config_marketplace_install_transaction.rs` behind `InstallSnapshotRequest` and named `MarketplaceInstallProvenance`; the five parent call sites now pass explicit fields. Host authorization, source selection, Git acquisition, command ordering, and filesystem safety primitives remain in their existing owners.
- Moved the existing registry compatibility test and added rollback-failure coverage to the transaction owner. Before extraction, the new failure characterization passed 1/1 against the prior implementation; after extraction, the two owner tests and the parent Marketplace candidate install/refresh test passed 3/3.
- Validation: Rust library tests 370/370; warning-free Cargo check; Rust fmt; `pnpm check` with 110 compatibility fixtures; architecture 5/5; lint; format and docs Prettier; `git diff --check`. Frontend unit/build were not rerun because no frontend code changed.
- Final state remains `beta...origin/beta` with package/Cargo/Tauri versions `0.4.0-beta.2`; all accumulated dirty work is preserved. No commit, push, publish, release, version change or `main` sync.
- Tool errors: one orchestration script had a JavaScript parser error before nested commands ran; one test filter matched 0 cases and was corrected to unique names; an initial Rust fmt invocation omitted `--manifest-path`, after which the correctly scoped check found formatting differences and the formatter fixed them. None affected unrelated workspace state.

## 2026-10-12 — PiSubagentRuntime residual-owner audit (Slice 165 in progress)

- Revalidated current `beta...origin/beta`, the aligned `0.4.0-beta.2` version trio, and the preserved accumulated dirty worktree; `session-catchup.py` exited 0 with no recovery report.
- Confirmed Slice 164 was actual progress in the prior goal turn. Reconciled its stale planning heading to complete; its source/test results remain unchanged.
- Began an evidence-led audit of the 1,183-line `PiSubagentRuntime` after existing policy-normalization, session-boundary, record-persistence, Host task-control, task-response and event owners. Current direct owner tests cover spawn/completion/ownership, wait/cancel envelope, and persisted resume.
- Audited the first half of the runtime: event output/settlement observation, live-session refresh, root cancellation/shutdown, record projection, descendant visibility, and the task-controller wait/cancel paths. The controller deliberately combines a bounded task namespace and Host/Pi routing; do not split it into a Host forwarding facade.
- Audited the full `spawnSubagent()` method: setup includes resume/policy/admission/worktree/model/resource/transcript preparation; post-open run handling assembles the task, manages event subscription/cancellation, emits accepted/terminal/task state, persists the resume record, and cleans up. A post-open lifecycle owner may be deeper than the existing policy/record/event modules, but production callers and tests still need confirmation.
- Audited call sites and tests: `PiSessionAdapter` owns the runtime instance, `task-tools.ts` invokes its supplied spawn callback, and nested subagents reuse the same method. Existing runtime tests exercise `spawnSubagent()` through the injected Pi SDK adapter; the task seam is established and does not require a new owner-local test port. Current gaps are the cancellation-during-emission race and event/persistence error cleanup.
- Reviewed the current task contract: run identity/context, status, refresh callbacks, event tail, output and cleanup handles already live on `TaskHandle`; production continues to enter through `PiSessionAdapter`/`task-tools`, and tests use the same runtime public method. This supports an internal run-lifecycle owner with a prepared task and three operations rather than another broad constructor port.
- Existing worker-smoke cancellation coverage exercises root ownership but not the documented initial status-emission race; use the established direct `spawnSubagent()`/`cancelTask()` seam for the missing characterization.
- Added the cancellation-during-initial-event characterization through the existing runtime behavior seam. Baseline `node --experimental-strip-types --test packages/agent-worker/src/pi/subagent-runtime.test.mjs` passed 4/4, including no provider prompt and terminal-event assertions. Next extract the post-open run lifecycle without moving setup or Host worktree authorization, then rerun the same interface tests.
- Read the repository test vocabulary in `CONTEXT.md`; no adjacent subagent-runtime ADR was found. Keep Agent Session/Task Launch terminology and existing command/event behavior as the contract.
- Confirmed `TaskHandle` already extends the shared session context and has the fields needed by the run owner; a single activation operation can own cancellation, event-tail observation, accepted/prompt/terminal event sequencing, persistence warnings, and final projections without moving task admission, Host worktree requests, or result selection.
- Added and wired `subagent-task-lifecycle.ts` with the prepared `TaskHandle` shape and one activation operation. `PiSubagentRuntime` still owns setup, map admission and command result selection; the child module owns cancellation, subscription/event tail, run events, prompt execution, persistence warning and cleanup. Formatting/type/test verification is now the next gate.
- Ran Prettier and the direct `subagent-runtime.test.mjs` suite after extraction; 4/4 passed, including the new cancellation-race characterization. `pnpm check`, full worker/root validation and architecture/build gates remain outstanding.
- First `pnpm check` found only an unused `onPiEvent()` forwarding wrapper left behind by the extraction; removed it and reran successfully, including TypeScript, packaging, 110 static compatibility/permission fixtures, and the Pi compatibility gate. Full worker/root unit and architecture/build gates remain outstanding.
- Full worker suite passed 189/189, including child task cancel and shutdown smoke coverage. The Pi migration handoff owner map is synchronized. Root unit/architecture/lint/format/build gates remain outstanding.
- Root `pnpm test:unit` passed 464/464. No Rust source changed; remaining checks are architecture, lint/format, production build, and final diff/branch/version audit.
- Architecture checks passed 5/5, lint/format passed, and `git diff --check` is clean. Production build and final branch/version/status checks are the remaining gates.
- Production build passed; existing Vite >500 kB warnings remain. Next review the focused diff and rerun diff/status/version checks after the final planning update.
- Reviewed the new owner against the moved implementation and public call site: task-map admission precedes activation, Host worktree authorization remains in `PiSubagentRuntime`/ToolGateway, lifecycle event ordering and best-effort cleanup are intact. Final state/diff checks remain.
- Formatted all planning and handoff documentation; Prettier reported no changes. Final format gate and `git diff --check` pass; branch is `beta...origin/beta`, all three versions are `0.4.0-beta.2`, and the accumulated dirty worktree remains preserved. No commit, push, publish, release, version bump, or main sync.
- Slice 165 complete: extracted post-open child-task run lifecycle behind the existing `spawnSubagent()` interface. Validation: direct runtime 4/4, worker 189/189, root unit 464/464, `pnpm check` (110 fixtures), architecture 5/5, lint, format, production build, and diff checks. Existing >500 kB Vite chunk warnings remain.

## 2026-10-12 — Whole-repo structural maintenance continuation (Slice 166 discovery)

- Classified the prior goal turn as progress: Slice 165 added the child-task run lifecycle owner and its cancellation-race characterization, verified by worker/root/check/build gates.
- Revalidated the authoritative checkout on `beta...origin/beta`; all three app version files remain `0.4.0-beta.2`, `git diff --check` is clean, and planning session catch-up exited 0 with no unsynchronized report. The large accumulated dirty worktree is preserved.
- No changes in this turn yet. Next build a fresh source-size/responsibility inventory and select a substantial, non-user-pending seam; the Workspace store latest-request, Host-router coordinator, and shared Workspace view-projection remain unselected.
- Inventory completed: the remaining large production owners span Host dispatch, subagent config, MCP remote transport, Pi session/supervisor, Marketplace commands, and extension config. Host gateway remains a security owner and is not a candidate for moving authorization; inspect responsibilities/callers before choosing elsewhere.
- Began the subagent-config audit: its only production consumers are the two `config_runtime` facade calls, while the implementation interleaves source discovery/inventory, definition normalization, and manifest/list projection. Markdown parsing and prompt-file resolution are already owned separately; next inspect whether source inventory has a deep interface without duplicating precedence or policy.
- Found a concrete candidate: manifest and Settings projections separately scan native/plugin agent definitions using parallel load-vs-inventory paths; shared parser/path functions reduce but do not eliminate duplicated source orchestration. Next inspect tests and the authorized `config_runtime` call path before deciding whether one source-inventory interface can preserve role/plugin/inline precedence.
- Confirmed the Settings command authorizes the workspace before scan, and `pi_resource_manifest` preserves resource → subagent → optional policy evaluation order. Existing tests include both private-helper checks and output behavior; if refactoring, move coverage to the existing config-runtime seams and retain Host authorization in the command facade.
- A current-source search found no `config_runtime.rs` test module; the production seams are its `pi_resource_manifest(cwd)` composer and authorized Settings command. Shared Markdown scan/parser functions are already reused, leaving only small projection-specific iteration loops. Keep Slice 166 as discovery in progress until a proposed existing-interface test seam and the value of one unified source-inventory interface are confirmed; no product/runtime source has changed. One initial symbol-search regex was over-escaped and failed to compile; the read-only search was rerun with a simpler expression.
- User approved the manifest and authorized Settings behavior seams for this candidate. The installed Tauri `State` constructor appears private, so verify a real command-test harness before choosing test placement; do not introduce a test-only production port. Two read-only command errors in this audit were corrected: an over-escaped `rg` expression and an unsupported `question` key in the first async-question schema attempt.

## 2026-10-12 — Subagent definition source catalog (Slice 166 complete)

- The authorized Settings command test now runs through `tauri::test::mock_builder()` with a registered `WorkspaceRegistry`; it verifies inline-over-file path/scope/support/enablement, unsupported Markdown fields, and an enabled plugin's qualified inventory entry. Canonicalized expected paths account for macOS `/var` → `/private/var` resolution.
- Added `config_subagent_catalog.rs` with `AgentDefinitionCatalog` as the owner for native and enabled-plugin Markdown discovery/parsing. It retains parsed definitions, source path/base, native scope, plugin identity, and unsupported-field classification; Pi policy and Settings still project different names and precedence.
- Pi policy loads native definitions at the prior stage, applies user/project config and inline overrides, then loads plugins and resolves qualified/bare-name behavior. Settings continues to authorize first, merge user/project config, then load native/plugin sources and apply inline entries last. No `config_runtime` composer, Host authorization, or runtime selection moved.
- Removed tests coupled to the former private inventory scan loops after moving their observable native/plugin checks onto the authorized Settings command seam; policy qualification/inline precedence coverage remains on `pi_subagent_policy_manifest`.
- Validation: Rust library 370/370; warning-free `cargo check --lib`; Rust fmt; `pnpm check` including 110 compatibility/permission fixtures; architecture 5/5; lint; repository and planning-document formatting; `git diff --check` all pass. UI unit/build were not rerun because this slice only changed Rust and documentation.
- Final state remains `beta` at aligned version `0.4.0-beta.2`; the accumulated dirty worktree is preserved. No commit, push, publish, release, version change, or `main` sync.
- Tool errors: the first post-refactor module compile needed `Clone` and an ignored `path` field; after moving the module, the first Rust fmt check required declaration/import ordering. Both were corrected and all gates passed. One existing sandbox fixture logged `sandbox_apply: Operation not permitted` while the full test command still completed 370/370; this is not target-platform sandbox verification. Earlier test path mismatch and test-feature setup remain logged in task_plan.

## 2026-10-12 — Pi plugin catalog owner (Slice 167 discovery)

- Continued the broad structural-maintenance goal under the supplied beta-only workflow. Revalidated `beta...origin/beta`, aligned `0.4.0-beta.2` release declarations, preserved the large accumulated dirty worktree, and ran planning session catch-up (exit 0, no report).
- Audited `config_extensions.rs`: plugin enablement, source roots, bounded recursive scan, static/dynamic capability classification, and project/user/config conflict resolution form one source-catalog responsibility shared by Pi resource projections, capability listing, extension listing, and Marketplace installed-plugin listing. The parser remains owned by `config_plugin_details`.
- User approved characterization through existing `list_melody_plugin_capabilities` and `list_installed_melody_plugins` Tauri commands. No Slice 167 code or test changes yet; next add tests through those command interfaces before extracting the owner. Avoid process-global environment mutation in parallel Rust tests.
- The Pi resource compatibility checker currently reads plugin bounds/activation markers from `config_extensions.rs`; update its source inputs to follow the catalog owner without losing checks for facade wiring.
- Added two pre-extraction characterizations through the approved Tauri commands: authorized plugin capability listing verifies configured-root dedupe, project-over-config precedence, explicit opt-in/disable, and declarative-vs-dynamic projection; Marketplace listing verifies stable ID activation, disabled-wins, and project-array replacement in an isolated child test process. After fixing test harness wiring, `cargo test --lib config_extensions::tests::` passed 12/12 against the original implementation.
- Created `config_plugin_catalog.rs` as the plugin enablement/discovery owner and wired it as an internal child of `config_extensions`; removed the parent-owned scanner and the corresponding private scanner tests after command-level coverage was established. Generic extension scanning tests remain with their owner. Compilation, formatting, and compatibility-source wiring are the next gates.
- Completed the catalog owner and preserved `config_extensions` facade exports plus the existing command authorization/order. Updated the Pi resource contract checker and fixtures to inspect `config_plugin_catalog.rs` for plugin bounds/activation while retaining facade and Skill-ignore ownership checks; added an aggregate-checker test for module wiring. Updated the Pi handoff owner map.
- Post-extraction focused tests passed 5/5; full Rust library 365/365; warning-free locked `cargo check --lib`; Rust fmt; `pnpm check` including 111 compatibility/permission fixtures; architecture 5/5; ESLint; Prettier format check; `git diff --check`. The focused Rust run initially exposed a now-unused scanner-test re-export, removed before passing. The first compatibility-check formatting run failed only on the edited fixture; Prettier fixed it. Continue the broad audit on beta; Slice 167 is complete, but the overall structural-maintenance goal is not.

## 2026-10-12 — Skill detail and path-policy owner (Slice 168)

- Fresh owner inventory selected `config_plugin_details.rs` for a behavior-preserving split: plugin manifest/detail parsing and Skill Markdown details/file/path policy have independent callers and security roles.
- The user chose the existing authorized `get_melody_skill_details` command as the characterization seam. The full Skill owner scope also includes the existing authorized `delete_melody_skill` command for allowed-root checks; no test-only production interface is introduced.
- Added command-level behavior tests before extraction: disabled-but-discovered Skill details remain inspectable, frontmatter and sorted file inventory project as before, the catalog rejects an unlisted path, direct-child Skill deletion succeeds, and nested/symlinked `SKILL.md` paths are refused. Pre-extraction baseline passed 2/2.
- Extracted Skill Markdown parsing, bounded file enumeration and allowed-root policy to `config_skill_details.rs`; command authorization and catalog-membership orchestration remain in `config_extensions`, resource-list description/deletability still route through the same helpers, and plugin manifest/capability parsing stays in `config_plugin_details`.
- Full gates pass: Rust library 365/365; warning-free locked `cargo check --lib`; Rust fmt; `pnpm check` including 111 compatibility/permission fixtures; architecture 5/5; ESLint; Prettier format; `git diff --check`. The final handoff table needed Prettier reflow after adding the new owner; formatting was rerun successfully. Final branch/version check remains `beta` / `0.4.0-beta.2` across package, Cargo and Tauri config. The large dirty tree remains preserved; no commit, push, publish, release or main sync.

## 2026-10-12 — Pi prompt resource owner (Slice 169)

- Continued the broad structural-maintenance goal under the repository's beta-only workflow. The existing large dirty worktree is preserved; no release, version change, `main` sync, commit, push or publish was requested or performed.
- Characterized prompt projection through the existing `config_runtime::pi_prompt_paths` and `pi_resource_manifest` seams before extraction. The test covers sorted flat files, disabled names, the 512-path cap, oversized/nested/symlink exclusions, and root snapshot preservation; pre-extraction baseline passed 1/1.
- Extracted prompt root ordering, bounded scanner and disabled-name snapshot into `config_prompt_resources.rs`. `config_extensions` keeps its existing facade export, `config_pi_resources` retains Skill resource policy and manifest parts, and full manifest composition remains in `config_runtime`.
- Added Host prompt bounds to `pi-resource-compatibility.mjs`/fixtures and moved the aggregate static ownership check to the new module, with a regression test for the new facade wiring. Validation passed: focused Rust facade test 1/1, Rust library 364/364, warning-free locked `cargo check --lib`, `pnpm check` with 113 compatibility/permission fixtures, Pi compatibility, architecture 5/5, ESLint, Rust/Prettier/planning-document formatting, and `git diff --check`. Branch remains `beta`, all three versions remain `0.4.0-beta.2`, and the accumulated dirty worktree was preserved; no commit, push, publish, release or main sync occurred. Slice 169 complete; continue the broad owner audit with Slice 170 discovery.

## 2026-10-13 — Workspace apply_patch owner (Slice 170 complete)

- Audited the patch grammar/planner inside `workspace_tools.rs` and retained the existing `apply_patch(root, arguments)` interface used by ToolGateway and direct behavior tests. The patch operation cluster has an independent vocabulary and owns all-file preflight plus add/update/delete/move execution; shared path, symlink, gitignore and no-follow write helpers remain parent-owned.
- Moved the implementation and its two existing tests verbatim into `workspace_tools/patch.rs`. ToolGateway permission decisions, Host gitignore override, mutation lock, request routing, and gateway-level symlink/gitignore integration tests remain in place. No new test port or behavior was added.
- Validation passed: patch owner tests 2/2, ToolGateway tests 25/25, full Rust library 364/364, warning-free `cargo check --locked --lib`, Rust formatting, `pnpm check`, architecture 5/5, lint, Prettier format and `git diff --check`. Branch remains `beta` with aligned `0.4.0-beta.2` versions; preserved the accumulated dirty worktree and did not commit, push, publish, release or sync `main`.

## 2026-10-13 — agent-contract resource manifest owner (Slice 171 complete)

- Audited the shared contract validator and selected the bounded Host resource-manifest schema as a cohesive owner: resource roots, timeout policy, subagent inventory and goal policy all enter through the existing command-envelope validator.
- Extracted the schema and bounds to validation/resource-manifest.ts; common validators and permission/control-character rules now live in validation/shared.ts. The command dispatcher and package-level public exports remain unchanged.
- Preserved the existing public seam tests instead of adding implementation-coupled tests. Pre-extraction baseline and post-extraction contract tests both pass 4/4, including every Host-projected subagent capability mode.
- Added the nested owner files to format, format:check and format:agent-worker so repository checks continue to cover them. Validation passed: pnpm check with 113 compatibility/permission fixtures, pnpm test:unit 464/464, architecture 5/5, lint, format:check and diff check.
- The active goal remains broader than this slice: continue the responsibility/call-graph audit without weakening Pi-only runtime, Host authority or existing behavior. Branch/version remain beta / 0.4.0-beta.2; no commit, push, publish, release or main sync.

## 2026-10-13 — Agent session binding Host preflight owner (Slice 172 complete)

- Audited `database_agent_bindings.rs` and its callers: binding CRUD/Tauri handlers remain a cohesive persistence facade, while persisted-session admission rules are shared by worker command forwarding, forks, and event validation.
- Moved Host checks for product session identity, workspace ownership, Pi engine binding, open/import/fork eligibility, and bounded migration-plan input to `database_agent_bindings/preflight.rs`. The common session-ID bound lives with this policy; the parent imports it for binding request validation and retains the existing crate-level `validate_pi_session_*` exports.
- Kept existing behavior tests at their unchanged seams: pre-extraction and post-extraction, `database_agent_bindings::tests` passed 7/7 and `database_agent_forks::tests` passed 2/2. No test-only production interface or new behavior test was added.
- Full validation passed: Rust library 364/364, warning-free locked `cargo check --lib`, Rust fmt, `pnpm check` with 113 compatibility/permission fixtures, architecture tests 5/5, lint, Prettier format and `git diff --check`. No frontend unit/build rerun was needed for this Rust/docs-only slice.
- Host authorization/admission authority, worker command ordering, fork intent behavior, Pi-only runtime, and import constraints are unchanged. The broad structural-maintenance goal remains active. Branch stays `beta`; existing accumulated work is preserved without commit, push, publish, release, version change or `main` sync.

## 2026-10-13 — Pi runtime capability policy owner audit (Slice 173 discovery)

- Revalidated the beta worktree and aligned `0.4.0-beta.2` version declarations; kept all 221 existing status entries intact and `git diff --check` clean.
- Audited the remaining inline capability section in `scripts/check-pi-compatibility.mjs`. Structured tool-set parity, runtime-fallback claim checks, and Browser limitation accuracy can be separated from filesystem/source-marker checks and the real `PI_CAPABILITIES` subprocess probe.
- `node --test scripts/check-pi-compatibility.test.mjs` passed 10/10, and the aggregate compatibility checker passed. Existing CLI tests do not directly exercise negative capability-policy cases.
- Submitted a user seam choice for a pure `checkPiRuntimeCapabilityPolicy({ declared, observed })` behavior interface. No source/tests changed before confirmation; the real capability probe remains required evidence in the aggregate gate.

## 2026-10-13 — Agent migration journal state-owner audit

- Revalidated beta/version/worktree state and traced all migration journal consumers. Begin/retry, import preflight, failure recording, and `session.imported` completion share one persisted state machine, so no function-level split was selected.
- Existing migration tests passed 6/6 for idempotency, retries, plan/backup identity, late completion rejection, and applied target identity. They invoke private helpers and direct SQLite setup; the audit does not treat them as a public command seam.
- Recorded the no-split decision and the test-boundary limitation in `task_plan.md` and `findings.md`. No product code or tests changed.

## 2026-10-13 — Workspace sandbox owner re-audit (Slice 175)

- Revalidated branch `beta`, the aligned `0.4.0-beta.2` version trio, 221 accumulated status entries, and `git diff --check`; no existing work was cleaned or staged.
- Confirmed that sandbox profile resolution and the Seatbelt/Landlock platform adapters already have focused owners. The remaining parent is intentionally the shared Host security coordinator: one fail-closed decision path, workspace authorization/preflight, and one command interface used by terminal and monitor.
- Existing approved seams cover the cross-platform read-only/read-write overlap policy and sandbox command projection. Further splitting would duplicate Host authority or make a shallow renderer/decision facade, so no code or tests changed.
- Recorded the platform-verification boundary: only the macOS Rust target is installed; nested Seatbelt execution is denied by the outer sandbox, and Linux Landlock remains unverified here. No claim of platform enforcement parity.
- The repository-wide goal remains active; continue auditing a different owner rather than counting no-split findings as completed refactors.

## 2026-10-13 — Recovery/schedule/projection owner audit (Slice 176)

- Continued from the live `beta` worktree after confirming the version trio is still `0.4.0-beta.2`; preserved all 221 existing status entries. The sandbox audit record was formatted and `git diff --check` passed.
- Traced current source roles and callers for Host recovery summary, schedule dispatch, Pi import-plan conversion, and session-update projection. Their remaining responsibilities are cohesive after their earlier focused owner extractions; no code split was selected by line count.
- Found a bounded Rust/TypeScript recovery parser discrepancy: Host validates IDs by UTF-8 bytes (256), renderer by JS string length (256). Recorded it as a precise malformed-payload acceptance-domain gap, not a claim about values the Host emits.
- The candidate would use existing `parsePiRecoveryPlan` behavior and Host command contract plus a new cross-layer drift fixture. As the specific test scope has not been selected, no behavior tests or runtime code were changed.
- This audit changes the next decision from broad recovery-module extraction to a narrow contract review; overall project goal remains active and incomplete.

## 2026-10-13 — Workspace bridge candidate resumed (Slice 177)

- Re-read the active plan, findings, and progress; confirmed the full repository-governance objective remains active.
- Revalidated current checkout on `beta`; `package.json`, Cargo, and Tauri versions all remain `0.4.0-beta.2`; `git diff --check` emitted no diagnostics. Existing accumulated dirty work was preserved.
- Recovered the prior read-only audit of `melody-bridge-workspace.ts` as the next candidate, but kept its call graph and test boundary provisional until rechecked against current source.
- At the start of this continuation no product source or tests had changed. The migration call graph was then rechecked before choosing an authorized seam; distinct lifecycle paths were not collapsed by name similarity.

### Slice 177 current-source recheck

- Re-read the bridge helper, `beginAgentSession()` import branch, call sites, and `agent-session-routing.test.mjs`. The two paths share the Host journal and `session.import` command but differ in archive completeness, binding/model policy, setup timeout, and acknowledgement/settlement lifecycle.
- Confirmed the existing routing tests are not migration behavior coverage. History shows the prior `beginAgentSession()` approval addressed runtime routing and ID semantics only, so it does not authorize adding migration-specific characterization as part of this candidate.
- Planning session catch-up ran separately and exited 0 with no recovery report.
- At that audit checkpoint no source/test edits had begun; subsequent review found the existing PiSessionAdapter import contract and selected the separately approved Pi fork seam instead of adding a migration-only port.
- Existing Pi worker test evidence confirms its command/event import interface covers the imported/opened event order, but not the renderer store's migration preparation and setup lifecycle. Explorer UI tests are a separate, already injected behavior seam; its pending fork-reference approval remains separate.
- One read-only `rg` attempt named a non-existent test file; the corrected search used the existing adapter test and no files were changed.
- Selected `forkPiSession()` as a stronger bridge candidate because its existing production interface hides a substantial ordered worker/Host lifecycle. Its tests currently mock the bridge function, so no implementation behavior seam is already in use.
- The user confirmed testing through the existing `forkPiSession(source, target, nativeEntryId)` production interface, then extracting its lifecycle owner. A success-path characterization passed 1/1 against the original implementation before extraction, with no test-only port or Host authorization movement.
- TDD prework read the project's `CONTEXT.md` and testing/mocking guidance. The characterization exercises the facade export through the existing `agent-session-routing.test.mjs` Vite SSR server and stubs only native Tauri IPC/events; no second Vite server or test-only production port is retained.

## 2026-10-13 — Pi Explorer fork lifecycle owner (Slice 178 complete)

- Kept the approved interface and behavior stable: `melody-bridge-workspace.ts` re-exports `forkPiSession()` from the new `melody-bridge-pi-fork.ts` owner. Host durable intent/authentication remains on the same command path; no authorization moved into the renderer.
- The pre-extraction test baseline passed 1/1, then the same test passed after extraction. It asserts fork intent fields, source-open before target-fork, command/session identities and binding fields, and cleanup of both Tauri listeners.
- Added the new TypeScript owner to the root formatter manifests. An initial manifest edit mistakenly included the `.ts` implementation in Node's test file list; that run failed on module loading, the entry was removed, and the corrected unit suite first passed 465/465. The three behavior tests now live in the existing `agent-session-routing.test.mjs` suite, which was already in unit and formatter manifests.
- After the extraction, expanded the approved interface coverage to include a matching source-open `runtime.error` and missing-ack timeout: both reject without sending the fork command and still remove both listeners. The owner suite now passes 3/3 and the full unit suite 467/467.
- A standalone second Vite SSR test server caused a concurrent `24678` WebSocket port warning even with HMR disabled. Moved its three behavior tests into the existing Vite SSR suite and removed the standalone test file/manifest entries; the full unit rerun passes 467/467 without the warning.
- Validation passed: `pnpm check` (113 compatibility/permission fixtures), architecture gate 5/5, ESLint, full `pnpm format:check`, production `pnpm build`, and `git diff --check`. Build retains the repository's existing >500 kB chunk warnings.
- Revalidated `beta` and package/Cargo/Tauri `0.4.0-beta.2`; no commit, push, publish, release, or main synchronization. The broader structural-maintenance goal remains active and incomplete; next continue with a fresh owner/call-graph audit rather than treating this slice as whole-repo completion.

## 2026-10-13 — Host LSP bridge candidate audit (Slice 179)

- Revalidated the `beta` worktree, aligned `0.4.0-beta.2` version trio, and clean `git diff --check`; preserved the accumulated dirty state.
- Rejected further schedule and marketplace splits: schedule persistence/policy/dispatch already have distinct owners, and Marketplace transaction/catalog/filesystem/registry/transport/plugin-source owners are already separated from command orchestration.
- Audited `pi_lsp_runtime.rs`: config and output formatting are separate, while the parent still owns a full short-lived LSP process/JSON-RPC sequence alongside Host request-envelope routing. Existing tests do not exercise subprocess protocol lifecycle, timeouts, or cleanup.
- A possible extraction would move only the child-process/session lifecycle and test it through the existing `resolve_request(root, value)` entry with a fake language server. This needs an explicit portable test seam decision; no source/tests changed in this audit, and Host authorization/path policy must remain in the parent/tool gateway.
- Asked the user whether to test/extract through this existing production seam or continue audit-only; the full structural-maintenance goal remains active.

## 2026-10-13 — WorkspaceStore latest-selection and retry behavior (Slice 180)

- The user approved tests through the existing useWorkspaceStore actions, without a test-only production port. Added both tests to the existing agent-session-routing.test.mjs Vite SSR suite to reuse its already-running server.
- Reproduced the project-selection race: deferred session lists for A and B, resolved B first and A last, and observed the old implementation finish with A active. selectProject now uses the existing RequestGate to ignore stale completions and stale failures.
- Added retry coverage for initialize(): first list_projects fails, then a second action call succeeds. Temporarily restoring the old catch reproduced initialized === true after failure; the implementation now clears the guard in its catch.
- Verification passed: focused store/route suite 16/16, pnpm test:unit 469/469, pnpm check (including 113 compatibility/permission fixtures), pnpm lint, pnpm format:check, and git diff --check.
- Revalidated branch beta and package/Cargo/Tauri versions 0.4.0-beta.2; preserved the cumulative 223-entry dirty worktree. No commit, push, publish, release, or main sync. The repository-wide objective remains active.

## 2026-10-13 — Pi turn run-transition owner (Slice 181)

- Rechecked the `PiSessionAdapter` submit/steer/cancel cluster as one stateful run lifecycle: command admission and identity, idempotency, resource/model refresh, Pi invocation, cancellation serialization, and terminal event settlement all share the existing live session state.
- Kept the already-approved public adapter command/event seam. The pre-extraction `session-adapter.test.mjs` baseline was 31/31; no test-only production port was introduced.
- Moved turn orchestration into `session-turn-runtime.ts`; `PiSessionAdapter` retains the public methods and injects the existing session map, `PiSubagentRuntime`, and emitter. Pure policy stays in `turn-policy.ts`; attachment limits/decoding stay in `attachment-policy.ts`; Host permissions remain in ToolGateway.
- The post-extraction adapter suite passed 31/31, `pnpm test:unit` passed 469/469, `pnpm check` passed with 113 compatibility/permission fixtures, `pnpm check:architecture` passed 5/5, and ESLint plus full Prettier checks passed.
- Read-only `config_subagents.rs` audit found `AgentDefinitionCatalog` already shares bounded discovery/parsing. Policy-manifest and Settings-inventory projections intentionally diverge, so no additional source inventory owner is justified. The earlier LSP process candidate still awaits a specific seam choice.
- Current policy remains `beta` only with package/Cargo/Tauri at `0.4.0-beta.2`; existing dirty work is preserved and no commit, push, publish, release, or main sync occurred. The whole-repository structural-maintenance goal remains active and incomplete.

## 2026-10-13 — Host Pi worker tool-routing seam audit (Slice 182 candidate)

- Revalidated the live beta worktree, aligned version trio, and clean whitespace check before reading the next owner; preserved all accumulated changes.
- Inspected `PiWorkerRuntime` and its child owners. Launch/environment, JSONL protocol, event acceptance and durable event pipeline, session preflight, dispatch ledger, Host tool routing, and memory lifecycle already have separate owners. The remaining process/generation lifecycle is a single start/stop/handshake/EOF/failure state machine, so no LOC-driven split was selected.
- Confirmed a more substantive gap in the 683-line `host_tool_routing.rs`: no direct behavior tests cover the joined workspace authorization → enforceable PreToolUse → persisted permission → Host ToolGateway/domain dispatch → worker-resolution sequence. Existing event-pipeline fake-port and lower gateway tests cover adjacent contracts only.
- Recorded a possible deep router coordinator seam while keeping WorkspaceRegistry and Host ToolGateway as authorization authorities. No source/tests changed pending user confirmation of this new test scope, as required by the TDD seam rule. This is distinct from the earlier generic compatibility-checker wiring candidate.
- The overall repository goal remains active. Branch is `beta`; versions are `0.4.0-beta.2`; no commit, push, publish, release, or main synchronization.

## 2026-10-13 — Marketplace settings owner audit (Slice 183)

- Audited the 688-line `MarketplaceSettings` against its current consumers, `MarketplaceSourceDialog`, and `MarketplacePluginRow`. Source save/delete and catalog scans share state and ordering, while plugin grouping/search/paging depend on the same source/catalog snapshot.
- No direct component behavior suite exists. The normal project-selection handler closes Settings before changing project; while an old-cwd response could theoretically overwrite state if cwd changes without unmounting, source evidence does not establish that flow as reachable, so it is not recorded as a reproduced bug.
- Kept the page composition intact: extracting more hooks would currently spread loading/error/live-activity and scan coordination without a demonstrated deeper interface. No runtime code/test changed and no unconfirmed UI test seam was introduced.
- This is a no-split audit, not overall completion. The Host router seam choice remains unanswered; beta/version boundaries continue to apply.

## 2026-10-13 — Pi subagent adapter seam coverage (Slice 184)

- Added an integration characterization through `PiSessionAdapter`: its registered `run_background_task` tool opens a child, then a public `task.cancel` command cancels it while the initial running-status event is suspended.
- The test verifies zero provider prompts, exactly one cancelled terminal run event with `parent_cancelled`, and a cancelled task acknowledgement. It does not inspect private maps or add a production test port.
- Focused adapter suite 32/32, worker suite 190/190, root unit suite 470/470, `pnpm check` (113 fixtures), lint, full format check, and diff check passed. Earlier in this continuation the Rust library suite passed 364/364.
- Test-only change; Host authorization, Pi-only runtime, runtime behavior, and wire contracts were not changed. Branch/version remain `beta` / `0.4.0-beta.2`; broader goal remains active.

## 2026-10-13 — Pi subagent cancellation test-boundary de-duplication (Slice 185)

- Replaced the duplicate `PiSubagentRuntime` direct cancellation-race test with Slice 184's stronger characterization through the existing `PiSessionAdapter` command/event boundary. The adapter case exercises the registered `run_background_task` tool and public `task.cancel` command while the initial running event is gated.
- Removed only the now-redundant direct test and its test-helper-only `onEmit` hook; retained the three distinct owner-level spawn/ownership, wait/cancel-envelope, and persisted-resume cases. No production code or production test port changed.
- The combined focused adapter/runtime files passed 35/35; `pnpm test:agent-worker` passed 189/189 and `pnpm test:unit` passed 469/469. The adapter test continues to assert no provider prompt, exactly one cancelled `run.finished` with `parent_cancelled`, and the final cancelled task projection.
- Host authorization, Pi-only runtime behavior, and wire contracts remain unchanged. Branch/version remain `beta` / `0.4.0-beta.2`; the whole-repository structural-maintenance goal remains active.

## 2026-10-13 — PiSessionAdapter test seam cleanup (Slice 186)

- Replaced the resource-refresh test's private `questionTimeoutPolicy` reads with a command/event behavior test: a Host-projected 80 ms ask-user policy times out through the registered tool, then an omitted policy is cleared and the next interaction remains pending until `resolveInteraction`.
- Replaced the lifecycle-queue test's `openInternal` monkey patch with two concurrent public `session.open` calls through the injected Pi SDK harness. The test observes one native session, two idempotent `session.opened` acknowledgements, and identical native ID/config revision.
- The focused cases passed, followed by `pnpm test:agent-worker` 189/189 and `pnpm test:unit` 469/469. The test file no longer reads `adapter.questionTimeoutPolicy` or replaces `adapter.openInternal`.
- One adjacent test still reads the private `goalPolicy` snapshot; the extension's effective policy refresh semantics need separate behavior-seam analysis before replacing that assertion. No production behavior changed in this slice.

## 2026-10-13 — Pi session resource-refresh owner (Slice 187)

- Moved the cohesive root/child refresh workflow from `PiSessionAdapter` into `session-resource-refresh-runtime.ts`: Host snapshot normalization/application, lifecycle serialization, active-run deferral, error aggregation, and completion warning stay under one owner. The existing adapter command seam remains unchanged.
- Added an adapter-level regression for root reload failure (`pi.resource_refresh_failed`, no success event) and updated aggregate/question-timeout static compatibility checks plus fixtures to follow the new owner and adapter wiring.
- Verification passed: refresh suite 5/5, `pnpm test:agent-worker` 190/190, `pnpm test:unit` 470/470, `pnpm check` (113 compatibility/permission fixtures), `pnpm lint`, full `pnpm format:check`, `pnpm check:architecture` 5/5, and `git diff --check`.
- Branch/version remain `beta` / `0.4.0-beta.2`. No commit, push, publish, release, or main sync. The private `goalPolicy` test remains pending downstream behavior-seam analysis; the whole-repository goal remains in progress.

## 2026-10-13 — Pi session-open lifecycle owner (Slice 188)

- Extracted root Pi session creation and registration from `PiSessionAdapter.openInternal()` into `session-open-runtime.ts`: idempotent reconnect, model/resource binding, ToolGateway configuration, Pi session construction, handle/subscription registration, and the existing lifecycle acknowledgements now sit behind one workflow owner.
- The adapter still owns command dispatch and its per-session lifecycle queue; fork/import use the same owner. Five existing public-interface cases passed before and after the extraction. Host authorization, Pi-only routing, IDs, event ordering, and error behavior remain in their existing places.
- Updated the aggregate compatibility checker and added two fixtures that reject missing adapter delegation or missing model-policy application in the open owner.
- Verification passed: worker 190/190, root unit 470/470, `pnpm check` with 115 compatibility/permission fixtures, ESLint, full Prettier check, architecture 5/5, and `git diff --check`.
- Branch/version remain `beta` / `0.4.0-beta.2`; no commit, push, publish, release, or main sync. The whole-repository structural-maintenance goal remains active.

## 2026-10-13 — Agent Session latest-generation projection guard (Slice 189)

- Through the user-approved `beginAgentSession` store seam, reproduced two overlapping desktop activations: A waits for Host binding, B becomes the current session, then A's binding failure incorrectly changes B's runtime/chat phases and status message.
- Added a per-store `RequestGate` generation and a current-activation commit guard for persisted model/permission controls, async error projection, and setup-timeout writes. The existing same-session in-flight idempotency return remains before generation allocation, so a duplicate no-op cannot invalidate the real activation.
- The guard does not cancel or early-return an older activation's Host/Pi work. A second red/green test confirms B's model controls remain selected while A still emits its original session-scoped `session.open` envelope with A's own model/permission values.
- Red/green evidence: the late-error test failed before the guard with `session-a`'s failure projected while `session-b` was current; temporarily bypassing the binding config guard caused the config test to fail with `model-a` replacing `model-b`. Both pass with the final implementation.
- Validation passed: focused `agent-session-routing.test.mjs` 18/18, full root unit suite 472/472, `pnpm check` with 115 compatibility fixtures, architecture 5/5, lint, full format check, production build, and `git diff --check`. Build retains the existing >500 kB chunk warnings.
- Branch/version remain `beta` / `0.4.0-beta.2`; no commit, push, publish, release, or main sync. The neighboring late capability-report catch in `use-agent-bridge.ts` is a separate unreviewed seam; the repo-wide maintenance goal remains active.

## 2026-10-13 — Pi capability preflight stale-failure audit (Slice 190 candidate)

- Revalidated `beta...origin/beta`, the aligned `0.4.0-beta.2` package/Cargo/Tauri versions, the accumulated dirty worktree, planning catch-up, and `git diff --check`; no existing changes were cleaned or overwritten.
- Traced `useAgentBridge` capability preflight: success checks the effect's `disposed` flag before committing; the `getPiCapabilityReport` rejection handler does not, and writes both global capability diagnostics and global status. Other post-await worker failure handling is guarded, so this is a specific stale-commit candidate rather than a blanket hook-lifecycle defect.
- Confirmed no hook renderer/lifecycle test harness in the inspected test dependencies. Recorded a candidate coordinator seam and deferred-failure test in `findings.md`/`task_plan.md`; no source/test change pending explicit interface confirmation. Current capability policy remains Host-projected and Pi fail-closed with no ACP fallback.
- Full structural-maintenance goal remains active and incomplete; no commit, push, publish, release, or main synchronization.

## 2026-10-13 — Session persistence ownership audit (Slice 191)

- Audited `useSessionPersistence` and its sole caller. The queue, per-session revision/signature state, archive diff, serialized writes, retry policy and lifecycle flushes form one persistence state machine; the latest-revision guard prevents old responses from replacing the current workspace session projection.
- Existing tests cover timeline projection rules, not persistence writer retries. No split was made because a file-only extraction would spread the queue invariants across a new writer/scheduler interface; a future deeper owner should be justified by an observable, replaceable persistence seam.
- No runtime changes. Slice 190's capability-preflight seam question remains pending; the current checkout stays on beta with aligned `0.4.0-beta.2` versions, and the accumulated dirty worktree is preserved.

## 2026-10-13 — Same-session reactivation timeout regression (Slice 192)

- Extended the user-approved `beginAgentSession` store seam with an A → B → A scenario. The first A activation's unacknowledged `session.open` setup timeout is fired after a new A activation owns the same session ID and is still creating.
- The old timeout must not commit into the newer A generation, even though local/active session IDs and phase now match again. The test observes only the store's public state; it does not inspect private generation or timer state and adds no production test port.
- Regression specificity was confirmed by temporarily bypassing that timeout's `setIfCurrent`: the test failed because the old callback changed `runtimePhase` from `creating` to `error`. Restoring the current guard made it pass.
- Validation: focused `agent-session-routing.test.mjs` 19/19; full `pnpm test:unit` 473/473; `pnpm check` with 115 compatibility/permission fixtures; architecture 5/5; lint; full format check; `git diff --check`. No runtime source changed, so no production build rerun.
- Current worktree remains `beta...origin/beta`, package/Cargo/Tauri all `0.4.0-beta.2`; accumulated uncommitted work preserved. Full-repository structural maintenance remains active and incomplete; Slice 190's separate capability-preflight seam still awaits user confirmation.
