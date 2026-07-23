import { TerminalSquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isTauriRuntime,
  runTerminalCommand,
  subscribeToTerminal,
} from "@/lib/melody-bridge";

interface TerminalPanelProps {
  cwd: string;
  onClose: () => void;
}

export function TerminalPanel({ cwd, onClose }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const pendingRef = useRef(false);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void)[] = [];
    void import("@xterm/xterm").then(async ({ Terminal }) => {
      if (disposed || !containerRef.current) {
        return;
      }
      const terminal = new Terminal({
        cols: 100,
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        fontFamily:
          '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        rows: 20,
        theme: {
          background: "#fafafa",
          foreground: "#202020",
          cursor: "#202020",
          red: "#b42318",
          green: "#067647",
          yellow: "#b54708",
          blue: "#175cd3",
        },
      });
      terminal.open(containerRef.current);
      terminal.write(`MelodyWork terminal\r\n${cwd}\r\n\r\n`);
      terminalRef.current = terminal;
      unsubscribe = await subscribeToTerminal(
        (event) => {
          if (pendingRef.current) {
            activeIdRef.current = event.terminalId;
            pendingRef.current = false;
          }
          if (event.terminalId === activeIdRef.current) {
            terminal.write(event.data);
          }
        },
        (event) => {
          if (event.terminalId === activeIdRef.current) {
            terminal.write(
              `\r\n[process exited with code ${event.code ?? "unknown"}]\r\n`,
            );
            setRunning(false);
            activeIdRef.current = null;
          }
        },
      );
    });

    return () => {
      disposed = true;
      for (const unlisten of unsubscribe) {
        unlisten();
      }
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [cwd]);

  const run = async () => {
    const nextCommand = command.trim();
    if (!nextCommand || running) {
      return;
    }
    setRunning(true);
    setCommand("");
    terminalRef.current?.write(`\r\n$ ${nextCommand}\r\n`);
    if (!isTauriRuntime()) {
      window.setTimeout(() => {
        terminalRef.current?.write(
          "Browser preview: command execution is available in the desktop app.\r\n",
        );
        setRunning(false);
      }, 350);
      return;
    }
    pendingRef.current = true;
    try {
      activeIdRef.current = await runTerminalCommand(cwd, nextCommand);
      pendingRef.current = false;
    } catch (reason) {
      pendingRef.current = false;
      terminalRef.current?.write(
        `\r\n${reason instanceof Error ? reason.message : String(reason)}\r\n`,
      );
      setRunning(false);
    }
  };

  return (
    <section className="absolute inset-x-4 bottom-4 z-30 flex h-[28rem] flex-col overflow-hidden rounded-2xl border bg-background shadow-xl">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <TerminalSquareIcon className="size-4 text-muted-foreground" />
        <h2 className="font-medium text-sm">Terminal</h2>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {cwd}
        </span>
        <Button
          aria-label="Close terminal"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 bg-[#fafafa] p-3" ref={containerRef} />
      <form
        className="flex shrink-0 gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Input
          aria-label="Terminal command"
          disabled={running}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={running ? "Command is running…" : "Run a command"}
          value={command}
        />
        <Button disabled={running || !command.trim()} type="submit">
          Run
        </Button>
      </form>
    </section>
  );
}
