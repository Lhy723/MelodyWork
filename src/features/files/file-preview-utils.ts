export const imageExtensions = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

export const audioExtensions = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
]);

export const videoExtensions = new Set([
  "m4v",
  "mov",
  "mp4",
  "ogv",
  "webm",
]);

export const legacyOfficeExtensions = new Set(["doc", "xls", "ppt"]);

export type PreviewKind =
  | "audio"
  | "docx"
  | "html"
  | "image"
  | "legacy-office"
  | "markdown"
  | "pdf"
  | "pptx"
  | "text"
  | "video"
  | "xlsx";

export const extensionFor = (path: string) =>
  path.split(".").at(-1)?.toLowerCase() ?? "";

export const previewKindFor = (path: string): PreviewKind => {
  const extension = extensionFor(path);
  if (imageExtensions.has(extension)) return "image";
  if (audioExtensions.has(extension)) return "audio";
  if (videoExtensions.has(extension)) return "video";
  if (legacyOfficeExtensions.has(extension)) return "legacy-office";
  if (extension === "pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "xlsx") return "xlsx";
  if (extension === "pptx") return "pptx";
  if (extension === "md" || extension === "mdx") return "markdown";
  if (extension === "html" || extension === "htm") return "html";
  return "text";
};

export const languageFor = (path: string) => {
  const extension = extensionFor(path);
  return (
    {
      c: "c",
      cc: "cpp",
      cpp: "cpp",
      cs: "csharp",
      css: "css",
      csv: "plaintext",
      go: "go",
      h: "c",
      hpp: "cpp",
      html: "html",
      java: "java",
      js: "javascript",
      json: "json",
      jsonl: "json",
      jsx: "javascript",
      kt: "kotlin",
      kts: "kotlin",
      md: "markdown",
      mdx: "markdown",
      php: "php",
      py: "python",
      r: "r",
      rb: "ruby",
      rs: "rust",
      scss: "scss",
      sh: "shell",
      sql: "sql",
      swift: "swift",
      toml: "toml",
      ts: "typescript",
      tsx: "typescript",
      vue: "html",
      xml: "xml",
      yaml: "yaml",
      yml: "yaml",
      zsh: "shell",
    }[extension] ?? "plaintext"
  );
};

export const mimeTypeFor = (path: string) => {
  const extension = extensionFor(path);
  return (
    {
      aac: "audio/aac",
      avif: "image/avif",
      bmp: "image/bmp",
      flac: "audio/flac",
      gif: "image/gif",
      ico: "image/x-icon",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      m4a: "audio/mp4",
      m4v: "video/mp4",
      mov: "video/quicktime",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      oga: "audio/ogg",
      ogg: "audio/ogg",
      ogv: "video/ogg",
      opus: "audio/opus",
      pdf: "application/pdf",
      png: "image/png",
      svg: "image/svg+xml",
      wav: "audio/wav",
      webm: "video/webm",
      webp: "image/webp",
    }[extension] ?? "application/octet-stream"
  );
};

export const spreadsheetColumn = (reference: string) => {
  const letters = reference.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return (
    [...letters].reduce(
      (value, character) => value * 26 + character.charCodeAt(0) - 64,
      0,
    ) - 1
  );
};

export const spreadsheetColumnLabel = (index: number) => {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
};
