import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ResearchSkillId =
  | "literature-search"
  | "paper-review"
  | "citation-audit"
  | "systematic-review"
  | "experiment-design"
  | "scientific-writing";

export interface ResearchSkillDefinition {
  id: ResearchSkillId;
  title: string;
  englishTitle: string;
  category: string;
  description: string;
  trigger: string;
  guidance: string;
}

export const RESEARCH_SKILLS: ResearchSkillDefinition[] = [
  {
    id: "literature-search",
    title: "文献检索规划",
    englishTitle: "Literature search",
    category: "发现",
    description: "把白话研究问题拆成可复现的多源检索计划。",
    trigger: "自然语言检索、入门探索、综述准备",
    guidance: "先拆解研究问题、范围和同义词，再输出可复现检索式；记录实际数据源和失败来源。",
  },
  {
    id: "paper-review",
    title: "论文证据导读",
    englishTitle: "Paper review",
    category: "阅读",
    description: "按问题—方法—证据—限制结构化阅读单篇论文。",
    trigger: "打开论文、论文总结、批判性阅读",
    guidance: "先确认论文身份，再把主张和证据绑定；区分原文事实、模型推断与未核验陈述。",
  },
  {
    id: "citation-audit",
    title: "引用与真实性核验",
    englishTitle: "Citation audit",
    category: "可信度",
    description: "核对 DOI、作者、来源和关键结论的可追溯性。",
    trigger: "收藏论文、写综述、引用核验",
    guidance: "优先用两个独立来源匹配元信息；论文存在不等于论文支持某个主张，冲突必须显式标注。",
  },
  {
    id: "systematic-review",
    title: "系统综述与证据矩阵",
    englishTitle: "Systematic review",
    category: "综合",
    description: "把检索结果整理成可追溯的纳入记录和证据矩阵。",
    trigger: "综述、开题、证据地图、科研追踪",
    guidance: "保留检索批次、纳入排除标准和论文 ID；分开证据摘要、作者解释、共识和证据空白。",
  },
  {
    id: "experiment-design",
    title: "可复现实验设计",
    englishTitle: "Experiment design",
    category: "验证",
    description: "把论文主张或知识资产转成可证伪、可复现的实验计划。",
    trigger: "验证主张、消融、基准测试、研究方案",
    guidance: "预先定义假设、变量、基线、指标、统计方法、失败条件、随机种子和复现产物。",
  },
  {
    id: "scientific-writing",
    title: "证据优先科研写作",
    englishTitle: "Scientific writing",
    category: "表达",
    description: "用清晰、克制的结构改写摘要、导读、综述和讨论。",
    trigger: "摘要、综述、结果、讨论、审稿回复",
    guidance: "按主张—证据—边界组织文本；保留效果量和不确定性，不把借鉴的期刊风格冒充官方规范。",
  },
];

export type ResearchToolId =
  | "search-literature"
  | "verify-citation"
  | "format-bibtex"
  | "evidence-matrix"
  | "study-card";

export interface ResearchToolDefinition {
  id: ResearchToolId;
  title: string;
  description: string;
  availability: string;
  detail: string;
}

export const RESEARCH_TOOLS: ResearchToolDefinition[] = [
  {
    id: "search-literature",
    title: "多源文献检索",
    description: "把检索计划发送到已接通的数据源，并保留每个来源的返回状态。",
    availability: "Crossref · OpenAlex · arXiv · Semantic Scholar · PubMed",
    detail: "支持自然语言查询改写、来源开关、去重和研究收件箱。",
  },
  {
    id: "verify-citation",
    title: "引用真实性核验",
    description: "对 DOI 和元数据做跨来源比对，给出证据等级和冲突提示。",
    availability: "Crossref · OpenAlex（界面检索支持更多来源）",
    detail: "元信息匹配只证明论文身份，不替代摘要或全文证据。",
  },
  {
    id: "format-bibtex",
    title: "引用格式生成",
    description: "从已核验论文生成保守的 BibTeX 草稿，避免补写缺失字段。",
    availability: "当前文献库和研究收件箱",
    detail: "输出仍需按目标期刊或学校模板人工复核。",
  },
  {
    id: "evidence-matrix",
    title: "证据矩阵",
    description: "将一组论文整理成可追踪的研究设计、样本、指标和限制字段。",
    availability: "系统综述技能 · 知识资产",
    detail: "每行保留论文 ID 和数据源，方便回到原文核对。",
  },
  {
    id: "study-card",
    title: "论文研究卡片",
    description: "把论文导读压缩成问题、方法、结果、限制和下一步问题。",
    availability: "论文详情 · 对话提问",
    detail: "卡片不会把模型推断伪装成论文原文结论。",
  },
];

export const RESEARCH_MCP = {
  id: "melody-research",
  title: "Melody Research MCP",
  description: "通过本地 stdio MCP 暴露检索、引用核验、BibTeX、资源和研究提示。",
  tools: ["search_literature", "verify_citation", "format_bibtex"],
  sources: ["Crossref", "OpenAlex", "arXiv", "Semantic Scholar", "PubMed"],
  resources: ["research://protocol"],
  prompts: ["paper_review", "systematic_review"],
  relativeCommand: "plugins/melody-research/scripts/research-mcp-server.mjs",
} as const;

interface ResearchCapabilityState {
  enabledSkillIds: ResearchSkillId[];
  enabledToolIds: ResearchToolId[];
  mcpEnabled: boolean;
  setSkillEnabled: (id: ResearchSkillId, enabled: boolean) => void;
  setToolEnabled: (id: ResearchToolId, enabled: boolean) => void;
  setMcpEnabled: (enabled: boolean) => void;
  reset: () => void;
}

const DEFAULT_SKILLS = RESEARCH_SKILLS.map((skill) => skill.id);
const DEFAULT_TOOLS: ResearchToolId[] = [
  "search-literature",
  "verify-citation",
  "format-bibtex",
  "evidence-matrix",
  "study-card",
];

const capabilityStorage = createJSONStorage(() =>
  typeof window === "undefined"
    ? {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => undefined,
      }
    : window.localStorage,
);

export const useResearchCapabilityStore = create<ResearchCapabilityState>()(
  persist(
    (set) => ({
      enabledSkillIds: DEFAULT_SKILLS,
      enabledToolIds: DEFAULT_TOOLS,
      mcpEnabled: false,
      setSkillEnabled: (id, enabled) =>
        set((state) => ({
          enabledSkillIds: enabled
            ? Array.from(new Set([...state.enabledSkillIds, id]))
            : state.enabledSkillIds.filter((item) => item !== id),
        })),
      setToolEnabled: (id, enabled) =>
        set((state) => ({
          enabledToolIds: enabled
            ? Array.from(new Set([...state.enabledToolIds, id]))
            : state.enabledToolIds.filter((item) => item !== id),
        })),
      setMcpEnabled: (mcpEnabled) => set({ mcpEnabled }),
      reset: () =>
        set({
          enabledSkillIds: DEFAULT_SKILLS,
          enabledToolIds: DEFAULT_TOOLS,
          mcpEnabled: false,
        }),
    }),
    {
      name: "melodyresearch.capabilities.v1",
      storage: capabilityStorage,
      version: 1,
      partialize: (state) => ({
        enabledSkillIds: state.enabledSkillIds,
        enabledToolIds: state.enabledToolIds,
        mcpEnabled: state.mcpEnabled,
      }),
    },
  ),
);

export const buildResearchSkillContext = () => {
  const { enabledSkillIds, enabledToolIds } = useResearchCapabilityStore.getState();
  const enabled = RESEARCH_SKILLS.filter((skill) =>
    enabledSkillIds.includes(skill.id),
  );
  const skillContext = enabled.length
    ? enabled.map((skill) => `${skill.title}：${skill.guidance}`).join("\n")
    : "当前没有启用 Research 技能；回答时请明确区分事实、推断和未核验信息。";
  const toolContext = RESEARCH_TOOLS.filter((tool) =>
    enabledToolIds.includes(tool.id),
  )
    .map((tool) => tool.title)
    .join("、");
  return `${skillContext}\n可用 Research 工具：${toolContext || "无"}。`;
};

export const formatResearchBibtex = (paper: {
  authors: string[];
  doi?: string;
  title: string;
  year?: number;
}) => {
  const key = (paper.doi || paper.title)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80) || "paper";
  const lines = [
    `@article{${key},`,
    `  title = {${paper.title}},`,
    `  author = {${paper.authors.join(" and ") || "Unknown"}},`,
    `  year = {${paper.year ?? ""}},`,
  ];
  if (paper.doi) {
    lines.push(`  doi = {${paper.doi}},`);
  }
  lines.push("}");
  return lines.join("\n");
};

export const buildResearchEvidenceMatrix = (
  papers: Array<{
    abstract?: string;
    authors: string[];
    doi?: string;
    id: string;
    title: string;
    url: string;
    venue?: string;
    year?: number;
  }>,
) =>
  papers.map((paper) => ({
    id: paper.id,
    identity: [paper.title, paper.doi || "无 DOI", paper.year || "年份未知"].join(
      " · ",
    ),
    design: "待从摘要或全文提取",
    outcome: "待从摘要或全文提取",
    limitations: "待人工核对原文",
    source: paper.url,
    venue: paper.venue || "来源未收录",
    authors: paper.authors.join("、") || "作者未收录",
    abstract: paper.abstract || "未提供摘要",
  }));
