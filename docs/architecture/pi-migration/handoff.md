# MelodyWork Pi 迁移交接文档

更新时间：2026-10-09
交接分支：`beta`
基线提交：`ffa542f4`（`v0.3.3-beta.4`）
当前状态：Pi 已是唯一 Agent runtime；插件市场已迁为 Host 原生实现；修复 `0.4.0-beta.1` Windows 发布门禁后，正在验收 `0.4.0-beta.2`

这份文档给下一位维护者使用。Pi 已替代 Melody-build 承担 Agent 会话；旧 ACP 会话作为只读归档，不再运行或作为 Pi 的兼容回退。插件市场的扫描、安装、更新和卸载现由 Host 原生实现，旧 `melody-pager` 不再参与启动、构建或发布；`vendor/melody-build` Git 子模块及 `.gitmodules` 已移除。当前工作是补齐 Pi 上的产品交互与安全语义，并完成目标平台验收。**Rhai workflow 引擎已按产品决定删除**（设置项移除、预检不再回退、清单记入 `retiredCapabilities`）；周期任务由 Host schedule 承担。本文区分已实现、静态检查与目标平台实测，不能把 ACP 归档或警告诊断表述为 Pi 功能对等。

## 0i 0.4.0-beta.1 发布整理（2026-10-09）

- 本次版本汇总 Pi-only 对话、Host 原生插件市场、直接 API key 配置、Pi 技能目录、活动时间线/耗时分组、侧边栏层级和相关稳定性修复；用户可见变更见[发布说明](../../releases/0.4.0-beta.1.md)。
- 发布版本号须在 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 保持一致；从 `beta` 创建 `v0.4.0-beta.1` 测试版标签，不合并或同步到 `main`。
- `.mimosa`、`.pnpm-store`、`.github/hooks`、`.impeccable`、`.v2c` 与本地 Pi worker 二进制/映射文件属于机器本地状态或生成物，保留在磁盘并由 `.gitignore` 排除，不进入发布提交。
- 本地 TypeScript/agent/worker 检查、Rust 283 项测试、lint、格式检查、前端构建和 updater 公钥校验均通过。`v0.4.0-beta.1` 的 GitHub Actions Windows job 因路径解析失败未完成发布；修复版提升为 beta.2，结果以对应 Release workflow 为准。

## 0j 修复 Windows beta worker 打包路径（2026-10-09）

- `v0.4.0-beta.1` 的 GitHub Actions Windows job 在 `prepare:agent-worker` 目录初始化时失败：基于 `new URL(import.meta.url).pathname` 的路径解析把 runner 的 `D:` 盘符重复拼接为 `D:\D:\a\...`。
- 改用 `fileURLToPath(import.meta.url)` 后再走 Node path API，避免 Windows URL pathname 的盘符/斜杠格式歧义；本机 lint 通过，beta.2 的 Windows worker 构建与 smoke test 用于目标平台回归。
- `v0.4.0-beta.1` 标签保持不变；修复后以 `0.4.0-beta.2` 重新发布。

## 0h 移除会话信息侧栏中的定时任务面板（2026-10-08）

- 按产品要求移除 renderer 的 `SchedulePanel` 及其 `useAgentSchedules` 读取/管理层；会话信息侧栏不再展示定时任务。
- 这只是移除侧栏 UI：Host 持久调度状态、派发器、Pi `scheduler_create`/`scheduler_list`/`scheduler_delete` 工具和数据库数据均保留。
- `MonitorFeed`、子代理和会话统计仍留在会话信息侧栏。

## 0f 原生插件市场与 Melody sidecar 移除（2026-10-08；历史状态，子模块后由 0g 移除）

- **保留插件市场产品能力。** Marketplace 设置页和 Tauri command 名称保持不变；Host 原生实现本地/Git 来源扫描（含 Melody/Claude 插件索引及目录发现）、安装、更新、卸载。安装目录和 `registry.json` 继续沿用现有约定，旧安装记录可继续列出、更新和卸载；Git clone 使用浅克隆/缓存，支持来源 SHA 固定，并对相对路径、符号链接、清单读取和复制规模做边界校验。
- **移除旧 sidecar 的执行与交付链路。** Tauri bundle 仅打包 Pi worker；`pnpm tauri dev` 只准备 Pi worker；build.rs、CI、release workflow 和清理脚本不再构建、查找或打包 `melody-pager`，也不再依赖 DotSlash、vendor checkout 或 sidecar 所需的 protobuf 编译器。release workflow 仍逐平台构建并 smoke-test Pi worker。
- **当时暂留为惰性历史源码。** 0f 编写时 `.gitmodules` / `vendor/melody-build` 尚未删除、不参与常规构建；本机残余数据的处理与最终删除记录见 0g。
- **本地门禁已通过：** Marketplace 原生 Rust 单测 10 项、全量 Rust `cargo test --locked --lib`（283）、`cargo check --locked`（无 warning）、`cargo fmt --all -- --check`、`pnpm check`、`pnpm test:unit`（386）、`pnpm test:pi-worker-smoke`（2）、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check`。Vite 仍提示若干大 chunk；三平台 release 与桌面真实 Git/插件源操作仍需 CI/现场验收。

## 0g 删除 Melody Build 子模块（2026-10-08）

- 删除 `.gitmodules` 和 `vendor/melody-build` 工作树；Marketplace 保留 Host 原生实现，不再有 Melody Build 构建或运行依赖。
- 删除子模块内 18GB 的 Cargo `target` 缓存（可从源码重建）。子模块仅余的 `.mimosa` hook-state 是旧的空快照（无 touched paths、baseline 或 findings），且根目录同会话状态更新、更完整；确认无恢复用途后已删除，根目录状态未改动。
- 旧子模块 user-guide 的对照依据现改用固定上游提交链接；下方早期记录保留当时的历史状态。

## 0e 验收反馈修复（2026-10-05；历史状态，已由 0f 更新）

- **消除 Pi-only 运行时漂移。** Pi capability report 的 `requiresLegacyEngine` 改为 `blocksPiSession`，只表示配置风险会阻止打开 Pi；能力诊断不再携带 `fallbackEngine`，无法安全执行的会话明确失败，不切到 ACP。
- **把真实能力写回声明。** Pi worker 能力限制现在准确说明 Browser 的嵌入式 WebView、最多 8 个标签、显式 loopback 预览、可选 HTTPS 登录弹窗，以及依赖桌面/OS 权限的视口截图；保留密码字段不接受 DOM typing、Linux Wayland 截图 fail-closed 等限制。兼容 manifest 对缺失能力统一记录为 Pi 内诊断，不再声明 ACP fallback。
- **门禁覆盖本次漂移。** `check:pi-compatibility` 现在实际导入 worker 能力对象，核对工具集合、`runtimeFallback=none`、diagnostic 不含 fallback 声明，以及 Browser 已实现功能不会被误报为不支持；先在旧内容上确认红，再修复到绿。
- **文档状态归一。** README 明确 Pi-only 与 ACP 只读归档；早期 opt-in 设计/验收报告标为历史记录，当前验收见本文件与 `acceptance-report.md`。
- **本轮复验通过。** `pnpm check`、`pnpm test:unit`（382）、`pnpm test:agent-worker`（137）、`pnpm test:pi-worker-smoke`（2）、`pnpm lint`、`pnpm format:check`、架构/字体检查、Rust `cargo test --locked`（271）、`cargo check --locked`、`cargo fmt --all -- --check` 与 `pnpm build` 均通过；Vite 仍报告大 chunk 警告。
- **现场验收仍未替代。** Browser OS 截图权限/profile/视口裁剪与原生 Pi E2E、Explorer 重启恢复/确认丢失故障注入、真实 Provider 均需桌面环境验证。本地 Browser preview fixture 不算 Pi 桌面通过。

## 0d Proma 对齐续接（2026-10-04）

- 调研基线固定为 Proma `86d9dfb511db4c1e3ffded3b6c3e312996f50cbf`；详见[对照报告](../../research/proma-agent-parity.md)。Proma 当前 Agent runtime 已 Pi-only，旧 Claude transcript 只读；其 `updatedInput` 目前是授权接口能力，不是用户可改写参数的已交付 UI。
- 本轮已把 Proma 对齐的核心缺口做成真实 Host→Pi→UI 闭环；剩余工作主要是桌面实测/故障注入，以及现有 child/instruction-scope 切片的范围补足。Browser 与 Explorer 有界能力不能替代这些验收，自动测试通过也不代表已达到完整 parity。
- **Explorer 已补齐持久 lineage、多分支导航、恢复和原生 session-reference 带回。** 完成的纯文本 assistant 回复在 Pi session event 中携带经 SDK 原生消息核验的 `nativeEntryId`；聊天 UI 可从该回复创建独立 product session。Host 在 worker 启动前持久化源会话/分支/锚点与请求状态，并校验 Pi 绑定、同项目和 canonical workspace、目标未绑定；worker 独立打开 source `SessionManager`，以 SDK `createBranchedSession` 物化到新的 opaque Pi 文件，再打开目标会话。重试可复用原生分支文件，但必须验证其 `parentSession` 和锚点，不覆盖不匹配文件。新会话时间线仅复制锚点前缀；Explorer 导航可从源会话或任一分支查找有界 sibling 列表，返回源和分支。分支锚点后的 `&session:<id>` 保留在本地草稿，只有用户提交时才由 Host 校验同源、ready 状态、Pi binding、项目/cwd 与锚点，从原生时间线读取后续 user/assistant 可见消息（最多 128 条、总计 12,000 codepoints），排除工具/流式项并以 JSON 数据块标为不可信上下文；不会自动发送、不读任意路径。桌面完整恢复 UI 与故障注入仍待验收。
- **Browser 已有工作区内嵌、多标签、受限截图、本地预览和显式 popup 登录。** 每个产品会话使用独立 Tauri 子 WebView，远程网页没有 Melody IPC；用户 UI 上限 8 个标签，Pi 有 `browser_navigate`、`browser_tabs`、`browser_snapshot`、有界只读 `browser_wait`、`browser_screenshot`、`browser_click`、`browser_type`、`browser_tab_open/select/close`。`browser_wait` 可按 URL/可见文本条件等待，最长 10 秒并返回最终有界快照。导航/DOM交互/标签改变/截图即使在 always-approve 模式也逐次要求用户批准；截图只捕获 MelodyWork 主窗口并裁切 Browser 可视区域，JPEG 最多 512 KiB、1280×960，界面显示手动截图预览。窗口 profile 按产品会话隔离：Windows/Linux 持久目录、macOS 14+ 持久 WebKit data store、macOS 14 以下与 iOS ephemeral、Android fail closed。仅显式开启后接受当前标签的 public HTTPS 登录弹窗；仅在本地预览开关开启时接受严格 loopback HTTP(S)。Linux Wayland 截图 fail closed，macOS 权限说明已加入 app Info.plist。DNS 名称解析到私网无法由 URL 层拦截，因此这仍不是网络沙箱；不同 OS 的截图权限、窗口坐标裁剪和完整 Agent 交互待桌面 smoke。
- **Pi child session 用户续接已有首个切片。** Subagent 面板现在可对已完成、直接由当前根会话创建的 child 输入补充消息；`task.continue` 在 worker 侧重新校验 parent/session/task identity，以原 task id 通过 Pi `resume_from` 继续，复用 child transcript 和既有角色/模型/权限/隔离策略。交互请求仍由根 session 的授权 Host 解析，背景时间线中的审批可操作。运行中 child 目前仅可观察，嵌套 child 续接仍由父 Agent 的 `resume_from` 控制；该入口不是任意 Agent session navigator，桌面端交互仍待验收。
- **嵌套项目指令路径上下文已有首个切片。** `workspace_read_file`、`workspace_write_file`、`workspace_edit`、`workspace_list_directory`、`workspace_search` 与 `workspace_apply_patch` 在真实文件操作/授权前做内部 Host 预检。Host 解析 canonical workspace 内的目标路径，按祖先顺序读取适用的非符号链接 `AGENTS.md`、`CLAUDE.md`（同目录先 AGENTS 后 CLAUDE），对目标越界、文档数量/大小超限失败关闭；首次发现新指令时不执行原文件工具，将其加入下一轮 Pi system context，要求模型重试，同轮并发预检也维持阻断。worker 单测已确认 Pi `DefaultResourceLoader` 会读取 workspace root `CLAUDE.md`；桌面真实回合仍待验收。本机制不解析 Bash/终端访问路径，也不替代 filesystem sandbox。
- **本轮门禁已通过：** `pnpm test:unit` 382、`pnpm test:agent-worker` 137、Rust `cargo test --locked --lib` 271、`cargo check --locked`、`pnpm check`、lint、Prettier、`cargo fmt --check`、架构/字体/兼容清单检查、`git diff --check` 与 `pnpm build`。剩余对齐优先级：P0 Browser 截图 OS permission/窗口裁剪与完整桌面 E2E；P0 Explorer 重启恢复/并行多分支的桌面 E2E 和确认丢失故障注入；P1 补齐运行中与嵌套 child 的用户续接边界、验收 child 生命周期；P1 nested instructions 桌面真实回合，明确 Bash 不在路径预检内。审批参数编辑排后：Proma 当前无人工编辑审批 UI；Melody 若实现也必须对最终参数重新判权限/路径，避免 `allow_always` 扩权。

## 0c 本轮续接（2026-09-21）

- **Linux pre-exec Landlock 已接入。** `workspace_sandbox` 在 Linux 上查询 Landlock ABI，要求 ABI 3+，并在每个终端、后台终端和 monitor 的 `Command::pre_exec` 阶段安装同一份文件规则；Host 自身不会被不可逆地限制。workspace/devbox 以及没有 deny 覆盖的自定义 allow-only profile 可留在 Pi，缺少 Landlock、ABI 过旧、路径不可打开或规则无法表达时仍拒绝打开 Pi 会话。
- **Linux 的边界已显式记录。** Landlock 只有 allow 规则，Linux 自定义 exact deny 与 glob deny 不会被静默忽略；这类配置继续拒绝打开。网络受限 profile 仍不在该桥接范围内；Windows 无实现，会话降级为无沙箱+显著警告（reason_code `platform-unsupported`，产品决定）。
- **本机验证限制。** 本机为 macOS，已完成 Rust 编译检查；Linux 真实内核执法、平台包和 T09 矩阵仍需在目标 Linux 主机验收。当前运行环境禁止嵌套 `sandbox-exec`，因此 macOS monitor 的真实进程测试会被系统拒绝，不能把该环境结果误记为产品回归。

## 0 最近一轮（2026-09-12；历史记录）

- **P0.1 真实配置盘点（脱敏）已完成第一轮。** 真实配置只有 `chat_completions` 模型、基础 Markdown Memory，没有 Hook/MCP/LSP/OIDC/沙箱/工作流；启用的 3 个插件里 2 个已安装、1 个已不存在。详见[验收报告](./acceptance-report.md#p01-真实配置盘点脱敏)。
- **修复插件启用判定。** Melody 只在插件被 `[plugins].enabled` 显式列出且不在 `disabled` 时激活插件，Host 之前只判断“不在 disabled”，把 marketplace clone / install cache 里发现的每个插件都当成已启用。真实配置下预检把 49 个插件判为启用（实际 2 个），导致该配置的 Pi 会话每次都回退 ACP，并把从未启用插件的 Skill/命令投影给 Pi。修复后 Host 统一使用 `PluginEnablement`（项目覆盖用户、支持 `melody plugin add` 的 `<scope>/<hex8>/<name>` id、`disabled` 优先），Skill/Hook 保持 opt-out 语义；兼容清单新增 `pluginActivation` 事实源并由 `pnpm check:pi-compatibility` 防漂移。
- **重划插件与子代理的声明式/可执行边界。** `agents/`、带 `./` 前缀的多级 manifest 路径、声明的 Skill 目录本身都按声明式内容投影；`scripts/`、`bin/`、Skill 内脚本不再当作动态表面（Melody 只经 hook 执行脚本）；`hooks/`/`.mcp.json`/`.lsp.json`/`extensions`/不安全路径继续回退 ACP。插件 agent 以 `<plugin>:<agent>`（裸名未占用时也注册）进入子代理策略。Agent frontmatter 只把 Melody `AgentDefinition` 会读取的字段当策略面，未知键按惰性元数据处理，多行列表可解析；`tools` 白名单换算为最窄 Pi 能力档，新增 `read-write-execute` 档位。真实配置的 agent 定义从 0/6 可用变为 5/6 可用。
- **按工具授权 MCP 调用已落地。** 子代理策略新增有界 `mcpTools`（精确 `mcp__<server>__<tool>`，最多 64 条），Host 从 agent 定义的 `tools` 收集，worker 策略层 fail-closed 校验、网关按调用匹配，子代理授权与父级取交集（父级没有 MCP 能力时派生不能获得），`resume` 保留同一集合。这样 `literature-reviewer` 一类“显式点名 MCP 工具”的定义不必退化成 `all`（那会连带放开写文件与终端）。
- **`[skills].ignore` 路径前缀保真已落地。** Melody 把它当路径前缀（`~` 展开、相对项按工作区解析、canonical 前缀匹配），并在合并插件 Skill 之前隐藏匹配项。Host 解析后附着到原生 Skill 根，并随 `resource.manifest` 传给 worker（`skillRoots[].ignorePaths`），刷新不会让被忽略的 Skill 复活；插件根不带忽略列表。worker 的 root 信任放宽为“位于受信根之内”，以支持插件 manifest 声明的具体 Skill 目录。真实配置的受控 Skill 路径 159 → 100。
- **插件重名收敛与 `[plugins].paths` 已落地。** 插件按 project > user > 配置目录的优先级按 name 收敛（真实配置：发现 49 → 45，启用记录 4 → 2）；`[plugins].paths` 自定义目录现在会被扫描并按其语义自动启用（显式 `disabled` 仍优先），此前对 Pi 完全不可见。
- **当前真实配置已不触发回退：** 启用插件全部 static 且每个只出现一次，10 个 agent 定义全部可用（含 14 个 `mcp__zotero__*` 精确授权），LSP/Hook/MCP 配置、沙箱、OIDC、工作流、复杂 goal 编排均未启用；`[skills].ignore` 与插件优先级/忽略语义已与 engine 对齐。
- **P1.1 持久调度状态层已落地。** schema v12 新增 `agent_schedules` + `agent_schedule_runs`：产品 session/project 归属、`once`/`interval`/`cron`、间隔/本地时区日历规则/期限/maxRuns、`skip`/`run-once` 错过策略、状态机与 run journal，创建时快照 permission/session/model 身份；生命周期为纯函数（错过触发按策略跳过或只补一次，永不爆发重放；失败派发保留 schedule 且不空转）；Host 暴露 create/list/status/runs/delete；契约定义 `schedule.changed`/`schedule.fired`。
- **P1.1 调度执行器与接受确认已落地。** supervisor 维护有界待确认表（`promptId → oneshot`）：`run.accepted` → 接受、匹配 `requestId` 的 `runtime.error` → 拒绝、15s 超时或世代结束 → 未确认，世代结束会清空；同时跟踪每会话权威 `configRevision` 供 `turn.submit` 使用。决策/记账为纯函数（引擎未运行或工作区不匹配 → 跳过并记原因、会话忙 → 跳过、会话已删除 → 取消定时器、ACP 绑定 → 失败；busy 拒绝记跳过、其余拒绝与超时记 failed）。派发身份 = 创建时快照 ∩ 会话当前绑定（取更窄），同一会话不叠两条 Host 回合；renderer SchedulePanel 与此状态层相连。
- **P1.2 monitor 运行时已落地第一片：** Host-owned monitor 注册表 + 逐行 `task.notification` 事件 + 限速与自动停止 + 生命周期回收（worker 停止/切工作区/退出/关会话）+ 结束快照可读；命令面 `start_agent_monitor`/`list_agent_monitors`/`cancel_agent_monitor`。
- **monitor 模型工具已接通：** worker 注册 `monitor`（execute 类能力、plan/ask 模式拦截、权限身份同终端），Host 启动注册表并投递逐行 `task.notification`，任务控制工具接受 `pi-monitor:*`（不混批、跨会话拒绝）。
- **monitor UI 观察面已接通：** 投影层有界通知环（200 条，不进时间线）+ `MonitorFeed` 挂在会话信息面板（状态/事件数/最近行/停止）+ `useAgentMonitors` 按运行状态调整轮询；调度界面（`SchedulePanel`）随后也已接通：创建/暂停/恢复/取消/删除 + run journal。
- **调度界面已接通：** `useAgentSchedules`（按会话读取权威行，投影 `scheduleRevision` 变化即刷新）+ `SchedulePanel`（创建/暂停/恢复/取消/删除 + run journal 含跳过与失败原因）。
- **Host 终端沙箱已落地：** `workspace_sandbox` 把 Melody 的 profile 语义施加到每个派生命令（macOS Seatbelt；Linux ABI 3+ Landlock），前台/后台终端与 monitor 共用同一决策与 fail-closed 行为（monitor 曾漏接，已修）；网络受限 profile、glob deny、Linux exact deny/旧 ABI 仍拒绝打开；Windows 降级为无沙箱+显著警告。兼容清单的 `unsupportedInPi` 已移除 `sandbox`，机制/适用面/fail-closed 条件改由 `hostBridges.sandbox` 记录。
- **模型侧调度工具已落地（第三片）：** `scheduler_create`/`scheduler_list`/`scheduler_delete` 三个 worker 工具（list 只读、create/delete 写入且 `requiresPermission`，plan/ask 模式拒绝）；间隔沿用 Melody 的 `s/m/h/d` 解析与 60s–30d 钳制；身份由 Host 从**会话实时绑定**复制，模型无法放宽；非 Pi 绑定与无绑定给出不同拒绝原因；`fire_immediately` 只提前 `next_run_at`；同 task id 复用原 schedule。兼容清单新增 `agentSchedules` 事实源并防漂移。
- **压缩后的任务续接已落地：** `todo_write`/`update_goal` 是 custom entry（不进上下文），压缩后模型会丢掉"做到第几步"。压缩扩展现在用与工具相同的重建函数生成有界任务摘要（≤4000 字符）写进两遍压缩的 focus（Pi 会作为 `Additional focus` 拼进摘要提示词）；**第一遍失败时改为"仅任务摘要"压缩**，连摘要都没有时才回落 Pi 原生压缩。
- **类型化发现并修掉一个真实缺陷：** 去掉压缩扩展里的 `any`（改用 `ModelRegistry["complete"]`/`CompactionResult` 等 SDK 类型）后，编译器指出 `ResolvedRequestAuth.headers` 的 `null`（表示删除该 header）被原样传给 `compact()`，而 Pi 自己会过滤——被删除的 header 会以字面 `null` 发给 provider。已按 Pi 语义过滤并补测试。控制字符判定同时收敛为契约的 `containsControlCharacters`（Host/worker/renderer 共用，替换 8 处正则）。
- **门禁覆盖 `packages/**`：** `eslint.config.js` 此前不含 `packages/**`，本轮全部 worker/contract 代码从未被 lint；补上后暴露 18 个错误并全部修掉（`any` → SDK 类型、`prefer-const`、控制字符正则），Prettier 格式化 10 个原型文件，Rust 全量 `cargo fmt`。
- **端到端探测发现并修掉两个真实缺陷。** （1）`monitor` 与 `scheduler_*` 漏在 `PI_GATEWAY_TOOL_NAMES` 之外：该名单决定"哪些工具由 Host 网关执行"（据此抑制 provider 级重复工具事件），漏项会让界面出现一条带原始参数的重复工具卡片，同时运行时只宣告 30 个工具。现在 `PI_CAPABILITIES.tools` 直接由该名单派生（+ 扩展工具），运行时宣告 34 个、与清单一致。（2）`parse_scheduler_interval` 用按字节的 `split_at(len - 1)`，模型传 `5分` 会 panic；已改为按字符切分并补回归测试。
- **修掉一个影响每次工具调用的缺陷（端到端探测发现）。** 映射器在流式事件上读顶层 `assistantEvent.toolName`，而 Pi 的真实形状是 `partial.content[contentIndex]`——名字读不到 → 网关工具抑制失效 → **每次工具调用都多出一条无名 `tool.requested`**（前端渲染成空白卡片），扩展工具还会因回退 id 与执行事件 id 不一致被画成两行。现在从 `partial` 解析名字与 id，并且解析不到就不发请求。既有测试用了不存在的顶层字段，所以一直是绿的；回归测试已改用真实事件形状。
- **端到端回合夹具已进 CI。** `worker-smoke.test.mjs` 除健康握手外，还会用本地假 provider 跑完整回合（工具调用 → Host resolve → 最终回复），断言"一次工具调用只产生一个权威请求"、过期 `configRevision` 被拒、provider 恰好两次请求；源码入口与打包产物都跑。
- **压缩摘要做了注入面加固。** tracker 文本里的 `</task-state>` 曾能提前闭合我们的分隔符、控制字符（含 ANSI 转义）会原样进入提示词；现在摘要与包裹内容都做分隔符中和技术 + 控制字符剥离，再截断到 4000 字符。
- **门禁从文本匹配升级为运行时比对。** `pnpm check:pi-compatibility` 现在会真的 `import` worker 的 `PI_CAPABILITIES.tools` 并与清单做双向集合比较（缺/多都报错，约 0.4 s），新增调度工具参数的双向校验；事件映射器补了由名单驱动的"每个网关工具都不得产生重复请求"测试。两条新检查都做过扰动验证。
- **真实数据迁移已验证（用副本）。** 以 dev 库副本（v5、8 会话、3 项目）真实启动应用：历史验收迁移到 v11 后会话与项目全部保留、六张新表齐全；v11 → v12 增加 cron 列的真实用户库升级仍待目标数据库副本验收。
- **构建零警告。** 清掉 8 条死代码/未用导入警告（`project_projection`/`run_terminal`/`TerminalOutputCapture::new` 是测试辅助函数，改为 `#[cfg(test)]` 而非删除；`MELODY_SANDBOX` 常量改为真正被复用的单一来源）。
- **旧引擎会话只读归档已落地，默认引擎切 Pi。** 持久化的引擎设置在加载时被强制为 `pi`（原存储值保留，回滚旧版本构建仍能读到用户原来的选择）。旧引擎会话从持久化时间线归档（`session_timeline_entries` + `timeline_json`）只读打开：不启动任何引擎进程，输入区禁用并显示归档横幅（store 的 `archivedReadOnly` / `isLegacyArchiveSession`，判定在 `src/domain/agent/session-archive.ts`）。vendored 引擎不再为会话启动，从构建中移除它是下一步。
- **vendored 引擎的 agent 角色已摘除：Pi 是唯一 agent 引擎。** `agent_runtime` 只剩共享状态类型、`melody_home` 与 CLI 解析，四个 ACP 命令与 `acp_policy` 删除；渲染端运行时回退删除——worker 失败与会话级阻断都是硬错误（拒绝打开），不再切引擎。melody-pager 二进制仍作为 marketplace/config 的 CLI 保留（实测 release 二进制 **161MB**，内含整个退役 TUI 引擎；本地 12GB debug 缓存与 400MB debug sidecar 已清理，dev 改用 release 产物）；彻底删 vendor（源码约 61MB，submodule 固定在 `4b71187`）需先把 `melody-plugin-marketplace`/`inspect` 移植为原生 Rust（③b，独立工程待决策）。
- **Pi 会话中不可用的能力（降级诊断，不再由 ACP 承担）：** 远程媒体、动态插件扩展、语义索引/dream、OIDC/外部认证、高级 goal 编排等在 Pi 会话中直接不可用并给出 warning 诊断；配置不可读与沙箱不可执行则拒绝打开。**Rhai workflow 引擎已删除**，不是待补项。
- **本地门禁：** 前端/worker 单元测试 362 passed，Rust `cargo test` 247 passed（`cargo build` 0 警告），worker smoke 2/2 passed，`pnpm check`、`pnpm lint`（0 error/0 warning）、`pnpm format:check`、`cargo fmt --all -- --check`、架构检查、打包检查、Pi 兼容清单检查、`git diff --check`、Vite build 均通过。
- **注意：** 上述改动仍是工作树中的未提交内容，和之前几轮的迁移原型混在同一批文件里；提交前必须按本文件 §6.3 评审，不能把生成产物或用户未跟踪目录带进提交。

### 本轮之后最优先的下一步

1. **真实环境验收**：provider/MCP 认证、三平台打包与签名。旧 ACP 会话续聊已按产品决定移出验收范围。
2. **平台沙箱**：Linux pre-exec Landlock 已接入，但需要目标 ABI 3+ 内核的真实执法验收；Windows 降级为无沙箱+显著警告（产品决定）。
3. **Proma 功能对齐**：Browser/Explorer 的核心功能切片与 Host→Pi→UI 工具闭环已经实现；下一步做 Browser 跨平台 profile/截图权限与坐标裁切验收、Explorer 并行/重启恢复/确认丢失故障注入，并补桌面 child continuation 与路径作用域 instructions 的真实回合。运行中与嵌套 child 仍不能由面板直接续接；shell 路径不触发项目指令上下文门控。自动化门禁通过不等于桌面 parity 完成。

## 0b 本轮会话完成清单与提交计划（2026-09-13）

这一轮从 P0.1 真实配置盘点出发，修掉了预检的保真缺陷，然后把调度与监视两条线做成了端到端可用。下表是**可评审的切片**，按依赖顺序排列；每个切片都在同一轮里跑过完整门禁（`pnpm check`、单元测试、Rust 测试、worker smoke、架构/打包/兼容清单检查、`git diff --check`、Vite build）。

| #   | 切片                                   | 主要文件                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 插件启用判定与声明式表面保真           | `src-tauri/src/config_extensions.rs`、`config_plugin_details.rs`、`config_core.rs`、`config_marketplace.rs`、`config_subagents.rs`（前 4 片共用）、`scripts/check-pi-compatibility.mjs`、`pi-compatibility-manifest.json`、`src/domain/agent/capability-report.ts`（+ 测试） |
| 2   | 子代理 frontmatter / 能力档 / MCP 授权 | `packages/agent-contract/src/index.ts`、`packages/agent-worker/src/pi/{tool-gateway,subagent-policy,session-adapter}.ts`（+ 各测试）                                                                                                                                         |
| 3   | 调度状态层与生命周期                   | `src-tauri/src/database_agent_schedules.rs`（新）、`database_core.rs`、`database.rs`、`database_sessions.rs`、`database_projects.rs`                                                                                                                                         |
| 4   | 调度派发器与接受确认                   | `src-tauri/src/schedule_dispatch.rs`（新）、`pi_worker_runtime.rs`、`lib.rs`                                                                                                                                                                                                 |
| 5   | 调度界面                               | `src/lib/melody-bridge-schedules.ts`、`src/hooks/use-agent-schedules.ts`、`src/features/chat/schedule-panel.tsx`、`src/domain/agent/{event-to-session-update,projection-store-patch}.ts`、`src/stores/agent-store*.ts`                                                       |
| 6   | monitor 运行时与模型工具               | `src-tauri/src/pi_monitor_runtime.rs`（新）、`pi_tool_gateway.rs`、`lib.rs`、`packages/agent-worker/src/pi/tool-gateway.ts`（+ 测试）                                                                                                                                        |
| 7   | monitor UI 观察面                      | `src/lib/melody-bridge-monitors.ts`、`src/hooks/use-agent-monitors.ts`、`src/features/chat/monitor-feed.tsx`                                                                                                                                                                 |
| 8   | 模型侧调度工具                         | `src-tauri/src/database_agent_schedules.rs`、`pi_tool_gateway.rs`、`packages/agent-worker/src/pi/tool-gateway.ts`（+ 测试）                                                                                                                                                  |
| 9   | 压缩后的任务续接与 header 过滤         | `packages/agent-worker/src/pi/compaction-extension.ts`（+ 测试）                                                                                                                                                                                                             |
| 10  | 共享控制字符判定                       | `packages/agent-contract/src/{validation,index}.ts`、`packages/agent-worker/src/pi/{session-adapter,subagent-policy}.ts`、`src/domain/agent/capability-report.ts`                                                                                                            |
| 11  | 门禁覆盖 `packages/**`                 | `eslint.config.js`、若干被 Prettier/rustfmt 格式化的文件                                                                                                                                                                                                                     |
| 12  | 文档                                   | `docs/architecture/pi-migration/*`（README/feature-parity/acceptance-report/implementation-plan/本文件/manifest）                                                                                                                                                            |

**提交前必读：** 工作树里 97 个文件有改动，其中 `src-tauri/src/config_subagents.rs`、`pi_tool_gateway.rs`、`pi_worker_runtime.rs`、`database_agent_*.rs`、`docs/architecture/`、`packages/` 等**整个文件都还是未跟踪的原型**。切片 1–7 的改动分别落在这些文件里，因此提交时必须先评审原型 diff，再按上表分片；不要一次性把原型改动和本轮改动混成一个提交。`src-tauri/binaries/`、`.github/hooks/`、`.impeccable/`、`.v2c/`、`.pnpm-store/`、`.mimosa/` 是生成物或本地工具目录，不要提交。

### 本轮确立、下一位维护者不必重新推导的决策

1. **插件是否生效** = 在 `[plugins].enabled` 且不在 `disabled`（legacy 注册表规则）；`enabled` 里允许 `<scope>/<hex8>/<name>` id 形式；`[plugins].paths` 发现的插件按配置来源自动启用；重名按 project > user > config 收敛。
2. **插件的声明式/可执行分界**：`skills`/`commands`/`agents`（Markdown）与 manifest 声明的多级目录是声明式；`hooks`/`.mcp.json`/`.lsp.json`/`extensions` 与不安全路径是可执行边界；`scripts`/`bin` 与 Skill 内脚本是**惰性内容**（Melody 只经 hook 执行脚本，hook 已被单独识别）。
3. **Agent frontmatter 的策略面** = Melody `AgentDefinition` 会读取的字段；未知键按惰性元数据处理（serde 语义）；`tools` 白名单换算为**最窄** Pi 能力档。`disallowedTools` 与无法校验的 MCP 名不扩大权限，能力缺口进入诊断，不回退到 ACP Agent runtime。
4. **新增 `read-write-execute` 能力档**：Melody 常见定义同时要写文件和终端，用 `all` 表达会额外放开 MCP；该档位在契约、worker 策略、网关工具集与父子交集中都已实现。
5. **`mcpTools` 精确授权**只在能力档非 `all` 时生效，且与父级取交集（父级无 MCP 能力时派生不能获得）；`resume` 保留同一集合。
6. **调度**：Host 拥有时钟、状态机、错过策略与 run journal；派发必须等 `run.accepted`（busy → `skipped`、拒绝/超时 → `failed`、会话被删 → 取消定时器）；身份 = 创建时快照 ∩ 当前绑定（取更窄）。
7. **monitor**：每行一个 `task.notification`，滚动窗口 + 生命周期双限速并自动停止；结束的 monitor 离开活动表但保留有界快照；任务控制工具接受 `pi-monitor:*` 且不与终端任务混批。
8. **前端**：monitor 行进入有界的独立通知环（**不进聊天时间线**）；调度行不进 store，只由投影的 `scheduleRevision` 触发重读——renderer 不复制 Host 权威状态。
9. **工作流能力已删除（产品决定）**：设置界面不再有“启用工作流”，前端预检不再因 `workflows.enabled` 回退，worker 诊断目录移除 `pi.workflows_unavailable`，兼容清单把 `workflows` 移入 `retiredCapabilities`。Rhai 引擎**不是待补项**；周期任务由 Host schedule 承担。
10. **旧 ACP 会话兼容移出续聊范围（产品决定）**：不需要把旧 ACP 会话迁入 Pi；既有会话以只读归档展示，不启动旧 Agent runtime，也不能继续发送消息。`import plan`/`migration journal` 代码保留且已测试（未被删除）；矩阵 D02/D03 标注为“不适用”。
11. **模型可以创建调度，但不能自己决定权限**：`scheduler_*` 工具的身份（engine/session mode/permission mode/model）永远由 Host 从该会话的实时绑定复制，工具参数里没有这些字段；权限身份（审批摘要）只取间隔或 task id，**不含提示词正文**。非 Pi 绑定与"没有 Pi 绑定"是两种不同的拒绝原因。
12. **压缩摘要必须带上任务状态**：`todo_write`/`update_goal` 是 custom entry，不进上下文，因此压缩扩展负责把它们折叠成有界 digest 并写进两遍压缩的 focus；第一遍失败时改为"仅任务摘要"压缩，而不是交给不带摘要的 Pi 原生压缩。任务摘要用与工具相同的重建函数生成，不允许各写一套解析。
13. **压缩扩展只从 Pi 包取类型**：worker 不直接依赖 `@earendil-works/pi-ai`，需要 SDK 类型时用 `ModelRegistry["complete"]`、`CompactionResult`、`ExtensionContext["model"]` 这类派生类型；`ResolvedRequestAuth.headers` 的 `null` 表示"删除该 header"，传给 `compact()` 前必须过滤（Pi 自己也是这么做的）。
14. **网关工具只有一份名单。** `PI_GATEWAY_TOOL_NAMES` 同时决定"事件映射器要抑制哪些 provider 级重复事件"和"运行时宣告哪些工具"；能力清单从它派生，不得再手写第二份列表（`monitor`/`scheduler_*` 的漏项就是这样产生的：界面重复工具卡片 + 运行时少宣告 4 个工具）。
15. **解析外部字符串只按字符切分。** `split_at(len - 1)` 这类按字节的切片会被非 ASCII 输入打成 panic（模型可以传任何文本）；`parse_scheduler_interval` 已改为按最后一个字符切分并做饱和运算。
16. **被包裹的文本不可伪造分隔符。** 任何进入提示词的包裹内容（任务摘要、memory flush 笔记、对话块）都要先中和自己的分隔符、剥离控制字符，再按上限截断。
17. **门禁要能真正执行代码就不做文本匹配。** 工具集这类契约改为运行时比对（子进程 import + 集合比较），文本匹配无法区分"注册过的工具"和"被提到的字符串"。
18. **门禁必须真的覆盖新代码**：`eslint.config.js`/`format:check`/`cargo fmt --check` 的覆盖范围要和实际源码目录一致；`packages/**` 曾经完全没被 lint，补上覆盖后暴露的问题应当修掉而不是关规则。

## 1 当前结论

- **当前事实（2026-10-09）：Pi 是唯一 Agent runtime，桌面 Agent 会话默认 Pi。** 旧 ACP 会话只能作为只读时间线归档展示；worker 失败或配置/沙箱不支持不会回退 ACP。无等价实现的能力按清单给出 warning 或阻断，ACP 代码只为 marketplace/config CLI 等非 Agent 用途保留。
- Host 拥有工作区、文件、终端、权限、MCP、Web、Memory、LSP、代码库索引、后台任务和生命周期；Pi worker 只负责 Pi SDK 会话循环与产品协议适配；React 只消费规范事件和 store patch。
- 代码库导航由 Host-owned tree-sitter 索引提供，支持 Rust、TypeScript/JavaScript、Python、Go 的有限定义/引用/符号；严格跨文件语义图和未支持语言仍不等价，按兼容清单诊断处理，不回退 ACP。
- 当前修复版以 `v0.4.0-beta.2` 的 GitHub Actions Release workflow 结果为准；`v0.4.0-beta.1` 标签保持不变。本地缓存、工具状态目录和 Pi worker 构建物不应纳入提交。平台沙箱、Browser OS 权限、Explorer 恢复和真实 Provider 验收仍需按下方边界逐项确认。

最近一次完整本地门禁结果（2026-10-05，历史记录）：`pnpm test:unit` 382 passed，`pnpm test:agent-worker` 137 passed，`pnpm test:pi-worker-smoke` 2 passed，Rust `cargo test --locked` 271 passed；`pnpm check`、`pnpm lint`、`pnpm format:check`、架构/字体检查、`cargo check --locked`、`cargo fmt --all -- --check`、`git diff --check` 与 `pnpm build` 均通过（Vite 仍提示若干 bundle chunk 超过 500 KiB）。本次发布门禁的最新结果见 CI 和 release workflow；真实 provider、OAuth、Browser OS 截图权限/profile 与 Explorer 桌面恢复仍未完成现场验收。

## 2 代码地图

### 2.1 产品协议和前端

- `packages/agent-contract/src/`：引擎无关的命令、规范事件、能力、会话模式和运行时校验。这里不能依赖 React、Zustand、Tauri、Pi 或文件系统。
- `src/domain/agent/`：规范事件检查点、事件日志、事件投影、store patch、能力诊断、会话迁移/恢复报告、模型目录和子代理投影。
- `src/lib/agent-client.ts`：Tauri 客户端与订阅 façade；前端不应直接依赖 Pi wire 类型。
- `src/hooks/use-agent-bridge.ts`、`src/stores/agent-store-pi.ts` 以及现有 `agent-store-*`：将 Pi 规范事件投影到产品状态；legacy store/type 只用于只读归档和兼容展示，不再启动 ACP Agent runtime。

### 2.2 Pi worker

- `packages/agent-worker/src/main.ts`、`protocol.ts`、`transport.ts`：静态 Bun/Node worker 入口、LF JSONL 帧、协议 v1、世代/序号和有界传输。
- `packages/agent-worker/src/pi/session-adapter.ts`：Pi `AgentSession`/`SessionManager` 适配、模型与思考强度、取消、steer/follow-up、原生 JSONL 会话。
- `packages/agent-worker/src/pi/tool-gateway.ts`：工具注册、能力模式、权限交互、Host tool request/resolve 和任务控制。Pi 内置文件/终端工具关闭，禁止绕过 Host 策略。
- `packages/agent-worker/src/pi/todo-extension.ts`、`goal-extension.ts`、`compaction-extension.ts`：first-party 任务列表、基础目标状态、Memory Flush 与 `/flush` 兼容；复杂 goal 编排、分类器、重试和角色模型策略未在 Pi 内实现，按兼容清单诊断处理。
- `packages/agent-worker/src/pi/event-mapper.ts`：Pi 事件到产品规范事件的映射。不要把 Pi 原生事件直接泄露给 UI。

Pi 依赖固定为 `@earendil-works/pi-coding-agent@1.0.1` 和 `@earendil-works/pi-server@1.0.1`，对应源码 tag `v1.0.1`（`a7229ddc21810d6245105978033b7df645ecc2f7`）。本次升级已核对 npm 包与源码提交；Pi 原生 session format 仍为 v3，导入目标保持 `pi-coding-agent-v3`（[v1.0.1 session format](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/docs/session-format.md)）。后续升级仍须同时核对依赖闭包和 session format，不要直接跟随上游 `main`。

### 2.3 Rust Host

- `src-tauri/src/pi_worker_runtime.rs`：worker 监督、握手、命令归属、会话生命周期、事件落盘和恢复/关闭清理。
- `src-tauri/src/pi_tool_gateway.rs`：Host-owned 文件、搜索、目录、编辑、补丁、终端、权限、计划、问题、子代理和后台任务。
- `src-tauri/src/pi_codebase_runtime.rs`：有界 tree-sitter 代码库索引；每个工作区最多缓存 16 个空闲索引，文件/字节/结果/AST 深度均有上限。
- `src-tauri/src/pi_mcp_runtime.rs`、`pi_web_runtime.rs`、`pi_lsp_runtime.rs`、`pi_memory_runtime.rs`、`pi_hook_runtime.rs`：MCP/Web、受信任 stdio LSP、基础 Memory/SQLite lexical sidecar、受限 JSON command hooks。
- `src-tauri/src/pi_model_config.rs`、`pi_storage.rs`：模型/凭据/策略快照及 Pi 原生存储路径。
- `src-tauri/src/database_agent_*.rs`、`database.rs`：当前 schema v13 的 agent binding、规范事件日志、迁移 journal 和恢复数据。

Rust 是宿主资源与安全策略的最终裁决者。worker 不能直接读写工作区、应用 SQLite、用户凭据或任意网络资源。

### 2.4 配置、脚本和文档

- `docs/architecture/pi-migration/README.md`：架构总览。
- `feature-parity.md`：逐项能力对等矩阵和现场验收契约。
- `acceptance-report.md`：截至最近一次的验收结果和剩余边界。
- `native-alternatives.md`：Pi 原生能力与 Melody Host/ACP 取舍。
- `implementation-plan.md`：P0–P5 实施阶段和退出门禁。
- `pi-compatibility-manifest.json`：Pi 版本、工具、Host bridge、限制和 unsupported 清单的事实源；`pnpm check:pi-compatibility` 会检查代码标记与清单不漂移。
- `scripts/prepare-agent-worker.mjs`：按目标平台准备静态 Bun worker；缺少 Bun 或产物时，正式构建必须明确失败，不能偷偷启动 ACP。
- `scripts/check-agent-packaging.mjs`、`scripts/check-pi-compatibility.mjs`、`scripts/check-architecture.mjs`：打包、兼容矩阵和依赖边界门禁。

## 3 已接管能力

以下项目已有代码和自动化证据，但真实模型/平台样本仍需补充：

| 领域         | 当前实现                                                                                                   | 维护注意                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 会话和流     | Pi SDK 会话、规范事件、live/replay barrier、幂等、取消竞态、模型/思考强度/模式配置                         | `session.open/import/configure/close` 按 product session 串行；旧 run 的迟到事件必须拒绝                  |
| 文件和命令   | Host-owned 读、搜索、目录、写、编辑、补丁、前台/后台终端                                                   | 路径、符号链接、`.gitignore`、输出归档和权限上限只能在 Host 执行                                          |
| 权限和交互   | allow/deny、ask/auto/always-approve、计划、问题、超时策略                                                  | renderer 不是最终裁决者；规则查询失败应询问或拒绝，不能自动批准                                           |
| 子代理和任务 | 独立 Pi 子会话、父子关系、read-only/execute 能力交集、后台任务、wait-any/wait-all/kill                     | 不能把后台终端任务伪造成子代理；任务 ID 必须校验 session/workspace 归属                                   |
| MCP/Web      | Host stdio、HTTP/SSE MCP，列工具/调用/取消/超时/重连/输出归档；受控 Web search/fetch                       | 真实 OAuth/provider 仍需验证；不得把任意 URL、header 或环境变量直接传给 worker                            |
| Memory       | 全局/工作区/session Markdown、BM25、受控写入、首轮注入、session-end 快照、SQLite lexical sidecar、`/flush` | Markdown 是权威源；embedding/vector/dream 未在 Pi 内等价实现，配置问题可阻断会话；索引异常可回退 Markdown |
| LSP/代码库   | 受信任 stdio LSP；tree-sitter 有限定义/引用/符号/状态/重建/增量刷新                                        | 非 stdio、未信任、未支持语言和严格语义图进入能力诊断，不启动 ACP Agent runtime                            |
| Hooks/资源   | 受限 JSON command hooks；标准 Markdown skills/commands 和纯 Markdown 插件资源投影                          | 动态 JS/HTTP、插件脚本、Agent/MCP/LSP 表面不能因为能枚举就当作安全可执行                                  |
| 数据和恢复   | schema v13 binding/event log/migration journal、Pi opaque JSONL、恢复检查、显式 ACP→Pi import plan         | 三种存储分层；旧 ACP 历史不能用展示文本伪造成 Pi 原生上下文                                               |
| 目标和压缩   | 基础 `todo_write`、`update_goal`、blocked/stall/token 护栏、压缩前 Memory Flush                            | 复杂规划/验证/重试/角色策略仍由 ACP 提供                                                                  |

## 4 Pi 内尚未等价覆盖的能力和产品决定

**当前没有 Agent-runtime ACP 回退路径。** 能力缺失按兼容清单发 warning/diagnostic；配置不可读、沙箱不能安全执行等会话级风险直接阻断 Pi 会话。旧 ACP 会话保持只读归档；ACP 代码若存在，仅服务于 marketplace/config 等非 Agent 功能。

这些不是遗漏，暂时不要通过别名或“看起来能运行”的实现来掩盖语义差异：

1. ~~持久工作流、`/loop`、scheduler、monitor。~~ **已消解：** workflow 按产品决定删除；scheduler 与 monitor 由 Host 接管（persist 状态、错过触发、限速、生命周期与界面均已落地）。
2. **动态插件和 Hook。** JavaScript/HTTP 扩展、动态命令/Agent、无法安全重放的 Stop 阻断尚无 Pi 等价实现；当前 JSON command hook 只覆盖受限、可审计的命令定义，缺口诊断而非回退 ACP。
3. **严格语义代码图和 Memory 语义索引。** tree-sitter 是有限语法索引，不提供完整类型解析或跨文件语义图；SQLite lexical sidecar 不等于 embedding/vector/dream consolidation。
4. **远程媒体和异步媒体作业。** 图片生成 API 尚未完成产品工具、素材存储、进度、取消和重启查询的端到端闭环；视频/语音等能力继续由现有服务拥有。
5. **Linux/Windows sandbox、外部认证和 headless OAuth/OIDC。** macOS 已有 kernel 级隔离（Seatbelt 施加在 Host 派生的每个终端/monitor 子进程上，见 §0）；Linux workspace/devbox 已用 pre-exec Landlock ABI 3+，但 exact deny、旧内核和网络受限 profile 会阻断打开，Windows 降级为无沙箱+显著警告；Host 自身是长驻 GUI 进程，不能被整体沙箱化。Pi API-key 适配也不等于旧认证命令、浏览器 OAuth 或 OIDC。
6. **Melody 专用模型/角色和高级 subagent/goal 策略。** 基础角色与能力模式已有安全交集，但复杂 persona/model 编排、分类器、规划/验证器和重试策略尚未实现；按兼容清单诊断或阻断，不由 ACP 运行。
7. ~~旧 ACP 会话无损续聊。~~ **不适用：** 产品决定不迁移旧 ACP 会话；既有会话以只读归档展示。`import plan` 与 migration journal 代码保留且已测试，但不提供 ACP Agent runtime。

## 5 下一轮建议顺序

### P0 先做真实验收，不先扩代码

1. 记录当前用户/项目实际启用的 provider、模型、MCP、插件、Hook、LSP、Memory、媒体和远程设置；样本必须脱敏，不把密钥、个人对话或真实工作区提交仓库。
2. 为纯聊天、工具+权限+计划、子代理+后台+压缩各建立 ACP/Pi 对照 fixture；涉及真实副作用的测试只能单独执行一次并清理。
3. 在 macOS ARM/x64、Windows、Linux 验证 worker 资源路径、代理/证书、进程回收、签名、升级中断和崩溃恢复。
4. 验证三类真实 API（Responses、Messages、Chat Completions）的流式、空闲超时、错误、重试、usage/cost、图片输入和思考参数。

### P1 优先补齐产品能力缺口

> 当前实际顺序见 §0「本轮之后最优先的下一步」：先做声明式插件表面与 `[skills].ignore`/插件去重保真，再回到本节的调度基础设施。Pi 不做运行时回退；兼容能力缺口应在 Pi 内补齐、明确限制或从产品范围移除。

按以下顺序单独提交，每项都先补契约测试，再实现，再更新矩阵和 manifest：

1. ~~持久任务调度基础设施~~：**已完成**（Host schedule 状态、权限身份、重启/取消语义与产品事件）。monitor 语义与两者的界面也已完成。
2. Monitor 语义：逐行输出事件、事件限速、归档、persistent 生命周期、session-end 清理和 UI 观察；需增加 worker/Host 异步通知协议，不能只返回一个后台 task ID。
3. 动态插件/Hook 的分级信任与隔离：只有经过明确授权、独立进程和可回收生命周期的表面才考虑离开 ACP；不允许在 worker 内任意加载项目 JS。
4. 媒体工具：逐 provider 做图片/视频异步作业、输出文件、进度、取消、重启查询和失败样本；完成前继续 ACP。
5. 平台 sandbox：macOS 已完成；Linux pre-exec Landlock 已接入，仍需在 ABI 3+ 目标内核上按矩阵 T09 做真实执法测试；Windows 降级为无沙箱+显著警告（产品决定）。

### P2 最后处理语义

- 完整跨文件代码语义图、embedding/vector/dream consolidation。
- 高级 goal/subagent policy、角色模型和重试编排。
- ~~旧 ACP 工具历史、压缩点、附件和 provider opaque metadata 的转换~~：按产品决定不再需要。

只有矩阵中的必需项全部达到“通过”，并且 beta 灰度期间没有数据/安全回归，才可以评估删除 ACP。删除 ACP 不是本轮交接的动作。

## 6 恢复开发操作手册

### 6.1 开始前

```sh
cd /Users/lhy/Project/Client/grok/MelodyWork
git switch beta
git status --short
git diff --check
```

当前工作树是迁移原型的连续工作区，不要使用 `git reset --hard`、`git checkout --` 或批量删除来“整理”它。先确认哪些改动属于本次迁移；未跟踪的 `.github/hooks/`、`.impeccable/`、`.pnpm-store/`、`.v2c/` 以及生成的 `src-tauri/binaries/` 要单独判断，不能未经确认提交。

### 6.2 本地门禁

```sh
pnpm check
pnpm lint
pnpm format:check
pnpm test:unit --silent
pnpm test:pi-worker-smoke
pnpm check:architecture
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features
git diff --check
```

CI（`.github/workflows/check.yml`）跑的是同一组命令再加 `pnpm build`；`pnpm lint`、`pnpm format:check` 与 `cargo fmt --check` 在 `packages/**` 被纳入覆盖后才真正有意义——提交前不要只跑 `pnpm check`。

需要检查静态 worker 时，使用已构建的目标产物：

```sh
MELODY_PI_WORKER_PATH=/absolute/path/to/melody-agent-worker \
  pnpm test:pi-worker-smoke
```

正式 Tauri 构建由 `beforeBuildCommand` 调用 `scripts/prepare-agent-worker.mjs --required`。开发机若没有 Bun，允许用 `MELODY_PI_WORKER_SOURCE` 或 `MELODY_BUN_PATH` 指定来源；不能把 `pnpm start` 的脚本路径当成正式 externalBin。

### 6.3 提交前

1. 更新实现、契约测试、`feature-parity.md`、`acceptance-report.md` 和 `pi-compatibility-manifest.json`；如果加入新的限制，代码标记和 manifest 必须一起改。
2. 检查 `src/domain` 没有引入 UI/React/Tauri，检查非 `packages/agent-worker/src/pi/` 没有直接 import Pi。
3. 只提交源代码、必要的 lockfile 和可复现脚本；生成的平台二进制必须由 release 构建产出，除非已有明确的供应链策略。
4. 先在 `beta` 提交和发布测试版本。没有用户明确要求时，不合并到 `main`、不创建正式版、不 push。

## 7 关键不变量

- **安全不变量：** 所有文件、命令、MCP、媒体、子代理和后台任务都经过 Host 归属、路径/权限/并发/输出上限检查；Pi 的 `always-approve` 不能绕过产品模式和 Host 策略。
- **事件不变量：** 一个 product session 使用一个稳定事件检查点；`eventId`、`sourceEventId`、`seq`、`workerEpoch` 和 `runId/promptId` 不能混用；迟到事件必须可解释地拒绝。
- **存储不变量：** React store、Rust product event log、Pi native JSONL 和 migration journal 各自有唯一职责；不要把一层的快照当成另一层的权威数据。
- **Pi-only 不变量：** 能力诊断应在创建副作用前完成；能力缺口必须明确标为不可用或阻止打开 Pi，绝不隐式切换执行引擎、改写用户偏好或丢掉输入。
- **资源不变量：** worker 停止、切换工作区、会话关闭、协议失败和应用退出都要清理 Pi 会话、MCP 子进程、后台终端和临时文件；空闲 Host 索引要有上限。
- **版本不变量：** `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的应用版本必须一致；Pi SDK 版本由 manifest 和 lockfile 同时约束。

## 8 交接验收清单

- [ ] 已阅读[迁移总览](./README.md)、[功能对等矩阵](./feature-parity.md)、[原生能力对照](./native-alternatives.md)和[最近验收报告](./acceptance-report.md)。
- [ ] 已确认当前分支为 `beta`，并保存了接手时的 `git status`/`git diff` 摘要。
- [ ] 已跑完 TypeScript、worker、前端单元、Rust、smoke、架构、兼容清单和 `git diff --check` 门禁。
- [ ] 已为每项准备实现的能力写出 ACP/Pi 对照样本和副作用清理方案。
- [ ] 已把真实环境未知项标为“待现场验收”，没有用“ACP 回退”冒充 Pi 对等。
- [ ] 旧 ACP 会话仅按只读归档展示；vendored ACP/CLI 代码的移除另按 marketplace/config CLI 依赖单独评估。
