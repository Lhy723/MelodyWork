import type {
  ResearchPaper,
  ResearchSearchResult,
  ResearchSource,
  ResearchVerificationEvidence,
} from "@/domain/research";
import { ResearchSourceClient } from "@/domain/research-source-adapter";
import { fetchResearchResource } from "@/lib/melody-bridge";
import {
  cleanDoi,
  paperFromArxivEntry,
  paperFromCrossref,
  paperFromOpenAlex,
  paperFromPubMedArticle,
  paperFromSemanticScholar,
  titleKey,
} from "./research-paper-parsers";

export {
  cleanDoi,
  paperFromArxivEntry,
  paperFromCrossref,
  paperFromOpenAlex,
  paperFromPubMedArticle,
  paperFromSemanticScholar,
  titleKey,
} from "./research-paper-parsers";

const CROSSREF_API = "https://api.crossref.org";
const OPENALEX_API = "https://api.openalex.org";
const ARXIV_API = "https://export.arxiv.org";
const PUBMED_API = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1";

export const RESEARCH_SEARCH_SOURCES: ResearchSource[] = [
  "Crossref",
  "OpenAlex",
  "arXiv",
  "Semantic Scholar",
  "PubMed",
];
export const DEFAULT_RESEARCH_SEARCH_SOURCES: ResearchSource[] = [
  "Crossref",
  "arXiv",
  "Semantic Scholar",
  "PubMed",
];

export type ResearchSearchProgress = {
  source: ResearchSource;
  status: "running" | "success" | "error";
  completed: number;
  total: number;
  resultCount?: number;
  message?: string;
};

const researchSourceClient = new ResearchSourceClient();

const fetchSourceResource = (
  source: ResearchSource,
  url: string,
  accept?: string,
) =>
  researchSourceClient.fetch(
    source,
    `${source}:${accept ?? ""}:${url}`,
    (signal) => fetchResearchResource(url, accept, signal),
  );

const recordIdForPaper = (paper: ResearchPaper) =>
  paper.id.replace(/^(?:doi|arxiv|pubmed|semantic-scholar):/i, "");

const evidenceForPaper = (
  paper: ResearchPaper,
  checkedAt: number,
): ResearchVerificationEvidence[] => [
  ...(paper.verification?.evidence ?? []),
  ...paper.sources.map((source) => ({
    source,
    status: "matched" as const,
    checkedAt,
    recordId: recordIdForPaper(paper),
    title: paper.title,
    url: paper.url,
  })),
];

const mergeVerificationEvidence = (
  evidence: ResearchVerificationEvidence[],
) => {
  const uniqueEvidence = new Map<string, ResearchVerificationEvidence>();
  for (const item of evidence) {
    const key = `${item.source}:${item.recordId ?? item.title ?? "unknown"}`;
    if (!uniqueEvidence.has(key)) uniqueEvidence.set(key, item);
  }
  return Array.from(uniqueEvidence.values());
};

export const mergeResearchPapers = (
  papers: ResearchPaper[],
): ResearchPaper[] => {
  const merged = new Map<string, ResearchPaper>();
  for (const paper of papers) {
    const doi = cleanDoi(paper.doi);
    const normalizedTitle = titleKey(paper.title);
    const existingEntry = Array.from(merged.entries()).find(
      ([, current]) =>
        (doi && cleanDoi(current.doi) === doi) ||
        titleKey(current.title) === normalizedTitle,
    );
    const key = existingEntry?.[0] ?? doi ?? normalizedTitle;
    const current = existingEntry?.[1];
    if (!current) {
      merged.set(key, paper);
      continue;
    }
    const sources = Array.from(new Set([...current.sources, ...paper.sources]));
    const checkedAt = Date.now();
    merged.set(key, {
      ...current,
      ...paper,
      abstract: current.abstract || paper.abstract,
      authors:
        current.authors.length >= paper.authors.length
          ? current.authors
          : paper.authors,
      doi: current.doi || paper.doi,
      pdfUrl: current.pdfUrl || paper.pdfUrl,
      url: current.url || paper.url,
      sources,
      verified: sources.length > 1,
      verification: {
        status: sources.length > 1 ? "verified" : "single-source",
        checkedAt,
        matchedSources: sources,
        method: "cross-source-metadata-match",
        evidence: mergeVerificationEvidence([
          ...evidenceForPaper(current, checkedAt),
          ...evidenceForPaper(paper, checkedAt),
        ]),
      },
      saved: current.saved || paper.saved,
      addedAt: Math.min(current.addedAt, paper.addedAt),
    });
  }
  return Array.from(merged.values())
    .sort(
      (left, right) =>
        (right.year ?? 0) - (left.year ?? 0) ||
        (right.citationCount ?? 0) - (left.citationCount ?? 0),
    )
    .map((paper) => ({
      ...paper,
      verification: {
        status: paper.verified ? "verified" : "single-source",
        checkedAt: Date.now(),
        matchedSources: paper.sources,
        method: "cross-source-metadata-match",
        evidence: mergeVerificationEvidence(
          evidenceForPaper(paper, Date.now()),
        ),
      },
    }));
};

const fetchJson = async (source: ResearchSource, url: string) => {
  const body = await fetchSourceResource(source, url, "application/json");
  return JSON.parse(body) as Record<string, unknown>;
};

const fetchXml = async (source: ResearchSource, url: string) => {
  return new DOMParser().parseFromString(
    await fetchSourceResource(
      source,
      url,
      "application/atom+xml, application/xml, text/xml",
    ),
    "application/xml",
  );
};

const searchCrossref = async (query: string): Promise<ResearchPaper[]> => {
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: "20",
  });
  const payload = await fetchJson(
    "Crossref",
    `${CROSSREF_API}/works?${params}`,
  );
  const items = (payload.message as { items?: unknown[] } | undefined)?.items;
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const paper = paperFromCrossref(item as Record<string, unknown>);
        return paper ? [paper] : [];
      })
    : [];
};

const searchOpenAlex = async (query: string): Promise<ResearchPaper[]> => {
  const params = new URLSearchParams({ search: query, "per-page": "20" });
  const payload = await fetchJson(
    "OpenAlex",
    `${OPENALEX_API}/works?${params}`,
  );
  const items = payload.results;
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const paper = paperFromOpenAlex(item as Record<string, unknown>);
        return paper ? [paper] : [];
      })
    : [];
};

const searchArxiv = async (query: string): Promise<ResearchPaper[]> => {
  const params = new URLSearchParams({
    search_query: `all:${query.replaceAll('"', " ")}`,
    start: "0",
    max_results: "20",
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const document = await fetchXml("arXiv", `${ARXIV_API}/api/query?${params}`);
  return Array.from(document.querySelectorAll("entry")).flatMap((entry) => {
    const paper = paperFromArxivEntry(entry);
    return paper ? [paper] : [];
  });
};

const searchSemanticScholar = async (
  query: string,
): Promise<ResearchPaper[]> => {
  const params = new URLSearchParams({
    query,
    limit: "20",
    fields:
      "title,authors,year,venue,externalIds,url,openAccessPdf,citationCount,abstract",
  });
  const payload = await fetchJson(
    "Semantic Scholar",
    `${SEMANTIC_SCHOLAR_API}/paper/search?${params}`,
  );
  return Array.isArray(payload.data)
    ? payload.data.flatMap((item) => {
        const paper = paperFromSemanticScholar(item as Record<string, unknown>);
        return paper ? [paper] : [];
      })
    : [];
};

const searchPubMed = async (query: string): Promise<ResearchPaper[]> => {
  const searchParams = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmode: "json",
    retmax: "20",
    sort: "relevance",
  });
  const searchPayload = await fetchJson(
    "PubMed",
    `${PUBMED_API}/esearch.fcgi?${searchParams}`,
  );
  const ids = (searchPayload.esearchresult as { idlist?: unknown } | undefined)
    ?.idlist;
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const normalizedIds = ids.filter(
    (id): id is string => typeof id === "string",
  );
  if (normalizedIds.length === 0) return [];
  const fetchParams = new URLSearchParams({
    db: "pubmed",
    id: normalizedIds.join(","),
    retmode: "xml",
  });
  const document = await fetchXml(
    "PubMed",
    `${PUBMED_API}/efetch.fcgi?${fetchParams}`,
  );
  return Array.from(document.querySelectorAll("PubmedArticle")).flatMap(
    (article) => {
      const paper = paperFromPubMedArticle(article);
      return paper ? [paper] : [];
    },
  );
};

const sourceRequestQuery = (source: ResearchSource, query: string) =>
  source === "arXiv" ? `all:${query.replaceAll('"', " ")}` : query;

export const searchResearchPapers = async (
  query: string,
  requestedSources: ResearchSource[] = DEFAULT_RESEARCH_SEARCH_SOURCES,
  onProgress?: (progress: ResearchSearchProgress) => void,
): Promise<ResearchSearchResult> => {
  const trimmed = query.trim();
  if (!trimmed) {
    return { papers: [], sources: [], warnings: [], sourceRuns: [] };
  }
  const adapters: Array<
    [ResearchSource, (query: string) => Promise<ResearchPaper[]>]
  > = [
    ["Crossref", searchCrossref],
    ["OpenAlex", searchOpenAlex],
    ["arXiv", searchArxiv],
    ["Semantic Scholar", searchSemanticScholar],
    ["PubMed", searchPubMed],
  ];
  const enabledAdapters = adapters.filter(([source]) =>
    requestedSources.includes(source),
  );
  if (enabledAdapters.length === 0) {
    throw new Error("请至少选择一个文献数据源。");
  }
  let completed = 0;
  const total = enabledAdapters.length;
  const attempts = await Promise.allSettled(
    enabledAdapters.map(async ([source, search]) => {
      onProgress?.({ source, status: "running", completed, total });
      try {
        const papers = await search(trimmed);
        completed += 1;
        onProgress?.({
          source,
          status: "success",
          completed,
          total,
          resultCount: papers.length,
        });
        return papers;
      } catch (reason) {
        completed += 1;
        onProgress?.({
          source,
          status: "error",
          completed,
          total,
          message: reason instanceof Error ? reason.message : String(reason),
        });
        throw reason;
      }
    }),
  );
  const sources: ResearchSource[] = [];
  const warnings: string[] = [];
  const papers: ResearchPaper[] = [];
  const sourceRuns = [];
  for (const [index, attempt] of attempts.entries()) {
    const [source] = enabledAdapters[index];
    const checkedAt = Date.now();
    if (attempt.status === "fulfilled") {
      sources.push(source);
      papers.push(...attempt.value);
      sourceRuns.push({
        source,
        status: "success" as const,
        resultCount: attempt.value.length,
        query: trimmed,
        requestQuery: sourceRequestQuery(source, trimmed),
        checkedAt,
      });
    } else {
      const message = String(attempt.reason);
      warnings.push(`${source}：${message}`);
      sourceRuns.push({
        source,
        status: "error" as const,
        resultCount: 0,
        query: trimmed,
        requestQuery: sourceRequestQuery(source, trimmed),
        checkedAt,
        message,
      });
    }
  }
  if (sources.length === 0) {
    throw new Error(warnings.join("\n") || "学术数据源暂时不可用。");
  }
  return {
    papers: mergeResearchPapers(papers),
    sources,
    warnings,
    sourceRuns,
  };
};

const extractDoi = (candidate: string) => {
  const decoded = decodeURIComponent(candidate);
  const match = decoded.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return cleanDoi(match?.[0]);
};

const crossrefByDoi = async (doi: string) => {
  const payload = await fetchJson(
    "Crossref",
    `${CROSSREF_API}/works/${encodeURIComponent(doi)}`,
  );
  const message = payload.message;
  return message && typeof message === "object"
    ? paperFromCrossref(message as Record<string, unknown>)
    : undefined;
};

const openAlexByDoi = async (doi: string) => {
  const payload = await fetchJson(
    "OpenAlex",
    `${OPENALEX_API}/works/${encodeURIComponent(`https://doi.org/${doi}`)}`,
  );
  return paperFromOpenAlex(payload);
};

export const verifyResearchPaper = async (
  paper: ResearchPaper,
): Promise<ResearchPaper> => {
  const doi = cleanDoi(paper.doi);
  if (!doi) {
    throw new Error(
      "只有带 DOI 的论文可以执行跨来源核验。请先补充 DOI 或打开原文。",
    );
  }
  const attempts = await Promise.allSettled([
    crossrefByDoi(doi),
    openAlexByDoi(doi),
  ]);
  const records = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" && attempt.value ? [attempt.value] : [],
  );
  if (records.length === 0) {
    throw new Error("Crossref 与 OpenAlex 都没有返回该 DOI 的元数据。");
  }
  const merged = mergeResearchPapers([{ ...paper, doi }, ...records]);
  return merged[0] ?? paper;
};

const importArxiv = async (candidate: string): Promise<ResearchPaper> => {
  const id = candidate.match(
    /(?:abs|pdf)\/([^?#/]+?)(?:\.pdf)?(?:[?#]|$)/i,
  )?.[1];
  if (!id) throw new Error("无法从链接中识别 arXiv ID。");
  const document = await fetchXml(
    "arXiv",
    `${ARXIV_API}/api/query?id_list=${encodeURIComponent(id)}`,
  );
  const entry = document.querySelector("entry");
  const paper = entry ? paperFromArxivEntry(entry) : undefined;
  if (!paper) throw new Error("arXiv 未返回该论文。");
  return {
    ...paper,
    saved: true,
    verified: false,
    verification: {
      status: "single-source",
      checkedAt: Date.now(),
      matchedSources: paper.sources,
      method: "cross-source-metadata-match",
      evidence: evidenceForPaper(paper, Date.now()),
    },
  };
};

export const importResearchPaper = async (
  candidate: string,
): Promise<ResearchPaper> => {
  const value = candidate.trim();
  if (!value) throw new Error("请输入论文链接或 DOI。");
  if (/arxiv\.org\/(?:abs|pdf)\//i.test(value)) {
    return importArxiv(value);
  }
  const doi = extractDoi(value);
  if (!doi) {
    throw new Error("当前支持 arXiv 链接、doi.org 链接或 DOI。");
  }
  const attempts = await Promise.allSettled([
    crossrefByDoi(doi),
    openAlexByDoi(doi),
  ]);
  const papers = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" && attempt.value ? [attempt.value] : [],
  );
  if (papers.length === 0) {
    throw new Error("Crossref 与 OpenAlex 均未找到该 DOI。");
  }
  return { ...mergeResearchPapers(papers)[0], saved: true };
};
