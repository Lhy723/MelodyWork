import {
  BotIcon,
  ChevronDownIcon,
  HandIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  PaperclipIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  AgentContextUsage,
  AgentModelOption,
  AgentPermissionMode,
  AgentPromptAttachment,
  AgentSessionModeOption,
} from "@/domain/acp";
import {
  groupModelsByProvider,
  modelProvider,
  type ModelProvider,
} from "@/domain/model-provider";
import { cn } from "@/lib/utils";
import { useAppSettingsStore } from "@/stores/app-settings-store";
import { useMemo, useState } from "react";
import { ReasoningEffortSlider } from "./reasoning-effort-slider";

interface AgentComposerProps {
  contextUsage?: AgentContextUsage;
  models: AgentModelOption[];
  modelChanging: boolean;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
  onSessionModeChange: (modeId: string) => void;
  selectedModelId?: string;
  selectedReasoningEffort?: string;
  selectedSessionModeId?: string;
  reasoningEffortChanging: boolean;
  sessionModeChanging: boolean;
  sessionModes: AgentSessionModeOption[];
  permissionMode: AgentPermissionMode;
  status: "ready" | "submitted" | "streaming" | "error";
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (effort: string) => void;
  onStop: () => void;
  onSubmit: (
    content: string,
    attachments: AgentPromptAttachment[],
  ) => void | Promise<void>;
}

const permissionModes = [
  {
    id: "ask",
    label: "操作前询问",
    shortLabel: "询问",
    description: "编辑外部文件或使用网络前始终询问。",
    icon: HandIcon,
  },
  {
    id: "auto",
    label: "智能授权",
    shortLabel: "自动授权",
    description: "仅在检测到高风险操作时询问。",
    icon: ShieldCheckIcon,
  },
  {
    id: "always-approve",
    label: "完全访问",
    shortLabel: "完全访问",
    description: "允许不受限制地访问本机文件和网络。",
    icon: ShieldAlertIcon,
  },
] satisfies {
  id: AgentPermissionMode;
  label: string;
  shortLabel: string;
  description: string;
  icon: typeof HandIcon;
}[];

const sessionModeCopy: Record<
  string,
  {
    label: string;
    description: string;
    icon: typeof BotIcon;
  }
> = {
  default: {
    label: "代理",
    description: "按需使用工具完成任务。",
    icon: BotIcon,
  },
  plan: {
    label: "规划",
    description: "先制定方案，不修改文件。",
    icon: ListTodoIcon,
  },
  ask: {
    label: "问答",
    description: "回答问题，不主动执行操作。",
    icon: MessageCircleQuestionIcon,
  },
};

const PromptInputAttachmentsDisplay = () => {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <Attachments className="w-full" variant="inline">
      {attachments.files.map((attachment) => (
        <Attachment
          className="max-w-52"
          data={attachment}
          key={attachment.id}
          onRemove={() => attachments.remove(attachment.id)}
        >
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
};

const ModelProviderMark = ({ provider }: { provider: ModelProvider }) => (
  <span className="relative flex size-5 shrink-0 items-center justify-center">
    <BotIcon className="size-3.5 text-muted-foreground" />
    <ModelSelectorLogo
      className="absolute size-4 rounded-full bg-white p-px shadow-sm ring-1 ring-black/10"
      key={provider.id}
      onError={(event) => {
        event.currentTarget.hidden = true;
      }}
      provider={provider.id}
    />
  </span>
);

export function AgentComposer({
  contextUsage,
  models,
  modelChanging,
  onPermissionModeChange,
  onSessionModeChange,
  selectedModelId,
  selectedReasoningEffort,
  selectedSessionModeId,
  reasoningEffortChanging,
  sessionModeChanging,
  sessionModes,
  permissionMode,
  status,
  onModelChange,
  onReasoningEffortChange,
  onStop,
  onSubmit,
}: AgentComposerProps) {
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const sendShortcut = useAppSettingsStore((state) => state.sendShortcut);
  const showContextUsage = useAppSettingsStore(
    (state) => state.showContextUsage,
  );
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const selectedModelProvider = selectedModel
    ? modelProvider(selectedModel)
    : undefined;
  const modelGroups = useMemo(() => groupModelsByProvider(models), [models]);
  const effectiveContextUsage =
    contextUsage ??
    (selectedModel?.contextWindowTokens
      ? {
          usedTokens: 0,
          maxTokens: selectedModel.contextWindowTokens,
        }
      : undefined);
  const selectedPermissionMode =
    permissionModes.find((mode) => mode.id === permissionMode) ??
    permissionModes[0];
  const PermissionIcon = selectedPermissionMode.icon;
  const selectedSessionMode =
    sessionModes.find((mode) => mode.id === selectedSessionModeId) ??
    sessionModes[0];
  const selectedSessionModeCopy = selectedSessionMode
    ? sessionModeCopy[selectedSessionMode.id]
    : undefined;
  const SessionModeIcon = selectedSessionModeCopy?.icon ?? BotIcon;

  const handleSubmit = (message: PromptInputMessage) => {
    setComposerText("");
    return onSubmit(message.text, message.files);
  };

  return (
    <div className="harness-composer-wrap mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6">
      <PromptInput
        accept="image/*,.txt,.md,.json,.toml"
        className="harness-composer [&_[data-slot=input-group]]:rounded-[18px]"
        maxFileSize={8 * 1024 * 1024}
        maxFiles={8}
        multiple
        onSubmit={handleSubmit}
      >
        <PromptInputHeader>
          <PromptInputAttachmentsDisplay />
        </PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea
            onChange={(event) => setComposerText(event.currentTarget.value)}
            placeholder="让 Melody 构建、审查或解释…"
            submitShortcut={sendShortcut}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger tooltip="添加附件">
                <PaperclipIcon />
              </PromptInputActionMenuTrigger>
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            {models.length > 0 ? (
              <ModelSelector
                onOpenChange={setModelSelectorOpen}
                open={modelSelectorOpen}
              >
                <ModelSelectorTrigger asChild>
                  <PromptInputButton
                    aria-label="选择智能体模型"
                    className="motion-view-enter max-w-56"
                    disabled={modelChanging}
                  >
                    {modelChanging ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : selectedModelProvider ? (
                      <ModelProviderMark provider={selectedModelProvider} />
                    ) : (
                      <BotIcon />
                    )}
                    <span className="truncate">
                      {selectedModel?.name ?? "选择模型"}
                    </span>
                    <ChevronDownIcon className="size-3.5" />
                  </PromptInputButton>
                </ModelSelectorTrigger>
                <ModelSelectorContent
                  className="max-w-lg rounded-xl"
                  title="选择智能体模型"
                >
                  <ModelSelectorInput placeholder="搜索模型…" />
                  <ModelSelectorList>
                    <ModelSelectorEmpty>没有找到匹配的模型</ModelSelectorEmpty>
                    {modelGroups.map(({ provider, models: groupModels }) => (
                      <ModelSelectorGroup
                        heading={provider.name}
                        key={provider.id}
                      >
                        {groupModels.map((model) => (
                          <ModelSelectorItem
                            data-checked={model.id === selectedModelId}
                            disabled={modelChanging}
                            key={model.id}
                            onSelect={() => {
                              if (model.id !== selectedModelId) {
                                onModelChange(model.id);
                              }
                              setModelSelectorOpen(false);
                            }}
                            value={`${model.name} ${model.id} ${provider.name}`}
                          >
                            <ModelProviderMark provider={provider} />
                            <ModelSelectorName>{model.name}</ModelSelectorName>
                            <span className="max-w-44 truncate text-muted-foreground text-xs">
                              {model.id}
                            </span>
                          </ModelSelectorItem>
                        ))}
                      </ModelSelectorGroup>
                    ))}
                  </ModelSelectorList>
                </ModelSelectorContent>
              </ModelSelector>
            ) : (
              <span className="px-2 text-muted-foreground text-xs">
                智能体 · 默认模型
              </span>
            )}
            {selectedModel && selectedModel.reasoningEfforts.length > 0 ? (
              <ReasoningEffortSlider
                disabled={modelChanging || reasoningEffortChanging}
                loading={reasoningEffortChanging}
                onValueChange={onReasoningEffortChange}
                options={selectedModel.reasoningEfforts}
                value={selectedReasoningEffort}
              />
            ) : null}
            {selectedSessionMode ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <PromptInputButton
                    aria-label="会话模式"
                    className="max-w-36"
                    disabled={sessionModeChanging}
                    tooltip="会话模式"
                  >
                    {sessionModeChanging ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : (
                      <SessionModeIcon />
                    )}
                    <span className="truncate">
                      {selectedSessionModeCopy?.label ??
                        selectedSessionMode.name}
                    </span>
                    <ChevronDownIcon className="size-3.5" />
                  </PromptInputButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-64 rounded-lg p-1"
                  side="top"
                  sideOffset={8}
                >
                  <DropdownMenuRadioGroup
                    onValueChange={onSessionModeChange}
                    value={selectedSessionModeId}
                  >
                    {sessionModes.map((mode) => {
                      const copy = sessionModeCopy[mode.id];
                      const Icon = copy?.icon ?? BotIcon;
                      return (
                        <DropdownMenuRadioItem
                          className="items-start gap-2 rounded-md px-2 py-1.5 pr-8"
                          disabled={sessionModeChanging}
                          key={mode.id}
                          value={mode.id}
                        >
                          <Icon className="mt-px size-4" />
                          <span className="min-w-0">
                            <span className="block font-medium text-sm leading-4">
                              {copy?.label ?? mode.name}
                            </span>
                            <span className="block whitespace-normal text-muted-foreground text-xs leading-4">
                              {copy?.description ??
                                mode.description ??
                                mode.name}
                            </span>
                          </span>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PromptInputButton
                  aria-label="权限模式"
                  className={cn(
                    "max-w-40",
                    permissionMode === "always-approve" &&
                      "text-orange-600 hover:text-orange-600",
                  )}
                >
                  <PermissionIcon />
                  <span className="truncate">
                    {selectedPermissionMode.shortLabel}
                  </span>
                  <ChevronDownIcon className="size-3.5" />
                </PromptInputButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-72 rounded-lg p-1"
                side="top"
                sideOffset={8}
              >
                <DropdownMenuRadioGroup
                  onValueChange={(value) =>
                    onPermissionModeChange(value as AgentPermissionMode)
                  }
                  value={permissionMode}
                >
                  {permissionModes.map((mode) => {
                    const Icon = mode.icon;
                    return (
                      <DropdownMenuRadioItem
                        className="items-start gap-2 rounded-md px-2 py-1.5 pr-8"
                        key={mode.id}
                        value={mode.id}
                      >
                        <Icon
                          className={cn(
                            "mt-px size-4",
                            mode.id === "always-approve" && "text-orange-600",
                          )}
                        />
                        <span className="min-w-0">
                          <span
                            className={cn(
                              "block font-medium text-sm leading-4",
                              mode.id === "always-approve" && "text-orange-600",
                            )}
                          >
                            {mode.label}
                          </span>
                          <span
                            className={cn(
                              "block whitespace-normal text-muted-foreground text-xs leading-4",
                              mode.id === "always-approve" && "text-orange-600",
                            )}
                          >
                            {mode.description}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {effectiveContextUsage && showContextUsage ? (
              <Context
                cost={effectiveContextUsage.cost}
                maxTokens={effectiveContextUsage.maxTokens}
                usedTokens={effectiveContextUsage.usedTokens}
              >
                <ContextTrigger
                  aria-label="上下文窗口用量"
                  className="motion-view-enter"
                  size="sm"
                />
                <ContextContent align="end" side="top" sideOffset={8}>
                  <ContextContentHeader />
                  <ContextContentBody />
                  <ContextContentFooter />
                </ContextContent>
              </Context>
            ) : null}
          </PromptInputTools>
          <PromptInputSubmit
            hasContent={composerText.trim().length > 0}
            onStop={onStop}
            status={status}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
