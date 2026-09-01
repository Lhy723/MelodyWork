import { MonitorIcon } from "lucide-react";

import type { EnvironmentCapability } from "@/lib/melody-bridge";

import { CapabilityCard, PanelHeader } from "./about-ui";

export function AboutEnvironmentPanel({
  capabilities,
  state,
  tauriRuntime,
}: {
  capabilities: EnvironmentCapability[];
  state: "idle" | "loading" | "ready" | "error";
  tauriRuntime: boolean;
}) {
  return (
    <section
      aria-labelledby="about-environment-title"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <PanelHeader
        description="检测桌面端 Node.js 和 Git 的安装状态，供 MCP、Git 变更视图等功能使用。"
        title={
          <>
            <MonitorIcon className="size-4 text-muted-foreground" />
            <span id="about-environment-title">环境检测</span>
          </>
        }
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {capabilities.map((capability) => (
          <CapabilityCard capability={capability} key={capability.name} />
        ))}
        {!tauriRuntime ? (
          <p className="sm:col-span-2 rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-xs">
            浏览器预览不会读取本机环境；在桌面版中可以检查 Node.js 和 Git
            的实际安装状态。
          </p>
        ) : null}
        {tauriRuntime && state === "loading" ? (
          <p className="sm:col-span-2 text-muted-foreground text-xs">
            正在检查本机环境…
          </p>
        ) : null}
        {tauriRuntime && state === "ready" && capabilities.length === 0 ? (
          <p className="sm:col-span-2 text-muted-foreground text-xs">
            暂未检测到 Node.js 或 Git。
          </p>
        ) : null}
        {state === "error" ? (
          <p className="sm:col-span-2 text-destructive text-xs">
            环境检查失败，请稍后重试。
          </p>
        ) : null}
      </div>
    </section>
  );
}
