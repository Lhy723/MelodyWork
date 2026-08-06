# 右侧文件预览功能交接

更新时间：2026-08-01  
当前状态：主体实现、纯逻辑测试和构建检查已完成；已启动 Tauri 桌面壳并验证右侧预览布局，真实二进制样例的逐项回归仍待在桌面端完成；尚未提交 Git。

## 目标

扩展右侧工作区的文件预览能力，在保留现有 Monaco 文本预览的基础上，支持 Markdown、HTML、图片、SVG、PDF、音频、视频以及现代 Office 文件。

## 已完成

### 统一文件预览器

新增 `src/features/files/file-preview.tsx`，并从 `workspace-side-panel.tsx` 中移出原有的内联文本预览实现。

预览类型分流、语言映射、MIME 映射和 XLSX 列号转换已抽到
`src/features/files/file-preview-utils.ts`，方便扩展和单元测试。

当前分流如下：

- 文本与代码：继续使用只读 Monaco，并扩展了常见语言的高亮映射。
- Markdown：默认排版渲染，可切换到源码。
- HTML：使用无脚本权限的沙盒 `iframe` 渲染，可切换到源码。
- 图片与 SVG：使用自适应等比预览。
- PDF：使用内嵌 PDF 查看器。
- 音频：使用浏览器原生音频控件。
- 视频：使用浏览器原生视频控件。
- DOCX：本地提取段落和表格，按文档页面样式展示。
- XLSX：本地解析工作表，提供工作表切换和可滚动表格。
- PPTX：本地提取幻灯片文本，按 16:9 幻灯片列表展示。
- 旧式 `.doc`、`.xls`、`.ppt`：目前显示明确的格式升级提示，尚未实现解析。
- 未识别扩展名：仍尝试作为 UTF-8 纯文本打开。

### 安全的二进制读取

在 `src-tauri/src/workspace_runtime.rs` 新增 `read_workspace_binary_file`：

- 复用现有工作区根目录校验，拒绝访问项目目录外的路径。
- 使用 `tauri::ipc::Response` 返回二进制数据，避免大型文件经过 JSON 数组序列化。
- 单文件预览上限为 100 MB。
- 不开放 Tauri Asset Protocol，也不扩大 WebView 对用户目录的静态访问范围。

命令已经在 `src-tauri/src/lib.rs` 注册，前端桥接位于 `src/lib/melody-bridge.ts`。

### Office 本地解析

新增依赖 `fflate@0.8.3`，用于解析 DOCX、XLSX、PPTX 的 ZIP/XML 结构。

- 仅解压预览需要的 XML，不提取内嵌媒体。
- 参与预览的解压后内容累计上限为 100 MB。
- XLSX 最多显示每张表 500 行、100 列。
- PPTX 最多提取 200 张幻灯片。
- 文件内容不会上传到第三方服务。

## 已完成验证

- `pnpm check`：通过。
- `pnpm build`：通过。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过。
  - 使用 `/private/tmp/melodywork-preview-check` 作为临时 Cargo target。
  - 检查结束后临时 target 已移入系统废纸篓，未保留项目内的大型 Rust 缓存。
- `git diff --check`：通过。
- `node --experimental-strip-types --test src/features/files/file-preview-utils.test.mjs src/domain/*.test.mjs`：26 项通过。
- `cargo test --manifest-path src-tauri/Cargo.toml workspace_runtime --lib`：4 项通过，覆盖二进制预览读取、目录拒绝、工作区外路径拒绝和终端回归。
- 浏览器模式下主界面可以正常加载，文件树可打开文本预览，刷新按钮可重新读取，原有右侧工作区空状态未出现布局回归。
- 使用现有 debug sidecar 启动 Tauri 桌面壳成功，并确认右侧工作区在桌面 WebView 中正常渲染；首次启动失败仅因独立 Vite 已占用 1420 端口，随后已停掉独立进程并完成桌面启动。
- 已将本轮生成的 `src-tauri/target`、`dist`、临时 Playwright 产物和 vendor Rust 增量缓存移入系统废纸篓；工作区从约 15 GB 降至约 1.2 GB。vendor 中保留约 380 MB 的 debug sidecar，可继续用于快速启动。
- Rust 测试所需的 sidecar 和临时 Cargo target 已在测试结束后再次移入系统废纸篓，当前工作区没有残留生成二进制。

## 尚待完成

### 必做回归

1. 在 Tauri 桌面运行时逐一打开真实样例（当前尚未逐项完成）：
   - PNG、JPEG、GIF、WebP、SVG
   - PDF
   - MP3、WAV
   - MP4、WebM
   - DOCX、XLSX、PPTX
   - Markdown、HTML
2. 在桌面端验证刷新按钮会重新读取当前文件，以及切换或关闭标签页后 Blob URL 被释放。
3. 在桌面端验证 2 MB 文本限制、100 MB 二进制限制和损坏 Office 文件的错误状态。
4. 检查深色模式下 PDF、Office 页面和媒体区域的视觉效果。
5. 检查窄右侧面板下标题、文件类型标签以及“预览/源码”按钮是否拥挤。

### 已知限制

- DOCX 当前以内容预览为主，不还原复杂样式、分页、页眉页脚、浮动图片和批注。
- XLSX 当前不计算公式，只显示文件中缓存的结果；不还原图表、合并单元格和复杂样式。
- PPTX 当前提取文字内容，不还原母版、图形、图片、动画和精确坐标。
- 旧式二进制 Office 格式尚未解析。
- HTML 预览禁用脚本；相对路径资源目前没有以源文件目录作为基准解析。
- 音视频需要底层 WebView 支持相应编码格式。
- 浏览器开发模式的二进制读取是文本占位数据，因此媒体和 Office 的完整验证必须在 Tauri 桌面运行时完成。

## 建议的下一步

1. 先补齐真实文件的桌面端回归，修复发现的问题。
2. 为 DOCX/XLSX/PPTX 的具体 XML 解析增加浏览器或 DOM 环境测试；目前已覆盖文件类型分流、MIME/语言映射和 XLSX 列号转换。
3. 若要求 Office 高保真预览，评估引入专用渲染器或调用本地 LibreOffice 转 PDF；当前实现定位是快速、安全、可读的本地内容预览。
4. 回归通过后再提交，建议提交信息：

   `feat: add rich workspace file previews`

## 当前改动文件

- `package.json`
- `pnpm-lock.yaml`
- `src-tauri/src/lib.rs`
- `src-tauri/src/workspace_runtime.rs`
- `src/features/files/file-preview.tsx`
- `src/features/files/file-preview-utils.ts`
- `src/features/files/file-preview-utils.test.mjs`
- `src/features/workspace/workspace-side-panel.tsx`
- `src/lib/melody-bridge.ts`

## 工作区注意事项

- 当前功能改动尚未提交。
- `cargo fmt --check` 会报告 `src-tauri/src/agent_runtime.rs` 中一处既有格式差异，该文件不属于本功能改动。
- 生产构建会生成被 Git 忽略的 `dist`；本轮验证后已清理。系统废纸篓中的缓存如需恢复仍可找回，确认无用后可由用户统一清空废纸篓。
- Tauri 的 `cargo test` / `tauri dev` 需要先由 `scripts/prepare-sidecar.mjs` 生成 `src-tauri/binaries` 下的当前平台 sidecar；为控制体积，本轮测试结束后该生成文件已清理。
