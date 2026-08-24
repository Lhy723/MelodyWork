import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { CodeIcon } from "lucide-react";
import type { BundledLanguage } from "shiki";
import type { ComponentProps, ReactNode } from "react";

type MarkdownCodeBlockProps = ComponentProps<"code"> & {
  "data-block"?: string;
  metastring?: string;
  node?: unknown;
};

const languageAliases: Record<string, BundledLanguage> = {
  bash: "bash",
  c: "c",
  cpp: "cpp",
  css: "css",
  diff: "diff",
  go: "go",
  html: "html",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  plaintext: "markdown",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sh: "shellscript",
  shell: "shellscript",
  sql: "sql",
  swift: "swift",
  text: "markdown",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const codeText = (children: ReactNode) =>
  Array.isArray(children)
    ? children.map((child) => String(child ?? "")).join("")
    : String(children ?? "");

const requestedLanguage = (className?: string) =>
  className?.match(/(?:^|\s)language-([^\s]+)/u)?.[1]?.toLowerCase();

const codeLanguage = (className?: string) => {
  const requested = requestedLanguage(className);
  return requested ? (languageAliases[requested] ?? "markdown") : "markdown";
};

const codeFilename = (
  metastring: string | undefined,
  requested: string | undefined,
) => {
  const explicit =
    metastring?.match(/\b(?:title|filename)=["']([^"']+)["']/u)?.[1] ??
    metastring?.match(/\b(?:title|filename)=([^\s]+)/u)?.[1];
  return explicit ?? requested ?? "代码";
};

export function MessageCodeBlock({
  children,
  className,
  metastring,
  ...props
}: MarkdownCodeBlockProps) {
  Reflect.deleteProperty(props, "node");
  const code = codeText(children).replace(/\n$/u, "");
  const language = codeLanguage(className);
  const filename = codeFilename(metastring, requestedLanguage(className));

  return (
    <CodeBlock
      className="my-4 rounded-xl [&_code]:text-sm [&_pre]:text-sm"
      code={code}
      language={language}
      showLineNumbers={code.includes("\n")}
      {...props}
    >
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeIcon className="size-3.5" />
          <CodeBlockFilename>{filename}</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton aria-label="复制代码" className="size-7" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}
