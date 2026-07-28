import type { AgentModelOption } from "@/domain/acp";

export interface ModelProvider {
  id: string;
  name: string;
}

const providerRules: {
  id: string;
  name: string;
  tokens: string[];
}[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    tokens: ["openrouter"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    tokens: ["deepseek"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    tokens: ["anthropic", "claude"],
  },
  {
    id: "openai",
    name: "OpenAI",
    tokens: ["openai", "chatgpt", "gpt-", "o1", "o3", "o4"],
  },
  {
    id: "google",
    name: "Google",
    tokens: ["google", "gemini"],
  },
  {
    id: "moonshotai",
    name: "Moonshot AI",
    tokens: ["moonshot", "kimi"],
  },
  {
    id: "alibaba",
    name: "Alibaba",
    tokens: ["alibaba", "qwen"],
  },
  {
    id: "xai",
    name: "xAI",
    tokens: ["xai", "grok"],
  },
  {
    id: "mistral",
    name: "Mistral",
    tokens: ["mistral", "codestral"],
  },
  {
    id: "groq",
    name: "Groq",
    tokens: ["groq"],
  },
  {
    id: "zhipuai",
    name: "智谱 AI",
    tokens: ["zhipu", "glm-"],
  },
  {
    id: "llama",
    name: "Meta",
    tokens: ["meta", "llama"],
  },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    tokens: ["bedrock"],
  },
  {
    id: "azure",
    name: "Azure",
    tokens: ["azure"],
  },
];

const fallbackProvider: ModelProvider = {
  id: "submodel",
  name: "其他模型",
};

export const modelProvider = (
  model: Pick<AgentModelOption, "id" | "name">,
): ModelProvider => {
  const searchable = `${model.id} ${model.name}`.toLowerCase();
  const provider = providerRules.find((rule) =>
    rule.tokens.some((token) => searchable.includes(token)),
  );
  return provider
    ? { id: provider.id, name: provider.name }
    : fallbackProvider;
};

export const groupModelsByProvider = (models: AgentModelOption[]) => {
  const groups = new Map<
    string,
    { provider: ModelProvider; models: AgentModelOption[] }
  >();
  for (const model of models) {
    const provider = modelProvider(model);
    const group = groups.get(provider.id);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(provider.id, { provider, models: [model] });
    }
  }
  return [...groups.values()];
};
