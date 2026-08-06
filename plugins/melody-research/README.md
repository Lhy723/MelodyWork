# Melody Research

本地 Research 插件，把科研工作拆成六个可单独启用的技能：

- `literature-search`：白话问题到可复现多源检索计划
- `paper-review`：单篇论文的证据优先导读
- `citation-audit`：引用元数据和真实性核验
- `systematic-review`：纳入排除记录与证据矩阵
- `experiment-design`：可证伪、可复现实验设计
- `scientific-writing`：清晰、克制、证据优先的科研写作

插件还提供一个不依赖第三方 npm 包的 Node.js stdio MCP 服务：

- `search_literature`：检索 Crossref、OpenAlex、arXiv、Semantic Scholar 和 PubMed，并保留来源运行记录
- `verify_citation`：用 Crossref/OpenAlex 交叉核对 DOI 元数据
- `format_bibtex`：根据已有元数据生成保守的 BibTeX 草稿
- `research://protocol`：证据等级和来源边界说明
- `paper_review`、`systematic_review`：可复用的研究提示

在 Melody Research 的“科研能力”页面启用 MCP 后，当前项目会写入：

```toml
[mcp_servers.melody-research]
command = "node"
args = ["plugins/melody-research/scripts/research-mcp-server.mjs"]
```

已打开的会话不会热加载 MCP；请新建或重新载入会话。MCP 返回的元信息只能证明论文身份，不能替代摘要、全文和人工核验。
