![MelodyWork](docs/images/melodywork-hero.png)

[English](README.md) | **简体中文**

# MelodyWork

> 一个面向 [Melody Build](https://github.com/Lhy723/melody-build) 的本地优先桌面工作台。

MelodyWork 将完整的 Agent 工作闭环带到一个专注的桌面应用中：围绕任务进行对话，审查改动，查看文件，运行命令，并直接从本地项目交付结果。它强调开发者控制权，围绕 Git 工作流构建，并提供清晰、可追踪的权限边界。

**本地优先 · Agent 协作 · Git 原生 · 面向交付**

## 能力概览

| 领域 | 能力 |
| --- | --- |
| **Agent 会话** | 使用内置 `melody-pager` 启动和恢复 ACP stdio 会话，流式展示响应与工具活动，并在上下文中处理权限请求。 |
| **项目管理** | 支持多个项目和会话，使用本地 SQLite 持久化，默认共享项目目录。 |
| **Git 工作流** | 查看仓库状态和逐文件 Diff，暂存变更、提交代码，并管理分支和用户主动创建的 worktree。 |
| **文件与终端** | 编辑受工作区边界保护的文本文件，预览受支持的文件，并通过集成终端面板有意识地运行命令。 |
| **研究工作区** | 收集研究上下文，整理来源材料，让调查过程与实现工作保持在同一个工作区内。 |
| **配置管理** | 管理用户级和项目级 `config.toml`，发现工作区中的 MCP、Skills、Plugins 和 Hooks。 |
| **权限控制** | 支持一次性、会话级和项目级允许或拒绝；项目规则可查看和删除。 |

## 设计原则

- **代码属于你。** 项目、会话状态和工作数据都保存在本机。当前 beta 版本没有账号系统或云同步。
- **仓库是事实来源。** Git 状态、Diff、提交、分支和 worktree 都是一等能力，而不是事后补上的工具。
- **自动化保持可见。** 工具调用、终端活动、文件变更和权限请求都可以在同一个工作区中查看和审查。
- **严肃工作需要严肃的界面。** MelodyWork 是为持续的工程工作打造的完整工作台，而不是简单包裹 Shell 的聊天窗口。

## 快速开始

### 环境要求

- Node.js 22
- pnpm
- Rust 工具链
- [DotSlash](https://dotslash-cli.com)
- ripgrep
- 对应平台的 Tauri 2 系统依赖

`melody-build` 以 Git submodule 的形式固定在 `vendor/melody-build`。首次克隆或上游固定版本发生变化后，请初始化 submodule：

```bash
git submodule update --init --recursive
pnpm install
cargo install dotslash --locked
pnpm tauri dev
```

`pnpm tauri dev` 会先增量编译本地 `melody-build` debug sidecar，再启动 Tauri 和 Vite。这样的启动顺序可以避免 sidecar 准备过程中触发文件监听器，导致窗口被重复唤起。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动 Vite 前端开发服务器。 |
| `pnpm tauri dev` | 构建或刷新 sidecar，然后启动桌面应用。 |
| `pnpm check` | 执行 TypeScript 类型检查。 |
| `pnpm test:unit` | 运行前端和领域层单元测试。 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 运行 Rust 测试。 |
| `pnpm build` | 生成生产环境前端构建产物。 |

Windows 用户需要确保系统已安装 `git`，并且可以从 `PATH` 访问，以使用 Git 工作区能力。

### Sidecar 查找顺序

在本地开发和直接执行 Rust 构建时，MelodyWork 会按以下顺序查找可用的 `melody-pager` sidecar：

1. `MELODY_PAGER_SOURCE` 指向的本地可执行文件
2. 项目内增量编译生成的 `vendor/melody-build/target/debug` 产物
3. 兼容旧目录结构的同级 `melody-build/target/debug` 或 `target/release` 产物
4. macOS/Linux 的 `~/.melody/bin/melody`，或 Windows 的 `%USERPROFILE%\\.melody\\bin\\melody.exe`
5. 旧版 `~/.grok/bin/grok` 兼容回退
6. 已存在的 `src-tauri/binaries/melody-pager-$TARGET_TRIPLE` 二进制文件

运行 `cargo build` 或 `cargo check --manifest-path src-tauri/Cargo.toml` 时，`src-tauri/build.rs` 也会自动准备匹配当前架构的 sidecar。如果没有可用产物，请先运行 `node scripts/prepare-sidecar.mjs`，或设置 `MELODY_PAGER_SOURCE`。

## 发布与更新

推送 `v*` 标签会触发 GitHub Actions 发布工作流。工作流会基于仓库固定的 Melody sidecar 提交，分别构建 Apple Silicon macOS、Intel macOS 和 x64 Windows 版本，生成签名更新包和 `latest.json`，并创建 beta 草稿 Release。人工发布后，该 Release 会成为 updater 使用的最新版本。

首次发布前，请生成 Tauri updater 密钥并配置：

- Repository variable `TAURI_UPDATER_PUBLIC_KEY`：完整的 `.pub` 文件内容进行 Base64 编码后的值，必须与 `tauri.conf.json` 中的配置一致
- Secrets `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

私钥不得提交到仓库。应用启动时会检查 GitHub Release 中的 `latest.json`，发现新版本后在应用顶部提供安装入口。

当前 macOS beta 不使用 Apple Developer ID 签名或公证。首次启动时，macOS 可能要求用户在 Finder 中右键选择“打开”，或在 **系统设置 → 隐私与安全性** 中确认运行。Tauri updater 密钥只用于验证更新包，不能替代 Apple 平台签名。

## 项目状态

MelodyWork 目前处于持续迭代的 beta 阶段，目标是为 Melody Build 提供可靠的本地工作环境，同时继续完善产品界面和发布流程。

---

基于 [Melody Build](https://github.com/Lhy723/melody-build) 构建，为思考、审查和交付留出更多空间。
