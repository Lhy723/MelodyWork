# MelodyWork

MelodyWork 是 [Melody Build](https://github.com/Lhy723/melody-build) 的本地桌面 GUI。它以 Agent 对话为中心，在需要时展开改动审查、文件编辑、终端、Git 和 Melody 配置。

## Beta 功能

- ACP stdio 会话：启动内置 `melody-pager`、恢复会话、流式消息、工具调用与权限确认
- 多项目与多会话：SQLite 本地持久化，默认共享项目目录
- 改动审查：Git 状态、逐文件 Diff、暂存/取消暂存和提交
- 分支与 worktree：查看、创建、切换和删除用户主动创建的 worktree
- 文件与终端：受工作区边界保护的文本编辑器，以及用户主动运行的命令面板
- Melody 配置：编辑用户级和项目级 `config.toml`，发现 MCP、Skills、Plugins 与 Hooks
- 权限：一次、会话和项目级允许/拒绝；项目规则可查看和删除
- macOS 与 Windows 安装包，以及签名更新包的 GitHub Actions 流水线

所有数据都保存在本机；当前版本没有账号或云同步。

## 本地开发

需要 Node.js 22、pnpm、Rust、[DotSlash](https://dotslash-cli.com)、ripgrep
和 Tauri 2 的系统依赖。`melody-build` 以 Git submodule 固定在
`vendor/melody-build`；首次检出或上游版本更新后需要初始化：

```bash
git submodule update --init --recursive
pnpm install
cargo install dotslash --locked
pnpm tauri dev
```

`pnpm tauri dev` 会先增量编译项目内的 `vendor/melody-build` debug
sidecar，再启动 Tauri 与 Vite。sidecar 会在 Tauri 文件监听启动前准备好，避免
开发启动过程中因 sidecar 文件变化而重复唤起窗口；修改前端或 melody-build 源码后重新运行该命令即可。
设置 `MELODY_PAGER_SOURCE` 时会跳过内置仓库编译并使用指定可执行文件。

如果直接运行 `cargo build` 或 `cargo check --manifest-path src-tauri/Cargo.toml`，
`src-tauri/build.rs` 也会自动从 vendor 的 debug/release 产物准备当前架构的
sidecar；没有可用产物时，请先执行 `node scripts/prepare-sidecar.mjs` 或设置
`MELODY_PAGER_SOURCE`。

开发构建会从以下位置之一准备 sidecar：

1. `MELODY_PAGER_SOURCE` 指向的本地可执行文件
2. 自动增量编译的项目内 `vendor/melody-build/target/debug` 产物
3. 兼容旧布局的同级 `melody-build/target/debug` 或 `target/release` 产物
4. macOS/Linux 的 `~/.melody/bin/melody` 或 Windows 的 `%USERPROFILE%\.melody\bin\melody.exe`
5. 旧版 `~/.grok/bin/grok`（仅作为兼容回退）
6. 已存在的 `src-tauri/binaries/melody-pager-$TARGET_TRIPLE`

常用验证命令：

```bash
pnpm check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
```

Windows 的 Git 页面依赖系统已安装 `git` 并可从 `PATH` 访问。

## 发布与自动更新

推送 `v*` 标签会在 GitHub Actions 中：

1. 从仓库固定的 `vendor/melody-build` 提交分别为 Apple Silicon、Intel macOS 和 x64 Windows 编译 `melody-pager-bin`
2. 生成 macOS/Windows 安装包
3. 生成签名更新包和 `latest.json`
4. 创建 beta 草稿 Release；人工发布后成为 updater 的 latest Release

首次发布前需要生成 Tauri updater 密钥，并配置：

- Repository variable `TAURI_UPDATER_PUBLIC_KEY`（Tauri 生成的完整 `.pub`
  文件内容再进行 Base64 编码；必须与 `tauri.conf.json` 中的值一致）
- Secrets `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

私钥不得提交到仓库。应用会在启动时检查 GitHub Release 的 `latest.json`，发现新版本后在顶部提供安装入口。

当前 macOS beta 不使用 Apple Developer ID 签名或公证。首次启动时可能需要用户在 Finder 中右键选择“打开”，或在“系统设置 → 隐私与安全性”中确认运行。Tauri updater 密钥只用于验证更新包，不能替代 Apple 平台签名。
