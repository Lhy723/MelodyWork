import {
  ArrowRightIcon,
  BlocksIcon,
  CheckCircle2Icon,
  InboxIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toUserMessage } from "@/domain/app-error";
import { readMelodyConfig, updateMelodyConfig } from "@/lib/melody-bridge";
import { cn } from "@/lib/utils";

import { CapabilityCard } from "./research-capability-card";
import {
  RESEARCH_MCP,
  RESEARCH_SKILLS,
  RESEARCH_TOOLS,
  useResearchCapabilityStore,
} from "./research-capability-store";
import type { ResearchMainKind } from "./research-main-workspace";
import { ProjectContext } from "./research-ui";

export function CapabilitiesWorkspace({
  cwd,
  onNavigate,
  projectName,
}: {
  cwd: string;
  onNavigate: (kind: ResearchMainKind) => void;
  projectName: string;
}) {
  const enabledSkillIds = useResearchCapabilityStore(
    (state) => state.enabledSkillIds,
  );
  const enabledToolIds = useResearchCapabilityStore(
    (state) => state.enabledToolIds,
  );
  const mcpEnabled = useResearchCapabilityStore((state) => state.mcpEnabled);
  const setSkillEnabled = useResearchCapabilityStore(
    (state) => state.setSkillEnabled,
  );
  const setToolEnabled = useResearchCapabilityStore(
    (state) => state.setToolEnabled,
  );
  const setMcpEnabled = useResearchCapabilityStore(
    (state) => state.setMcpEnabled,
  );
  const reset = useResearchCapabilityStore((state) => state.reset);
  const [mcpConfigured, setMcpConfigured] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string>();
  const [capabilityView, setCapabilityView] = useState<
    "skills" | "tools" | "mcp"
  >("skills");

  const handleCapabilityTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    value: "skills" | "tools" | "mcp",
  ) => {
    const values = ["skills", "tools", "mcp"] as const;
    const index = values.indexOf(value);
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % values.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + values.length) % values.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = values.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextValue = values[nextIndex];
    setCapabilityView(nextValue);
    requestAnimationFrame(() =>
      document
        .getElementById(`research-capabilities-tab-${nextValue}`)
        ?.focus(),
    );
  };

  useEffect(() => {
    let cancelled = false;
    void readMelodyConfig("project", cwd)
      .then((document) => {
        if (cancelled) return;
        const servers = document.values.mcp_servers;
        const configured =
          Boolean(servers) &&
          typeof servers === "object" &&
          !Array.isArray(servers) &&
          Boolean((servers as Record<string, unknown>)[RESEARCH_MCP.id]);
        setMcpConfigured(configured);
        if (configured) setMcpEnabled(true);
      })
      .catch(() => {
        if (!cancelled) setMcpConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, setMcpEnabled]);

  const toggleMcp = async (enabled: boolean) => {
    setMcpBusy(true);
    setMcpError(undefined);
    try {
      await updateMelodyConfig("project", cwd, [
        {
          path: ["mcp_servers", RESEARCH_MCP.id],
          value: enabled
            ? {
                command: "node",
                args: [RESEARCH_MCP.relativeCommand],
              }
            : null,
        },
      ]);
      setMcpConfigured(enabled);
      setMcpEnabled(enabled);
    } catch (reason) {
      setMcpError(toUserMessage(reason));
    } finally {
      setMcpBusy(false);
    }
  };

  return (
    <div className="flex size-full min-h-0 flex-col overflow-y-auto bg-background">
      <header className="shrink-0 border-b px-6 py-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <BlocksIcon className="size-5 text-muted-foreground" />
              <h1 className="research-serif font-semibold text-2xl">
                科研能力
              </h1>
            </div>
            <p className="mt-1 max-w-2xl text-muted-foreground text-xs leading-5">
              Research 内置一套证据优先的技能、工具和本地
              MCP。启用后会参与论文检索、导读、核验和对话，不需要在每次任务里重新说明工作方法。
            </p>
            <ProjectContext projectName={projectName} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">{enabledSkillIds.length} 项技能</Badge>
            <Badge variant="outline">{enabledToolIds.length} 个工具</Badge>
            <Button onClick={reset} size="sm" variant="ghost">
              恢复默认
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => onNavigate("search")} size="sm">
            <SearchIcon />
            开始自然语言检索
            <ArrowRightIcon />
          </Button>
          <Button
            onClick={() => onNavigate("inbox")}
            size="sm"
            variant="outline"
          >
            <InboxIcon />
            打开研究收件箱
          </Button>
        </div>
        <nav
          aria-label="科研能力分组"
          className="mt-5 flex max-w-2xl items-end gap-5 border-b"
          role="tablist"
        >
          {(
            [
              ["skills", "内置技能", `${enabledSkillIds.length} 项`],
              ["tools", "可调用工具", `${enabledToolIds.length} 项`],
              ["mcp", "本地 MCP", mcpEnabled ? "已启用" : "可选"],
            ] as const
          ).map(([value, label, count]) => (
            <button
              aria-controls={`research-capabilities-panel-${value}`}
              aria-selected={capabilityView === value}
              className={cn(
                "border-b-2 px-1 pb-2 text-left text-xs",
                capabilityView === value
                  ? "border-primary font-medium text-primary"
                  : "border-transparent text-muted-foreground",
              )}
              id={`research-capabilities-tab-${value}`}
              key={value}
              onClick={() => setCapabilityView(value)}
              onKeyDown={(event) => handleCapabilityTabKeyDown(event, value)}
              role="tab"
              tabIndex={capabilityView === value ? 0 : -1}
              type="button"
            >
              <span className="block">{label}</span>
              <span className="mt-1 block text-[10px] font-normal text-muted-foreground">
                {count}
              </span>
            </button>
          ))}
        </nav>
      </header>

      <div className="mx-auto w-full max-w-6xl space-y-8 p-6">
        {capabilityView === "skills" ? (
          <section
            aria-labelledby="research-capabilities-tab-skills"
            id="research-capabilities-panel-skills"
            role="tabpanel"
            tabIndex={0}
          >
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h2 className="research-serif font-semibold text-lg">
                  内置 Research 技能
                </h2>
                <p className="mt-1 text-muted-foreground text-xs">
                  每项技能都带有触发场景、输出边界和可复用的工作流；停用后不会写入对话上下文。
                </p>
              </div>
              <Badge variant="secondary">本地插件 · melody-research</Badge>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {RESEARCH_SKILLS.map((skill) => (
                <CapabilityCard
                  category={skill.category}
                  checked={enabledSkillIds.includes(skill.id)}
                  description={skill.description}
                  key={skill.id}
                  onCheckedChange={(checked) =>
                    setSkillEnabled(skill.id, checked)
                  }
                  title={`${skill.title} · ${skill.englishTitle}`}
                  trigger={skill.trigger}
                />
              ))}
            </div>
          </section>
        ) : null}

        {capabilityView === "tools" ? (
          <section
            aria-labelledby="research-capabilities-tab-tools"
            id="research-capabilities-panel-tools"
            role="tabpanel"
            tabIndex={0}
          >
            <div className="mb-3">
              <h2 className="research-serif font-semibold text-lg">
                可调用工具
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                工具对应真实的 Research 页面或本地 MCP
                方法；开关只控制它们是否进入 Research 对话的可用能力集合。
              </p>
            </div>
            <div className="divide-y border">
              {RESEARCH_TOOLS.map((tool) => (
                <article
                  className="flex items-start gap-3 bg-background/70 p-4"
                  key={tool.id}
                >
                  <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/30">
                    <CheckCircle2Icon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="research-serif font-semibold text-sm">
                        {tool.title}
                      </h3>
                      <Badge variant="outline">{tool.availability}</Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground text-xs leading-5">
                      {tool.description}
                    </p>
                    <p className="mt-1 text-muted-foreground text-[11px]">
                      {tool.detail}
                    </p>
                  </div>
                  <Switch
                    aria-label={`${enabledToolIds.includes(tool.id) ? "停用" : "启用"}${tool.title}`}
                    checked={enabledToolIds.includes(tool.id)}
                    onCheckedChange={(checked) =>
                      setToolEnabled(tool.id, checked)
                    }
                  />
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {capabilityView === "mcp" ? (
          <section
            aria-labelledby="research-capabilities-tab-mcp"
            id="research-capabilities-panel-mcp"
            role="tabpanel"
            tabIndex={0}
          >
            <div className="mb-3">
              <h2 className="research-serif font-semibold text-lg">
                本地 MCP 插件
              </h2>
              <p className="mt-1 text-muted-foreground text-xs">
                MCP 按照 tools、resources、prompts
                分开暴露能力，方便在本地对话代理或其他兼容客户端复用。
              </p>
            </div>
            <article className="border bg-muted/10 p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
                  <BlocksIcon className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="research-serif font-semibold text-sm">
                      {RESEARCH_MCP.title}
                    </h3>
                    <Badge variant={mcpConfigured ? "outline" : "secondary"}>
                      {mcpConfigured ? "已写入当前项目" : "可选启用"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground text-xs leading-5">
                    {RESEARCH_MCP.description}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {RESEARCH_MCP.sources.map((source) => (
                      <Badge key={source} variant="secondary">
                        source · {source}
                      </Badge>
                    ))}
                    {RESEARCH_MCP.tools.map((tool) => (
                      <Badge key={tool} variant="outline">
                        tool · {tool}
                      </Badge>
                    ))}
                    {RESEARCH_MCP.resources.map((resource) => (
                      <Badge key={resource} variant="outline">
                        resource · {resource}
                      </Badge>
                    ))}
                    {RESEARCH_MCP.prompts.map((prompt) => (
                      <Badge key={prompt} variant="outline">
                        prompt · {prompt}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
                    node {RESEARCH_MCP.relativeCommand}
                  </p>
                  <p className="mt-2 text-muted-foreground text-[11px] leading-4">
                    启用会更新当前项目的 <code>.melody/config.toml</code>
                    ；已打开的会话不会自动重载，下一次新建或重新载入会话后生效。
                  </p>
                  {mcpError ? (
                    <p
                      aria-live="assertive"
                      className="mt-2 flex items-center gap-1.5 text-destructive text-xs"
                      role="alert"
                    >
                      <TriangleAlertIcon className="size-3.5" />
                      {mcpError}
                    </p>
                  ) : null}
                </div>
                <Switch
                  aria-label={`${mcpEnabled ? "停用" : "启用"} Melody Research MCP`}
                  checked={mcpEnabled}
                  disabled={mcpBusy}
                  onCheckedChange={(checked) => void toggleMcp(checked)}
                />
              </div>
            </article>
          </section>
        ) : null}

        <p className="border-t pt-4 text-muted-foreground text-[11px] leading-5">
          这些技能借鉴证据矩阵、系统综述和高影响力期刊常见的严谨写作流程；它们不是任何期刊的官方插件，也不会替代原文、同行评审或人工核验。
        </p>
      </div>
    </div>
  );
}
