export interface MessageCitation {
  title: string;
  url: string;
}

export interface ProjectReference {
  absolutePath: string;
  displayPath: string;
  kind: "file" | "folder";
}

const MARKDOWN_LINK =
  /(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/giu;
const MARKDOWN_IMAGE =
  /!\[[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/giu;
const BARE_URL =
  /\bhttps?:\/\/[^\s<>{}\[\]()"',;!?，。；：！？、]+/giu;
const TRAILING_PUNCTUATION = /[),.;:!?，。；：！？]+$/u;
const MARKDOWN_DECORATION = /[*_`~]/gu;
const FILE_NAME =
  /(?:^|\/)(?:[^/]+\.[a-z0-9][a-z0-9.-]{0,15}|Dockerfile|Makefile|LICENSE)$/iu;

const normalizeUrl = (candidate: string): string | undefined => {
  const trimmed = candidate.replace(TRAILING_PUNCTUATION, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
};

const citationTitle = (label: string | undefined, url: string) => {
  const normalizedLabel = label
    ?.replace(MARKDOWN_DECORATION, "")
    .trim();
  if (normalizedLabel) {
    return normalizedLabel;
  }
  return new URL(url).hostname.replace(/^www\./u, "");
};

const normalizePosixPath = (path: string) => {
  const absolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${absolute ? "/" : ""}${segments.join("/")}`;
};

const joinPosixPath = (base: string, path: string) =>
  normalizePosixPath(path.startsWith("/") ? path : `${base}/${path}`);

export const resolveProjectReference = (
  value: string,
  projectRoot: string,
  cwd = projectRoot,
): ProjectReference | undefined => {
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.includes("\n") ||
    candidate.includes(" ") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(candidate)
  ) {
    return undefined;
  }

  const pathLike =
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.includes("/") ||
    FILE_NAME.test(candidate);
  if (!pathLike) {
    return undefined;
  }

  const root = normalizePosixPath(projectRoot).replace(/\/$/u, "");
  const base = normalizePosixPath(cwd);
  const absolutePath = joinPosixPath(base, candidate);
  if (
    !root ||
    (absolutePath !== root && !absolutePath.startsWith(`${root}/`))
  ) {
    return undefined;
  }

  const relativePath =
    absolutePath === root
      ? "."
      : absolutePath.slice(root.length + 1);
  const kind =
    candidate.endsWith("/") || !FILE_NAME.test(candidate)
      ? "folder"
      : "file";

  return {
    absolutePath,
    displayPath:
      kind === "folder" && relativePath !== "."
        ? `${relativePath}/`
        : relativePath,
    kind,
  };
};

export const extractMessageCitations = (
  markdown: string,
  limit = 8,
): MessageCitation[] => {
  if (!markdown || limit <= 0) {
    return [];
  }

  const citations = new Map<string, MessageCitation>();
  const imageUrls = new Set(
    [...markdown.matchAll(MARKDOWN_IMAGE)]
      .map((match) => normalizeUrl(match[1]))
      .filter((url): url is string => Boolean(url)),
  );
  const addCitation = (
    candidate: string,
    label?: string,
    excludeImages = false,
  ) => {
    if (citations.size >= limit) {
      return;
    }
    const url = normalizeUrl(candidate);
    if (
      !url ||
      citations.has(url) ||
      (excludeImages && imageUrls.has(url))
    ) {
      return;
    }
    citations.set(url, {
      title: citationTitle(label, url),
      url,
    });
  };

  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    addCitation(match[2], match[1]);
  }
  for (const match of markdown.matchAll(BARE_URL)) {
    addCitation(match[0], undefined, true);
  }

  return [...citations.values()];
};
