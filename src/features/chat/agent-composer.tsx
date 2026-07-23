import { PaperclipIcon } from "lucide-react";

import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";

interface AgentComposerProps {
  status: "ready" | "submitted" | "streaming" | "error";
  onSubmit: (content: string) => void;
}

export function AgentComposer({ status, onSubmit }: AgentComposerProps) {
  const handleSubmit = (message: PromptInputMessage) => {
    onSubmit(message.text);
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-5">
      <PromptInput
        accept="image/*,.txt,.md,.json,.toml"
        className="rounded-2xl shadow-sm"
        maxFiles={8}
        multiple
        onSubmit={handleSubmit}
      >
        <PromptInputBody>
          <PromptInputTextarea placeholder="Ask Melody to build, review, or explain…" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger tooltip="Attach files">
                <PaperclipIcon />
              </PromptInputActionMenuTrigger>
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            <span className="px-2 text-muted-foreground text-xs">
              Agent · Default model
            </span>
          </PromptInputTools>
          <PromptInputSubmit status={status} />
        </PromptInputFooter>
      </PromptInput>
      <p className="mt-2 px-2 text-center text-muted-foreground text-[11px]">
        Melody can modify files and run commands after permission is granted.
      </p>
    </div>
  );
}
