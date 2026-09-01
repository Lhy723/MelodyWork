import type { ConfigObject } from "./configuration-types";
import { stringConfigValue } from "./configuration-utils";

export function modelProviderLabel(model: ConfigObject) {
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

export const providerTemplates = [
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

export const inheritedModelFields = [
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
