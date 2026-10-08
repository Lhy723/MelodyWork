# Pi 原生能力与 Melody 兼容层对照

状态：2026-10-05 · Pi SDK：`1.0.1`

本文回答“迁移到 Pi 后哪些能力可以直接采用 Pi 原生实现，哪些必须由 MelodyWork 的 Host/产品层保留”。**原生可用不等于可以把 Host 安全边界删掉**：Pi worker 以应用用户权限运行，扩展与默认工具也不提供 Melody 的 OS 沙箱、项目权限或产品数据事务。

当前处置：Pi 是唯一 Agent runtime；旧 ACP 会话只读归档。下文标为 Pi 不可用的能力会由能力诊断说明，无法安全满足的配置会阻止打开 Pi；没有运行时 ACP 回退。

## 1. 采用原则

1. **优先使用 Pi 的公开 SDK。** 主循环、provider 适配、流式事件、会话树和压缩不在 MelodyWork 中再实现一份；只在 `packages/agent-worker/src/pi/` 依赖 Pi。
2. **产品语义由 Host/contract 负责。** 权限、工作区路径、SQLite 事件、任务归属、模型目录和更新生命周期不能通过 Pi 的“看起来相似”接口替代。
3. **没有等价能力就明确降级或阻止。** 发现用户实际启用的功能需要更强语义时，能力预检必须阻止 Pi 静默降级；不切换到 ACP。
4. **只采用可验证的版本能力。** 本文针对 `1.0.1` npm/tag 基线；升级 Pi 时先跑 contract、worker、Rust、打包 smoke 和真实 provider 样本。

## 2. 可直接采用的 Pi 原生能力

| Melody 能力                          | Pi 原生入口                                                                                     | 当前接法与边界                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider、流式文本/思考、模型切换    | `ModelRuntime`、`AgentSession.prompt()`、`subscribe()`、`setModel()`、`setThinkingLevel()`      | worker 直接复用；Host 只负责模型目录、凭据和产品事件投影。                                                                                                                                                                                                                                                                                         |
| 会话 JSONL、分支、树导航、fork/clone | `SessionManager`、`AgentSessionRuntime`、`navigateTree()`、`fork()`                             | 原生文件按产品 session 派生 opaque 名称；SQLite 只保存绑定/检查点，不伪造 Pi 上下文。                                                                                                                                                                                                                                                              |
| 自动压缩                             | `compaction.reserveTokens`、Pi 的 compaction/branch-summary 事件、`session_before_compact` 扩展 | Melody 的单一百分比阈值按模型上下文窗口换算为 `reserveTokens`；`melody-compaction` 先生成有界 Memory Flush 记录，再调用 Pi 公开 `compact()`，失败时回落 Pi 原生压缩。两遍压缩都会带上由 `melody.todo_state`/`melody.goal_state` 重建的有界任务摘要（否则 custom entry 不进上下文，压缩后模型会丢掉进行到哪一步）；第一遍失败时改为仅任务摘要压缩。 |
| 自定义工具                           | `customTools` / `registerTool()`                                                                | 只注册受控 Host ToolGateway；worker 关闭 Pi 内建文件/终端工具，避免绕过路径和权限检查。                                                                                                                                                                                                                                                            |
| 会话生命周期扩展                     | `pi.on("session_start"/"before_agent_start"/...)`                                               | first-party 扩展用于 Memory Flush/goal；标准 JSON command hooks 由 Host 受控执行（PreToolUse 可阻断，post/session/compaction/subagent 为观察），不能直接加载第三方 JS/HTTP 插件并宣称 Hook 对等。                                                                                                                                                  |
| 会话内自定义状态                     | `pi.appendEntry()`、custom entry                                                                | `todo_write` 与基础 `update_goal` 已用此方式保存分支可恢复的任务/目标状态，且不进入模型上下文；产品事实仍同步到规范事件。                                                                                                                                                                                                                          |
| 模型级 OAuth（Pi 已支持的 provider） | Pi provider credential/OAuth 接口                                                               | 只覆盖 Pi 已知 provider 的登录；产品外部认证命令、OIDC/浏览器流程在 Pi 中不可用，不能把 API key 注入误称为 OAuth。                                                                                                                                                                                                                                 |

## 3. 需要 MelodyWork Host bridge 的能力

这些能力可以在 Pi 回合中使用，但 Pi 本身不是安全或产品实现的所有者：

| 能力                             | 为什么不直接用 Pi                                                            | Host 方案                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件读写、搜索、目录、补丁、终端 | Pi 默认工具没有产品路径/审批/输出归档契约；Pi 没有内建沙箱                   | 受控 `ToolGateway`，统一 workspace、符号链接、`.gitignore`、权限、超时和输出上限。                                                                                                                                                                                                                                                      |
| 权限 allow/deny、计划/问题       | Pi 没有 Melody 的项目规则、历史回放和 renderer 交互语义                      | `tool.requested`/`tool.resolve` + Rust 最终裁决；`update_plan`、`ask_user_question` 使用产品契约。                                                                                                                                                                                                                                      |
| 提问超时                         | Pi 交互 API 不承载 Melody 的项目配置和“禁用计时”语义                         | Host 生成 `questionTimeoutPolicy`，worker gateway 设置有界 timer；资源刷新会清除旧快照。                                                                                                                                                                                                                                                |
| MCP stdio/HTTP/SSE               | Pi 0.85 没有内建 MCP client                                                  | Rust Host 负责配置合并、认证引用、同源校验、超时、取消、进程回收和结果归档。                                                                                                                                                                                                                                                            |
| 子代理与后台作业                 | Pi 的示例不包含 Melody 的任务归属、wait-any/all、取消和预算边界              | Host TaskRegistry + 独立 Pi 子会话；终端任务由 Host 受控进程注册表承接，统一输出、等待、取消和 worker 停止清理。                                                                                                                                                                                                                        |
| 模型目录和凭据                   | Pi 的可用模型列表受 credential 过滤，不能作为设置页完整目录                  | Host 生成版本化目录与短生命周期环境注入，worker 只消费快照。                                                                                                                                                                                                                                                                            |
| Web search/fetch                 | Pi provider API 不等于 Melody 的 URL、重定向和网络安全策略                   | Host-owned bounded web gateway；Pi 只发声明式请求，Host 负责 HTTPS、域名、大小、超时和取消。                                                                                                                                                                                                                                            |
| 基础跨会话 Memory                | Pi 没有 Melody 的全局/工作区作用域与产品生命周期                             | Host-owned `memory_search`/`memory_get`/`memory_remember`、首轮注入和有界 session-end Markdown 快照；工作区 `index.sqlite` 侧车按内容摘要自动同步，读取前校验 schema、摘要、数量、作用域和 mtime，失败即回退 Markdown，`rebuild_melody_memory_index` 提供显式修复；Pi 扩展提供 `/flush` 的压缩前记忆刷新；不把 Host 路径暴露给 worker。 |
| 代码库导航/索引                  | Pi 没有 Melody 的 workspace index，也不能安全暴露任意 AST/文件遍历           | Host-owned bounded tree-sitter bridge；`codebase_navigation` 提供定义、引用、文档/工作区符号、状态、重建和增量刷新，支持 Rust/TypeScript/JavaScript/Python/Go，并在 Host 侧执行最多 64 个路径 glob、16 个空闲工作区索引、文件/字节/结果/AST 深度上限；严格跨文件语义图和未支持语言在 Pi 中不可用并有诊断。                              |
| 产品事件、统计、恢复             | Pi 原生事件没有 Melody 的 product session、幂等 eventId/seq 和 SQLite 检查点 | Rust 规范事件日志 + worker epoch/seq + React 统一投影。                                                                                                                                                                                                                                                                                 |

## 4. 仍不能用 Pi 原生替代的能力

下列能力当前没有 Pi 等价实现；不要为了“全量 Pi”而删除或简化。能力诊断会将其标为不可用；若配置关系到安全策略而 Pi 无法等价执行，则阻止打开该 Pi 会话：

- 第三方 Melody/Claude JavaScript/HTTP 插件、未映射的 Hook 生命周期（如 `Stop`/`StopFailure` 阻断）、动态插件命令/代理；纯 Markdown Skill/命令插件和受控 JSON command hook 子集已由 Host bridge 承接。Rhai workflow 引擎已从产品范围删除。
- 插件/非 stdio/不受信任的 LSP 服务、严格跨文件语义代码图、未支持语言，以及记忆 embedding/vector index、dream consolidation（语义索引与梦境整理）。受信任的 stdio LSP、有限 tree-sitter 代码库导航已由 Host 只读桥接接管。
- image/video generation/edit 等远程媒体任务及 provider 专用参数。
- Melody 的 OS/kernel sandbox 中 Windows 部分、Linux 上 Landlock allow-only 无法表达的 custom deny/network profile，以及真正的进程/网络隔离。macOS 已由 Host 用 Seatbelt 施加在派生的终端/monitor 子进程上；Linux workspace/devbox 也由 Host 在派生子进程的 pre-exec 阶段施加 Landlock ABI 3+，但 worker 进程自身仍继承应用用户权限，Pi 扩展也不受该隔离约束。
- 外部认证命令、OIDC/浏览器 OAuth、动态 remote-settings。
- `update_goal` 的分类器/规划器/验证器、重试/停滞/预算状态机（workflow 引擎已按产品决定删除；scheduler 与 monitor 已由 Host 接管）。

这些项目不是“找一个 Pi API 名字”就能完成的替换；它们涉及产品数据、权限或外部服务的行为契约。基础 Markdown memory（含受控 `memory_remember` 写入和版本化 SQLite lexical sidecar）、两阶段 Memory Flush（含 `/flush`）、基础 `update_goal` 以及有界 token/stall/blocked-attempt 安全护栏已由 Host/Pi 扩展接管。语义 embedding/vector 索引、dream consolidation 与复杂 goal 编排目前在 Pi 中不可用；是否补齐、明确限制或从产品范围移除，应由后续功能决策和真实平台验收确定，不能把它们描述成 ACP 回退能力。

## 5. 升级时的决策检查

每次升级 Pi 版本按以下顺序执行：

1. 对照 release/tag 核验公开 API 是否仍支持 `createAgentSession`、`ModelRuntime`、`customTools`、`appendEntry`、`resourceLoader` 和 compaction 配置。
2. 更新 `pi-compatibility-manifest.json` 与本表，明确“Pi 原生/Host/不可用”归属；不因 API 名称相似而改变能力等级。
3. 运行 `pnpm test:unit`、`pnpm check`、Rust `cargo test --lib --no-default-features`、worker smoke 和三平台打包检查。
4. 使用脱敏 fixture 验证流式、取消、压缩、权限、MCP、子代理、恢复和模型目录；任一关键项失败就阻止该路径通过验收，不切换到 ACP。

结论：Pi 已替代 Melody-build 的 Agent runtime；MelodyWork 继续维护产品宿主、安全边界和桌面集成。当前实现是 **Pi 原生内核 + Melody Host bridge + 明确的能力诊断/安全阻断**，而不是运行时回退到 ACP，也不是把所有旧功能硬塞进 Pi 扩展。
