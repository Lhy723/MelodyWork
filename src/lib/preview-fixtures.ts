import type { GitChange, GitDiff } from "@/domain/git";

/** Bump when the browser-only ACP fixture contract changes. */
export const PREVIEW_FIXTURE_VERSION = "melodywork-acp-preview-v1";

export const PREVIEW_AGENT_MESSAGE =
  "浏览器预览已完成 ACP 初始化；桌面版会将同一流程连接到 Melody Build。";

export const PREVIEW_GIT_CHANGES: GitChange[] = [
  {
    path: "src-tauri/src/agent_runtime.rs",
    status: " M",
    staged: false,
    additions: 48,
    deletions: 6,
  },
  {
    path: "src/stores/agent-store.ts",
    status: " M",
    staged: false,
    additions: 72,
    deletions: 21,
  },
  {
    path: "src/features/git/change-review.tsx",
    status: "??",
    staged: false,
    additions: 184,
    deletions: 0,
  },
];

export const previewGitDiff = (path: string): GitDiff => ({
  path,
  binary: false,
  content: [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -18,6 +18,10 @@",
    " export function AgentWorkspace() {",
    "+  const changes = useGitChanges();",
    "+  const [reviewOpen, setReviewOpen] = useState(false);",
    "+",
    "   useAgentBridge();",
    '-  const status = "Preview";',
    "+  const status = useAgentStore((state) => state.status);",
  ].join("\n"),
});
