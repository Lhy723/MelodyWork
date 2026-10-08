# Melody-build → Pi 迁移验收报告

日期：2026-10-05 · 分支：`beta` · Pi SDK：`1.0.1`

## 当前结论（2026-10-05）

Pi 是唯一 Agent runtime，旧 ACP 会话只读归档；外围能力缺口在 Pi 会话中给出诊断，无法安全保留的策略会阻止打开 Pi，不存在运行时 ACP 回退。Pi SDK 锁定为 1.0.1。Browser/Explorer 已有 Host→worker→UI 实现，但本地预览 fixture 不是原生桌面 Pi 验收；真实 OS 截图权限、浏览器 profile、Explorer 重启恢复及故障注入仍需在桌面环境完成。

本轮验收结果与未完成现场项见下方“2026-10-05 本地复验”。本报告随后保留的 2026-09-11 章节是历史记录，里面的 opt-in、默认 ACP 和 fallback 描述已被取代，不能作为当前行为依据。

## 2026-10-05 本地复验

| 检查                                                                      | 结果                                         |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| `pnpm check`（TypeScript、agent-contract、worker、打包配置、Pi 兼容门禁） | 通过；manifest 与 worker 能力声明一致        |
| `pnpm test:unit`                                                          | 382 passed                                   |
| `pnpm test:agent-worker`                                                  | 137 passed                                   |
| `pnpm test:pi-worker-smoke`                                               | 2 passed（健康握手、模拟完整工具往返）       |
| `pnpm lint`、`pnpm format:check`、架构/字体检查、`git diff --check`       | 全部通过                                     |
| `CARGO_HOME=/private/tmp/melodywork-cargo-check cargo test --locked`      | 271 passed；0 failed                         |
| `cargo check --locked`、`cargo fmt --all -- --check`                      | 通过                                         |
| `pnpm build`                                                              | 通过；Vite 提示若干压缩后 chunk 超过 500 KiB |

本轮 Pi 兼容门禁先在旧声明上失败，再在清除运行时 ACP fallback 描述、修正 Browser 能力并同步 manifest 后通过。`package.json`、`src-tauri/Cargo.toml`、`tauri.conf.json` 均为 `0.3.3-beta.4`，Pi SDK 为 `1.0.1`；分支仍为 `beta`。本轮未提交、未推送、未发布。

**仍待现场验收：** 真实 Provider/认证与 OAuth、Tauri 桌面 Browser 的真实 profile 和 OS 截图权限/裁剪、Explorer 的重启恢复/并行分支/worker 接受确认丢失注入，以及三平台打包签名。本地 worker smoke 和 ACP preview fixture 都不算这些桌面 E2E 通过。

## 2026-09-11 历史验收记录（已被当前结论取代）

## 本轮补齐

### P0.1 真实配置盘点（脱敏）

用真实桌面配置（不提交路径、插件名以外的用户数据）跑通 Host 预检后得到的结论：

- 模型侧只有两个 `chat_completions` provider，默认模型与思考强度均可映射到 Pi 模型目录；没有 Responses/Messages 样本，真实 provider 验收仍未完成。
- Memory 只有基础 Markdown 生命周期（全局开关开启、session-end 保存开启、首轮注入关闭），不触发 ACP 回退；无 embedding/vector/dream 配置。
- 没有 Hook 定义、没有 MCP 服务器、没有 LSP 服务器定义、没有沙箱、没有外部认证/OIDC、没有工作流或复杂 goal 编排；`features.lsp_tools = true` 但没有可执行的 server 定义。
- 启用了 3 个插件（其中 1 个已不在安装目录中，等于无效条目）；这 2 个已安装插件分别带有 `agents/` 或 `scripts/` + manifest 资源路径，属于当前定义的动态表面。

**发现的关键缺陷：Host 的插件启用判定与 Melody 真实语义不一致。** Melody 只在插件被 `[plugins].enabled` 显式列出且不在 `[plugins].disabled` 时才激活它（`melody-agent` 插件注册表：`enabled = !is_disabled && explicitly_enabled`），marketplace clone、install cache 和 `installed_plugins.json` 里的插件默认是**未启用**的。Host 之前只判断“不在 disabled 列表”，于是把磁盘上发现的每个插件都当成已启用：

- 真实配置下预检把 **49 个插件**判为启用（其中 43 个用户从未启用），产生大量 `pi.plugins_unavailable` 阻塞诊断，使该配置的 Pi 会话**每次都静默回退到 ACP**；
- 同一个错误标记还让 Skill/命令投影带上了从未启用插件的资源（实测受控 Skill 路径 122 → 112、命令模板 42 → 35），Pi 会看到用户没有启用的插件命令。

### 修复：插件启用判定与 Melody 对齐

- Host 统一使用 `PluginEnablement`：合并用户/项目 `[plugins].enabled` 与 `[plugins].disabled`（项目按 Melody 的数组替换语义覆盖用户），只有“显式启用且未禁用”的插件才是 active，`disabled` 优先；同时支持 Melody 写回的 `<scope>/<hex8>/<name>` 插件 id 形式（`melody plugin add` 写的就是 id）。
- 该判定同时作用于 Pi 预检/资源投影（`pi_plugin_resources`、`pi_skill_roots`、`pi_prompt_scan_roots`）、Settings 的扩展列表和已安装插件列表，避免三处各用一套规则。
- Skill/Hook 仍保持 Melody 的“只有 opt-out 列表”语义，类型上不可与插件规则混用。
- 新增契约测试：磁盘存在但未列出的插件不得激活、`disabled` 覆盖 `enabled`、id 形式可激活、格式错误的 `enabled` 段不能激活插件、Skill 扫描保持 opt-out。
- 兼容清单新增 `pluginActivation` 事实源，`pnpm check:pi-compatibility` 会在 Host 丢失该语义时报错（已用反向扰动验证该检查真的会失败）。
- 修复后该配置只剩真正启用的插件参与判定，用户可以看到准确原因，而不是 43 个从未启用的插件。

### 修复：声明式插件表面与智能体定义（本轮第二批）

真实配置里两个启用插件的组件全部是声明式的（`agents/*.md`、`commands/*.md`、manifest 声明的嵌套 Skill 目录），但旧规则把它们当成动态表面，加上用户 6 个 agent 定义中的 frontmatter 写法，Pi 仍然不可用。本轮按“Melody 实际会执行什么”重划边界：

- **声明式 = 可在 Pi 加载**：`skills/`、`commands/`、`agents/`（Markdown），以及带 `./` 前缀、指向多级目录的 manifest 声明路径。`safe_plugin_path` 现在只拒绝 `..`、绝对路径和符号链接，而不再拒绝 `./`；声明的 Skill 目录本身（含 `SKILL.md`）会作为 Skill 投影，不再要求它必须是“容器目录”。
- **可执行 = 继续回退 ACP**：`hooks/`（Host 会执行命令）、`.mcp.json`、`.lsp.json`、manifest `extensions`，以及不安全的 manifest 路径。
- **不再当作动态表面**：`scripts/`、`bin/` 目录和 Skill 内的脚本文件。Melody 从不直接执行插件脚本，只能经 hook 触发，而 hook 已经被单独识别；脚本对模型而言只是普通文件，要运行仍需经过 Host 终端工具的权限与工作区边界。
- **插件 agent 真正可用**：新增 `agent_roots` 投影，插件 agent 以 `<plugin>:<agent>` 限定名注册，裸名在没有同名定义时才注册（与 Melody “原生定义优先”一致）。清单里同时出现限定名与裸名，模型可通过 `spawn_subagent` 的 `agent`（或 `subagent_type`）选中它们。
- **Agent frontmatter 规则与 Melody 的 `AgentDefinition` 对齐**：Melody 反序列化时不拒绝未知键，因此只有它自己会读取的字段才算策略面（`tools`/`disallowedTools`/`mcpServers`/`hooks`/`memory`/`toolConfig`/`maxTurns`…），其余（`color`、`Context:`、示例块等）按惰性元数据处理。真实定义里的多行 flow 列表（`tools: ["Read",` 续行）和块列表（`- Read`）都会被正确解析。
- **工具白名单 → Pi 能力上限**：`tools` 会被换算成最窄的 Pi ceiling（无写/执行 → `read-only`；只有写 → `read-write`；只有终端 → `execute`；写+终端 → 新增的 `read-write-execute`）。无法精确表达的（MCP 调用、`disallowedTools` 的减法、未知工具名）继续按不支持处理并回退 ACP，而不是放宽权限。
- **新增 Pi 能力档位 `read-write-execute`**：契约、worker 策略校验、网关工具集与父子交集都已支持。此前“写文件 + 终端”只能表达为 `all`，会额外授予 MCP 调用；现在这一档既满足 Melody 常见的 `["Read","Write","Edit","Bash","Grep"]` 定义，又不放开 MCP。
- **按工具授权 MCP 调用**：子代理策略新增有界 `mcpTools`（精确 `mcp__<server>__<tool>`，最多 64 条，server ≤ 64 字节、tool ≤ 96 字节），Host 从 agent 定义的 `tools` 收集，worker 在网关层按调用校验；子代理只能调用其定义点名的工具，父级没有 MCP 能力时派生也不能获得，`resume` 会保留同一授权集合。格式不合法的名字（缺 server/tool、含空格、超长）仍按不支持处理并回退 ACP。

修复后真实配置的预检结果：启用插件全部为 `static`（无动态表面），受控 Skill 路径 159、命令模板 37，**10 个子代理定义全部可用**（0 个 unsupported），其中 `literature-reviewer` 以 `read-write` 上限 + 14 个 `mcp__zotero__*` 精确授权留在 Pi；`code-reviewer` 为 `execute`、`tdd-guide`/`paper-miner` 为 `read-write-execute`、`rebuttal-writer` 为 `read-write`。该配置不再因为插件或子代理定义触发 `requiresLegacyEngine`。

### 修复：`[skills].ignore` 路径前缀保真（本轮第三批）

Melody 把 `[skills].ignore` 当**路径前缀**处理（不是 glob）：展开 `~`、相对项按工作区解析、把 canonical 路径落在前缀下的 Skill 直接从列表里**隐藏**（与 `disabled` 的“保留但注入时排除”不同），并且是在合并插件 Skill **之前**过滤。Host 之前只实现了 `disabled` 名称维度。

- Host 新增 `pi_skill_ignore_paths`（用户/项目合并、项目覆盖用户、`~` 展开、相对路径按工作区解析、canonicalize、上限 64 条 / 单条 4096 字节），并把它附着到**原生** Skill 根（`.melody`/`.agents`/`.claude`/`.cursor`），插件根不带忽略列表——与 engine 的过滤顺序一致。
- 该前缀同时进入 `pi_resource_manifest` 的 `skillRoots[].ignorePaths`，worker 在刷新时按同一套前缀过滤；否则用户在会话中途新建的 Skill 会在下一次刷新后“复活”。
- worker 的 root 信任从“精确等于受信根”放宽为“等于或位于受信根之内”，因为插件 manifest 声明的是具体 Skill 目录（`skills/<group>/<name>`）；同时声明目录本身含 `SKILL.md` 时会被当作 Skill 投影。相对路径、`..` 前缀会被丢弃而不是相对 worker 的 cwd 解析。
- 契约新增 `AgentSkillResourceRoot.ignorePaths`，兼容清单新增 `hostBridges.skillPaths.skillIgnore` 事实源，`pnpm check:pi-compatibility` 校验 Host/worker 双端上限与过滤函数是否存在（已用反向扰动验证会失败）。

真实配置验证：`ignore = ["~/.agents", ".agents"]` 解析为 `/Users/lhy/.agents` 与 `<workspace>/.agents`，受控 Skill 路径从 **159 降到 100**（隐藏 59 个），投影中位于忽略前缀下的 Skill 数量为 0。随后插件按 name 收敛，重复安装的 `mattpocock-skills` 只保留一份，最终受控 Skill 路径为 **75**、命令模板 36——复验时插件 45 个被发现、2 个启用且全部 `static`，10 个 agent 定义 0 个 unsupported，LSP/Hook 均为 0。

### 修复：插件重名收敛与 `[plugins].paths`（本轮第四批）

- **重名按来源优先级收敛。** 之前只按 canonical 路径去重，同一插件从 `installed-plugins` 与 marketplace cache 各发现一次就会在清单和诊断里出现两次。现在按 Melody 的优先级（project > user > 配置目录，同 scope 内取先发现者）每个 name 只保留一个。真实配置：发现的插件 49 → 45，启用插件 4 条 → **2 条**（每个插件一条）。
- **纳入 `[plugins].paths`。** Melody 会扫描这些自定义目录，并把它发现的插件加入启用列表（目录本身就是用户显式配置的），因此这类插件标记为 `config` scope、默认启用、显式 `disabled` 仍优先。之前 Host 完全看不到这些目录，插件对 Pi 不可见——属于“静默缺失”方向的风险。上限 64 条。
- 兼容清单 `pluginActivation` 增加 `configuredPaths` 与 `nameConflictPrecedence` 事实源；`pnpm check:pi-compatibility` 校验 Host 是否真的扫描 `[plugins].paths`、是否按配置来源自动启用、是否按 name 收敛（已用反向扰动验证会失败）。

### 本轮新增：持久调度状态层（P1.1 第一片）

Melody 的 workflow 原本是 **Rhai 脚本引擎**（`melody-workflow`：`run_workflow`/`validate_script`/agent budget/host calls/journal）。**该能力已按产品决定从迁移范围删除**（设置界面不再提供“启用工作流”，能力预检不再因 `workflows.enabled` 回退，兼容清单记入 `retiredCapabilities`）；周期任务由 Host schedule 承担，因此这里只做 Host 侧持久状态与触发契约：

- schema v11 新增 `agent_schedules`（产品 session/project 归属、`once`/`interval`、间隔/期限/maxRuns、`skip`/`run-once` 错过策略、状态、next/last run、runCount、创建时的 permission/session/mode/model 身份快照、revision）与 `agent_schedule_runs`（fired/skipped/failed 审计行）。
- 生命周期是纯函数：错过的触发按策略**跳过或只补一次**，永不爆发式重放；`once` 在到达时间即到期；`failed` 的派发保留 schedule、只推进时间槽且不增加 runCount（避免坏派发器空转）；终态（completed/expired/cancelled）不能被旧 renderer 复活；resume 会重算下一次触发而不是补跑暂停期间的所有槽位。
- 触发速率下限（5s）与 maxRuns/expires 上限由 Host 强制，renderer 不能伪造起点或绕过下限。
- 契约新增 `schedule.changed`/`schedule.fired` 与 `AgentScheduleRecord`；前端投影把它们作为辅助事件（不是时间线行，也不报“未知事件”）。
- 新增 8 个 Rust 测试（间隔不重放、错过策略、maxRuns/expires 完成、存储校验、pause/resume/cancel 规则、失败保留、删除清理 journal）与 1 个投影契约测试。

**当时的边界（后续已被本文件后面几片补齐）：** 这一片只做了持久状态与产品事件；执行器/派发、monitor 语义与两者的界面随后分别补齐。Rhai workflow 引擎不再实现——它是被删除的产品能力，而不是待补的回退项。

**同时修掉一个本轮引入的生命周期缺陷：** 会话/项目删除原本会显式清理 binding/event log/journal（因为旧库可能没开外键），但新加的 schedule 表没有一起清理，会留下仍能触发的孤儿定时器。现在把这段清理抽成 `purge_session_agent_rows`（会话）并在项目删除路径同样清理 schedule 与 run journal，并补了三条回归测试：v10 → v11 升级后 schedule 表可用且旧数据不丢、删除会话清空 schedule 与 journal、删除项目清空其会话的 schedule。

### 本轮新增：调度执行器与接受确认关联（P1.1 第二片）

状态层只回答"什么时候该触发"；这一片回答"Host 现在是否可以把这条提示词跑起来"，并且**在 worker 真正接受之前不许记账成功**：

- **接受确认关联**：Host 为每次派发生成稳定的 `promptId`（`pi-schedule-<id>-<ordinal>`），在 supervisor 里登记一个有界的待确认表（上限 32，`promptId → oneshot`）。`run.accepted` 到达 → Accepted；匹配 `requestId` 的 `runtime.error` → Rejected（带 worker 的稳定错误码）；15s 超时或 worker 世代结束（崩溃、强杀、重启）→ Unacknowledged 并解除登记。世代结束时清空待确认表，避免用死掉的 worker 的迟到事件充当"已接受"。
- **会话配置 revision 跟踪**：`turn.submit` 必须带与 worker 相同的 `config.configRevision`，否则被 `pi.config_revision_conflict` 拒绝。supervisor 现在从 `session.opened/configured/imported` 事件记录每个产品会话的权威 revision（新世代从 0 重新开始），派发时使用它——与渲染端用同一套乐观并发令牌。
- **决策与记账是纯函数**：`plan_dispatch`（worker 未运行 → **跳过**而不是失败；工作区不匹配 → 跳过；会话已有 Host 回合在飞 → 跳过；错过窗口按策略跳过；会话已删除 → **取消定时器**而不是永远失败；ACP 绑定会话 → 明确失败）与 `outcome_status`（busy 拒绝映射为"跳过并记录原因"，其余拒绝记 failed 并带 worker 错误码，超时记 failed）。触发速率下限、maxRuns/expires、错过策略全部复用一个实现。
- **权限不放大**：派发用的身份 = schedule 创建时的快照 ∩ 会话当前绑定（`narrow_permission_mode` 取更窄者），命令完全由 Host 从持久化绑定构造，renderer 无法注入模型或权限。
- **不重叠**：`DispatchRegistry` 按会话登记在飞派发，避免同一会话叠两条 Host 回合；同时保留 worker 端的幂等键（`pi-schedule-<id>-<ordinal>`），真实的重复帧会被 worker 账本抑制。
- 新增 7 个纯函数/注册表测试（计划分支、错过策略、过期、确认到记账映射、身份收窄、同会话只派发一次）。

- 补上 Melody-build `list_dir` 的 Pi 映射：`workspace_list_directory`。
- 增加 Host-owned tree-sitter 代码库导航桥：`codebase_navigation` 支持 Rust、TypeScript/JavaScript、Python、Go 的定义、引用、文档/工作区符号、状态、重建和增量刷新，并复用 Melody 的 `features.codebase_indexing` 布尔值/路径 glob 语义；文件、字节、结果、AST 深度和工作区缓存数量均有界。
- 目录浏览只允许登记工作区内的相对目录；默认跳过隐藏项和常见生成目录，不遍历符号链接，并限制递归深度、条目数和输出大小。
- Rust Host、worker 能力清单、工具分派和权限模式使用同一工具名；增加了路径越界、文件目标、隐藏/生成目录、深度和绝对路径泄露回归测试。
- 将 Melody 的 `.gitignore` 可见性策略补到 Host ToolGateway：搜索与目录列表复用 `ignore` 规则，读取、编辑和删除忽略目标会被拒绝；策略由 Host 配置解析，worker 请求中的同名字段不能关闭这一边界。
- 增加 worker 直达测试，验证目录工具会正确发出 `tool.requested`，携带会话、工作目录、权限模式和批准状态，并能在 Host resolution 后恢复执行。
- 将本轮结果写入功能对等矩阵和实施计划，避免把静态能力清单误当作现场验收。
- 将 `toolset.ask_user_question.timeout_enabled` / `timeout_secs` 投影为 Host 生成的 `questionTimeoutPolicy`，通过 worker gateway 为提问交互设置有界计时；禁用计时会明确表示为等待用户，不会误用旧默认值。
- 资源刷新时以 Host 清单为权威快照：当项目配置删除提问超时策略时，worker 会清除启动时遗留的环境变量策略，避免“删除配置后仍沿用旧计时器”。
- 增加 Host-owned Memory bridge：`memory_search`/`memory_get` 使用全局、工作区和 session Markdown 的安全作用域与有界 BM25 排序；`memory_remember` 通过 Host 权限网关追加有界 Markdown 笔记；首轮注入只执行一次并从产品事件/记忆快照中剥离；session-end 按 Melody 的最小交互门槛保存有界 transcript，worker 停止、失败和关闭都会 flush 未完成快照。
- 增加 Host-owned 持久化 Memory lexical index：Markdown 仍是权威源，搜索和记忆写入会同步工作区 `index.sqlite` 侧车；内容摘要未变化时跳过写入，变化时清理旧 chunk；检索只消费通过 schema、摘要、数量、路径作用域和 mtime 校验的侧车行，任何异常都回退 Markdown；设置/诊断可通过 `rebuild_melody_memory_index` 显式重建，索引故障不会阻断 `memory_search`。
- 将 Pi 的 `session_before_compact` 扩展接入 Melody 的两阶段 Memory Flush：先用当前模型生成有界 durable note，再调用 Pi 公开 `compact()`；认证、取消或第二阶段失败时回落 Pi 原生压缩，不阻断会话。
- 增加 first-party `melody-goal` 扩展：基础目标状态、`update_goal`、阻塞计数、完成/暂停/恢复/清除、分支恢复和 `/goal` 命令使用 Pi custom entry 持久化；Host 投影有界 token budget、停滞检测和 blocked-attempt 上限，只有分类器、规划/验证器、重试编排或角色模型策略继续回退 ACP。
- 增加 Host-owned 受限 JSON command Hook bridge：只扫描受信任 `.melody/hooks` 根下的有界 JSON 定义，PreToolUse 可在 ToolGateway 前阻断，PostToolUse/PostToolUseFailure/PermissionDenied、Session/Compaction/Subagent 生命周期按有界 command 执行；环境、stdin/stdout、超时、文件数和 matcher 均有上限，动态 JS/HTTP、未知事件和无法安全回放的 Stop 阻断保持 ACP。
- 增加纯 Markdown 插件资源投影：Host 会校验插件根、清单和组件路径，拒绝符号链接、路径穿越、损坏清单及超限扫描；只把无动态扩展的 Skill/命令目录投影给 Pi，插件 Hook、Agent、MCP、LSP、脚本和其他动态表面继续按能力诊断回退 ACP。

## 已通过的本地验收

| 门禁                                                            | 结果                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| TypeScript、agent-contract、agent-worker、打包配置、Pi 兼容清单 | 通过                                                                 |
| 架构边界检查                                                    | 通过                                                                 |
| 前端/worker 单元测试                                            | **362 passed**                                                       |
| Rust `cargo test`                                               | **247 passed，0 failed**（引擎/ACP 策略的 7 个旧测试随代码一并移除） |
| ESLint（`pnpm lint`）                                           | 通过（0 error、0 warning）；本轮新增 `packages/**` 覆盖              |
| Prettier `format:check`                                         | 通过（本轮把 10 个未格式化的原型文件格式化）                         |
| `cargo fmt --all -- --check`                                    | 通过                                                                 |
| `git diff --check`                                              | 通过                                                                 |
| Rust `cargo build` 警告数                                       | **0**（本轮清掉全部 8 条死代码/未用导入警告）                        |
| Vite production build                                           | 通过；仅保留既有大 chunk 警告                                        |
| Pi worker source/packaged smoke                                 | **2/2 passed**（健康握手 + 完整回合往返）                            |

**已知问题：** `pnpm test:unit` 存在一条**未定位的间歇性失败**——本日约 12 次全量运行中出现 2 次，重跑即绿（连续 8 次全绿未能复现）。CI 输出会打印失败测试名；下次出现时按名定位修复，不要重跑掩盖。

这些结果证明协议、类型、权限边界、Host ToolGateway、事件投影和打包链路自洽；不代表已经用真实第三方 provider 或真实用户插件完成端到端验收。

## 相较 Melody-build 的能力状态

### Pi 原生或 Host 已覆盖

- 流式文本/思考、Markdown、代码、表格和最终消息修复。
- 会话打开、关闭、配置、模型目录、API key 认证、取消、steer/follow-up、重连、幂等事件和有界恢复。
- 文件读取、搜索、**目录浏览**、写入、编辑、补丁、终端、问题、计划、权限审批，以及通过 Pi 内联扩展实现的 `todo_write` 任务列表。
- `toolset.bash` 的前台超时、最大超时和输出预览上限由 Host ToolGateway 按用户/项目配置投影；worker 不能抬高 Host ceiling，超出硬上限时仍会有界截断/归档。
- 上下文/账单/耗时的分离统计，未知值不会伪造为 0；Melody 单一自动压缩阈值按上下文窗口换算为 Pi 原生 `compaction.reserveTokens`，保留包含边界。
- 子代理、后台任务的输出、wait-any/wait-all、取消和归属校验。
- 后台终端由 Host-owned task registry 接管：稳定任务 ID、会话/工作区归属校验、有界输出、wait-any/wait-all、kill，以及 worker 停止时的进程清理。
- 代码库导航由 Host-owned tree-sitter 索引接管：支持 Rust、TypeScript/JavaScript、Python、Go 的定义/引用/符号查询、状态、重建和增量刷新；`features.codebase_indexing` 的布尔值与最多 64 个路径 glob 会在 Host 与能力门禁中保持一致。
- 本地 stdio 与受控 HTTP/SSE MCP 的列工具、调用、取消、超时、失活重连和有界输出归档。
- 基础跨会话 Memory：Host-owned `memory_search`/`memory_get`/`memory_remember`、首轮注入、session-end transcript 快照和 worker 关闭/失败时的有界 flush；搜索/写入生命周期维护版本化 SQLite lexical sidecar，并可通过 `rebuild_melody_memory_index` 修复；Pi compaction extension 负责压缩前 Memory Flush 与 `/flush` 兼容命令；embedding/vector 与 LLM dream consolidation 仍按配置回退 ACP。
- 产品会话树、SQLite 事件日志、Pi 原生 JSONL、迁移 journal、显式 ACP→Pi 导入计划和恢复检查。
- 文件树、编辑器、Git、PTY、更新器、设置、主题、Marketplace、研究服务等产品宿主能力继续由 MelodyWork 保留。

### 仍由 ACP 回退，尚未成为 Pi 原生对等

只要这些能力在当前用户/项目配置或扩展清单中被启用，能力预检就会生成阻塞诊断并切换该会话到 ACP：

- Melody/Claude 插件 JavaScript/HTTP 扩展、未映射的 Hook 生命周期（如 Stop 阻断）、动态插件命令/代理；纯 Markdown Skill/命令插件与受限 JSON command hooks 已由 Host bridge 承接。
- 插件/非 stdio/不受信任的 LSP 服务、严格跨文件语义代码图、未支持语言、记忆 embedding/vector index、dream consolidation；受信任的 stdio LSP、有限 tree-sitter 代码库导航与基础 lexical memory index 已由 Host 桥接接管。
- 远程媒体工具（image/video generation/edit）、其异步 job 与 provider 特定参数。
- 沙箱的剩余面：Windows 无实现（按产品决定降级为无沙箱+显著警告，reason_code `platform-unsupported`）；Linux Landlock 已实现但待 ABI 3+ 真机执法验收；`read-only`/`strict` 网络受限 profile 与 glob deny 仍拒绝打开。macOS Seatbelt 已实现并真实验收；Linux Landlock 接入后受支持 profile 会话留在 Pi。
- 复杂压缩编排（除已接管的两阶段 Memory Flush 外）；单一自动压缩阈值已映射到 Pi 原生 `reserveTokens`，终端超时/输出策略和提问超时策略已由 Host/worker gateway 承接。
- 外部认证命令、OIDC/浏览器 OAuth；Pi 当前使用 Host 管理的 API key。
- 角色/专用模型/类型开关等 Melody 子代理策略。
- Melody 的 goal planning / `update_goal` 分类器验证器、重试编排和角色模型策略；Pi 已原生承接基础 goal 状态、`update_goal`、`/goal` 生命周期命令以及有界 token/stall/blocked-attempt 安全护栏，复杂编排仍回退 ACP。
- ~~持久工作流~~、`/loop`、scheduler、monitor 等跨会话调度：**这一项已消解**——workflow（Rhai 引擎）按产品决定删除，周期任务与流式监视由 Host schedule/monitor 接管，不再需要 ACP 兜底。
- 原版通过远程设置服务动态打开的记忆、LSP、OAuth、订阅/实验开关等，当前没有等价的 remote-settings 拉取与合并层；基础 Markdown Memory 和受信任 stdio LSP 不再属于此缺口。

### 部分能力需要真实环境才能定案

- Responses、Messages、Chat Completions 三类真实模型 provider 的流式、错误、重试、空闲超时和上下文计费。
- 真实 MCP OAuth/认证 provider，以及 macOS、Windows、Linux 的进程回收、证书、代理和路径行为。
- 用户实际插件/Skill 的完整清单；标准 Markdown Skill 和纯 Markdown 插件资源已受控桥接，但插件脚本、扩展和来源不明 Skill 会回退。
- worker 崩溃、强制退出、应用升级中断后的双存储恢复，以及 Pi 子代理在 worker 重启后的原生上下文恢复。
- ~~旧 ACP 会话的真实续聊~~：**不再是验收项**（产品决定不迁移旧 ACP 会话）；既有会话继续由原引擎承载，只读导入计划代码保留但不再要求现场样本。

## 未发现的静默缺失

本轮没有发现“UI 仍显示支持、但 Pi 工具实际不可执行”的未处理映射。尤其是原版 `list_dir` 和受控代码库导航已补齐；超出语言、文件/AST 边界或严格语义图要求的代码索引会在启动前/调用时进入结构化诊断并回退 ACP，而不是被 Pi 忽略。`task.wait` 等旧 ACP 控制不会被伪装成 Pi 能力，Pi 路径使用自己的受控任务工具。

## 发布建议与剩余门禁

可以继续以 Pi opt-in 发布 beta，保留 Legacy ACP 作为默认和兼容兜底。暂不删除 Melody-build/ACP，直到以下项目取得真实样本并记录到[功能对等矩阵](./feature-parity.md)：

1. 真实 provider、MCP 认证和三平台打包/签名/升级验收。
2. 当前用户实际启用的插件、Hook、LSP（含可信 stdio 与需回退项）、memory、媒体和 remote-settings 开关清单。
3. 子代理、后台终端、取消、崩溃恢复和旧会话续聊的破坏性测试。
4. 若目标是最终移除 ACP，再逐项实现上面的回退能力，并为每项增加旧引擎/Pi 对照样本；在此之前移除 ACP 会造成明确的功能减少。

### 本轮新增：monitor 运行时（P1.2 第一片）

读了 vendored 文档后确认 Melody `monitor` 工具的语义是：把命令的 **stdout+stderr 合并**，**每一行变成对话通知**（带描述），`persistent: true` 表示会话级生命周期，**事件过多时自动停止**，用 `kill_command_or_subagent` 停。`run_background_task` 只是累积输出等模型来取，所以不等价。

Host 侧新增 `pi_monitor_runtime`：

- Host-owned 进程注册表（并发上限 16），逐行读取合并流，每行经**长度上限（4 KiB，带 `… [+N chars]` 标记）**后作为 `task.notification` 产品事件写进同一个事件日志、走同一条渲染通道。
- **限速与自动停止**：滚动 60 秒窗口 120 行 + 生命周期 10000 行双重上限，超限即 `auto-stopped` 并给出可操作提示（"加 `grep --line-buffered` 之类的过滤"），不会把洪水灌进对话。
- **生命周期**：`persistent` 会记录并以会话为界；worker 停止/工作区切换/应用退出/`session.close` 都会回收对应 monitor（与后台终端任务同一批钩子），进程不会成为孤儿。
- 结束的 monitor 离开活动表但保留**有界的最终快照**（含尾部输出），所以 `get_command_or_subagent_output` 仍能读到尾部——这是我第一版实现的一个真 bug（开始时清理已完成项，导致刚结束的 monitor 立刻"不存在"），被测试抓到并修掉。
- **模型侧 `monitor` 工具已接通**：worker 侧注册 `monitor`（`command`/`description`/`persistent`），归入 execute 类能力（只读与读写档位拿不到，plan/ask 模式由会话模式门禁拦截），权限身份与终端命令同形（`title\ncommand`），因此 `ask` 模式不会静默批准；Host ToolGateway 的 `MONITOR` 分支启动注册表并把每行事件写入产品事件日志与渲染通道（缺 AppHandle 的无头路径仍可运行，只是不投递）。`get_command_or_subagent_output` / `wait_commands_or_subagents` / `kill_command_or_subagent` 现在接受 `pi-monitor:*` id（含跨会话拒绝与"不与终端任务混批"），所以模型用已有的任务工具就能读流、等待和停止。
- 兼容清单的 worker 工具表新增 `monitor`，`pnpm check:pi-compatibility` 会校验 worker 声明与 Host 执行分支同时存在（已用反向扰动验证会失败）。
- **UI 观察面（monitor）已接通**：投影层新增**有界的 monitor 通知环**（上限 200 条，按会话累积，不进聊天时间线），随 store patch 进入 `agentStore.monitorNotifications`；`MonitorFeed` 挂在“会话信息”面板里（与 SubagentTray/SessionStatsLine 同层），展示运行中的监视器、状态、已发事件数与最近若干行，并可直接停止；`useAgentMonitors` 在运行中每 4 秒轮询、空闲降到 20 秒，空闲会话不产生额外负担。- **调度界面已接通**：`melody-bridge-schedules.ts` 提供 list/create/status/runs/delete 封装（`now` 由 Host 决定），`useAgentSchedules` 以会话为单位读取权威行并在投影的 `scheduleRevision` 变化时刷新（事件只作为"该重读了"的信号，不在 renderer 复制调度状态），`SchedulePanel` 挂在会话信息面板：提示词 + 间隔预设 + 错过策略创建、暂停/恢复/取消/删除、逐条展开 run journal（含 `skipped`/`failed` 的原因）。创建时提交保守基线（ask + default），触发时由派发器与会话当前绑定取更窄者。

### 本轮新增：Host 终端沙箱（macOS Seatbelt）

Melody 的 `melody-sandbox` 在 agent 进程启动时用 `nono` 施加内核隔离（macOS Seatbelt / Linux Landlock），覆盖进程自身与所有子进程。桌面 Host 不能这么做——它是长驻 GUI 进程，必须保留对用户机器的完整访问——所以同一套规则改为施加在**每个终端子进程**上：

- 新增 `workspace_sandbox`：解析 profile（内置 `workspace`/`devbox`/`read-only`/`strict`/`off` + `~/.melody/sandbox.toml`、`.melody/sandbox.toml` 自定义，项目只能新增名字、不能重定义用户 profile），生成规则集；macOS 用 `sandbox-exec -p <SBPL>` 包装 `/bin/sh -lc`，Linux 在每个子进程的 `pre_exec` 阶段安装 ABI 3+ Landlock 规则集后执行 `/bin/sh -lc`。前台与后台终端走同一个命令构造，隔离方式一致。
- **路径先 canonicalize**：这一点是实测发现的——macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，Seatbelt 按解析后的路径匹配，未解析的规则会被静默忽略（我第一次手工验证时就踩到了）。允许写：工作区 + `~/.melody` + 临时目录（含 `$TMPDIR`）+ 设备文件（`/dev/null` 等，否则 git/编译器会碎）。
- **不能执行就拒绝**：profile 还限制子进程网络（`read-only`/`strict`）、含 glob deny、Linux allow-only 无法表达的 exact deny、Landlock ABI 过旧或平台是 Windows 时返回 `unsupported`，命令被拒绝而不是以更弱的隔离运行。平台级例外（产品决定）：完全没有执法实现的 OS（Windows）降级为无沙箱+显著警告，不再拒绝打开。
- 真实执法测试（macOS）：工作区内写成功、工作区外（`$HOME` 下）写被 OS 拒绝且文件不存在、`strict` 被拒绝执行、无 profile 时保持原有不受限行为。
- 能力预检改为读 Host 的 `read_workspace_sandbox_plan`：Host 能执行该 profile → 会话留在 Pi；不能 → 用 Host 给出的原因回退 ACP。此前是"只要配置了 sandbox 就回退"。
- **修复了一处沙箱绕过：** 首次实现只包装了终端命令，`monitor` 工具仍用自己构造的 shell 启动进程——在配置了 profile 的工作区里，模型只要改用 monitor 就能不受隔离地执行命令。现在"把命令变成进程"只有一处实现（`sandboxed_shell_command`），前台终端、后台终端、monitor 三条路径共用同一个决策，不可执行的 profile 对三者都 fail closed。新增真实进程测试：受限 monitor 仍能写工作区、无法写工作区外、`strict` 直接拒绝启动。
- **明确不覆盖的边界：** Host 自己构造并管理的进程（如 `git worktree add` 创建子代理工作树）与按配置启动的 MCP/LSP 服务不经过这层隔离——它们不承载模型给出的 shell 文本；Melody 的进程级沙箱会覆盖它们，这一点记录为差异而不是等价。

### 本轮新增：模型侧调度工具

状态层与派发器此前只有 Host 命令，模型看不到调度能力。这一片把 Melody 的 `scheduler_create`/`scheduler_list`/`scheduler_delete` 补齐为真正的工具：

- worker 侧注册三个工具（`schedulerCreateParameters`/`schedulerListParameters`/`schedulerDeleteParameters`），`list` 归只读类、`create`/`delete` 归写入类并标记 `requiresPermission`；plan/ask 模式由会话模式门禁拒绝，权限身份只取间隔或 task id，**绝不把提示词正文当身份**（提示词可能含用户隐私，出现在审批摘要里会泄露）。
- 间隔解析与 Melody 一致：接受 `5m`/`2h`/`1d` 这类 `s/m/h/d` 后缀，钳制在 60 秒到 30 天之间，非法值明确报错而不是静默取默认值。
- **身份由 Host 从会话实时绑定复制**（engine/session mode/permission mode/model），模型无法通过工具参数放宽权限；非 Pi 绑定会话与"完全没有 Pi 绑定"的会话返回**不同的**拒绝原因，便于用户判断该配置为什么不能调度。
- `fire_immediately` 只把 `next_run_at` 提前到当前时刻，不绕过间隔下限与错过策略；同一 task id 再次创建会复用并更新原 schedule，而不是堆出重复定时器。
- 新增 5 个 Rust 测试（间隔解析/钳制、身份继承、拒绝其它引擎与无绑定会话、立即触发、Host 网关路由）与 1 个 worker 测试（写入类工具在 plan/ask 模式下被拒）。
- 兼容清单新增 `hostBridges.agentSchedules` 事实源（工具名、间隔解析、错过策略、身份来源、拒绝条件、孤儿清理、完成关联），`pnpm check:pi-compatibility` 会校验 worker 常量、Host 分支、身份继承与会话绑定表同时存在（已用反向扰动验证会失败）。

### 本轮新增：压缩后的任务续接

Pi 的压缩摘要决定下一个上下文窗口能看到什么，而 `todo_write`/`update_goal` 的状态是 **custom entry**（不进上下文），所以压缩后模型会"忘记"自己正在做第几步。两遍式 Memory Flush 只解决"记住什么事实"，不解决"继续哪一步"：

- 压缩扩展现在用与工具相同的重建函数（`reconstructTodoState`/`reconstructGoalState`）从分支 entries 生成有界任务摘要（goal 状态 + 条目统计 + 逐条 todo，上限 4000 字符），并写入**两遍的 focus**：第一遍提示模型在笔记末尾原样保留 `## Task state`，第二遍作为 Pi `compact()` 的显式 focus（Pi 会把它作为 `Additional focus` 拼进摘要提示词，因此摘要里一定有它）。
- **第一遍失败也保住任务状态**：provider 不可用或响应为空时，只要摘要存在就改为"仅任务摘要"调用 `compact()`，而不是直接交给 Pi 原生压缩（原生压缩不会带上这个摘要）。只有连摘要也没有时才保持原来的回落行为，失败路径全部保持 fail-open。
- 兼容清单新增 `hostBridges.compaction` 事实源，`pnpm check:pi-compatibility` 会顺着 import 校验摘要真的读了 `melody.todo_state`/`melody.goal_state`，并确认失败兜底路径存在。

### 本轮新增：类型化发现的压缩 header 缺陷

把压缩扩展里的 `any` 换成 SDK 类型（`ModelRegistry["complete"]`、`CompactionResult`、`ExtensionContext["model"]` 等，worker 只从 `pi-coding-agent` 取类型）时，编译器直接暴露出一个真实缺陷：`ResolvedRequestAuth.headers` 允许值为 `null` 表示"删除这个 header"，Pi 自己在压缩前会过滤（`withoutDeletedHeaders`），而扩展把 `auth.headers` 原样传给 `compact()`——被删除的 header 会以字面 `null` 发给 provider。现在扩展做同样的过滤，并补了对应测试。

顺带把控制字符判定收敛成契约里的 `containsControlCharacters`（C0 + DEL），Host、worker、renderer 共用同一实现，替换了 8 处各自写的正则。

### 本轮新增：门禁真正覆盖 `packages/**`

`eslint.config.js` 此前只覆盖 `src/**` 和 `scripts/**`，`packages/agent-contract`、`packages/agent-worker` 完全没有被 lint——包括本轮所有新代码。补上配置块后一次暴露 18 个错误（`no-explicit-any`、`prefer-const`、控制字符正则），已全部修掉而不是关掉规则：`any` 换成 SDK 类型（并因此发现上面的 header 缺陷），控制字符正则换成语义等价的共享判定函数。同时用 Prettier 格式化了 10 个此前未格式化的原型文件，并对 Rust 全量执行 `cargo fmt`。CI 里本来就有 `pnpm lint`、`format:check` 和 `cargo fmt --check`，因此这三项从"从未真正跑过"变成提交前必过。

### 本轮新增：引擎角色摘除（Pi 成为唯一 agent 引擎）

按单引擎方向把 vendored ACP 引擎的 agent 角色从代码中摘除，Pi 成为唯一 agent 引擎：

- **Rust 侧**：`agent_runtime.rs` 只剩共享的 `AgentStatus`/`AgentPhase` 类型（仍被 Pi worker 监督器消费）、`melody_home` 与 `resolve_binary`；`start_agent`/`send_acp`/`stop_agent`/`agent_status` 四个命令、`AgentRuntime` 状态与整个 `acp_policy` 模块随之删除，`lib.rs` 不再注册它们。
- **渲染侧**：`use-agent-bridge.ts` 删除 `fallbackToLegacy`——Pi worker 启动失败以 failed 状态终止会话并给出阻断性 `pi.worker_unavailable` 诊断，绝不切换引擎；阻断性预检（配置不可读、沙箱不可执行）改为**拒绝打开会话**（「无法以 Pi 打开该会话：…」）而不是路由到 ACP。浏览器预览仍使用确定性的 ACP 夹具，不涉及 vendored 引擎。
- **双用途二进制的保留与实测（③b 待决）**：同一份捆绑二进制 melody-pager 仍是 marketplace 插件操作（`melody plugin install/update/uninstall/list`、`plugin marketplace update`）与 `melody inspect` 所依赖的 CLI。实测：release 构建的 CLI 二进制为 **161MB**（内含整个已退役的 TUI 引擎），因此"保留 CLI"的真实运输成本是这 161MB，而不是本地缓存的体积——本地 12GB 的 `target/debug` 构建缓存与 400MB 的 debug sidecar 已删除（可随时重建，dev 之后改用 release 产物）。彻底删除 vendor（源码约 61MB，submodule 固定在 `4b71187`）需要把 `melody-plugin-marketplace` 及 `inspect` 移植为原生 Rust，这是一个独立工程，待产品决策。
- Rust 测试从 254 → **247**：7 个引擎/ACP 策略测试随其代码一并删除。

### 本轮新增：旧引擎会话只读归档（默认引擎切 Pi）

按 Proma 式单引擎方向又推进一步：持久化的引擎设置在加载时被强制为 `pi`（默认值同步切换），旧引擎（melody-acp）创建的会话不再按原引擎续聊，而是以**只读归档**打开。

- **历史来自持久化时间线归档**（`session_timeline_entries` + `timeline_json`），不再启动任何引擎进程：vendored melody-pager、ACP subscribe、initialize/session.open 都不会发生。
- **输入区整体禁用**，并显示一条解释归档状态的信息横幅；会话仍可浏览既有历史，只是不能续聊。
- **判定集中在** `src/domain/agent/session-archive.ts` 的 `isLegacyArchiveSession`，store 增加 `archivedReadOnly`：绑定到 pi 的会话永不归档；melody-acp 绑定或只有 ACP 历史而无 pi 绑定的会话归档；全新创建的会话不受影响。
- **设置回滚安全**：原存储键与值保留，回滚到旧版本构建仍能读到用户原来的引擎选择；设置页该行改为静态的「Pi（唯一引擎）」，描述为"旧引擎创建的会话以只读归档打开"。
- **刻意未做**：ACP→Pi 会话迁移/导入仍不在范围（只读导入计划与 journal 代码保留，但不被归档路径使用）；从构建中移除 vendored 引擎本体是下一步。

### 本轮新增：回退语义改造（外设降级，会话不再被拽回 ACP）

预检从“发现不支持的能力就整体回退”改造为两级模型：**阻断（blocking）** 只保留会话级风险，**降级（degradation）** 覆盖其余外设能力缺失——降级不再把会话拽回 ACP，会话留在 Pi 继续运行。

仍阻断的只有两类，且各有不可妥协的理由：

- `pi.config_unreadable`：配置读不出来，就无法知道这个会话将以什么配置运行，任何静默推进都是盲飞；
- `pi.sandbox_unavailable`：沙箱是安全边界，绝不能因为“降级也能跑”而被静默削弱。

降级集合覆盖此前会触发整体回退的全部外设面：MCP、代码库索引、外部认证 provider、OIDC 认证、子代理定义、终端策略、提问超时策略、LSP、语义记忆索引、高级 goal 编排、Skills、Hooks、插件。能力报告相应新增 `degradations` 列表并呈现在该 Pi 会话的状态消息上（`requiresLegacyEngine` 仅在存在阻断项时为真），用户能看到“少了什么、为什么”，而不是整会话换引擎。

这样改造的理由是对齐 Proma 的单引擎形态：产品方向是 Pi 单引擎，任何旧配置陷阱——一个插件、一段 OIDC、一个语义记忆开关——都不能再把会话拖回旧引擎；彻底移除 ACP 路径是下一步。

### 本轮新增：端到端探测发现的两个真实缺陷

这一轮不再只跑既有断言，而是用打包产物 + 独立探测脚本对抗性地打新代码，结果发现两个测试和静态检查都没抓到的问题：

- **`monitor` 与 `scheduler_*` 不在网关工具名单里（功能性缺陷）。** `PI_GATEWAY_TOOL_NAMES` 被事件映射器用来判定"这是 Host 网关工具"，据此**抑制 provider 级的重复 `tool.requested`/`tool.progress`**（网关自己会发一份经过校验的权威请求）。四个新工具漏在名单外，后果是 provider 的原始参数会再产生一条工具卡片——界面出现重复行，且其中一条带的是未经校验的参数。同一份名单还决定了 `runtime.ready` 里宣告的工具集，所以运行时只宣告了 30 个工具（缺 `monitor`/`scheduler_create`/`scheduler_list`/`scheduler_delete`）。根因是**能力清单和注册表是两份手写列表**：现在 `PI_CAPABILITIES.tools` 直接由 `PI_GATEWAY_TOOL_NAMES` 派生（外加扩展工具 `todo_write`/`update_goal`），运行时宣告恢复为 34 个工具、与兼容清单完全一致。
- **`parse_scheduler_interval` 会因非 ASCII 后缀 panic。** 解析用的是 `split_at(len - 1)`（按**字节**切分），模型只要传 `5分` 这样的间隔就会在 `byte index 3 is not a char boundary` 处 panic，而不是返回一个可读的错误。已改为按最后一个**字符**切分（`char::len_utf8`），并补了 `5分`/`5分钟`/`每次5m`/`５m` 与饱和值 `9223372036854775807d` 的回归测试。

顺带修掉的两处：模型侧 `scheduler_create` 曾声明 `recurring`/`durable` 两个 Host 根本不读取的参数（请求一次性调度会静默得到循环调度）——已从 schema 移除；`ResolvedRequestAuth.headers` 里值为 `null` 的 header（表示删除该 header）此前被原样传给 `compact()`，现按 Pi 的语义过滤。

### 本轮新增：流式工具事件读错字段，导致每次工具调用都多出一个空白卡片

把"扮演 Host + 本地假 provider + 打包 worker"的端到端夹具跑起来之后，立刻暴露出一个**影响每一次工具调用**的缺陷：映射器在 `toolcall_start`/`toolcall_delta` 上读的是顶层 `assistantEvent.toolName`，但 Pi 的流式事件把工具调用放在 `partial.content[contentIndex]`（`AssistantMessageEvent` 的真实形状：`{type:"toolcall_start", contentIndex, partial}`），顶层根本没有 `toolName`。后果有两层：

- 判定网关工具用的是工具名，名字读不到 → 抑制逻辑失效 → **每次工具调用都会多出一条无名的 `tool.requested`**（toolCallId 落到 `session:tool:N` 回退值），前端把它渲染成一条没有标题的空白工具卡片；
- 对扩展工具（`todo_write`/`update_goal`），无名请求用的回退 id 与后续 `tool_execution_*` 事件的真实 id 不一致，同一次调用会被画成两行。

既有的映射器测试用的是**不存在的顶层 `toolName` 字段**（真实事件没有），所以一直绿灯。修复分两部分：从 `partial.content` 解析出工具名与 id（让网关抑制与行身份都正确），并且**解析不到名字时不发请求**（宁可晚一行，也不要空白行）。回归测试改用真实事件形状，并新增"无名流式事件不得产生空白行"与"扩展工具流式请求必须带名字且 id 与执行事件一致"两条。

### 本轮新增：端到端回合夹具（已进 CI）

`packages/agent-worker/src/worker-smoke.test.mjs` 现在除了健康握手，还会跑一个**完整回合**：本地 OpenAI 兼容假 provider（`127.0.0.1`，无外网）→ 模型返回 `scheduler_create` 工具调用 → 夹具扮演 Host 回 `tool.resolve` → 断言：

1. 运行时宣告的能力清单包含 `monitor` 与三个调度工具；
2. 过期的 `configRevision` 被拒（乐观并发守卫真的生效）；
3. 一次工具调用只产生**一个**带 `activity.gateway === "melody"` 的权威请求；
4. 工具结果回灌后 `run.finished` 为 `completed`，并拿到模型的最终回复；
5. provider 恰好收到两次请求（工具调用 + 收尾）。

它同时跑源码入口与打包产物（`MELODY_PI_WORKER_PATH`），并已接入 `test:unit`、`test:pi-worker-smoke` 和 CI。这类缺陷只有端到端才能发现——单元测试可以全绿而真实形状是错的。

### 本轮新增：压缩摘要的注入面加固

探测压缩摘要时发现：tracker 文本（`todo_write` 的条目内容、goal objective）是模型可写的，其中的 `</task-state>` 能提前闭合我们的分隔符，让后面的文本变成"指令"；C0 控制字符（含 ANSI 转义）也会原样进入提示词。现在摘要生成后会同时做分隔符中和（`</task-state>` → `[/task-state]`）与控制字符剥离（保留 `\n`/`\t`），再按 4000 字符截断；第一遍笔记（`<memory-flush>`）与对话块（`<conversation>`）的分隔符同样不可被内容伪造。上限本身在加固前后都生效（100×4000 字符输入被截到恰好 4000）。

### 本轮新增：门禁从"文本匹配"升级为"运行时比对"

`pnpm check:pi-compatibility` 过去对工具集的检查只是在源码里找字符串——注册过的工具和被提到的字符串无法区分，所以上述能力清单漂移一路绿灯。现在检查器会用一个子进程 `import` worker 的 `PI_CAPABILITIES.tools`，把它与兼容清单做**双向集合比较**（缺一个/多一个都报错，整轮约 0.4 s），并新增调度工具参数的双向校验（worker 声明的字段必须被 Host 读取，Host 读取的字段必须在清单里）。这两条都用扰动法验证过会失败。事件映射器也补了一条由 `PI_GATEWAY_TOOL_NAMES` 驱动的回归测试：名单里**每一个**工具都必须抑制 provider 级重复请求，而不是只测一个代表。

### 本轮验证：真实数据的 schema 迁移

用一份**你的真实 dev 数据库的副本**（v5、8 个会话、3 个项目）跑了一次真实启动：应用把副本迁移到 v11，8 个会话与 3 个项目全部保留，`agent_schedules`/`agent_schedule_runs`/`agent_session_bindings`/`agent_event_log`/`migration_journal`/`session_timeline_entries` 全部建出。整个过程通过探针标识符（`--config '{"identifier":"...probe"}'`）指向独立数据目录，你的原库主文件与 WAL 未被修改（mtime 仍是 9 月 4 日；只读检查碰过 `-shm` 共享索引）。探测目录与进程在结束后已清理。

**仍未验证：** 桌面 UI 层的点击路径（切换引擎 → 打开 Pi 会话 → worker 握手 → 面板渲染）。本机 computer-use 的 Screen Recording 授权未真正生效（需要重启 ZCode），因此这一步留给现场：按上一节的手动步骤操作即可。

### 下一步（按顺序）

1. **Linux/Windows 沙箱**：Linux pre-exec Landlock 已接入，但需要在 ABI 3+ 的目标内核上按 T09 做真实执法验收；Windows 降级为无沙箱+显著警告（产品决定）。
2. **真实环境验收**：真实 provider（Responses/Messages/Chat Completions）、MCP OAuth、三平台打包/签名/升级、真实用户插件清单。这部分只能在用户环境执行，不能由本地测试替代。
3. 可选增强（按价值排序，尚未实现）：把审批参数改写（Proma 的 `canUseTool` + `updatedInput`）做进权限交互、把 `AGENTS.md` 指令作用域按目录门控、通知渠道（系统通知/headless 入口）、浏览器工具。
