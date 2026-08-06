export interface ResearchQueryPlan {
  original: string;
  query: string;
  terms: string[];
  strategy?: "local-keyword-normalization";
  removedTerms?: string[];
}

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "does",
  "do",
  "for",
  "how",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "which",
  "with",
  "以及",
  "如何",
  "哪些",
  "是否",
  "有关",
  "相关",
  "研究",
  "问题",
  "请问",
]);

const normalize = (value: string) =>
  value
    .replace(/[“”"'‘’！？!?。；;：:、，,（）()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const unique = (items: string[]) => Array.from(new Set(items));

/**
 * Builds a transparent, local query draft from a natural-language prompt.
 * It intentionally does not claim to be an AI rewrite: users can inspect and
 * edit the draft before any external index is queried.
 */
export const buildResearchQueryPlan = (input: string): ResearchQueryPlan => {
  const original = normalize(input);
  if (!original) {
    return { original: "", query: "", terms: [] };
  }

  const englishTerms = original.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? [];
  const phraseTerms = original
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  const terms = unique(
    [...englishTerms, ...phraseTerms].filter(
      (term) => !QUERY_STOP_WORDS.has(term.toLocaleLowerCase()),
    ),
  ).slice(0, 12);
  const removedTerms = unique(
    phraseTerms.filter((term) => QUERY_STOP_WORDS.has(term.toLocaleLowerCase())),
  );

  return {
    original,
    query: terms.length > 0 ? terms.join(" ") : original,
    terms,
    strategy: "local-keyword-normalization",
    removedTerms,
  };
};
