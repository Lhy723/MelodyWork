import type { AgentToolOperation } from "@/domain/acp";
import type { ToolTimelineEntry } from "@/domain/timeline-groups";
import {
  BookOpenIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

export const displayPath = (path: string, projectRoot: string, cwd: string) => {
  const normalized = path.replaceAll("\\", "/");
  const roots = [projectRoot, cwd]
    .map((root) => root.replaceAll("\\", "/").replace(/\/$/u, ""))
    .filter(Boolean);
  const root = roots.find((candidate) =>
    normalized.startsWith(`${candidate}/`),
  );
  return root ? normalized.slice(root.length + 1) : normalized;
};

export const shortPath = (path: string) => path.split("/").at(-1) ?? path;

export const isRunning = (tool: ToolTimelineEntry) =>
  tool.permission !== "denied" &&
  tool.status !== "failed" &&
  tool.status !== "completed";

export const activityLabel = (
  operation: AgentToolOperation,
  running: boolean,
) => {
  const labels: Record<AgentToolOperation, [string, string]> = {
    read: ["正在读取", "已读取"],
    search: ["正在搜索", "已搜索"],
    create: ["正在创建", "已创建"],
    edit: ["正在编辑", "已编辑"],
    delete: ["正在删除", "已删除"],
    execute: ["正在运行", "已运行"],
    other: ["正在执行", "已执行"],
  };
  return labels[operation][running ? 0 : 1];
};

export const operationIcon = (operation: AgentToolOperation): LucideIcon => {
  switch (operation) {
    case "read":
      return BookOpenIcon;
    case "search":
      return SearchIcon;
    case "create":
    case "edit":
    case "delete":
      return PencilIcon;
    case "execute":
      return TerminalIcon;
    default:
      return WrenchIcon;
  }
};

export const groupTitle = (tools: ToolTimelineEntry[]) => {
  const question = tools.find((tool) => tool.question);
  if (question) {
    return question.question?.outcome === "pending"
      ? "等待你的回答"
      : "已收到你的回答";
  }
  const active = tools.find(isRunning);
  if (active) {
    const operation = active.activity?.operation ?? "other";
    return `${activityLabel(operation, true)}${operation === "execute" ? "命令" : "文件"}`;
  }
  const operations = [
    ...new Set(tools.map((tool) => tool.activity?.operation ?? "other")),
  ];
  const labels: Record<AgentToolOperation, string> = {
    read: "读取了文件",
    search: "搜索了文件",
    create: "创建了文件",
    edit: "编辑了文件",
    delete: "删除了文件",
    execute: "运行了命令",
    other: "执行了操作",
  };
  return operations.map((operation) => labels[operation]).join("、");
};
