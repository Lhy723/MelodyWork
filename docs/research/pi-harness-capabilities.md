# Pi Agent Harness 一手资料核验

研究日期：2026-09-05。用途：为 MelodyWork 从 melody-build 迁移至 Pi 的架构设计提供可追溯事实；本文不代表迁移已经实现或兼容性已经验收。

## 1. 核验基线

- 研究仓库：`earendil-works/pi`。本次只克隆并阅读源码，没有安装依赖或运行上游代码。
- 读取的 main HEAD：`9841914c71a74d81abe07f751aefd271fd924e63`，提交时间 `2026-09-05T00:46:34+02:00`。
- 当前源码包版本为 `0.85.0`；已核验正式 tag `v0.85.0` 指向 `107d79f11072bbc8a3a757ed7fd69596bee7d68c`。两者不是同一个提交。建议 PoC 锁定正式 tag / npm 精确版本，并在实施时再次核验 npm tarball 与 lockfile，而非跟随 main。
- 当前包名为 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`，三者声明 Node `>=22.19.0`。旧教程中的 `@mariozechner/*` 不能作为新方案的依赖名称。
- 许可证为 MIT。需保留上游及分发依赖的相应许可信息。

证据：[coding-agent package.json][pkg]、[agent-core package.json][corepkg]、[pi-ai package.json][aipkg]、[v0.85.0 源码][release]、[LICENSE][license]。

## 2. 架构选择：SDK 优先，RPC 可用于验证

Pi 官方同时提供 SDK、JSON 输出、RPC 和交互终端。SDK 明确面向桌面/Web 自定义 UI；RPC 是 stdin/stdout 的 JSONL 协议。对 MelodyWork，建议在自有 TypeScript sidecar 内嵌 coding-agent SDK，由自有协议连接 Tauri；让 SDK 负责 agent loop、模型适配、会话树和压缩，让 Melody 负责产品服务、权限、子代理和现有插件兼容。[SDK][sdk]、[RPC][rpc]

| 接入方式         | 上游已提供                                                            | 迁移判断                                                       |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| coding-agent SDK | AgentSession、ModelRuntime、SessionManager、资源加载、压缩、工具/扩展 | 首选；能复用较完整的 harness，不必重做会话和压缩               |
| `pi --mode rpc`  | 请求应答、流式事件、模型切换、会话操作、扩展 UI 应答                  | 适合 PoC、黑盒对照；原生协议不应直接成为前端长期契约           |
| pi-agent-core    | agent 状态、tool execution、流事件、context conversion                | 适合高度定制；单独采用会重新承担较多 coding-agent 已实现的工作 |
| pi-ai            | 模型/供应商、鉴权、流 API、图片生成 API                               | 不是完整会话 harness；仅替换此层无法实现此次迁移目标           |

这里的选型是工程建议，不是上游要求。不要为了使用 Pi 而重写现有 Tauri 和 React 产品层。仓库还包含 Chord 等模块，但没有证据表明本次迁移必须采用它们。[根 README][readme]、[agent-core README][core]

## 3. 必须使用当前 API，不能照搬旧博客

当前 `createAgentSession()` 返回 session、extensionsResult 和可选 modelFallbackMessage；主要注入点包括 `cwd`、`agentDir`、`modelRuntime`、`sessionManager`、`settingsManager`、`resourceLoader`、`customTools`。`tools` 是工具名称 allowlist（`string[]`），不是工具对象数组。`noTools: "builtin"` 可禁用默认内建工具而保留 custom/extension tools。工具注册和有效工具选择必须显式控制。[SDK 源码][sdksrc]

`AgentSession` 提供 `prompt`、`steer`、`followUp`、`subscribe`、`abort`、`compact`、`abortCompaction`、`setModel`、`setThinkingLevel`、`navigateTree`、`dispose`。新建、切换、fork、导入等替换整个活动 session 的操作属于 **AgentSessionRuntime**：`newSession()`、`switchSession()`、`fork()`、`importFromJsonl()`。切换后 `runtime.session` 会变化，必须重新订阅事件，并在使用 extensions 时重新绑定 extensions UI/context。[SDK][sdk]

鉴权/模型中心现为异步 `ModelRuntime`。Changelog 明确说明旧 `authStorage` / `modelRegistry` factory options、`AuthStorage` exports 已移除。不能设计成继续依赖这些旧接口。[CHANGELOG][changelog]

注意文档与源码不完全一致：SDK 部分图片示例使用 `source` 对象，但当前 `ImageContent` 源码和 RPC 文档均为 `{ type: "image", data: string, mimeType: string }`。实施契约以锁定版本的 TypeScript 类型和测试为准。[pi-ai types][types]、[RPC][rpc]

## 4. 能力事实及 Melody 的保留责任

| 能力                                      | Pi 当前状态                                  | Melody 迁移责任                                                       |
| ----------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| LLM agent loop、工具调用                  | 内建                                         | 用 adapter 归一事件/错误，保留现有交互语义                            |
| 流式文本/思考/tool progress               | 内建事件                                     | 保留 UI markdown、动效、重连和事件补偿                                |
| 会话持久化、分支、压缩                    | coding-agent 内建                            | 保留项目/任务索引和用户原始历史，转换并验证旧格式                     |
| MCP                                       | README 明确不内建，可通过 extension 添加     | 保留 MCP discovery、连接、OAuth、工具映射与权限服务                   |
| subagent                                  | README 明确不内建；仓库有示例扩展            | 自有 supervisor，保留并发、父子关系、独立历史、取消和恢复             |
| plan mode                                 | README 明确不内建                            | 保留模式约束、计划报告、审批及状态，不仅添加一段 prompt               |
| 工具审批、持久权限规则                    | 不内建                                       | 保留现有权限引擎；对所有副作用入口执行策略                            |
| OS sandbox                                | 不内建                                       | 保留/实现现有进程隔离与文件/网络执行边界                              |
| Skills / prompt templates / context files | 内建 ResourceLoader                          | 兼容既有来源、优先级、启停、冲突展示与信任策略                        |
| Pi packages                               | 内建 npm/git/local 资源包体系                | 与现有 Melody/Claude Code plugin manifest 分别适配，不能假设格式兼容  |
| 图片输入                                  | 内建内容类型，受模型能力限制                 | 保留附件校验；不支持 vision 时明确提示，避免静默丢图                  |
| 图片生成                                  | pi-ai 有独立 one-shot ImagesModels API       | 必须注册/桥接产品工具并保留素材存储、进度和取消；不是默认 coding tool |
| 视频、语音等产品媒体能力                  | 本次没有找到等价的完整 coding-agent 原生链路 | 作为自有工具/服务保留，逐项端到端验收                                 |
| 更新、发布、UI 组件、项目导航             | 不属于 harness 替换范围                      | 继续由 Melody 产品层拥有                                              |

证据：[coding-agent README 的 Philosophy][coding]、[SDK][sdk]、[subagent 示例][subagent]、[packages][packages]、[skills][skills]、[图片 API][ai]。

### 权限与扩展的关键边界

Pi 明确以启动用户权限运行。Project trust 只决定是否加载项目资源，不限制后续工具的文件、命令、网络能力。扩展是同权限 TypeScript 模块，可直接调用系统 API。`tool_call` hook 可拦截模型发起的工具调用，但不能隔离任意恶意 extension 自行执行的代码。[security][security]

官方 `permission-gate.ts` 仅是检查少量危险 shell pattern 的示例，不是完整权限引擎，更不能当作 Melody 现有权限系统的替代。应由 Melody-owned ToolGateway 实施统一策略，并将 shell、文件、MCP、媒体、subagent、后台作业等均接入；高权限任意代码插件与不可信项目插件要有明确的信任和进程边界。[permission-gate 示例][permission]

当前工具默认 **parallel**。自定义文件变更工具需使用上游 `withFileMutationQueue()` 或等效且覆盖更广的 Melody 写入调度；并发审批应有独立 request ID、超时、取消、会话归属。不要假定 Pi 会继续遵循原 harness 的串行执行顺序。[agent types][agenttypes]、[extensions][extensions]

### 子代理示例的局限

官方示例可启动独立 Pi 进程，支持 single/parallel/chain、输出和 usage streaming、取消传播；文档描述 parallel 最多 8 项、4 并发。这是**示例默认值**，不是 Pi 平台的硬上限。它不等于 Melody 的持久化多代理管理、应用重启恢复、任务关系、权限继承、UI 点击历史与生命周期语义已经得到满足。[subagent 示例][subagent]

## 5. 事件、取消与恢复

核心事件含 `agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`，session 层另含队列、压缩、自动重试、摘要重试事件。RPC 还文档化 `agent_settled`。应区分“prompt 已接受”与“运行已完成”：RPC `prompt` success 是接受/排队确认，后续失败由事件/消息报告；SDK prompt Promise 等到完整运行结束。[SDK][sdk]、[RPC][rpc]

`steer` 在本次 assistant turn 的工具执行结束后、下一次 LLM 请求前投递；不是抢断当前工具。`followUp` 在 agent 无待执行工具/steering 后投递。RPC 文档明确：若队列仍存在，`abort` 后队列可继续触发执行；若 UI 的“停止”意味着完全停住，须先 clear_queue，再 abort，并决定是否恢复草稿。[RPC][rpc]

原生 RPC 使用 **LF 分隔 JSONL**，不能使用会把 U+2028/U+2029 当换行的通用 reader。原生 request id 并不自动提供 Melody 需要的重放 sequence、幂等 request、流 backpressure 或 session/running-job 持久恢复；自有协议需定义这些字段和行为。[RPC][rpc]

RPC 的扩展 UI `select/confirm/input/editor` 可通过 `extension_ui_request/response` 完成；`custom()` 等 TUI-only API 不可用于桌面原生界面，其他 TUI 设置部分 no-op。SDK 集成应绑定 Melody UI 服务，避免遗漏扩展等待用户输入时的 activity 状态。[RPC][rpc]

## 6. 数据与上下文

Pi coding-agent 默认 JSONL 会话树，entry 通过 id/parentId 关联。当前格式 `CURRENT_SESSION_VERSION = 3`，包含 model/thinking change、compaction、branch summary、custom entries 等。v1/v2 迁移仅针对 Pi 自身旧格式，不会自动认识 melody-build 历史。[session format][format]、[SessionManager 源码][session]

`SessionManager.inMemory(cwd, header, entries)` 在 0.85.0 支持从外部管理 entries 恢复，这是数据库接入的可用入口；但 inMemory 不是自动数据库 backend，不提供应用需要的事务持久化。选用原生 JSONL + Melody 元数据索引，或外部 entry store，必须明确唯一权威来源，避免两个引擎同时写同一历史。[SDK][sdk]、[CHANGELOG][changelog]

自动压缩阈值为 contextTokens > contextWindow - reserveTokens，默认 reserveTokens 16384；支持工具结束与下一次 LLM 之间压缩，保存 CompactionEntry 并重建有效上下文，不删除原始历史。跨 branch 的摘要另有机制。[compaction][compaction]

Melody 的 `auto_compact_threshold_percent` 已可直接投影到该原生设置：Host 保留模型/会话覆盖和 `MELODY_AUTO_COMPACT_THRESHOLD_PERCENT` 进程覆盖，worker 按模型 `contextWindow` 计算 `reserveTokens = contextWindow - ceil(contextWindow * percent / 100) + 1`，因此仍在达到阈值的第一个整数 token 触发。上游 Pi 本身没有 Melody 的两阶段预热/Memory Flush 策略；当前 MelodyWork adapter 已通过 first-party `melody-compaction` 扩展补齐该策略，并提供 `/flush` 兼容命令，失败时回落 Pi 原生压缩。

`AgentSession.getContextUsage()` 可能返回 undefined，压缩后若没有新的可靠 assistant usage 还会返回 `{tokens: null, percent: null}`。产品必须保留 unknown/estimated/measured 区别；null 不能显示为 0。usage 累计总量、当前上下文占用、provider cache tokens 是不同指标。[AgentSession 源码][agentsession]

迁移旧 history 应保留原始格式归档与映射清单；完整处理 toolCall/toolResult 配对、图片与附件引用、取消/错误消息、分支关系、压缩边界、模型标识，以及 provider opaque thinking signatures。不能只把文本 message 数组拷贝过去就宣称无损迁移。[pi-ai types][types]、[session format][format]

## 7. 模型、自定义供应商与媒体

ModelRuntime 支持 custom models.json、provider headers、API key、OAuth、注入 CredentialStore。鉴权优先级是 runtime override、auth.json、环境变量、fallback resolver。模型可用列表是鉴权过滤后的结果；无鉴权本地模型默认也需要 placeholder credential，因此 Melody 应分别展示 configured/available/auth-needed，而非直接把 getAvailable 当设置页的完整列表。[SDK][sdk]、[models][models]

自定义 API 支持 OpenAI Chat Completions、Responses、Anthropic Messages、Google Generative AI，并有 compatibility flags。思考级别必须按当前 model capability 解析和 clamp，不能把 UI 的每个档位生硬映射给所有 provider。credential operation 与远端模型刷新是分离语义，SDK 应加 deadline；默认创建恢复缓存但不会必然刷新远端模型目录。[models][models]、[SDK][sdk]

pi-ai 图片生成与 chat API 分离，使用 ImagesModels/generateImages，为 one-shot，并不参与 tool calling；失败按文档返回 `AssistantImages.stopReason: "error"`，不能只用 catch 判定失败。部分模型支持输入图像编辑。现有 Melody 媒体服务可以先保留，只在契约测试通过后逐 provider 替换为该 API。[pi-ai README][ai]

## 8. 分发及持续升级建议

上游提供 standalone Bun binary 的构建脚本，包含运行时资源；源码 archive 带生成的 model data，可用 offline-model-data 构建，但脚本仍可能安装依赖。SDK sidecar 不能直接假定官方 CLI binary 就是可装入自有业务代码的包；需要单独验证自有 bundling 对动态扩展、WASM、资源路径及 macOS/Windows 的影响。[根 README][readme]、[package.json][pkg]

建议维护量边界：交给上游 agent loop、provider 适配、重试与压缩；Melody 继续拥有权限、插件兼容、MCP、subagents、产品数据和发布。目标是减少底层维护，不是取消所有 harness 周边维护。精确锁定版本、定期升级 PR、fixture 回放与平台 smoke tests、beta 灰度及旧引擎 fallback 应构成升级流程。不要在已签名应用内让 `pi update` 自动替换内置运行时；随 Melody 自身签名更新一起发布。

0.85.0 之前已发生 ModelRuntime、session replacement API 等实质 API 改动，说明不能保证简单跟随版本永不改 adapter。主干不是稳定兼容契约；应为 Pi adapter 独立设置编译、事件、工具审批、模型、历史恢复、取消和压缩回归门禁。[CHANGELOG][changelog]

## 9. 尚须实施验证，不可提前宣称完成

1. 锁定 npm 包与本次源码 API 的一致性，以及 Node sidecar 或 Bun bundle 在 macOS ARM/x64、Windows 的资源加载与签名打包。
2. 当前每个 Melody provider 的鉴权、思考参数、usage、streaming、tool calling、图片、代理环境兼容性。
3. 工具、MCP、插件 hooks、agent 模式、权限、subagents、媒体所有入口的无功能退化对照。
4. 原 history 到 Pi session 的无损展示与可继续运行，尤其压缩/工具配对/provider signature 边界。
5. 同会话单 writer、多任务并发、停止/断开/崩溃/恢复的竞态；避免重复执行有副作用的工具。

### 9.1 本地原型的发布包注意事项

对 `@earendil-works/pi-coding-agent@0.85.0` 的 npm tarball 做了独立安装 smoke test。其 SDK 入口在动态加载时会解析 `@earendil-works/pi-server`，但该包没有出现在 coding-agent 的发布依赖列表中；因此本仓库的原型 worker 直接精确锁定同版本 `@earendil-works/pi-server`。这不是对上游源码的补丁，也不代表生产打包已经完成；升级 Pi 时必须重新检查发布 tarball 的依赖闭包和三平台 bundle。

[readme]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/README.md
[pkg]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/package.json
[corepkg]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/package.json
[aipkg]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/package.json
[release]: https://github.com/earendil-works/pi/tree/107d79f11072bbc8a3a757ed7fd69596bee7d68c
[license]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/LICENSE
[coding]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/README.md
[core]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/README.md
[sdk]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/sdk.md
[sdksrc]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/sdk.ts
[rpc]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/rpc.md
[changelog]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/CHANGELOG.md
[types]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/types.ts
[agenttypes]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/types.ts
[extensions]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/extensions.md
[permission]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/examples/extensions/permission-gate.ts
[subagent]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/examples/extensions/subagent/README.md
[security]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/security.md
[packages]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/packages.md
[skills]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/skills.md
[ai]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/README.md
[models]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/models.md
[format]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/session-format.md
[session]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/session-manager.ts
[compaction]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/docs/compaction.md
[agentsession]: https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts
