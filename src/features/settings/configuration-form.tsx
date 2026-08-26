import {
  BotIcon,
  BrainCircuitIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleGaugeIcon,
  DatabaseIcon,
  KeyRoundIcon,
  MonitorIcon,
  NetworkIcon,
  PlusIcon,
  ServerIcon,
  Settings2Icon,
  ShieldIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AgentModelOption, AgentPermissionMode } from "@/domain/acp";
import type { MelodyConfigScope, MelodyConfigValue } from "@/domain/config";
import { requestSystemNotificationPermission } from "@/lib/system-notifications";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/agent-store";
import {
  useAppSettingsStore,
  type AppSettings,
} from "@/stores/app-settings-store";

type ConfigValues = Record<string, MelodyConfigValue>;
type ConfigObject = Record<string, MelodyConfigValue>;

const providerTemplates = [
  {
    id: "openai",
    name: "OpenAI",
    description: "Responses API，使用 OPENAI_API_KEY。",
    baseUrl: "https://api.openai.com/v1",
    backend: "responses",
    envKey: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Messages API，使用 ANTHROPIC_API_KEY。",
    baseUrl: "https://api.anthropic.com/v1",
    backend: "messages",
    envKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "compatible",
    name: "OpenAI 兼容",
    description: "适用于第三方网关和自托管服务。",
    baseUrl: "",
    backend: "chat_completions",
    envKey: "",
  },
] as const;

const inheritedModelFields = [
  {
    key: "temperature",
    label: "温度",
    description: "控制回复的随机性。",
    fallback: 1,
    min: 0,
    max: 2,
    step: 0.1,
  },
  {
    key: "top_p",
    label: "Top P",
    description: "限制候选词的概率范围。",
    fallback: 1,
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: "max_completion_tokens",
    label: "最大输出 Token",
    description: "限制单次回复的最大长度。",
    fallback: 8192,
    min: 1,
    step: 1,
  },
  {
    key: "max_retries",
    label: "最大重试次数",
    description: "请求失败后的自动重试上限。",
    fallback: 8,
    min: 0,
    step: 1,
  },
  {
    key: "inference_idle_timeout_secs",
    label: "推理空闲超时",
    description: "流式响应无新内容后等待的秒数。",
    fallback: 600,
    min: 1,
    step: 1,
  },
] as const;

interface ConfigurationFormProps {
  availableModels: AgentModelOption[];
  sectionId: string;
  scope: MelodyConfigScope;
  values: ConfigValues;
  onChange: (path: string[], value: MelodyConfigValue) => void;
}

export interface ConfigurationNavigationItem {
  id: string;
  label: string;
  icon: typeof Settings2Icon;
}

type SettingKind =
  | "agents-skills-source"
  | "boolean"
  | "key-value"
  | "number"
  | "select"
  | "string"
  | "string-list";

interface SettingDefinition {
  path: string[];
  label: string;
  description: string;
  kind: SettingKind;
  defaultValue?: string | number | boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  clearValue?: string;
  secret?: boolean;
  numberValues?: boolean;
}

interface SettingSection {
  id: string;
  label: string;
  description: string;
  icon: typeof Settings2Icon;
  settings: SettingDefinition[];
}

const userSections: SettingSection[] = [
  {
    id: "models",
    label: "模型",
    description: "选择默认模型、调整生成行为并管理自定义模型。",
    icon: BotIcon,
    settings: [
      {
        path: ["models", "default"],
        label: "默认模型",
        description: "新会话默认使用的模型或自定义模型名称。",
        kind: "string",
      },
      {
        path: ["models", "web_search"],
        label: "联网搜索模型",
        description: "需要联网检索时使用的模型。",
        kind: "string",
        placeholder: "例如 grok-4.20-multi-agent",
      },
      {
        path: ["models", "temperature"],
        label: "温度",
        description: "控制回复随机性；留空时由模型决定。",
        kind: "number",
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        path: ["models", "top_p"],
        label: "Top P",
        description: "限制候选词概率范围；留空时由模型决定。",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        path: ["models", "max_completion_tokens"],
        label: "最大输出 Token",
        description: "单次回复可生成的最大 Token 数。",
        kind: "number",
        min: 1,
        step: 1,
      },
      {
        path: ["models", "max_retries"],
        label: "最大重试次数",
        description: "模型请求失败后的自动重试上限。",
        kind: "number",
        defaultValue: 8,
        min: 0,
        step: 1,
      },
      {
        path: ["models", "inference_idle_timeout_secs"],
        label: "推理空闲超时",
        description: "流式响应无新内容后等待的秒数。",
        kind: "number",
        defaultValue: 600,
        min: 1,
        step: 1,
      },
      {
        path: ["models", "stream_tool_calls"],
        label: "流式工具调用",
        description: "允许在模型尚未结束输出时开始解析工具调用。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["models", "extra_headers"],
        label: "全局请求头",
        description: "每行填写“名称=值”，应用到所有模型请求。",
        kind: "key-value",
      },
    ],
  },
  {
    id: "melody-appearance",
    label: "界面",
    description: "终端界面、滚动和内容展示方式。",
    icon: MonitorIcon,
    settings: [
      {
        path: ["ui", "simple_mode"],
        label: "简洁模式",
        description: "减少界面装饰，保持紧凑展示。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["ui", "vim_mode"],
        label: "Vim 模式",
        description: "在输入区启用 Vim 风格操作。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["ui", "show_thinking_blocks"],
        label: "显示思考过程",
        description: "在会话中展示模型提供的思考块。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["ui", "default_selected_permission"],
        label: "默认权限选项",
        description: "权限确认窗口默认选中的操作。",
        kind: "select",
        defaultValue: "always_allow_all_sessions",
        options: [
          { value: "allow_once", label: "仅允许一次" },
          { value: "always_allow_session", label: "本会话始终允许" },
          { value: "always_allow_all_sessions", label: "所有会话始终允许" },
          { value: "deny_once", label: "仅拒绝一次" },
        ],
      },
      {
        path: ["ui", "remember_tool_approvals"],
        label: "记住工具授权",
        description: "在后续会话中继续应用已确认的工具授权。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["ui", "group_tool_verbs"],
        label: "合并工具活动",
        description: "将连续的读取、搜索或编辑操作折叠成活动组。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["ui", "collapsed_edit_blocks"],
        label: "默认折叠编辑内容",
        description: "文件编辑完成后默认收起差异详情。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["ui", "page_flip_on_send"],
        label: "发送后翻页",
        description: "发送消息时自动移动到最新内容。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["ui", "screen_mode"],
        label: "屏幕模式",
        description: "控制 Melody 终端界面的占屏方式。",
        kind: "select",
        defaultValue: "fullscreen",
        options: [
          { value: "fullscreen", label: "全屏" },
          { value: "inline", label: "行内" },
        ],
      },
      {
        path: ["ui", "scroll_mode"],
        label: "滚动模式",
        description: "按输入设备优化滚动手感。",
        kind: "select",
        defaultValue: "auto",
        options: [
          { value: "auto", label: "自动" },
          { value: "wheel", label: "鼠标滚轮" },
          { value: "trackpad", label: "触控板" },
        ],
      },
      {
        path: ["ui", "scroll_speed"],
        label: "滚动速度",
        description: "滚动响应速度，范围 1–100。",
        kind: "number",
        defaultValue: 50,
        min: 1,
        max: 100,
        step: 1,
      },
      {
        path: ["ui", "scroll_lines"],
        label: "每次滚动行数",
        description: "鼠标滚轮每步移动的行数。",
        kind: "number",
        min: 1,
        max: 10,
        step: 1,
      },
      {
        path: ["ui", "invert_scroll"],
        label: "反转滚动方向",
        description: "反转鼠标或触控板的滚动方向。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["ui", "max_thoughts_width"],
        label: "思考内容最大宽度",
        description: "思考块每行允许显示的最大字符数。",
        kind: "number",
        defaultValue: 120,
        min: 40,
        step: 1,
      },
    ],
  },
  {
    id: "features",
    label: "功能",
    description: "可选能力、隐私和索引行为。",
    icon: CircleGaugeIcon,
    settings: [
      {
        path: ["features", "telemetry"],
        label: "遥测",
        description: "发送匿名使用数据以帮助改进 Melody。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["features", "feedback"],
        label: "反馈入口",
        description: "在界面中显示反馈功能。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["features", "lsp_tools"],
        label: "LSP 工具",
        description: "允许代理使用语言服务器能力。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["features", "codebase_indexing"],
        label: "代码库索引",
        description: "为项目建立索引以改进代码检索。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["features", "two_pass_compaction"],
        label: "两阶段上下文压缩",
        description: "使用额外阶段改善长会话压缩质量。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["features", "remote_fetch"],
        label: "远程内容获取",
        description: "允许工具读取远程网页内容。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["tools", "respect_gitignore"],
        label: "遵循 .gitignore",
        description: "文件搜索和扫描时排除 Git 忽略项。",
        kind: "boolean",
        defaultValue: false,
      },
    ],
  },
  {
    id: "tools",
    label: "工具",
    description: "命令执行、提问和网页获取限制。",
    icon: WrenchIcon,
    settings: [
      {
        path: ["toolset", "bash", "timeout_secs"],
        label: "命令超时",
        description: "单个终端命令允许运行的秒数。",
        kind: "number",
        defaultValue: 120,
        min: 1,
      },
      {
        path: ["toolset", "bash", "output_byte_limit"],
        label: "命令输出上限",
        description: "单次命令保留的最大输出字节数。",
        kind: "number",
        defaultValue: 20000,
        min: 1000,
        step: 1000,
      },
      {
        path: ["toolset", "ask_user_question", "timeout_enabled"],
        label: "提问超时",
        description: "等待用户回答时启用超时限制。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["toolset", "ask_user_question", "timeout_secs"],
        label: "提问等待时间",
        description: "等待用户回答的最大秒数。",
        kind: "number",
        defaultValue: 1800,
        min: 1,
      },
      {
        path: ["toolset", "web_fetch", "proxy_endpoint"],
        label: "网页代理地址",
        description: "通过指定代理访问网页；留空表示直连。",
        kind: "string",
        placeholder: "https://proxy.example.com",
      },
      {
        path: ["toolset", "web_fetch", "allowed_domains"],
        label: "网页域名白名单",
        description: "每行一个允许访问的域名；留空表示不限制。",
        kind: "string-list",
        placeholder: "docs.rs\nexample.com",
      },
      {
        path: ["toolset", "web_fetch", "allow_local"],
        label: "允许访问本地地址",
        description: "允许网页工具访问 localhost 和局域网地址。",
        kind: "boolean",
        defaultValue: false,
      },
    ],
  },
  {
    id: "session",
    label: "会话与记忆",
    description: "长会话压缩、环境加载和持久记忆。",
    icon: BrainCircuitIcon,
    settings: [
      {
        path: ["session", "auto_compact_threshold_percent"],
        label: "自动压缩阈值",
        description: "上下文占用达到此百分比时自动压缩。",
        kind: "number",
        defaultValue: 85,
        min: 1,
        max: 100,
      },
      {
        path: ["session", "load_envrc"],
        label: "加载 .envrc",
        description: "进入项目后加载 direnv 环境。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["memory", "enabled"],
        label: "持久记忆",
        description: "允许 Melody 保存并检索跨会话记忆。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["memory", "session", "save_on_end"],
        label: "结束时保存记忆",
        description: "会话结束时自动提取并保存有用信息。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["memory", "watcher", "enabled"],
        label: "记忆文件监听",
        description: "监控记忆文件变化并自动更新索引。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["memory", "search", "max_results"],
        label: "记忆检索数量",
        description: "单次检索最多返回的记忆条数。",
        kind: "number",
        min: 1,
      },
      {
        path: ["memory", "search", "min_score"],
        label: "记忆最低相关度",
        description: "过滤低相关度记忆，范围 0–1。",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        path: ["memory", "initial_injection", "enabled"],
        label: "初始记忆注入",
        description: "开始会话时自动注入相关记忆。",
        kind: "boolean",
        defaultValue: false,
      },
      {
        path: ["memory", "initial_injection", "min_score"],
        label: "初始记忆最低相关度",
        description: "仅注入高于此相关度的记忆。",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        path: ["memory", "embedding", "model"],
        label: "嵌入模型",
        description: "生成记忆向量所使用的模型。",
        kind: "string",
      },
      {
        path: ["memory", "embedding", "dimensions"],
        label: "嵌入维度",
        description: "嵌入模型输出向量的维度。",
        kind: "number",
        min: 1,
      },
    ],
  },
  {
    id: "agents",
    label: "代理",
    description: "子代理、工作流和技能发现。",
    icon: BotIcon,
    settings: [
      {
        path: ["subagents", "enabled"],
        label: "启用子代理",
        description: "允许主代理把独立工作委派给子代理。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["subagents", "toggle", "explore"],
        label: "探索子代理",
        description: "允许使用专门的项目探索代理。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["subagents", "toggle", "plan"],
        label: "规划子代理",
        description: "允许使用专门的规划代理。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["subagents", "models", "explore"],
        label: "探索模型",
        description: "探索子代理使用的模型名称。",
        kind: "string",
      },
      {
        path: ["workflows", "enabled"],
        label: "启用工作流",
        description: "允许 Melody 发现并执行工作流。",
        kind: "boolean",
        defaultValue: true,
      },
      {
        path: ["skills", "paths"],
        label: "额外技能目录",
        description: "每行一个额外扫描的技能目录。",
        kind: "string-list",
      },
      {
        path: ["skills", "ignore"],
        label: "忽略的技能",
        description: "每行一个不参与扫描的技能名称或模式。",
        kind: "string-list",
      },
      {
        path: ["skills", "disabled"],
        label: "停用的技能",
        description: "每行一个明确停用的技能名称。",
        kind: "string-list",
      },
    ],
  },
  {
    id: "auth",
    label: "认证",
    description: "外部凭据提供器和 OIDC 登录。",
    icon: ShieldIcon,
    settings: [
      {
        path: ["auth", "auth_provider_command"],
        label: "凭据提供命令",
        description: "运行后返回认证令牌的本地命令。",
        kind: "string",
      },
      {
        path: ["auth", "auth_provider_label"],
        label: "凭据提供器名称",
        description: "登录界面中显示的提供器名称。",
        kind: "string",
      },
      {
        path: ["auth", "auth_token_ttl"],
        label: "令牌缓存时间",
        description: "凭据提供命令结果的缓存秒数。",
        kind: "number",
        min: 0,
      },
      {
        path: ["grok_com_config", "oidc", "issuer"],
        label: "OIDC Issuer",
        description: "OpenID Connect 发行方地址。",
        kind: "string",
      },
      {
        path: ["grok_com_config", "oidc", "client_id"],
        label: "OIDC Client ID",
        description: "应用在 OIDC 提供器中的客户端标识。",
        kind: "string",
      },
      {
        path: ["grok_com_config", "oidc", "scopes"],
        label: "OIDC Scopes",
        description: "每行一个需要请求的 OIDC scope。",
        kind: "string-list",
      },
      {
        path: ["grok_com_config", "oidc", "audience"],
        label: "OIDC Audience",
        description: "令牌预期的 audience。",
        kind: "string",
      },
    ],
  },
  {
    id: "compatibility",
    label: "兼容性",
    description: "从其他编码工具导入约定和数据。",
    icon: DatabaseIcon,
    settings: [
      {
        path: ["compat", "agents", "skills"],
        label: "技能",
        description: "发现用户 ~/.agents 与当前工作目录 .agents 中的通用技能。",
        kind: "agents-skills-source",
        defaultValue: true,
      },
      ...(["claude", "cursor"] as const).flatMap((provider) =>
        [
          ["skills", "技能", "发现技能与旧式自定义命令。"],
          ["rules", "规则", "读取项目和用户级规则目录。"],
          ["agents", "代理指令", "读取命名的代理与项目指令文件。"],
          ["mcps", "MCP 服务器", "读取 MCP 服务器配置。"],
          ["hooks", "钩子", "读取生命周期钩子配置。"],
          ["sessions", "会话", "允许发现兼容的历史会话。"],
        ].map(([feature, label, description]): SettingDefinition => ({
          path: ["compat", provider, feature],
          label,
          description,
          kind: "boolean",
          defaultValue: true,
        })),
      ),
      {
        path: ["compat", "codex", "sessions"],
        label: "会话",
        description: "允许发现兼容的 Codex 历史会话。",
        kind: "boolean",
        defaultValue: true,
      },
    ],
  },
];

const compatibilityGroups = [
  {
    id: "agents",
    label: "Agents",
    description: "控制跨智能体工具共享的 .agents 通用技能目录。",
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "兼容 ~/.claude 与项目 .claude 中的约定和资源。",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "兼容 ~/.cursor 与项目 .cursor 中的约定和资源。",
  },
  {
    id: "codex",
    label: "Codex",
    description: "仅显示 MelodyBuild 当前提供的 Codex 兼容能力。",
  },
] as const;

function valueAt(
  values: ConfigValues,
  path: string[],
): MelodyConfigValue | undefined {
  let current: MelodyConfigValue = values;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function hasValue(values: ConfigValues, path: string[]) {
  return valueAt(values, path) !== undefined;
}

function SettingControl({
  definition,
  values,
  onChange,
}: {
  definition: SettingDefinition;
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  const explicit = valueAt(values, definition.path);
  const value = explicit ?? definition.defaultValue;

  if (definition.kind === "agents-skills-source") {
    const ignoreValue = valueAt(values, ["skills", "ignore"]);
    const ignored = Array.isArray(ignoreValue)
      ? ignoreValue.filter((item): item is string => typeof item === "string")
      : [];
    const managedPaths = new Set(["~/.agents", ".agents"]);
    const checked = !ignored.some((path) => managedPaths.has(path));
    return (
      <Switch
        aria-label={definition.label}
        checked={checked}
        onCheckedChange={(next) => {
          const preserved = ignored.filter((path) => !managedPaths.has(path));
          const updated = next
            ? preserved
            : [...preserved, "~/.agents", ".agents"];
          onChange(["skills", "ignore"], updated.length > 0 ? updated : null);
        }}
      />
    );
  }

  if (definition.kind === "boolean") {
    const checked = Boolean(value);
    return (
      <Switch
        aria-label={definition.label}
        checked={checked}
        onCheckedChange={(next) => onChange(definition.path, next)}
      />
    );
  }

  if (definition.kind === "select") {
    const selectedValue =
      typeof explicit === "string"
        ? explicit
        : (definition.clearValue ?? (typeof value === "string" ? value : ""));
    return (
      <Select
        onValueChange={(next) =>
          onChange(
            definition.path,
            next === definition.clearValue ? null : next,
          )
        }
        value={selectedValue}
      >
        <SelectTrigger aria-label={definition.label} className="w-44">
          <SelectValue placeholder="使用默认值" />
        </SelectTrigger>
        <SelectContent>
          {definition.options?.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (definition.kind === "string-list" || definition.kind === "key-value") {
    const textValue =
      definition.kind === "string-list"
        ? Array.isArray(explicit)
          ? explicit
              .filter((item): item is string => typeof item === "string")
              .join("\n")
          : ""
        : explicit && typeof explicit === "object" && !Array.isArray(explicit)
          ? Object.entries(explicit)
              .map(([key, item]) => `${key}=${String(item)}`)
              .join("\n")
          : "";
    return (
      <textarea
        aria-label={definition.label}
        className="min-h-20 w-64 resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-xs outline-none transition-[color,background-color,border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        onChange={(event) => {
          if (definition.kind === "string-list") {
            const next = event.target.value
              .split(/\r?\n|,/)
              .map((item) => item.trim())
              .filter(Boolean);
            onChange(definition.path, next.length > 0 ? next : null);
            return;
          }
          const next: Record<string, string | number> = {};
          for (const line of event.target.value.split(/\r?\n/)) {
            const [key, item] = line.split(/=(.*)/s);
            if (!key?.trim() || item === undefined) {
              continue;
            }
            if (!definition.numberValues) {
              next[key.trim()] = item.trim();
              continue;
            }
            const number = Number(item.trim());
            if (Number.isFinite(number)) {
              next[key.trim()] = number;
            }
          }
          onChange(definition.path, Object.keys(next).length > 0 ? next : null);
        }}
        placeholder={
          definition.placeholder ??
          (definition.kind === "key-value" ? "名称=值" : undefined)
        }
        value={textValue}
      />
    );
  }

  return (
    <Input
      aria-label={definition.label}
      className="w-52"
      max={definition.max}
      min={definition.min}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(
          definition.path,
          definition.kind === "number"
            ? raw === ""
              ? null
              : Number(raw)
            : raw === ""
              ? null
              : raw,
        );
      }}
      placeholder={definition.placeholder ?? "使用默认值"}
      step={definition.step}
      type={
        definition.secret
          ? "password"
          : definition.kind === "number"
            ? "number"
            : "text"
      }
      value={
        explicit === undefined || explicit === null
          ? ""
          : typeof explicit === "string" || typeof explicit === "number"
            ? explicit
            : ""
      }
    />
  );
}

function SettingsList({
  section,
  values,
  onChange,
}: {
  section: SettingSection;
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {section.settings.map((definition, index) => (
        <div
          className={cn(
            "flex min-h-16 items-center gap-5 px-4 py-3",
            index > 0 && "border-t",
          )}
          key={definition.path.join(".")}
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">{definition.label}</p>
            <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
              {definition.description}
              {definition.defaultValue !== undefined &&
              !hasValue(values, definition.path)
                ? ` 默认：${String(definition.defaultValue)}`
                : ""}
            </p>
          </div>
          <SettingControl
            definition={definition}
            onChange={onChange}
            values={values}
          />
        </div>
      ))}
    </div>
  );
}

function CompatibilitySettings({
  section,
  values,
  onChange,
}: {
  section: SettingSection;
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  return (
    <div className="grid gap-6">
      {compatibilityGroups.map((group) => {
        const settings = section.settings.filter(
          (definition) => definition.path[1] === group.id,
        );
        return (
          <section key={group.id}>
            <h4 className="font-medium text-sm">{group.label}</h4>
            <p className="mt-0.5 mb-2 text-muted-foreground text-xs">
              {group.description}
            </p>
            <SettingsList
              onChange={onChange}
              section={{
                ...section,
                id: group.id,
                label: group.label,
                settings,
              }}
              values={values}
            />
          </section>
        );
      })}
    </div>
  );
}

function PreferenceRow({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description: string;
  label: string;
}) {
  return (
    <div className="flex min-h-14 items-center gap-5 border-t px-4 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">{label}</p>
        <p className="mt-0.5 text-muted-foreground text-xs leading-4">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

function PreferenceGroup({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section>
      <h4 className="mb-2 font-medium text-sm">{title}</h4>
      <div className="overflow-hidden rounded-xl border bg-card">
        {children}
      </div>
    </section>
  );
}

function PreferenceSelect<Key extends keyof AppSettings>({
  label,
  options,
  settingKey,
}: {
  label: string;
  options: { label: string; value: AppSettings[Key] & string }[];
  settingKey: Key;
}) {
  const value = useAppSettingsStore((state) => state[settingKey]);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <Select
      onValueChange={(next) => setSetting(settingKey, next as AppSettings[Key])}
      value={String(value)}
    >
      <SelectTrigger aria-label={label} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PreferenceSwitch<Key extends keyof AppSettings>({
  label,
  settingKey,
}: {
  label: string;
  settingKey: Key;
}) {
  const value = useAppSettingsStore((state) => state[settingKey]);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <Switch
      aria-label={label}
      className="data-[state=checked]:bg-blue-500"
      checked={Boolean(value)}
      onCheckedChange={(next) =>
        setSetting(settingKey, next as AppSettings[Key])
      }
    />
  );
}

function UnavailableControl({ label = "尚未实现" }: { label?: string }) {
  return <Badge variant="outline">{label}</Badge>;
}

function PermissionModePreference() {
  const value = useAppSettingsStore((state) => state.defaultPermissionMode);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <Select
      onValueChange={(next) => {
        const mode = next as AgentPermissionMode;
        setSetting("defaultPermissionMode", mode);
        void useAgentStore.getState().selectPermissionMode(mode);
      }}
      value={value}
    >
      <SelectTrigger aria-label="默认及当前权限模式" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ask">询问</SelectItem>
        <SelectItem value="auto">自动审核</SelectItem>
        <SelectItem value="always-approve">始终允许</SelectItem>
      </SelectContent>
    </Select>
  );
}

function NotificationPreferenceSwitch({
  settingKey,
}: {
  settingKey: "permissionNotifications";
}) {
  const value = useAppSettingsStore((state) => state[settingKey]);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  const [permissionDenied, setPermissionDenied] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <Switch
        aria-label="启用权限通知"
        checked={value}
        onCheckedChange={(checked) => {
          if (!checked) {
            setPermissionDenied(false);
            setSetting(settingKey, false);
            return;
          }
          void requestSystemNotificationPermission().then((granted) => {
            setPermissionDenied(!granted);
            setSetting(settingKey, granted);
          });
        }}
      />
      {permissionDenied ? (
        <span className="text-destructive text-[11px]">系统未授予通知权限</span>
      ) : null}
    </div>
  );
}

function CompletionNotificationPreference() {
  const value = useAppSettingsStore((state) => state.completionNotification);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  const [permissionDenied, setPermissionDenied] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        onValueChange={(next) => {
          const mode = next as AppSettings["completionNotification"];
          if (mode === "never") {
            setPermissionDenied(false);
            setSetting("completionNotification", mode);
            return;
          }
          void requestSystemNotificationPermission().then((granted) => {
            setPermissionDenied(!granted);
            setSetting("completionNotification", granted ? mode : "never");
          });
        }}
        value={value}
      >
        <SelectTrigger aria-label="轮次完成通知" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unfocused">仅应用失焦时</SelectItem>
          <SelectItem value="always">始终</SelectItem>
          <SelectItem value="never">从不</SelectItem>
        </SelectContent>
      </Select>
      {permissionDenied ? (
        <span className="text-destructive text-[11px]">系统未授予通知权限</span>
      ) : null}
    </div>
  );
}

function ApplicationGeneralSettings() {
  const importInput = useRef<HTMLInputElement>(null);
  const [actionMessage, setActionMessage] = useState<string>();

  const importSettings = async (file?: File) => {
    if (!file) {
      return;
    }
    try {
      const incoming = JSON.parse(await file.text()) as Partial<AppSettings>;
      const current = useAppSettingsStore.getState();
      for (const [key, value] of Object.entries(incoming)) {
        if (key in current && key !== "setSetting") {
          current.setSetting(key as keyof AppSettings, value as never);
        }
      }
      setActionMessage("已导入可识别的 MelodyWork 设置。");
    } catch {
      setActionMessage("无法读取该设置文件。");
    }
  };

  return (
    <div className="flex flex-col gap-7">
      <PreferenceGroup title="权限">
        <PreferenceRow
          description="立即应用到当前任务，并作为以后新任务的默认权限模式。"
          label="默认及当前权限模式"
        >
          <PermissionModePreference />
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title="常规">
        <PreferenceRow
          description="从消息或工具活动中打开文件时使用的应用。"
          label="默认文件打开目标"
        >
          <UnavailableControl />
        </PreferenceRow>
        <PreferenceRow description="MelodyWork 界面使用的语言。" label="语言">
          <UnavailableControl label="简体中文 · 其他语言尚未实现" />
        </PreferenceRow>
        <PreferenceRow
          description="关闭主窗口后仍在系统菜单栏中保留 MelodyWork。"
          label="在菜单栏中显示"
        >
          <UnavailableControl />
        </PreferenceRow>
        <PreferenceRow
          description="在应用底部显示终端和其他面板控件。"
          label="底部面板"
        >
          <UnavailableControl />
        </PreferenceRow>
        <PreferenceRow
          description="选择终端快捷键和环境操作在何处打开终端标签页。"
          label="默认终端位置"
        >
          <UnavailableControl />
        </PreferenceRow>
        <PreferenceRow
          description="代理运行时阻止系统自动休眠。"
          label="运行时防止系统休眠"
        >
          <UnavailableControl />
        </PreferenceRow>
        <PreferenceRow
          description="搜索项目文件和已连接应用，建议下一步操作。"
          label="建议提示"
        >
          <UnavailableControl />
        </PreferenceRow>
        <PreferenceRow
          description="导入其他客户端导出的 JSON 设置。"
          label="从其他 AI 应用导入工作内容"
        >
          <input
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              void importSettings(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
            ref={importInput}
            type="file"
          />
          <Button
            onClick={() => importInput.current?.click()}
            size="sm"
            variant="secondary"
          >
            导入
          </Button>
        </PreferenceRow>
        <PreferenceRow
          description="查看 MelodyWork 使用的第三方开源依赖。"
          label="开源许可证"
        >
          <Button
            onClick={() =>
              setActionMessage(
                "开源依赖信息可在 package.json 与 pnpm-lock.yaml 中查看。",
              )
            }
            size="sm"
            variant="secondary"
          >
            查看
          </Button>
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title="编辑器">
        <PreferenceRow
          description="在输入区显示当前会话的上下文窗口使用情况。"
          label="显示上下文窗口使用情况"
        >
          <PreferenceSwitch
            label="显示上下文窗口使用情况"
            settingKey="showContextUsage"
          />
        </PreferenceRow>
        <PreferenceRow
          description="选择按 Enter 时发送消息还是插入新行。"
          label="发送快捷键"
        >
          <PreferenceSelect
            label="发送快捷键"
            options={[
              { value: "enter", label: "Enter" },
              { value: "mod-enter", label: "⌘ / Ctrl + Enter" },
            ]}
            settingKey="sendShortcut"
          />
        </PreferenceRow>
        <PreferenceRow
          description="代理运行时，将后续指令加入队列或引导当前运行。"
          label="跟进行为"
        >
          <PreferenceSelect
            label="跟进行为"
            options={[
              { value: "queue", label: "排队" },
              { value: "steer", label: "引导" },
            ]}
            settingKey="followUpBehavior"
          />
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title="弹出窗口">
        <PreferenceRow
          description="为弹出输入窗口设置全局快捷键；留空表示禁用。"
          label="弹出窗口快捷键"
        >
          <UnavailableControl />
        </PreferenceRow>
        <PreferenceRow
          description="无需选择项目即可开始新任务。"
          label="默认设为无项目任务"
        >
          <UnavailableControl />
        </PreferenceRow>
      </PreferenceGroup>

      <PreferenceGroup title="通知">
        <PreferenceRow
          description="设置代理完成回复时提醒你的时机。"
          label="轮次完成通知"
        >
          <CompletionNotificationPreference />
        </PreferenceRow>
        <PreferenceRow
          description="在需要授权时显示系统提醒。"
          label="启用权限通知"
        >
          <NotificationPreferenceSwitch settingKey="permissionNotifications" />
        </PreferenceRow>
        <PreferenceRow
          description="代理需要你回答问题时显示系统提醒。"
          label="启用问题通知"
        >
          <UnavailableControl />
        </PreferenceRow>
      </PreferenceGroup>

      {actionMessage ? (
        <p className="text-muted-foreground text-xs">{actionMessage}</p>
      ) : null}
    </div>
  );
}

function ThemePreview({
  label,
  mode,
}: {
  label: string;
  mode: AppSettings["theme"];
}) {
  const selected = useAppSettingsStore((state) => state.theme === mode);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <button
      aria-pressed={selected}
      className="group text-left"
      onClick={() => setSetting("theme", mode)}
      type="button"
    >
      <div
        className={cn(
          "relative h-28 overflow-hidden rounded-xl border-2 bg-[#f5f5f5] transition-colors",
          selected ? "border-foreground" : "border-border",
          mode === "dark" && "bg-[#575757]",
          mode === "system" &&
            "bg-[linear-gradient(90deg,#f5f5f5_50%,#575757_50%)]",
        )}
      >
        <div className="absolute inset-x-5 top-8 h-1.5 rounded-full bg-black/15" />
        <div className="absolute inset-x-3 top-12 bottom-0 rounded-t-xl bg-white shadow-sm">
          <div className="mx-3 mt-4 h-2 w-14 rounded-full bg-black/15" />
          <div className="mx-3 mt-2 h-px bg-black/5" />
          <div className="mx-3 mt-2 h-2 w-20 rounded-full bg-black/10" />
        </div>
        {mode === "system" ? (
          <div className="absolute inset-y-0 left-1/2 w-1/2 bg-black/55 mix-blend-multiply" />
        ) : null}
      </div>
      <p className="mt-1.5 text-center text-muted-foreground text-xs">
        {label}
      </p>
    </button>
  );
}

function ColorSetting({
  label,
  settingKey,
}: {
  label: string;
  settingKey:
    | "lightAccent"
    | "lightBackground"
    | "lightForeground"
    | "darkAccent"
    | "darkBackground"
    | "darkForeground";
}) {
  const value = useAppSettingsStore((state) => state[settingKey]);
  const setSetting = useAppSettingsStore((state) => state.setSetting);
  return (
    <PreferenceRow description="" label={label}>
      <label
        className="flex h-7 w-36 cursor-pointer items-center gap-2 rounded-lg border px-2 text-xs"
        style={{
          backgroundColor: value,
          color:
            settingKey.includes("Background") && value === "#ffffff"
              ? "#1a1c1f"
              : undefined,
        }}
      >
        <input
          aria-label={label}
          className="size-3 cursor-pointer appearance-none rounded-full border border-current/20"
          onChange={(event) => setSetting(settingKey, event.target.value)}
          type="color"
          value={value}
        />
        <span className="font-mono">{value.toUpperCase()}</span>
      </label>
    </PreferenceRow>
  );
}

function AppearanceThemeGroup({ dark }: { dark: boolean }) {
  const prefix = dark ? "dark" : "light";
  const uiFont = useAppSettingsStore((state) => state.uiFont);
  const codeFont = useAppSettingsStore((state) => state.codeFont);
  const setSetting = useAppSettingsStore((state) => state.setSetting);

  return (
    <PreferenceGroup title={dark ? "深色主题" : "浅色主题"}>
      <ColorSetting
        label="强调色"
        settingKey={`${prefix}Accent` as "lightAccent" | "darkAccent"}
      />
      <ColorSetting
        label="背景"
        settingKey={
          `${prefix}Background` as "lightBackground" | "darkBackground"
        }
      />
      <ColorSetting
        label="前景"
        settingKey={
          `${prefix}Foreground` as "lightForeground" | "darkForeground"
        }
      />
      <PreferenceRow description="" label="UI 字体">
        <Input
          aria-label="UI 字体"
          className="w-52"
          onChange={(event) => setSetting("uiFont", event.target.value)}
          value={uiFont}
        />
      </PreferenceRow>
      <PreferenceRow description="" label="代码字体">
        <Input
          aria-label="代码字体"
          className="w-52"
          onChange={(event) => setSetting("codeFont", event.target.value)}
          value={codeFont}
        />
      </PreferenceRow>
      <PreferenceRow description="" label="半透明侧边栏">
        <PreferenceSwitch
          label="半透明侧边栏"
          settingKey="translucentSidebar"
        />
      </PreferenceRow>
    </PreferenceGroup>
  );
}

function ApplicationAppearanceSettings() {
  const uiFontSize = useAppSettingsStore((state) => state.uiFontSize);
  const codeFontSize = useAppSettingsStore((state) => state.codeFontSize);
  const setSetting = useAppSettingsStore((state) => state.setSetting);

  return (
    <div className="flex flex-col gap-7">
      <section>
        <h4 className="mb-2 font-medium text-sm">主题</h4>
        <div className="grid grid-cols-3 gap-3">
          <ThemePreview label="系统" mode="system" />
          <ThemePreview label="浅色" mode="light" />
          <ThemePreview label="深色" mode="dark" />
        </div>
        <div className="mt-3 grid overflow-hidden rounded-xl border font-mono text-[11px] sm:grid-cols-2">
          <div className="min-w-0 border-b sm:border-r sm:border-b-0">
            <p className="h-5 px-3 leading-5 text-muted-foreground">
              1&nbsp; const themePreview = {"{"}
            </p>
            <p className="border-l-2 border-red-500 bg-red-500/10 px-3 py-0.5 text-red-700 dark:text-red-300">
              2&nbsp;&nbsp; surface: "sidebar",
            </p>
            <p className="border-l-2 border-red-500 bg-red-500/10 px-3 py-0.5 text-red-700 dark:text-red-300">
              3&nbsp;&nbsp; contrast: 42,
            </p>
          </div>
          <div className="min-w-0">
            <p className="h-5 px-3 leading-5 text-muted-foreground">
              1&nbsp; const themePreview = {"{"}
            </p>
            <p className="border-l-2 border-emerald-500 bg-emerald-500/10 px-3 py-0.5 text-emerald-700 dark:text-emerald-300">
              2&nbsp;&nbsp; surface: "sidebar-elevated",
            </p>
            <p className="border-l-2 border-emerald-500 bg-emerald-500/10 px-3 py-0.5 text-emerald-700 dark:text-emerald-300">
              3&nbsp;&nbsp; contrast: 68,
            </p>
          </div>
        </div>
      </section>

      <AppearanceThemeGroup dark={false} />
      <AppearanceThemeGroup dark />

      <PreferenceGroup title="偏好设置">
        <PreferenceRow
          description="悬停交互元素时切换为指针光标。"
          label="使用指针光标"
        >
          <PreferenceSwitch label="使用指针光标" settingKey="pointerCursor" />
        </PreferenceRow>
        <PreferenceRow
          description="减少动画效果或匹配系统辅助功能设置。"
          label="减少动态效果"
        >
          <PreferenceSelect
            label="减少动态效果"
            options={[
              { value: "system", label: "系统" },
              { value: "on", label: "开启" },
              { value: "off", label: "关闭" },
            ]}
            settingKey="reducedMotion"
          />
        </PreferenceRow>
        <PreferenceRow
          description="调整 MelodyWork 界面使用的基准字号。"
          label="UI 字号"
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="UI 字号"
              className="w-20"
              max={18}
              min={14}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) {
                  setSetting("uiFontSize", Math.min(18, Math.max(14, value)));
                }
              }}
              type="number"
              value={uiFontSize}
            />
            <span className="text-muted-foreground text-xs">px</span>
          </div>
        </PreferenceRow>
        <PreferenceRow
          description="调整任务活动和差异对比中代码的字号。"
          label="代码字体大小"
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="代码字体大小"
              className="w-20"
              max={18}
              min={10}
              onChange={(event) =>
                setSetting("codeFontSize", Number(event.target.value))
              }
              type="number"
              value={codeFontSize}
            />
            <span className="text-muted-foreground text-xs">px</span>
          </div>
        </PreferenceRow>
        <PreferenceRow
          description="使用颜色或加减号标记文件变更。"
          label="差异标记"
        >
          <UnavailableControl />
        </PreferenceRow>
        <PreferenceRow
          description="在 macOS 上使用原生字体抗锯齿。"
          label="字体平滑"
        >
          <PreferenceSwitch label="字体平滑" settingKey="fontSmoothing" />
        </PreferenceRow>
      </PreferenceGroup>
    </div>
  );
}

function objectEntries(values: ConfigValues, path: string[]) {
  const value = valueAt(values, path);
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

function configObject(value: MelodyConfigValue | undefined): ConfigObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function stringConfigValue(object: ConfigObject, key: string) {
  const value = object[key];
  return typeof value === "string" ? value : "";
}

function modelProviderLabel(model: ConfigObject) {
  const backend = stringConfigValue(model, "api_backend");
  const baseUrl = stringConfigValue(model, "base_url");
  if (backend === "messages" || baseUrl.includes("anthropic.com")) {
    return "Anthropic";
  }
  if (baseUrl.includes("api.openai.com")) {
    return "OpenAI";
  }
  return backend === "responses" ? "Responses API" : "OpenAI 兼容";
}

function DynamicSection({
  kind,
  values,
  onChange,
}: {
  kind: "models" | "mcp";
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  const root = kind === "models" ? ["model"] : ["mcp_servers"];
  const entries = objectEntries(values, root);
  const [draftName, setDraftName] = useState("");
  const add = () => {
    const name = draftName.trim();
    if (!name || entries.some(([current]) => current === name)) {
      return;
    }
    onChange(
      [...root, name],
      kind === "models"
        ? { model: name, api_backend: "chat_completions" }
        : { enabled: true, command: "" },
    );
    setDraftName("");
  };

  const definitions = (name: string): SettingDefinition[] =>
    kind === "models"
      ? [
          {
            path: [...root, name, "model"],
            label: "模型标识",
            description: "发送给模型提供商的实际模型名称。",
            kind: "string",
          },
          {
            path: [...root, name, "name"],
            label: "显示名称",
            description: "模型选择器中显示的名称。",
            kind: "string",
          },
          {
            path: [...root, name, "description"],
            label: "说明",
            description: "模型选择器中显示的简短说明。",
            kind: "string",
          },
          {
            path: [...root, name, "base_url"],
            label: "接口地址",
            description: "兼容 OpenAI、Responses 或 Messages 的 API 地址。",
            kind: "string",
          },
          {
            path: [...root, name, "api_backend"],
            label: "接口类型",
            description: "此模型使用的 API 协议。",
            kind: "select",
            defaultValue: "chat_completions",
            options: [
              { value: "chat_completions", label: "Chat Completions" },
              { value: "responses", label: "Responses" },
              { value: "messages", label: "Messages" },
            ],
          },
          {
            path: [...root, name, "api_key"],
            label: "API Key",
            description: "直接保存的密钥；优先建议使用环境变量。",
            kind: "string",
            secret: true,
          },
          {
            path: [...root, name, "env_key"],
            label: "密钥环境变量",
            description: "每行一个候选环境变量名。",
            kind: "string-list",
          },
          {
            path: [...root, name, "context_window"],
            label: "上下文窗口",
            description: "模型可接收的最大 Token 数。",
            kind: "number",
            min: 1,
          },
          {
            path: [...root, name, "max_completion_tokens"],
            label: "最大输出 Token",
            description: "此模型单次生成的最大 Token 数。",
            kind: "number",
            min: 1,
          },
          {
            path: [...root, name, "max_retries"],
            label: "最大重试次数",
            description: "此模型请求失败后的自动重试上限。",
            kind: "number",
            min: 0,
            step: 1,
          },
          {
            path: [...root, name, "inference_idle_timeout_secs"],
            label: "推理空闲超时",
            description: "此模型流式响应无新内容后等待的秒数。",
            kind: "number",
            min: 1,
            step: 1,
          },
          {
            path: [...root, name, "temperature"],
            label: "温度",
            description: "此模型专用的随机性设置。",
            kind: "number",
            min: 0,
            max: 2,
            step: 0.1,
          },
          {
            path: [...root, name, "top_p"],
            label: "Top P",
            description: "此模型专用的核采样设置。",
            kind: "number",
            min: 0,
            max: 1,
            step: 0.05,
          },
          {
            path: [...root, name, "stream_tool_calls"],
            label: "流式工具调用",
            description: "覆盖全局的流式工具调用设置。",
            kind: "boolean",
            defaultValue: true,
          },
          {
            path: [...root, name, "supports_backend_search"],
            label: "服务端搜索",
            description: "声明此模型支持提供商侧联网搜索。",
            kind: "boolean",
            defaultValue: false,
          },
          {
            path: [...root, name, "extra_headers"],
            label: "请求头",
            description: "每行填写“名称=值”，覆盖或补充全局请求头。",
            kind: "key-value",
          },
        ]
      : [
          {
            path: [...root, name, "enabled"],
            label: "启用服务器",
            description: "启动 Melody 时连接此 MCP 服务器。",
            kind: "boolean",
            defaultValue: true,
          },
          {
            path: [...root, name, "command"],
            label: "启动命令",
            description: "本地 stdio MCP 服务器的可执行命令。",
            kind: "string",
          },
          {
            path: [...root, name, "args"],
            label: "命令参数",
            description: "每行一个传给启动命令的参数。",
            kind: "string-list",
          },
          {
            path: [...root, name, "url"],
            label: "远程地址",
            description: "远程 MCP 服务器地址；与启动命令二选一。",
            kind: "string",
          },
          {
            path: [...root, name, "startup_timeout_sec"],
            label: "启动超时",
            description: "等待服务器就绪的秒数。",
            kind: "number",
            min: 1,
          },
          {
            path: [...root, name, "tool_timeout_sec"],
            label: "工具超时",
            description: "MCP 工具调用的默认超时秒数。",
            kind: "number",
            min: 1,
          },
          {
            path: [...root, name, "env"],
            label: "环境变量",
            description: "每行填写“名称=值”，传给本地 MCP 进程。",
            kind: "key-value",
          },
          {
            path: [...root, name, "headers"],
            label: "请求头",
            description: "每行填写“名称=值”，随远程 MCP 请求发送。",
            kind: "key-value",
          },
          {
            path: [...root, name, "tool_timeouts"],
            label: "单工具超时",
            description: "每行填写“工具名=秒数”。",
            kind: "key-value",
            numberValues: true,
          },
        ];

  return (
    <div>
      <div className="mb-4 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label
            className="mb-1.5 block font-medium text-xs"
            htmlFor={`${kind}-name`}
          >
            {kind === "models" ? "添加自定义模型" : "添加 MCP 服务器"}
          </label>
          <Input
            id={`${kind}-name`}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                add();
              }
            }}
            placeholder={
              kind === "models" ? "例如 fast-model" : "例如 filesystem"
            }
            value={draftName}
          />
        </div>
        <Button disabled={!draftName.trim()} onClick={add} variant="outline">
          <PlusIcon />
          添加
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {entries.map(([name]) => {
          const enabledValue =
            kind === "mcp"
              ? valueAt(values, [...root, name, "enabled"])
              : undefined;
          const enabled =
            typeof enabledValue === "boolean" ? enabledValue : true;
          return (
            <details
              className="group overflow-hidden rounded-xl border bg-card"
              key={name}
            >
              <summary className="flex h-11 cursor-pointer list-none items-center gap-2 px-4">
                <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                <span className="min-w-0 flex-1 truncate font-medium text-sm">
                  {name}
                </span>
                {kind === "mcp" ? (
                  <span
                    className="flex items-center"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    <Switch
                      aria-label={`${enabled ? "停用" : "启用"} MCP 服务器 ${name}`}
                      checked={enabled}
                      onCheckedChange={(checked) =>
                        onChange([...root, name, "enabled"], checked)
                      }
                    />
                  </span>
                ) : null}
                <Button
                  aria-label={`删除 ${name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onChange([...root, name], null);
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </summary>
              <div className="border-t">
                <SettingsList
                  onChange={onChange}
                  section={{
                    id: name,
                    label: name,
                    description: "",
                    icon: NetworkIcon,
                    settings: definitions(name),
                  }}
                  values={values}
                />
              </div>
            </details>
          );
        })}
        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed py-10 text-center text-muted-foreground text-sm">
            暂无{kind === "models" ? "自定义模型" : " MCP 服务器"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ModelOverrideField({
  definition,
  draft,
  globalValues,
  onChange,
}: {
  definition: (typeof inheritedModelFields)[number];
  draft: ConfigObject;
  globalValues: ConfigValues;
  onChange: (key: string, value: MelodyConfigValue | undefined) => void;
}) {
  const enabled = draft[definition.key] !== undefined;
  const inherited =
    valueAt(globalValues, ["models", definition.key]) ?? definition.fallback;
  const value = draft[definition.key];

  return (
    <div className="flex min-h-16 items-center gap-4 border-t px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm">{definition.label}</p>
          <Badge variant={enabled ? "secondary" : "outline"}>
            {enabled ? "单独设置" : `继承：${String(inherited)}`}
          </Badge>
        </div>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {definition.description}
        </p>
      </div>
      {enabled ? (
        <Input
          aria-label={definition.label}
          className="w-24"
          max={"max" in definition ? definition.max : undefined}
          min={definition.min}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) {
              onChange(definition.key, next);
            }
          }}
          step={definition.step}
          type="number"
          value={typeof value === "number" ? value : definition.fallback}
        />
      ) : null}
      <Switch
        aria-label={`${enabled ? "取消" : "启用"}${definition.label}单独设置`}
        checked={enabled}
        onCheckedChange={(checked) =>
          onChange(
            definition.key,
            checked && typeof inherited === "number"
              ? inherited
              : checked
                ? definition.fallback
                : undefined,
          )
        }
      />
    </div>
  );
}

function ModelEditorDialog({
  existingNames,
  globalValues,
  modelName,
  modelValue,
  onOpenChange,
  onSave,
  open,
}: {
  existingNames: string[];
  globalValues: ConfigValues;
  modelName?: string;
  modelValue?: MelodyConfigValue;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, value: ConfigObject) => void;
  open: boolean;
}) {
  const editing = Boolean(modelName);
  const [step, setStep] = useState<"provider" | "details">(
    editing ? "details" : "provider",
  );
  const [alias, setAlias] = useState(modelName ?? "");
  const [draft, setDraft] = useState<ConfigObject>(() =>
    configObject(modelValue),
  );
  const [authMode, setAuthMode] = useState<"environment" | "key">(() =>
    stringConfigValue(configObject(modelValue), "api_key")
      ? "key"
      : "environment",
  );

  const setField = (key: string, value: MelodyConfigValue | undefined) => {
    setDraft((current) => {
      const next = { ...current };
      if (
        value === undefined ||
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const chooseProvider = (template: (typeof providerTemplates)[number]) => {
    setDraft((current) => ({
      ...current,
      api_backend: template.backend,
      ...(template.baseUrl ? { base_url: template.baseUrl } : {}),
      ...(template.envKey ? { env_key: [template.envKey] } : {}),
    }));
    setAuthMode("environment");
    setStep("details");
  };

  const modelId = stringConfigValue(draft, "model");
  const baseUrl = stringConfigValue(draft, "base_url");
  const envKeys = Array.isArray(draft.env_key)
    ? draft.env_key
        .filter((item): item is string => typeof item === "string")
        .join(", ")
    : "";
  const nameConflict = !editing && existingNames.includes(alias.trim());

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `编辑 ${stringConfigValue(draft, "name") || modelName}`
              : step === "provider"
                ? "添加模型"
                : "配置模型"}
          </DialogTitle>
          <DialogDescription>
            {step === "provider"
              ? "选择接口类型，我们会预填常用连接参数。"
              : "先完成必要信息；其余参数可以继承全局默认值。"}
          </DialogDescription>
        </DialogHeader>

        {step === "provider" ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {providerTemplates.map((template) => (
              <button
                className="group rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/40"
                key={template.id}
                onClick={() => chooseProvider(template)}
                type="button"
              >
                <span className="mb-3 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:text-foreground">
                  <ServerIcon className="size-4" />
                </span>
                <span className="block font-medium text-sm">
                  {template.name}
                </span>
                <span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
                  {template.description}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="grid gap-5">
            <section>
              <h4 className="mb-2 font-medium text-sm">基础信息</h4>
              <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs">
                  <span className="font-medium">配置名称</span>
                  <Input
                    disabled={editing}
                    onChange={(event) => setAlias(event.target.value)}
                    placeholder="例如 gpt-work"
                    value={alias}
                  />
                  <span
                    className={
                      nameConflict
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    {nameConflict
                      ? "该配置名称已经存在。"
                      : "用于默认模型和代理路由。"}
                  </span>
                </label>
                <label className="grid gap-1.5 text-xs">
                  <span className="font-medium">显示名称</span>
                  <Input
                    onChange={(event) => setField("name", event.target.value)}
                    placeholder="例如 GPT 工作模型"
                    value={stringConfigValue(draft, "name")}
                  />
                </label>
                <label className="grid gap-1.5 text-xs sm:col-span-2">
                  <span className="font-medium">模型 ID</span>
                  <Input
                    onChange={(event) => setField("model", event.target.value)}
                    placeholder="例如 gpt-5.2"
                    value={modelId}
                  />
                  <span className="text-muted-foreground">
                    发送给模型提供商的实际模型名称。
                  </span>
                </label>
                <label className="grid gap-1.5 text-xs sm:col-span-2">
                  <span className="font-medium">说明</span>
                  <Input
                    onChange={(event) =>
                      setField("description", event.target.value)
                    }
                    placeholder="这个模型适合什么任务"
                    value={stringConfigValue(draft, "description")}
                  />
                </label>
              </div>
            </section>

            <section>
              <h4 className="mb-2 font-medium text-sm">连接与认证</h4>
              <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs sm:col-span-2">
                  <span className="font-medium">接口地址</span>
                  <Input
                    onChange={(event) =>
                      setField("base_url", event.target.value)
                    }
                    placeholder="https://api.example.com/v1"
                    value={baseUrl}
                  />
                </label>
                <label className="grid gap-1.5 text-xs">
                  <span className="font-medium">接口类型</span>
                  <Select
                    onValueChange={(value) => setField("api_backend", value)}
                    value={
                      stringConfigValue(draft, "api_backend") ||
                      "chat_completions"
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="chat_completions">
                        Chat Completions
                      </SelectItem>
                      <SelectItem value="responses">Responses</SelectItem>
                      <SelectItem value="messages">Messages</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-xs">
                  <span className="font-medium">认证方式</span>
                  <Select
                    onValueChange={(value) => {
                      const next = value as "environment" | "key";
                      setAuthMode(next);
                      if (next === "environment") {
                        setField("api_key", undefined);
                      } else {
                        setField("env_key", undefined);
                      }
                    }}
                    value={authMode}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="environment">环境变量</SelectItem>
                      <SelectItem value="key">直接填写 API Key</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                {authMode === "environment" ? (
                  <label className="grid gap-1.5 text-xs sm:col-span-2">
                    <span className="font-medium">密钥环境变量</span>
                    <Input
                      onChange={(event) =>
                        setField(
                          "env_key",
                          event.target.value
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        )
                      }
                      placeholder="OPENAI_API_KEY"
                      value={envKeys}
                    />
                  </label>
                ) : (
                  <label className="grid gap-1.5 text-xs sm:col-span-2">
                    <span className="flex items-center gap-1.5 font-medium">
                      <KeyRoundIcon className="size-3.5" />
                      API Key
                    </span>
                    <Input
                      autoComplete="off"
                      onChange={(event) =>
                        setField("api_key", event.target.value)
                      }
                      placeholder="输入密钥"
                      type="password"
                      value={stringConfigValue(draft, "api_key")}
                    />
                    <span className="text-muted-foreground">
                      推荐使用环境变量，避免把密钥写入配置文件。
                    </span>
                  </label>
                )}
              </div>
            </section>

            <details className="group overflow-hidden rounded-xl border bg-card">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3">
                <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">高级设置</p>
                  <p className="text-muted-foreground text-xs">
                    上下文能力和单模型生成参数覆盖
                  </p>
                </div>
              </summary>
              <div className="border-t">
                <div className="grid gap-4 p-4 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-xs">
                    <span className="font-medium">上下文窗口</span>
                    <Input
                      min={1}
                      onChange={(event) =>
                        setField(
                          "context_window",
                          event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        )
                      }
                      placeholder="由提供商决定"
                      type="number"
                      value={
                        typeof draft.context_window === "number"
                          ? draft.context_window
                          : ""
                      }
                    />
                  </label>
                  <label className="flex items-center justify-between gap-4 rounded-lg bg-muted/40 px-3 py-2">
                    <span>
                      <span className="block font-medium text-xs">
                        服务端搜索
                      </span>
                      <span className="text-muted-foreground text-xs">
                        声明模型支持提供商侧搜索
                      </span>
                    </span>
                    <Switch
                      checked={draft.supports_backend_search === true}
                      onCheckedChange={(checked) =>
                        setField("supports_backend_search", checked)
                      }
                    />
                  </label>
                </div>
                <div className="border-t">
                  {inheritedModelFields.map((definition) => (
                    <ModelOverrideField
                      definition={definition}
                      draft={draft}
                      globalValues={globalValues}
                      key={definition.key}
                      onChange={setField}
                    />
                  ))}
                  <div className="flex min-h-16 items-center gap-4 border-t px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm">流式工具调用</p>
                        <Badge
                          variant={
                            draft.stream_tool_calls === undefined
                              ? "outline"
                              : "secondary"
                          }
                        >
                          {draft.stream_tool_calls === undefined
                            ? `继承：${String(valueAt(globalValues, ["models", "stream_tool_calls"]) ?? true)}`
                            : "单独设置"}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-muted-foreground text-xs">
                        在模型输出结束前解析工具调用。
                      </p>
                    </div>
                    {draft.stream_tool_calls !== undefined ? (
                      <>
                        <Switch
                          aria-label="流式工具调用"
                          checked={draft.stream_tool_calls === true}
                          onCheckedChange={(checked) =>
                            setField("stream_tool_calls", checked)
                          }
                        />
                        <Button
                          onClick={() =>
                            setField("stream_tool_calls", undefined)
                          }
                          size="sm"
                          variant="ghost"
                        >
                          恢复继承
                        </Button>
                      </>
                    ) : (
                      <Button
                        onClick={() =>
                          setField(
                            "stream_tool_calls",
                            valueAt(globalValues, [
                              "models",
                              "stream_tool_calls",
                            ]) ?? true,
                          )
                        }
                        size="sm"
                        variant="outline"
                      >
                        单独设置
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </details>
          </div>
        )}

        <DialogFooter>
          {step === "details" ? (
            <>
              <Button onClick={() => onOpenChange(false)} variant="outline">
                取消
              </Button>
              <Button
                disabled={!alias.trim() || !modelId.trim() || nameConflict}
                onClick={() => {
                  onSave(alias.trim(), draft);
                  onOpenChange(false);
                }}
              >
                <CheckIcon />
                {editing ? "保存更改" : "添加模型"}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)} variant="outline">
              取消
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomModelManager({
  values,
  onChange,
}: {
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  const entries = objectEntries(values, ["model"]);
  const currentDefault = valueAt(values, ["models", "default"]);
  const [editingModel, setEditingModel] = useState<string | null>();
  const [pendingDelete, setPendingDelete] = useState<string>();

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h4 className="font-medium text-sm">自定义模型</h4>
          <p className="mt-0.5 text-muted-foreground text-xs">
            管理第三方提供商、自托管模型和模型专用参数。
          </p>
        </div>
        <Button onClick={() => setEditingModel(null)} size="sm">
          <PlusIcon />
          添加模型
        </Button>
      </div>

      {entries.length > 0 ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          {entries.map(([name, value], index) => {
            const model = configObject(value);
            const displayName = stringConfigValue(model, "name") || name;
            const modelId = stringConfigValue(model, "model") || name;
            const baseUrl = stringConfigValue(model, "base_url");
            const isDefault = currentDefault === name;
            return (
              <div
                className={cn(
                  "flex items-center gap-3 px-4 py-3",
                  index > 0 && "border-t",
                )}
                key={name}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <BotIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate font-medium text-sm">
                      {displayName}
                    </p>
                    {isDefault ? <Badge>默认</Badge> : null}
                    <Badge variant="outline">{modelProviderLabel(model)}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-muted-foreground text-xs">
                    {modelId}
                    {baseUrl
                      ? ` · ${baseUrl.replace(/^https?:\/\//, "")}`
                      : " · 使用默认接口"}
                  </p>
                </div>
                {!isDefault ? (
                  <Button
                    onClick={() => onChange(["models", "default"], name)}
                    size="sm"
                    variant="ghost"
                  >
                    设为默认
                  </Button>
                ) : null}
                <Button
                  onClick={() => setEditingModel(name)}
                  size="sm"
                  variant="outline"
                >
                  编辑
                </Button>
                <Button
                  aria-label={`删除 ${displayName}`}
                  onClick={() => setPendingDelete(name)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed px-6 py-10 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <ServerIcon className="size-4" />
          </span>
          <p className="mt-3 font-medium text-sm">还没有自定义模型</p>
          <p className="mt-1 text-muted-foreground text-xs">
            添加模型提供商或连接自己的兼容接口。
          </p>
        </div>
      )}

      {editingModel !== undefined ? (
        <ModelEditorDialog
          existingNames={entries.map(([name]) => name)}
          globalValues={values}
          key={editingModel ?? "new"}
          modelName={editingModel ?? undefined}
          modelValue={
            editingModel ? valueAt(values, ["model", editingModel]) : undefined
          }
          onOpenChange={(open) => {
            if (!open) {
              setEditingModel(undefined);
            }
          }}
          onSave={(name, model) => onChange(["model", name], model)}
          open
        />
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(undefined);
          }
        }}
        open={Boolean(pendingDelete)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除模型配置？</DialogTitle>
            <DialogDescription>
              这会从 Melody 配置中删除“{pendingDelete}
              ”。该操作不会删除提供商上的模型。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setPendingDelete(undefined)}
              variant="outline"
            >
              取消
            </Button>
            <Button
              onClick={() => {
                if (pendingDelete) {
                  onChange(["model", pendingDelete], null);
                  if (currentDefault === pendingDelete) {
                    onChange(["models", "default"], null);
                  }
                }
                setPendingDelete(undefined);
              }}
              variant="destructive"
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModelSettings({
  availableModels,
  section,
  values,
  onChange,
}: {
  availableModels: AgentModelOption[];
  section: SettingSection;
  values: ConfigValues;
  onChange: ConfigurationFormProps["onChange"];
}) {
  const configuredModels = objectEntries(values, ["model"]).map(
    ([name]) => name,
  );
  const currentDefault = valueAt(values, ["models", "default"]);
  const modelOptions = new Map(
    availableModels.map((model) => [
      model.id,
      model.name === model.id ? model.id : `${model.name} (${model.id})`,
    ]),
  );
  for (const name of configuredModels) {
    if (!modelOptions.has(name)) {
      modelOptions.set(name, name);
    }
  }
  if (typeof currentDefault === "string" && !modelOptions.has(currentDefault)) {
    modelOptions.set(currentDefault, `${currentDefault}（当前配置）`);
  }
  const inheritValue = "__melody_inherit_default__";
  const defaultSettings = section.settings.map((definition) =>
    definition.path[0] === "models" && definition.path[1] === "default"
      ? {
          ...definition,
          kind: "select" as const,
          clearValue: inheritValue,
          options: [
            { label: "跟随 Melody 默认值", value: inheritValue },
            ...Array.from(modelOptions, ([value, label]) => ({
              label,
              value,
            })),
          ],
        }
      : definition,
  );

  return (
    <div className="grid gap-7">
      <section>
        <h4 className="font-medium text-sm">默认值与生成行为</h4>
        <p className="mt-0.5 mb-2 text-muted-foreground text-xs">
          应用于新会话；自定义模型中的同名参数可以单独覆盖这些值。
        </p>
        <SettingsList
          onChange={onChange}
          section={{ ...section, settings: defaultSettings }}
          values={values}
        />
      </section>
      <CustomModelManager onChange={onChange} values={values} />
    </div>
  );
}

const configurationSections = (scope: MelodyConfigScope): SettingSection[] =>
  scope === "project"
    ? [
        {
          id: "mcp",
          label: "MCP",
          description: "仅为当前项目提供的工具服务器。",
          icon: NetworkIcon,
          settings: [],
        },
      ]
    : [
        {
          id: "general",
          label: "常规",
          description: "应用权限、编辑器、窗口与通知偏好。",
          icon: Settings2Icon,
          settings: [],
        },
        {
          id: "appearance",
          label: "外观",
          description: "主题、颜色、字体和视觉偏好。",
          icon: MonitorIcon,
          settings: [],
        },
        ...userSections.slice(0, 7),
        {
          id: "mcp",
          label: "MCP",
          description: "连接本地或远程工具服务器。",
          icon: NetworkIcon,
          settings: [],
        },
        ...userSections.slice(7),
      ];

export const getConfigurationNavigation = (
  scope: MelodyConfigScope,
): ConfigurationNavigationItem[] =>
  configurationSections(scope).map(({ id, label, icon }) => ({
    id,
    label,
    icon,
  }));

export function ConfigurationForm({
  availableModels,
  sectionId,
  scope,
  values,
  onChange,
}: ConfigurationFormProps) {
  const sections = configurationSections(scope);
  const active =
    sections.find((section) => section.id === sectionId) ?? sections[0];

  if (!active) {
    return null;
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-3xl">
        <h3 className="font-semibold text-lg">{active.label}</h3>
        <p className="mt-1 text-muted-foreground text-sm">
          {active.description}
        </p>
        <div className="mt-5">
          {active.id === "general" ? (
            <ApplicationGeneralSettings />
          ) : active.id === "appearance" ? (
            <ApplicationAppearanceSettings />
          ) : active.id === "models" ? (
            <ModelSettings
              availableModels={availableModels}
              onChange={onChange}
              section={active}
              values={values}
            />
          ) : active.id === "mcp" ? (
            <DynamicSection kind="mcp" onChange={onChange} values={values} />
          ) : active.id === "compatibility" ? (
            <CompatibilitySettings
              onChange={onChange}
              section={active}
              values={values}
            />
          ) : (
            <SettingsList
              onChange={onChange}
              section={active}
              values={values}
            />
          )}
        </div>
        <p className="mt-4 text-muted-foreground text-xs leading-relaxed">
          未在此界面中展示的配置项、注释和文件排版会在保存时保留。
        </p>
      </div>
    </div>
  );
}
