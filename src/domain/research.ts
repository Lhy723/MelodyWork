export type ResearchSource =
  | "arXiv"
  | "Crossref"
  | "OpenAlex"
  | "PubMed"
  | "Semantic Scholar";

export interface ResearchPaper {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url: string;
  pdfUrl?: string;
  abstract?: string;
  citationCount?: number;
  sources: ResearchSource[];
  verified: boolean;
  saved: boolean;
  addedAt: number;
}

export interface ResearchTrackingTopic {
  id: string;
  title: string;
  query: string;
  cadence: "manual" | "daily" | "weekly";
  lastCheckedAt?: number;
  latestCount: number;
  paperIds?: string[];
}

export interface ResearchSearchHistoryItem {
  id: string;
  query: string;
  createdAt: number;
  resultCount: number;
}

export interface ResearchSearchResult {
  papers: ResearchPaper[];
  sources: ResearchSource[];
  warnings: string[];
}
