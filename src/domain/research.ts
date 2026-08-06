export type ResearchSource =
  | "arXiv"
  | "Crossref"
  | "OpenAlex"
  | "PubMed"
  | "Semantic Scholar";

export interface ResearchVerificationEvidence {
  source: ResearchSource;
  status: "matched";
  checkedAt: number;
  recordId?: string;
  title?: string;
  url?: string;
}

export interface ResearchVerification {
  status: "verified" | "single-source";
  checkedAt: number;
  matchedSources: ResearchSource[];
  method: "cross-source-metadata-match";
  evidence?: ResearchVerificationEvidence[];
}

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
  verification?: ResearchVerification;
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
  searchQuery?: string;
  terms?: string[];
  sources?: ResearchSource[];
}

export type ResearchNoteKind = "note" | "experiment" | "meeting" | "idea";

export interface ResearchNote {
  id: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
  kind: ResearchNoteKind;
  linkedPaperIds?: string[];
  tags?: string[];
}

export interface ResearchTask {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  completedAt?: number;
  linkedPaperId?: string;
  source?: "manual" | "tracking" | "paper";
}

export interface ResearchSourceRun {
  source: ResearchSource;
  status: "success" | "error";
  resultCount: number;
  query: string;
  requestQuery?: string;
  checkedAt: number;
  message?: string;
}

export interface ResearchSearchResult {
  papers: ResearchPaper[];
  sources: ResearchSource[];
  warnings: string[];
  sourceRuns: ResearchSourceRun[];
}

/**
 * The latest multi-source search is kept as a project-scoped inbox so that
 * discovery does not disappear when the user leaves the search page.
 */
export interface ResearchInbox {
  query: string;
  searchQuery: string;
  createdAt: number;
  papers: ResearchPaper[];
  sourceRuns: ResearchSourceRun[];
}
