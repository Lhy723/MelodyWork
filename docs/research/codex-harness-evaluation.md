# 用 OpenAI Codex 作为 MelodyWork 底层 Agent Harness 的评估

_调研日期：2026-09-02；范围：官方 OpenAI 文档与 [`openai/codex`](https://github.com/openai/codex) 主分支源码。_

## 结论

**可以做，而且很值得做成可选后端；但不建议现在把 Melody Build 直接、一次性替换掉，也不建议 fork Codex 后自行改内核。**

更合适的方向是把 MelodyWork 从“绑定 `melody-pager` 的 ACP 客户端”演进为“有版本化适配器的桌面控制面”：

1. 保留现有 Melody Build 后端；
2. 新增 `Codex app-server` 后端，先作为实验性/可选引擎；
3. 使用官方发布的、**固定版本**的 Codex 二进制或要求用户安装该版本，走 stdio JSONL；
4. 只在兼容性测试通过后，逐个升级到新的稳定 Codex 版本，绝不跟踪 `main` 或 alpha 版本。

这样可以把 Agent loop、沙箱、审批、MCP、skills、插件和不断增加的 Codex 功能交给上游维护，同时继续由 MelodyWork 维护它真正有差异化的部分：桌面 UI、项目/任务组织、Git 审查、工作区导航与本地数据库。

最大的前提是产品是否接受 **OpenAI Responses API 优先**。当前 Codex 的自定义 provider 只支持 `responses` 协议；而 MelodyWork 现在还支持 Anthropic Messages 和 OpenAI-compatible Chat Completions。因此，若必须无损保留 DeepSeek、Anthropic、OpenRouter 等现有模型接入，不能把 Codex 当作无改动的替代品，除非这些服务提供兼容的 Responses API，或另行维护一个协议转换层——后者会重新引入大量维护成本。

## Codex 提供了什么可定制面

| 维度 | 可直接利用的能力 | 对 MelodyWork 的含义 |
| --- | --- | --- |
| 配置与项目规则 | `~/.codex/config.toml`、受信任项目的 `.codex/config.toml`、profiles、`AGENTS.md`、hooks、子 Agent 配置与权限 profiles。项目配置不能覆盖 provider/auth 等机器级项。 | 可以继续保留“应用/当前项目”两级设置，但需要把现有 `.melody/config.toml` 映射/迁移为 Codex 配置，并明确哪些只能在用户级设置。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) |
| 沙箱与审批 | `read-only`、`workspace-write`、`danger-full-access`；可配置额外可写根、网络、细粒度审批。App server 的 turn 可覆写 `cwd`、审批和沙箱；外部宿主已沙箱化时可声明 `externalSandbox`。 | 能覆盖当前的 ask/auto/always-approve 概念，但原生授权 UI 和持久化 allow-rule 逻辑要改为处理 Codex 的 approval 请求。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)；[app-server 协议](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |
| MCP 与插件 | 支持 stdio / Streamable HTTP MCP、OAuth、逐 server / tool allowlist 和审批；plugins 可打包 skills、MCP 与 assets。 | 比现有 MelodyWork 的 MCP / Marketplace 更接近上游生态；可以逐步改为展示与管理 Codex 的配置，不需要重造 server lifecycle。[MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) |
| Skills | 复用 `SKILL.md` 格式；会扫描 repo 的 `.agents/skills` 与用户 `$HOME/.agents/skills`，支持插件化分发和按需载入。 | 现有本仓库及用户的 `.agents/skills` 有很高复用度，不必迁移格式。[Skills 文档](https://learn.chatgpt.com/docs/build-skills) |
| 供 UI 嵌入的接口 | `codex app-server` 是官方 VS Code 扩展使用的接口，双向 JSON-RPC；stdio/JSONL 是推荐的本地传输；可生成与运行版本精确匹配的 TS / JSON schema。 | 这是 MelodyWork 应接的目标，而不是 CLI TUI，也不是 ACP。可以用 schema 生成 + contract tests 管住升级风险。[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |
| CLI / 自动化 | `codex exec`、`mcp`、`plugin`、`review`、`sandbox` 等是 stable；`app-server` 被官方标为 experimental；旧 `codex mcp-server` 已 deprecated。 | 适合将 headless / CI 能力交给 `codex exec`，但桌面嵌入仍应以 app-server 为准，不能把 MCP server 当成 UI 运行时的替代品。[CLI 参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli) |

## 维护收益与边界

### 能省掉的维护

- Agent loop、上下文压缩、线程/turn 生命周期、工具执行、子 Agent、模型认证、MCP OAuth、插件与 skill discovery。
- 跨平台沙箱与审批演进：Codex 已把这些作为核心产品面维护。
- 未来官方 CLI / IDE 新功能的底层能力；只要 app-server 暴露了稳定事件和方法，MelodyWork 可选择性接入。

### 仍然要维护，而且不能低估

- **协议适配器。** 现有 MelodyWork 使用 ACP stdio：`session/new`、`session/load`、`session/prompt` 及多个 `x.ai/*` 扩展；Codex app-server 使用 `thread/start`、`thread/resume`、`turn/start`、`item/*`、`thread/*` JSON-RPC 事件。两者不兼容，不能只替换 sidecar 路径。
- **本地状态迁移。** 当前 SQLite 持久化 `acp_session_id` 和 `acp_cursor`；新后端要保存 Codex `threadId`、turn/item 游标与版本，旧会话需要继续以 Melody 后端恢复，或只做只读归档。
- **UI 投影。** 会话信息、计划审批、轨迹、子 Agent、token 统计、文件 diff 与权限弹窗都依赖当前 ACP 事件形状。应新增一个内部统一事件模型，再分别由 ACP/Codex 适配器填充它，而不是把 Codex JSON 直接散落进组件。
- **配置和模型。** 目前 [`src/features/settings/model-settings-utils.ts`](../../src/features/settings/model-settings-utils.ts) 明确支持 Responses、Anthropic Messages 与 Chat Completions；Codex 自定义 provider 虽可配 `base_url`/headers/API key，但官方文档明确 `wire_api` 目前只有 `responses`。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- **安全边界。** 现有 [`src-tauri/src/acp_policy.rs`](../../src-tauri/src/acp_policy.rs) 限制消息方法、禁止客户端注入 MCP，并在 Rust 侧二次确认敏感操作。切到 Codex 时必须保留同等的宿主验证，而不是仅信任上游配置。

## 与当前 MelodyWork 的具体差异

| 当前实现 | Codex 迁移后的对应物 | 风险/工作量 |
| --- | --- | --- |
| [`src-tauri/src/agent_runtime.rs`](../../src-tauri/src/agent_runtime.rs) 固定启动 `melody-pager agent --no-leader stdio` | 启动 `codex app-server --stdio` | 中等：子进程管理可复用，协议层要重写。 |
| ACP JSON-RPC + `x.ai/*` 扩展 | Codex app-server JSON-RPC thread/turn/item/approval | 高：没有 ACP 兼容层。 |
| `~/.melody/config.toml` / `.melody/config.toml` | `~/.codex/config.toml` / 信任后的 `.codex/config.toml` | 中等：配置语义与 scope 不同。 |
| 多后端模型（Responses、Messages、Chat Completions） | 自定义 provider，但仅 Responses wire protocol | 高：可能是产品路线的决定性约束。 |
| 原生 Tauri 确认框和 session allow rule | app-server 反向 approval 请求 + 现有原生 UI | 中等：可以复用 UI 与数据库概念，但要重新映射。 |
| Melody Build 作为固定 Git submodule / 随应用编译 sidecar | 上游 Codex 固定 release 二进制或已安装 CLI | 中等：构建成本下降，但增加版本兼容测试和多平台分发检查。 |

## 更新节奏与兼容性判断

可以“跟着它更新”，但要把它理解为**有门禁的依赖升级**，而不是自动同步。2026-09-02 的官方 GitHub Releases 在约四天内已出现多个 stable 与 alpha Rust 版本（例如 `rust-v0.151.0`、`rust-v0.152.0`、`rust-v0.152.1`，以及大量 alpha）。这说明上游活跃、收益很大，也说明直接追 `main` 会非常脆弱。[官方 Releases](https://github.com/openai/codex/releases)

尤其要注意：官方 CLI 参考把 `codex app-server` 标为 **Experimental**，并写明它主要用于本地开发/调试且可能无通知变更；其 WebSocket transport 也明确标为 experimental / unsupported。应只用本地 stdio JSONL，并把 app-server API 当作“有稳定子集的快速演进接口”。[CLI 参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)；[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

另外，源码提供 `codex app-server generate-ts` 和 `generate-json-schema`，生成产物保证与**当前运行的 Codex 版本**匹配。这很适合在 CI 中对升级版本做 schema diff 与契约回归。[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

许可上，源码为 Apache-2.0；作为独立 sidecar 集成通常比 fork 轻，但重新分发二进制/源码时仍需按许可证保留 LICENSE、适用的 NOTICE 和第三方 notices。[Codex LICENSE](https://github.com/openai/codex/blob/main/LICENSE)

## 推荐的迁移路线

1. **先抽象，不改默认引擎。** 定义内部 `AgentBackend`：`start/resume/submit/cancel`、事件流、approval、session persistence、capabilities；把现有 ACP 放进 `MelodyBackend` 适配器。先用现有行为跑回归测试。
2. **做一个隐藏的 Codex POC。** 用本地 `codex app-server --stdio` 建立 `initialize → thread/start → turn/start → approval → resume` 的最小闭环；只支持单工作区、单模型、read-only/workspace-write 两种安全级别。
3. **建立版本门禁。** 固定一个 non-alpha Codex 版本；在 CI 生成 schema，跑录制的 JSONL golden tests（文本、工具、文件修改、审批、取消、恢复、子 Agent、MCP error）。升级失败就维持旧 sidecar，保留 rollback。
4. **先迁移可复用功能。** 先复用 `.agents/skills`、MCP 配置读取、`codex exec`/review；待事件适配稳定后再迁移主聊天。
5. **再做产品决策。** 若 Codex + Responses-compatible provider 能覆盖用户主力模型与成本需求，再将它设为默认；否则保持双引擎，并把“选底层 Agent”显式做成高级设置。

## 最终建议

若目标是**少维护 harness、更多吃上游能力**：做 Codex app-server 的可选后端，值得投入。

若目标是**保留对任何 Chat Completions / Anthropic / 自建模型的无损支持，并深度定制 agent loop**：不要整体替换；最好先抽象后端，继续让 Melody Build 承担多模型的主路径。把 Codex 当成一个高能力、更新很快、但协议和模型接口都需要版本防火墙的上游引擎，而不是可以直接替换 ACP sidecar 的 drop-in dependency。
