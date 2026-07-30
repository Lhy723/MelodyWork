import type {
  ResearchPaper,
  ResearchSearchResult,
  ResearchSource,
} from "@/domain/research";
import { fetchResearchResource } from "@/lib/melody-bridge";

const CROSSREF_API = "https://api.crossref.org";
const OPENALEX_API = "https://api.openalex.org";
const ARXIV_API = "https://export.arxiv.org";
const PUBMED_API = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const SEMANTIC_SCHOLAR_API =
  "https://api.semanticscholar.org/graph/v1";

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

const cleanDoi = (value?: string | null) =>
  value
    ?.trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .toLowerCase();

const text = (value: unknown) =>
  typeof value === "string" ? value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";

const titleKey = (title: string) =>
  title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

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
    merged.set(key, {
      ...current,
      ...paper,
      abstract: current.abstract || paper.abstract,
      authors: current.authors.length >= paper.authors.length
        ? current.authors
        : paper.authors,
      doi: current.doi || paper.doi,
      pdfUrl: current.pdfUrl || paper.pdfUrl,
      url: current.url || paper.url,
      sources,
      verified: sources.length > 1,
      saved: current.saved || paper.saved,
      addedAt: Math.min(current.addedAt, paper.addedAt),
    });
  }
  return Array.from(merged.values()).sort(
    (left, right) =>
      (right.year ?? 0) - (left.year ?? 0) ||
      (right.citationCount ?? 0) - (left.citationCount ?? 0),
  );
};

export const paperFromCrossref = (
  item: Record<string, unknown>,
): ResearchPaper | undefined => {
  const title = text((item.title as unknown[])?.[0]);
  const doi = cleanDoi(item.DOI as string | undefined);
  if (!title) return undefined;
  const authors = Array.isArray(item.author)
    ? item.author.flatMap((author) => {
        if (!author || typeof author !== "object") return [];
        const record = author as Record<string, unknown>;
        const name = [record.given, record.family].filter(Boolean).join(" ");
        return name ? [name] : [];
      })
    : [];
  const dateParts =
    (item.published as { "date-parts"?: number[][] } | undefined)?.[
      "date-parts"
    ]?.[0];
  const resourceUrl =
    (item.URL as string | undefined) ??
    (doi ? `https://doi.org/${doi}` : undefined);
  if (!resourceUrl) return undefined;
  return {
    id: doi ? `doi:${doi}` : `title:${titleKey(title)}`,
    title,
    authors,
    year: dateParts?.[0],
    venue: text((item["container-title"] as unknown[])?.[0]),
    doi,
    url: resourceUrl,
    abstract: text(item.abstract),
    citationCount:
      typeof item["is-referenced-by-count"] === "number"
        ? item["is-referenced-by-count"]
        : undefined,
    sources: ["Crossref"],
    verified: false,
    saved: false,
    addedAt: Date.now(),
  };
};

export const paperFromOpenAlex = (
  item: Record<string, unknown>,
): ResearchPaper | undefined => {
  const title = text(item.title);
  if (!title) return undefined;
  const doi = cleanDoi(item.doi as string | undefined);
  const authorships = Array.isArray(item.authorships) ? item.authorships : [];
  const authors = authorships.flatMap((authorship) => {
    const name = (
      authorship as { author?: { display_name?: unknown } }
    ).author?.display_name;
    return typeof name === "string" ? [name] : [];
  });
  const primaryLocation = item.primary_location as
    | {
        landing_page_url?: string;
        pdf_url?: string;
        source?: { display_name?: string };
      }
    | undefined;
  const resourceUrl =
    primaryLocation?.landing_page_url ??
    (item.id as string | undefined) ??
    (doi ? `https://doi.org/${doi}` : undefined);
  if (!resourceUrl) return undefined;
  return {
    id: doi ? `doi:${doi}` : `title:${titleKey(title)}`,
    title,
    authors,
    year:
      typeof item.publication_year === "number"
        ? item.publication_year
        : undefined,
    venue: primaryLocation?.source?.display_name,
    doi,
    url: resourceUrl,
    pdfUrl: primaryLocation?.pdf_url ?? undefined,
    citationCount:
      typeof item.cited_by_count === "number"
        ? item.cited_by_count
        : undefined,
    sources: ["OpenAlex"],
    verified: false,
    saved: false,
    addedAt: Date.now(),
  };
};

export const paperFromSemanticScholar = (
  item: Record<string, unknown>,
): ResearchPaper | undefined => {
  const title = text(item.title);
  const paperId = text(item.paperId);
  if (!title || !paperId) return undefined;
  const externalIds =
    item.externalIds && typeof item.externalIds === "object"
      ? (item.externalIds as Record<string, unknown>)
      : {};
  const doi = cleanDoi(
    typeof externalIds.DOI === "string" ? externalIds.DOI : undefined,
  );
  const authors = Array.isArray(item.authors)
    ? item.authors.flatMap((author) => {
        const name =
          author && typeof author === "object"
            ? text((author as Record<string, unknown>).name)
            : "";
        return name ? [name] : [];
      })
    : [];
  const openAccessPdf =
    item.openAccessPdf && typeof item.openAccessPdf === "object"
      ? (item.openAccessPdf as Record<string, unknown>)
      : undefined;
  return {
    id: doi ? `doi:${doi}` : `semantic-scholar:${paperId}`,
    title,
    authors,
    year: typeof item.year === "number" ? item.year : undefined,
    venue: text(item.venue) || undefined,
    doi,
    url:
      text(item.url) ||
      `https://www.semanticscholar.org/paper/${encodeURIComponent(paperId)}`,
    pdfUrl: openAccessPdf ? text(openAccessPdf.url) || undefined : undefined,
    abstract: text(item.abstract) || undefined,
    citationCount:
      typeof item.citationCount === "number"
        ? item.citationCount
        : undefined,
    sources: ["Semantic Scholar"],
    verified: false,
    saved: false,
    addedAt: Date.now(),
  };
};

const fetchJson = async (url: string) => {
  const body = await fetchResearchResource(url, "application/json");
  return JSON.parse(body) as Record<string, unknown>;
};

const fetchXml = async (url: string) => {
  return new DOMParser().parseFromString(
    await fetchResearchResource(
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
  const payload = await fetchJson(`${CROSSREF_API}/works?${params}`);
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
  const payload = await fetchJson(`${OPENALEX_API}/works?${params}`);
  const items = payload.results;
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const paper = paperFromOpenAlex(item as Record<string, unknown>);
        return paper ? [paper] : [];
      })
    : [];
};

const paperFromArxivEntry = (entry: Element): ResearchPaper | undefined => {
  const title = text(entry.querySelector("title")?.textContent);
  const entryUrl = text(entry.querySelector("id")?.textContent);
  const id = entryUrl.match(/\/abs\/([^?#/]+)/i)?.[1];
  if (!title || !id) return undefined;
  const doi = cleanDoi(
    entry.getElementsByTagNameNS("http://arxiv.org/schemas/atom", "doi")[0]
      ?.textContent,
  );
  const authors = Array.from(entry.querySelectorAll("author > name"))
    .map((node) => text(node.textContent))
    .filter(Boolean);
  const published = text(entry.querySelector("published")?.textContent);
  const pdfLink = Array.from(entry.querySelectorAll("link")).find(
    (link) =>
      link.getAttribute("title") === "pdf" ||
      link.getAttribute("type") === "application/pdf",
  );
  return {
    id: doi ? `doi:${doi}` : `arxiv:${id}`,
    title,
    authors,
    year: published ? new Date(published).getUTCFullYear() : undefined,
    venue: "arXiv",
    doi,
    url: entryUrl || `https://arxiv.org/abs/${id}`,
    pdfUrl:
      pdfLink?.getAttribute("href") ?? `https://arxiv.org/pdf/${id}.pdf`,
    abstract: text(entry.querySelector("summary")?.textContent) || undefined,
    sources: ["arXiv"],
    verified: false,
    saved: false,
    addedAt: Date.now(),
  };
};

const searchArxiv = async (query: string): Promise<ResearchPaper[]> => {
  const params = new URLSearchParams({
    search_query: `all:${query.replaceAll('"', " ")}`,
    start: "0",
    max_results: "20",
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const document = await fetchXml(`${ARXIV_API}/api/query?${params}`);
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
    `${SEMANTIC_SCHOLAR_API}/paper/search?${params}`,
  );
  return Array.isArray(payload.data)
    ? payload.data.flatMap((item) => {
        const paper = paperFromSemanticScholar(
          item as Record<string, unknown>,
        );
        return paper ? [paper] : [];
      })
    : [];
};

const pubmedArticleText = (article: Element, selector: string) =>
  text(article.querySelector(selector)?.textContent);

const paperFromPubMedArticle = (
  article: Element,
): ResearchPaper | undefined => {
  const pmid = pubmedArticleText(article, "PMID");
  const title = pubmedArticleText(article, "ArticleTitle");
  if (!pmid || !title) return undefined;
  const authors = Array.from(article.querySelectorAll("Author")).flatMap(
    (author) => {
      const collective = pubmedArticleText(author, "CollectiveName");
      const personal = [
        pubmedArticleText(author, "ForeName"),
        pubmedArticleText(author, "LastName"),
      ]
        .filter(Boolean)
        .join(" ");
      const name = collective || personal;
      return name ? [name] : [];
    },
  );
  const doiNode = Array.from(article.querySelectorAll("ArticleId")).find(
    (node) => node.getAttribute("IdType")?.toLowerCase() === "doi",
  );
  const doi = cleanDoi(doiNode?.textContent);
  const dateText =
    pubmedArticleText(article, "ArticleDate > Year") ||
    pubmedArticleText(article, "PubDate > Year") ||
    pubmedArticleText(article, "PubDate > MedlineDate");
  const yearMatch = dateText.match(/\b(18|19|20|21)\d{2}\b/);
  const abstract = Array.from(article.querySelectorAll("AbstractText"))
    .map((node) => {
      const content = text(node.textContent);
      const label = text(node.getAttribute("Label"));
      return label && content ? `${label}：${content}` : content;
    })
    .filter(Boolean)
    .join("\n\n");
  return {
    id: doi ? `doi:${doi}` : `pubmed:${pmid}`,
    title,
    authors,
    year: yearMatch ? Number(yearMatch[0]) : undefined,
    venue:
      pubmedArticleText(article, "Journal > Title") ||
      pubmedArticleText(article, "MedlineJournalInfo > MedlineTA") ||
      "PubMed",
    doi,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    abstract: abstract || undefined,
    sources: ["PubMed"],
    verified: false,
    saved: false,
    addedAt: Date.now(),
  };
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
    `${PUBMED_API}/esearch.fcgi?${searchParams}`,
  );
  const ids = (
    searchPayload.esearchresult as { idlist?: unknown } | undefined
  )?.idlist;
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
    `${PUBMED_API}/efetch.fcgi?${fetchParams}`,
  );
  return Array.from(document.querySelectorAll("PubmedArticle")).flatMap(
    (article) => {
      const paper = paperFromPubMedArticle(article);
      return paper ? [paper] : [];
    },
  );
};

export const searchResearchPapers = async (
  query: string,
  requestedSources: ResearchSource[] = DEFAULT_RESEARCH_SEARCH_SOURCES,
): Promise<ResearchSearchResult> => {
  const trimmed = query.trim();
  if (!trimmed) {
    return { papers: [], sources: [], warnings: [] };
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
  const attempts = await Promise.allSettled(
    enabledAdapters.map(([, search]) => search(trimmed)),
  );
  const sources: ResearchSource[] = [];
  const warnings: string[] = [];
  const papers: ResearchPaper[] = [];
  for (const [index, attempt] of attempts.entries()) {
    const [source] = enabledAdapters[index];
    if (attempt.status === "fulfilled") {
      sources.push(source);
      papers.push(...attempt.value);
    } else {
      warnings.push(`${source}：${attempt.reason}`);
    }
  }
  if (sources.length === 0) {
    throw new Error(warnings.join("\n") || "学术数据源暂时不可用。");
  }
  return { papers: mergeResearchPapers(papers), sources, warnings };
};

const extractDoi = (candidate: string) => {
  const decoded = decodeURIComponent(candidate);
  const match = decoded.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return cleanDoi(match?.[0]);
};

const crossrefByDoi = async (doi: string) => {
  const payload = await fetchJson(
    `${CROSSREF_API}/works/${encodeURIComponent(doi)}`,
  );
  const message = payload.message;
  return message && typeof message === "object"
    ? paperFromCrossref(message as Record<string, unknown>)
    : undefined;
};

const openAlexByDoi = async (doi: string) => {
  const payload = await fetchJson(
    `${OPENALEX_API}/works/${encodeURIComponent(`https://doi.org/${doi}`)}`,
  );
  return paperFromOpenAlex(payload);
};

const importArxiv = async (candidate: string): Promise<ResearchPaper> => {
  const id = candidate.match(/(?:abs|pdf)\/([^?#/]+?)(?:\.pdf)?(?:[?#]|$)/i)?.[1];
  if (!id) throw new Error("无法从链接中识别 arXiv ID。");
  const document = await fetchXml(
    `${ARXIV_API}/api/query?id_list=${encodeURIComponent(id)}`,
  );
  const entry = document.querySelector("entry");
  const paper = entry ? paperFromArxivEntry(entry) : undefined;
  if (!paper) throw new Error("arXiv 未返回该论文。");
  return { ...paper, saved: true, verified: true };
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
