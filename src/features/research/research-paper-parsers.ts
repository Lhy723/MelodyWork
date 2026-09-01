import type { ResearchPaper } from "@/domain/research";

export const cleanDoi = (value?: string | null) =>
  value
    ?.trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .toLowerCase();

const text = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

export const titleKey = (title: string) =>
  title
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

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
  const dateParts = (
    item.published as { "date-parts"?: number[][] } | undefined
  )?.["date-parts"]?.[0];
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
    const name = (authorship as { author?: { display_name?: unknown } }).author
      ?.display_name;
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
      typeof item.cited_by_count === "number" ? item.cited_by_count : undefined,
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
      typeof item.citationCount === "number" ? item.citationCount : undefined,
    sources: ["Semantic Scholar"],
    verified: false,
    saved: false,
    addedAt: Date.now(),
  };
};

export const paperFromArxivEntry = (
  entry: Element,
): ResearchPaper | undefined => {
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
    pdfUrl: pdfLink?.getAttribute("href") ?? `https://arxiv.org/pdf/${id}.pdf`,
    abstract: text(entry.querySelector("summary")?.textContent) || undefined,
    sources: ["arXiv"],
    verified: false,
    saved: false,
    addedAt: Date.now(),
  };
};

const pubmedArticleText = (article: Element, selector: string) =>
  text(article.querySelector(selector)?.textContent);

export const paperFromPubMedArticle = (
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
