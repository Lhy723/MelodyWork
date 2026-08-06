#!/usr/bin/env node

const CROSSREF_API = "https://api.crossref.org";
const OPENALEX_API = "https://api.openalex.org";
const ARXIV_API = "https://export.arxiv.org";
const PUBMED_API = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1";
const MAX_RESULTS = 20;

const asText = (value) =>
  typeof value === "string"
    ? value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : "";

const cleanDoi = (value) =>
  asText(value)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .toLowerCase();

const json = (value) => JSON.stringify(value, null, 2);

const decodeXml = (value) =>
  asText(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const xmlTag = (value, tag) => {
  const match = value.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
};

const fetchJson = async (url) => {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "MelodyResearch/0.1 (research MCP)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(response.status + " " + response.statusText);
  return response.json();
};

const paperFromCrossref = (item) => {
  const title = asText(item?.title?.[0]);
  if (!title) return undefined;
  const doi = cleanDoi(item?.DOI);
  return {
    id: doi ? "doi:" + doi : "title:" + title.toLowerCase(),
    title,
    authors: Array.isArray(item?.author)
      ? item.author
          .map((author) => [author?.given, author?.family].filter(Boolean).join(" "))
          .filter(Boolean)
      : [],
    year: item?.published?.["date-parts"]?.[0]?.[0],
    venue: asText(item?.["container-title"]?.[0]) || undefined,
    doi: doi || undefined,
    url: item?.URL || (doi ? "https://doi.org/" + doi : undefined),
    citationCount: item?.["is-referenced-by-count"],
    source: "Crossref",
  };
};

const searchCrossref = async (query, limit) => {
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: String(Math.min(limit, MAX_RESULTS)),
  });
  const payload = await fetchJson(CROSSREF_API + "/works?" + params);
  return (Array.isArray(payload?.message?.items) ? payload.message.items : [])
    .map(paperFromCrossref)
    .filter(Boolean);
};

const searchOpenAlex = async (query, limit) => {
  const params = new URLSearchParams({
    search: query,
    "per-page": String(Math.min(limit, MAX_RESULTS)),
  });
  const payload = await fetchJson(OPENALEX_API + "/works?" + params);
  return (Array.isArray(payload?.results) ? payload.results : [])
    .map((item) => {
      const title = asText(item?.title);
      if (!title) return undefined;
      const doi = cleanDoi(item?.doi);
      return {
        id: doi ? "doi:" + doi : item?.id,
        title,
        authors: Array.isArray(item?.authorships)
          ? item.authorships
              .map((authorship) => asText(authorship?.author?.display_name))
              .filter(Boolean)
          : [],
        year: item?.publication_year,
        venue: asText(item?.primary_location?.source?.display_name) || undefined,
        doi: doi || undefined,
        url: item?.primary_location?.landing_page_url || item?.id,
        pdfUrl: item?.primary_location?.pdf_url || undefined,
        citationCount: item?.cited_by_count,
        source: "OpenAlex",
      };
    })
    .filter(Boolean);
};

const searchArxiv = async (query, limit) => {
  const params = new URLSearchParams({
    search_query: `all:${query.replaceAll('"', " ")}`,
    start: "0",
    max_results: String(Math.min(limit, MAX_RESULTS)),
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const response = await fetch(ARXIV_API + "/api/query?" + params, {
    headers: { accept: "application/atom+xml" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(response.status + " " + response.statusText);
  const xml = await response.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].flatMap((match) => {
    const entry = match[1];
    const title = xmlTag(entry, "title");
    const url = xmlTag(entry, "id");
    if (!title || !url) return [];
    const id = url.match(/\/abs\/([^?#/]+)/i)?.[1];
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((item) => decodeXml(item[1]));
    const published = xmlTag(entry, "published");
    return [{
      id: id ? "arxiv:" + id : "title:" + title.toLowerCase(),
      title,
      authors,
      year: published ? Number(published.slice(0, 4)) : undefined,
      venue: "arXiv",
      url,
      pdfUrl: id ? "https://arxiv.org/pdf/" + id + ".pdf" : undefined,
      abstract: xmlTag(entry, "summary") || undefined,
      source: "arXiv",
    }];
  });
};

const searchSemanticScholar = async (query, limit) => {
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(limit, MAX_RESULTS)),
    fields: "title,authors,year,venue,abstract,url,openAccessPdf,citationCount,externalIds",
  });
  const payload = await fetchJson(SEMANTIC_SCHOLAR_API + "/paper/search?" + params);
  return (Array.isArray(payload?.data) ? payload.data : []).flatMap((item) => {
    const title = asText(item?.title);
    if (!title) return [];
    const doi = cleanDoi(item?.externalIds?.DOI);
    return [{
      id: doi ? "doi:" + doi : "semantic-scholar:" + asText(item?.paperId),
      title,
      authors: Array.isArray(item?.authors)
        ? item.authors.map((author) => asText(author?.name)).filter(Boolean)
        : [],
      year: item?.year,
      venue: asText(item?.venue) || undefined,
      doi: doi || undefined,
      url: asText(item?.url) || undefined,
      pdfUrl: asText(item?.openAccessPdf?.url) || undefined,
      abstract: asText(item?.abstract) || undefined,
      citationCount: item?.citationCount,
      source: "Semantic Scholar",
    }];
  });
};

const searchPubMed = async (query, limit) => {
  const searchParams = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmode: "json",
    retmax: String(Math.min(limit, MAX_RESULTS)),
  });
  const search = await fetchJson(PUBMED_API + "/esearch.fcgi?" + searchParams);
  const ids = Array.isArray(search?.esearchresult?.idlist)
    ? search.esearchresult.idlist
    : [];
  if (!ids.length) return [];
  const fetchParams = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "xml",
  });
  const response = await fetch(PUBMED_API + "/efetch.fcgi?" + fetchParams, {
    headers: { accept: "application/xml" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(response.status + " " + response.statusText);
  const xml = await response.text();
  return [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/gi)].flatMap((match) => {
    const article = match[1];
    const title = xmlTag(article, "ArticleTitle");
    const pmid = xmlTag(article, "PMID");
    if (!title || !pmid) return [];
    const authors = [...article.matchAll(/<Author>[\s\S]*?<LastName>([\s\S]*?)<\/LastName>[\s\S]*?(?:<ForeName>([\s\S]*?)<\/ForeName>)?[\s\S]*?<\/Author>/gi)]
      .map((item) => [item[2], item[1]].filter(Boolean).map(decodeXml).join(" "));
    const year = Number(xmlTag(article, "Year") || xmlTag(article, "PubDate").match(/(19|20)\d{2}/)?.[0]);
    const abstract = [...article.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gi)]
      .map((item) => decodeXml(item[1])).join(" ");
    return [{
      id: "pubmed:" + pmid,
      title,
      authors,
      year: Number.isFinite(year) ? year : undefined,
      venue: xmlTag(article, "Title") || "PubMed",
      url: "https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/",
      abstract: abstract || undefined,
      source: "PubMed",
    }];
  });
};

const verifyCitation = async (doi) => {
  const normalized = cleanDoi(doi);
  if (!normalized) throw new Error("A DOI is required.");
  const attempts = await Promise.allSettled([
    fetchJson(CROSSREF_API + "/works/" + encodeURIComponent(normalized)),
    fetchJson(OPENALEX_API + "/works/" + encodeURIComponent("https://doi.org/" + normalized)),
  ]);
  const evidence = [];
  const records = [];
  for (const [index, attempt] of attempts.entries()) {
    const source = index === 0 ? "Crossref" : "OpenAlex";
    if (attempt.status === "fulfilled") {
      const record = index === 0
        ? paperFromCrossref(attempt.value.message)
        : {
            title: asText(attempt.value.title),
            doi: cleanDoi(attempt.value.doi),
            year: attempt.value.publication_year,
            source,
          };
      if (record) {
        records.push({ ...record, source });
        evidence.push({ source, status: "matched", record });
      }
    } else {
      evidence.push({ source, status: "error", message: String(attempt.reason) });
    }
  }
  const titles = new Set(records.map((record) => record.title?.toLowerCase()));
  const matched = records.length > 1 && titles.size === 1;
  return {
    doi: normalized,
    status: matched ? "verified-metadata" : records.length ? "single-source" : "not-found",
    matchedSources: records.map((record) => record.source),
    evidence,
  };
};

const bibtex = (args) => {
  const doi = cleanDoi(args.doi);
  const key = (doi || args.title || "paper")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const authors = Array.isArray(args.authors) ? args.authors.join(" and ") : asText(args.authors);
  const lines = [
    "@article{" + key + ",",
    "  title = {" + (asText(args.title) || "Untitled") + "},",
    "  author = {" + (authors || "Unknown") + "},",
    "  year = {" + (args.year || "") + "},",
  ];
  if (doi) lines.push("  doi = {" + doi + "},");
  lines.push("}");
  return lines.join("\n");
};

const toolDefinitions = [
  {
    name: "search_literature",
    description: "Search Crossref, OpenAlex, arXiv, Semantic Scholar, or PubMed and return provenance-tagged paper metadata.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language or keyword query." },
        sources: {
          type: "array",
          items: {
            type: "string",
            enum: ["Crossref", "OpenAlex", "arXiv", "Semantic Scholar", "PubMed"],
          },
          description: "Optional source allow-list.",
        },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
      required: ["query"],
    },
  },
  {
    name: "verify_citation",
    description: "Check DOI metadata against independent scholarly indexes.",
    inputSchema: { type: "object", properties: { doi: { type: "string" } }, required: ["doi"] },
  },
  {
    name: "format_bibtex",
    description: "Format supplied paper metadata as a conservative BibTeX entry.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        authors: { type: "array", items: { type: "string" } },
        year: { type: ["integer", "string"] },
        doi: { type: "string" },
      },
      required: ["title"],
    },
  },
];

const resultText = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : json(value) }],
  structuredContent: typeof value === "object" ? value : { value },
});

const requestResult = async (request) => {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: { name: "melody-research", version: "0.1.0" },
      };
    case "notifications/initialized":
      return undefined;
    case "ping":
      return {};
    case "tools/list":
      return { tools: toolDefinitions };
    case "tools/call": {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      if (name === "search_literature") {
        const query = asText(args.query);
        if (!query) throw new Error("query is required");
        const limit = Number.isFinite(args.limit) ? Number(args.limit) : 10;
        const requested = Array.isArray(args.sources)
          ? args.sources
          : ["Crossref", "OpenAlex", "arXiv", "Semantic Scholar", "PubMed"];
        const attempts = await Promise.allSettled(
          requested.map((source) => {
            if (source === "OpenAlex") return searchOpenAlex(query, limit);
            if (source === "arXiv") return searchArxiv(query, limit);
            if (source === "Semantic Scholar") return searchSemanticScholar(query, limit);
            if (source === "PubMed") return searchPubMed(query, limit);
            return searchCrossref(query, limit);
          }),
        );
        const papers = [];
        const runs = [];
        attempts.forEach((attempt, index) => {
          const source = requested[index];
          if (attempt.status === "fulfilled") {
            papers.push(...attempt.value);
            runs.push({ source, status: "success", count: attempt.value.length });
          } else {
            runs.push({ source, status: "error", message: String(attempt.reason) });
          }
        });
        return resultText({ query, papers, sourceRuns: runs });
      }
      if (name === "verify_citation") return resultText(await verifyCitation(args.doi));
      if (name === "format_bibtex") return resultText(bibtex(args));
      throw new Error("Unknown tool: " + name);
    }
    case "resources/list":
      return {
        resources: [{
          uri: "research://protocol",
          name: "Research evidence protocol",
          description: "Evidence levels and provenance rules used by Melody Research.",
          mimeType: "text/markdown",
        }],
      };
    case "resources/read":
      if (request.params?.uri !== "research://protocol") throw new Error("Unknown resource");
      return {
        contents: [{
          uri: "research://protocol",
          mimeType: "text/markdown",
          text: "Use full-text, abstract, metadata, inference, or unverified evidence labels. Metadata matches never prove a paper's full-text claims.",
        }],
      };
    case "prompts/list":
      return {
        prompts: [
          { name: "paper_review", description: "Review a paper with evidence boundaries." },
          { name: "systematic_review", description: "Build a traceable evidence matrix." },
        ],
      };
    case "prompts/get": {
      const name = request.params?.name;
      const text = name === "paper_review"
        ? "Review the supplied paper using problem, method, evidence, limitations, and reproducibility fields. Mark every claim's evidence level."
        : name === "systematic_review"
          ? "Build a traceable evidence matrix from the supplied papers. Keep inclusion decisions, source runs, conflicts, and evidence gaps."
          : undefined;
      if (!text) throw new Error("Unknown prompt: " + name);
      return { description: text, messages: [{ role: "user", content: { type: "text", text } }] };
    }
    default:
      throw Object.assign(new Error("Method not found: " + request.method), { code: -32601 });
  }
};

const send = (response) => {
  process.stdout.write(JSON.stringify(response) + "\n");
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    if (request.id === undefined) {
      void requestResult(request).catch((error) => process.stderr.write(String(error) + "\n"));
      continue;
    }
    void requestResult(request)
      .then((result) => send({ jsonrpc: "2.0", id: request.id, result }))
      .catch((error) => send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: error.code || -32000, message: String(error.message || error) },
      }));
  }
});
