import { TerminalSquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  closeTerminalSession,
  createTerminalSession,
  isTauriRuntime,
  subscribeToTerminal,
  writeTerminalInput,
} from "@/lib/melody-bridge";

interface TerminalPanelProps {
  cwd: string;
  embedded?: boolean;
  onClose?: () => void;
}

const PROMPT = "$ ";

export function TerminalPanel({
  cwd,
  embedded = false,
  onClose,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const lineBufferRef = useRef("");
  const [phase, setPhase] = useState<
    "starting" | "ready" | "closed" | "error"
  >("starting");

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void)[] = [];
    let resizeObserver: ResizeObserver | undefined;
    let resizeFrame: number | undefined;
    let dataDisposable: { dispose: () => void } | undefined;
    let lastTerminalSize = { cols: 0, rows: 0 };

    const start = async () => {
      const { Terminal } = await import("@xterm/xterm");
      if (disposed || !containerRef.current) {
        return;
      }
      const dark = document.documentElement.classList.contains("dark");
      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        disableStdin: false,
        fontFamily:
          '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        scrollback: 5_000,
        theme: {
          background: dark ? "#171717" : "#fafafa",
          foreground: dark ? "#f5f5f5" : "#202020",
          cursor: dark ? "#f5f5f5" : "#202020",
          red: dark ? "#f87171" : "#b42318",
          green: dark ? "#4ade80" : "#067647",
          yellow: dark ? "#fbbf24" : "#b54708",
          blue: dark ? "#60a5fa" : "#175cd3",
        },
      });
      terminal.open(containerRef.current);
      terminalRef.current = terminal;

      const fit = () => {
        if (resizeFrame !== undefined) {
          return;
        }
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = undefined;
          const container = containerRef.current;
          if (!container || container.clientWidth === 0) {
            return;
          }
          const cols = Math.max(
            20,
            Math.floor((container.clientWidth - 24) / 7.2),
          );
          const rows = Math.max(
            5,
            Math.floor((container.clientHeight - 16) / 17),
          );
          if (
            cols === lastTerminalSize.cols &&
            rows === lastTerminalSize.rows
          ) {
            return;
          }
          lastTerminalSize = { cols, rows };
          terminal.resize(cols, rows);
        });
      };
      fit();
      resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(containerRef.current);

      unsubscribe = await subscribeToTerminal(
        (event) => {
          if (event.terminalId === terminalIdRef.current) {
            terminal.write(event.data);
          }
        },
        (event) => {
          if (event.terminalId === terminalIdRef.current) {
            terminal.write(
              `\r\n[终端已退出，退出码：${event.code ?? "未知"}]\r\n`,
            );
            setPhase("closed");
            terminalIdRef.current = null;
          }
        },
      );

      try {
        const terminalId = await createTerminalSession(cwd);
        if (disposed) {
          await closeTerminalSession(terminalId);
          return;
        }
        terminalIdRef.current = terminalId;
        terminal.write(`MelodyWork 终端\r\n${cwd}\r\n\r\n${PROMPT}`);
        setPhase("ready");
        terminal.focus();
      } catch (reason) {
        terminal.write(
          `\r\n${reason instanceof Error ? reason.message : String(reason)}\r\n`,
        );
        setPhase("error");
      }

      dataDisposable = terminal.onData((data) => {
        for (const character of data) {
          if (character === "\r" || character === "\n") {
            const command = lineBufferRef.current;
            lineBufferRef.current = "";
            terminal.write("\r\n");
            if (!isTauriRuntime()) {
              terminal.write(
                command
                  ? `浏览器预览：已接收命令 “${command}”。\r\n${PROMPT}`
                  : PROMPT,
              );
              continue;
            }
            const terminalId = terminalIdRef.current;
            if (!terminalId) {
              terminal.write("[终端尚未就绪]\r\n");
              continue;
            }
            const input = `${command}\nprintf '\\n${PROMPT}'\n`;
            void writeTerminalInput(terminalId, input).catch((reason) => {
              terminal.write(
                `\r\n${reason instanceof Error ? reason.message : String(reason)}\r\n`,
              );
              setPhase("error");
            });
          } else if (character === "\u007f") {
            if (lineBufferRef.current.length > 0) {
              lineBufferRef.current = lineBufferRef.current.slice(0, -1);
              terminal.write("\b \b");
            }
          } else if (character === "\u000c") {
            terminal.clear();
            terminal.write(PROMPT + lineBufferRef.current);
          } else if (character >= " ") {
            lineBufferRef.current += character;
            terminal.write(character);
          }
        }
      });
    };

    void start();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (resizeFrame !== undefined) {
        window.cancelAnimationFrame(resizeFrame);
      }
      dataDisposable?.dispose();
      for (const unlisten of unsubscribe) {
        unlisten();
      }
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      if (terminalId) {
        void closeTerminalSession(terminalId);
      }
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [cwd]);

  return (
    <section
      className={
        embedded
          ? "flex size-full min-h-0 flex-col overflow-hidden bg-background"
          : "absolute inset-x-4 bottom-4 z-30 flex h-[28rem] flex-col overflow-hidden rounded-2xl border bg-background shadow-xl"
      }
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <TerminalSquareIcon className="size-4 text-muted-foreground" />
        <h2 className="font-medium text-sm">终端</h2>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {cwd}
        </span>
        <span className="text-muted-foreground text-[11px]">
          {phase === "starting"
            ? "正在启动…"
            : phase === "ready"
              ? "可输入"
              : phase === "closed"
                ? "已退出"
                : "连接错误"}
        </span>
        {onClose ? (
          <Button
            aria-label="关闭终端"
            onClick={onClose}
            size="icon"
            variant="ghost"
          >
            <XIcon />
          </Button>
        ) : null}
      </header>
      <div
        aria-label="终端输入"
        className="min-h-0 flex-1 bg-[#fafafa] p-3 dark:bg-[#171717]"
        onClick={() => terminalRef.current?.focus()}
        ref={containerRef}
        role="textbox"
        tabIndex={0}
      />
    </section>
  );
}
