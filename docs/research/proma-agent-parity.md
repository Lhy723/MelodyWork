# Proma 的 Pi 接入与产品能力对照

研究日期：2026-10-04。用途：为 MelodyWork 评估用户指定的 Proma 项目并形成可执行的 Pi 功能对齐项。只阅读 Proma 官方仓库 README、源码、LICENSE 与 GitHub Release；没有安装、运行或复制 Proma 代码。

## 结论

Proma 值得借鉴的是它把 Pi 接入既有桌面产品，同时在 Pi 上补齐产品侧上下文、浏览器和会话交互。**截至本次核对，Proma 的当前 Agent Runtime 已是 Pi-only**：源码将 v2 描述为 Claude runtime 退役，旧 Claude transcript 迁移为只读历史、不能交给 Pi 恢复；Pi SDK 则仍由 release 持续升级。也就是说，“退役旧 runtime”与“保留旧会话可读”是分开的迁移边界。[旧 runtime 退役与历史迁移][claude-retirement]、[Pi 适配器][adapter]、[v0.19.58 release][release]

对照 MelodyWork 当前工作树，Pi 核心运行时、Host ToolGateway、web 搜索/抓取、可恢复子代理已经有实现。本轮还补上了 Explorer 多分支导航与 `&session` 引用式带回、Browser 工作区内嵌/多标签/截图/本地预览/popup 策略、已完成顶层 child 的用户续接，以及 typed 文件工具触发的嵌套项目指令作用域。最显著的剩余差距已从功能切片转为桌面端验收与生命周期边界：

1. Browser 的安全产品闭环已实现，但原生 WebView 嵌入、截图权限/坐标裁剪与跨平台 profile 仍需真实桌面验收；DNS 私网解析并非网络沙箱。
2. Explorer 已有持久 lineage、校验恢复、多分支导航和用户提交时按需读取的原生 `&session` 引用；缺少并行分支、重启恢复和确认丢失的桌面故障注入。
3. 已完成的顶层 child 可由用户续接；运行中与嵌套 child 仍不是面板可直接续接的生命周期。nested instructions 的 root `CLAUDE.md` 已由 Pi loader 单测验证，但桌面真实回合未验收，且 typed 路径门控不覆盖 shell。

`canUseTool` + `updatedInput` 值得借鉴为审批回调契约，不过不能把它描述成 Proma 已交付的“审批时可编辑参数”：当前 Proma UI 仍只显示原参数，允许后返回的也是原输入。真正的参数改写需要扩展审批 UI/IPC，并在改写后重新验证权限与路径边界。[Proma adapter][adapter]、[Proma permission service][permission]、[Proma permission UI][permission-ui]

## 研究基线和范围

- Proma 源码基线：`main` 快照 `86d9dfb511db4c1e3ffded3b6c3e312996f50cbf`，提交日期 2026-09-26。本文的 GitHub 源码链接固定到此提交，便于复核。
- 此快照中的 Agent runtime 边界是 Pi-only；旧 Claude transcript 被保留为只读展示数据，不代表 Claude runtime 仍可继续运行。[runtime 退役迁移][claude-retirement]
- 官方 `v0.19.58` release 日期为 2026-09-25，发布记录包含 Pi SDK `0.86.1 → 0.87.1` 升级；这证明 Proma 持续维护 Pi 依赖，但不证明整个产品已迁离旧 Runtime。[release][release]
- Proma README 把探索、父子会话、内嵌浏览器作为产品功能介绍；Pi 能力是否真的接入，以下以同一源码快照中的 runtime adapter、工具注册和 session 管理为准。[README][readme]
- Proma 根目录 `LICENSE` 声明 AGPL-3.0。本文只总结设计，不拷贝代码。[LICENSE][license]
- 本文只对照用户指定的 Pi 迁移/运行时边界、审批输入改写、Agent explorer、父子会话、浏览器和项目指令上下文；不将日历、Todo、Obsidian、远程聊天等 Proma 的整套产品功能视为 Pi 迁移验收项。

## Proma 的 Pi 运行时边界

Proma 用 Electron utility process 承载 Pi SDK adapter，main process 通过窄的 capability RPC 处理权限等产品能力。adapter 只传递可序列化查询数据，Pi 的消息被转换到 Proma 既有 `SDKMessage` 形状，因此 Renderer、消息存储与原有会话 UI 不必直接接收 Pi wire types。[Pi runtime adapter][utility]、[utility 到 main 的桥][runtime]、[Pi message adapter][message-adapter]

Pi 适配层显式创建 Pi `SessionManager` 与 `AgentSession`；内置文件/终端工具被关闭，改为 Proma 包装的 Pi 工具、产品工具和自定义工具。默认资源加载关闭 Pi 的环境式 context-file、extension、skill 自动发现，再将经 Proma 验证的 instructions / Skills 和 first-party extension factories 显式传入。这让产品配置与 Pi 用户目录不会互相隐式污染，也把 UI 与授权留在 Host。[Pi adapter tool/session setup][adapter-tools]、[受管资源加载策略][resource-loader]

这套边界对 MelodyWork 很接近：当前由 Rust Host 管理 Pi worker、会话绑定、权限、文件/终端/MCP/联网工具，并关闭 Pi 内置工具；规范事件和 UI 状态由产品协议承接。[Melody 交接文档][melody-handoff]、[Pi 兼容清单][melody-manifest]

## 审批回调与 `updatedInput`

Proma 的 Pi wrapper 将 Pi 工具名与参数先转换为现有产品熟悉的形状，例如把 Pi 文件工具的 `path` 映射成 `file_path`，把编辑的 `oldText/newText` 归一化成 `old_string/new_string`；审批允许后再通过 `restorePiInput()` 映射回 Pi schema。`wrapToolWithPermission()` 统一包装 Pi 内建工具、Proma 产品工具和自定义工具；工具按顺序执行。[输入映射][message-adapter]、[统一 permission wrapper][adapter]

PermissionResult 类型允许 `{ behavior: 'allow', updatedInput }`。Pi utility runtime 会将工具授权作为 capability RPC 发回 main；但用户当前能操作的权限 UI 只有允许、拒绝和“本会话总是允许”，IPC 回应只带 `behavior/alwaysAllow`，permission service 以 pending request 原始 `toolInput` 作为 `updatedInput` 返回。UI 展示参数为只读 JSON/命令文本。因此，Proma 源码提供了“执行前可以替换输入”的接口与适配点，尚未打通人工编辑审批参数的交互闭环。[权限结果与回调][permission]、[IPC 响应][permission-ipc]、[审批 UI][permission-ui]

MelodyWork 的 Pi ToolGateway 以 Host 发出的 `tool.requested` / `tool.resolve` 和 allow/deny 交互为边界，但当前审批解析只表达通过/拒绝，没有返回改写后的工具参数；handoff 也把 `updatedInput` 标作未实现增强。[Melody tool gateway][melody-gateway]、[handoff 优先项][melody-handoff]

可借鉴点：让权限结果携带“本次批准实际执行的参数”，使 UI、策略分类、审批摘要、执行器读取同一份最终输入。若增加编辑能力，路径变化、命令变化、MCP server/tool 变化都必须基于**改写后的输入**重新做权限判定；`always allow` 不应覆盖改写后更宽的输入；UI 要清晰呈现原始值与批准值。Proma 当前实现只提供接口参考，不提供这些 UI/安全语义的现成答案。

## Explorer 与父子会话是两个不同能力

### Explorer：从回复节点 fork，并由用户选择性带回

Proma 的 Explore 动作针对一条已完成的 assistant 回复，调用 Pi `SessionManager.createBranchedSession(entryId)` 与 `SessionManager.forkFrom()`，创建新的 Proma 产品 session。分支保留 fork 节点之前完整的 Pi transcript 与工具上下文，主会话不被改写；探索分支可以并行打开多个。若历史消息缺少 Pi entry 映射，或 native session artifact 缺失，Proma 会拒绝安全分叉，不按展示 JSON 猜测。[fork 实现][fork]、[Explorer UI 创建分支][explore-ui]

带回主线时，Proma 只选 fork 锚点之后新产生的 assistant 结论，向主会话草稿添加一个 `&session:<id>` 引用；草稿仍由用户发送，分支 Tab 继续保留。prompt 明确要求读取 `sourceMessageId` 之后的内容，不重复分支前已存在的历史。这是“并行探索 + 有界引用”，不是自动把整个分支 transcript 拼回主线。[带回按钮][bring-back]、[引用上下文边界][exploration-context]

MelodyWork 当前工作树的 Explorer 已有 `session.fork`：assistant 完成事件只在原生 Pi leaf 与显示文本一致、且不是工具调用时附带原生 entry ID；聊天 UI 从该锚点创建新的产品会话。Host 在 fork 命令执行前持久化源 session/锚点/请求状态，并验证源会话 Pi 绑定、源/目标同项目和工作区且目标未绑定；worker 单独打开源 JSONL、调用 Pi SDK `createBranchedSession`、复制到按目标产品 ID 派生的 opaque 文件并打开目标。新时间线只保留到锚点的投影前缀。若确认事件丢失，重试会核对已有文件的父 session 与 leaf 锚点，不会覆盖错配文件。Explorer 可从源会话/任一分支导航到有界 sibling 列表。分支锚点后的 `&session:<id>` 保留在草稿中，仅用户提交时由 Host 校验 lineage、Pi binding、项目/cwd 和锚点后读取原生时间线中的 user/assistant 可见消息（最多 128 条、12,000 Unicode codepoints），作为不可信 JSON 数据上下文送给 Pi；不会自动发送、不读取任意路径。尚缺并行分支、重启恢复和确认丢失的桌面故障注入验收。现有 `session.import` 仍只是历史转换入口，不等价于 Explorer。[Melody command contract][melody-contract]、[迁移说明][melody-handoff]

剩余高优先级 parity 项：为已实现的 lineage/fork/recovery/引用带回补上并行分支、桌面 E2E 与故障注入；检查引用注入的恶意内容、长记录和源会话变化边界。引用带回保留来源且不会自动发送。

### Delegated child：独立任务会话，不是 Explorer 分支

Proma 还提供模型可调用的 `delegate_agent(s)`，以完整 Proma 产品会话创建子会话，保存 `parentSessionId/rootSessionId/role/model/thinking/permission` 等元数据，按新会话运行。子会话可以持续交互，父会话通过 wait/list/result tools 收敛结果；README 将其定位为可迭代的父子会话，而不是一次性 SubAgent。[Proma child session 创建][delegation]、[Pi collaboration tools][collaboration]、[README child sessions][readme]

MelodyWork Pi 已有 `spawn_subagent` / `run_background_task`，子任务是独立 Pi `AgentSession`，支持 `explore/plan/general-purpose`、自定义 agent/role/persona、能力与 MCP 授权上限、隔离 worktree、后台控制以及 `resume_from`；子会话有父子 ID 和独立 transcript。[Melody spawn/resume][melody-subagent]

MelodyWork 现已允许用户在 Subagent 面板中查看并继续**已完成的顶层 Pi child session**：输入框发送 `task.continue`，worker 从同一 task id 对应的 Pi session/transcript 恢复，保留子代理原有角色、模型、权限上限与隔离身份；待处理工具权限也可在后台时间线中由用户解析。该入口只开放根会话的直接子任务，不开放嵌套 child 的用户续接，也不允许并发重复启动；运行中的 child 目前仍是观察态。这使用户可迭代补充顶层子任务，但还不是 Proma 的完整 child-product-session 生命周期/UI。[Melody child 会话 UI][melody-child-ui]、[Pi child continuation][melody-subagent]

## 内嵌浏览器

Proma Pi Runtime 将浏览器作为 first-party custom tools 注册，而不是要求 Pi 任意扩展或直接运行 CDP。工具面涵盖导航、可访问性快照、按角色查找元素、点击/填写/等待/截图/标签管理、本地预览等；工具运行时调用 `browserController`，页面 WebContents/CDP 保持在 Electron main。每个会话有独立 browser identity/tab；模型用短生命周期 ref 与页面快照交互，页面内容作为不可信输入处理。Proma README 说明该浏览器可由用户登录后交给 Agent 做自动化。[Pi browser tools][browser-tools]、[main 进程注册][browser-registration]、[README browser][readme]

MelodyWork Pi 已有 `web_search` / `web_fetch`，并已将 Browser 接入工作区：每个产品会话使用隔离的 Tauri 子 WebView，以 bounds 同步在主窗口中内嵌；每个会话最多 8 个标签。Pi 可导航、列出/打开/切换/关闭标签、读取有界页面/元素快照，并按 URL/可见文本条件只读等待（最长 10 秒），再按短期 ref 点击或填写非敏感文本；截图须显式批准，捕获主窗口后裁切 Browser viewport 并返回有界 JPEG。导航、DOM交互、标签改变和截图均逐次要求授权，网页内容不可信，密码字段不暴露。工作区提供本地预览开关以及显式 popup 登录策略；跨平台 profile 策略按 Tauri WebView 能力分流。Linux Wayland 截图 fail closed，macOS 权限说明已加入 Info.plist。桌面端截图权限、窗口坐标裁剪、登录态隔离和完整 Agent 交互仍待验收；DNS 名称解析到私网并非 URL 层可拦截，也不等于网络沙箱。[Melody Browser runtime][melody-browser]、[Melody Browser 工具][melody-gateway]、[Melody Browser 面板][melody-browser-ui]

剩余 Browser parity 工作以桌面自动化和平台验收为主：截图权限/裁剪、三平台 profile 行为、popup 登录授权、浏览器关闭/重启恢复和 Pi 交互回合。不要把 CDP 或任意 JS 放进 Pi worker。用户登录态和网页提示注入仍是高风险边界：页面文字不能提升权限，可能提交/发送/删除的动作必须保留逐次授权与执行回执。

## 项目上下文与 `AGENTS.md`

Proma 先关闭 Pi 的环境式 context-file、extension、skill 加载，再由 Host 传入经过验证的 workspace/project instruction 文件。`ProjectInstructionScopeController` 只识别带路径参数的 typed 文件工具：目标路径进入一个新的子目录时，第一次工具调用会被阻断，Proma 把该目录适用的 `AGENTS.md` / legacy `CLAUDE.md` 加进下一轮 system prompt 后让 Agent 重试；按路径和内容 hash 去重。代码注释明确此 controller 通过 typed path 工具工作，不解析 Bash，因此它是**上下文激活策略，不是 filesystem sandbox**。[资源加载覆盖][resource-loader]、[目录门控实现][instruction-scope]

MelodyWork 已将 Host 生成的受控 Skill/prompt 资源清单、memory 工具、`.gitignore` 文件可见性策略与路径作用域 instructions 接通。对 `workspace_read_file`、`workspace_write_file`、`workspace_edit`、`workspace_list_directory`、`workspace_search` 和 `workspace_apply_patch`，worker 会在文件操作前向 Host 预检目标路径；Host 依据 canonical workspace 边界逐层读取适用的 `AGENTS.md` 与 legacy `CLAUDE.md`（同一目录按此顺序），拒绝越界路径/符号链接指令文件，并限制文件数与内容大小。若发现新指令，第一次工具调用仅注入下一轮 Pi system context 并返回“未执行、请重试”；同轮并发调用也保持阻断。workspace 根层沿用 Pi 初始资源加载；Pi `DefaultResourceLoader` 对 workspace root `CLAUDE.md` 的加载已有自动化单测，桌面真实回合仍待执行。[Melody handoff][melody-handoff]、[tool manifest][melody-manifest]、[Melody instruction scope][melody-gateway]

剩余差异是 Bash/终端内自行访问路径不触发此上下文门控。它只作用于列出的 typed 文件工具，是上下文激活策略，不是 filesystem sandbox；实际读写权限仍由 Host ToolGateway 与终端沙箱控制。桌面端真实指令注入验收仍待执行。

## MelodyWork 对齐清单

| 优先级 | 差距                       | MelodyWork 当前基础                                                                                                 | 目标验收形态                                                                                                       |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P0     | 可见内嵌浏览器             | 工作区内嵌 Tauri WebView、最多 8 标签、受控 Agent 标签工具/截图、本地预览/popup 策略已实现；OS 截图与坐标裁剪未实测 | 三平台 profile / 权限 smoke、截图裁剪和浏览器关闭/重启恢复的桌面 E2E；记录 DNS 私网限制，不误称网络沙箱            |
| P0     | Explorer fork / bring-back | 持久 lineage、校验恢复、多分支导航与用户提交时原生 `&session` 引用读取已实现；桌面与故障注入未验收                  | 并行分支关联/重开、重启恢复、确认丢失与恶意/长引用数据的桌面 E2E                                                   |
| P1     | 可交互 child session       | 已可从面板继续已完成的顶层 child，复用 task/session/transcript 与原权限身份；运行中观察、嵌套 child 入口未开放      | 补全生命周期状态和真实桌面验收；保持与 Explorer fork 不同的父子/委派语义                                           |
| P1     | 嵌套项目指令路径上下文     | Pi root `CLAUDE.md` loader 单测通过；typed 文件工具执行前 Host 懒加载嵌套指令并阻断重试，有 canonical/symlink 检查  | 桌面端真实回合验收；明确不覆盖 shell/不替代 filesystem sandbox                                                     |
| P2     | 审批参数改写               | 权限交互只 allow/deny，Host 不接受 updated input                                                                    | 建立 typed 原始/批准输入对比、改写后重判权限、只对白名单化的最终规范输入生效；不要将该能力误报为 Proma 已有用户 UI |

**总体判断：** MelodyWork 已将 Proma 对照中最大的 Browser/Explorer 产品差距补到可测试的 Host→Pi→UI 切片：Browser 内嵌/多标签/有界截图/本地预览与弹窗策略，Explorer 多分支导航与原生引用带回。仍不能称为完整 parity：最重要剩余项是三平台桌面 E2E、Browser 截图权限/裁剪与 profile 验收、Explorer 故障注入、运行中/嵌套 child 面板续接，以及路径指令的桌面真实回合；DNS 私网和 shell 指令上下文继续是明确边界。`updatedInput` 审批改写需先定义安全交互。不要把自动化通过描述成桌面验收完成。

## 一手资料

源码链接固定到 Proma `86d9dfb511db4c1e3ffded3b6c3e312996f50cbf`：

- [Proma README][readme]、[LICENSE][license]、[v0.19.58 Release][release]
- [Pi utility runtime][runtime]、[Pi main-process facade][utility]、[Pi SDK adapter][adapter]
- [Claude runtime 退役与历史 transcript 迁移][claude-retirement]
- [Pi permission wrapper][adapter]、[输入归一化/恢复][message-adapter]、[permission service][permission]、[permission IPC][permission-ipc]、[permission UI][permission-ui]
- [Pi-native session fork][fork]、[Explorer 创建][explore-ui]、[Explorer 带回][bring-back]、[引用范围][exploration-context]
- [Pi collaboration tools][collaboration]、[产品 child session 创建][delegation]
- [Pi browser tools][browser-tools]、[browser tool registration][browser-registration]
- [受管 ResourceLoader][resource-loader]、[目录 instruction scope][instruction-scope]

MelodyWork 对照来源：

- [迁移 handoff](../architecture/pi-migration/handoff.md) 与 [兼容 manifest](../architecture/pi-migration/pi-compatibility-manifest.json)
- [会话 command contract](../../packages/agent-contract/src/index.ts)、[Pi subagent runtime](../../packages/agent-worker/src/pi/session-adapter.ts)、[Pi tool gateway](../../packages/agent-worker/src/pi/tool-gateway.ts)
- [Pi web runtime](../../src-tauri/src/pi_web_runtime.rs)、[Pi worker runtime](../../src-tauri/src/pi_worker_runtime.rs)、[只读 Subagent UI](../../src/features/workspace/subagent-conversation.tsx)

[readme]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/README.en.md
[license]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/LICENSE
[release]: https://github.com/proma-ai/Proma/releases/tag/v0.19.58
[runtime]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/utility/agent-runtime.ts#L176-L203
[claude-retirement]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/agent-session-manager.ts#L186-L210
[utility]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-utility-adapter.ts#L45-L99
[adapter]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-agent-adapter.ts#L668-L700
[adapter-tools]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-agent-adapter.ts#L1438-L1546
[message-adapter]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-message-adapter.ts#L49-L125
[permission]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/agent-permission-service.ts#L114-L215
[permission-ui]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/renderer/components/agent/PermissionBanner.tsx#L163-L205
[permission-ipc]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/ipc.ts#L3625-L3638
[fork]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/agent-session-manager.ts#L850-L935
[explore-ui]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/renderer/components/agent/AgentHistorySelectionLayer.tsx#L405-L449
[bring-back]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/renderer/components/agent/SidePanel.tsx#L313-L340
[exploration-context]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/agent-session-context-prompt.ts#L195-L214
[collaboration]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/agent-collaboration-tools.ts#L793-L875
[delegation]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/agent-collaboration-tools.ts#L695-L764
[browser-tools]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-builtin-tools.ts#L940-L1068
[browser-registration]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-builtin-tools.ts#L1558-L1625
[resource-loader]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-resource-loader-overrides.ts#L1-L40
[instruction-scope]: https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-project-instruction-scope.ts#L68-L151
[melody-handoff]: ../architecture/pi-migration/handoff.md
[melody-manifest]: ../architecture/pi-migration/pi-compatibility-manifest.json
[melody-contract]: ../../packages/agent-contract/src/index.ts
[melody-subagent]: ../../packages/agent-worker/src/pi/session-adapter.ts
[melody-gateway]: ../../packages/agent-worker/src/pi/tool-gateway.ts
[melody-web]: ../../src-tauri/src/pi_web_runtime.rs
[melody-browser]: ../../src-tauri/src/pi_browser_runtime.rs
[melody-browser-ui]: ../../src/features/workspace/browser-panel.tsx
[melody-child-ui]: ../../src/features/workspace/subagent-conversation.tsx
