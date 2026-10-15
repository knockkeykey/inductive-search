import { APIConnectionError, APIError, APITimeoutError, TypeSafeClient } from "@typesafe-ai/sdk";

export type Provider = "typesafe" | "openrouter" | "openlux";

export const PROVIDERS = {
  typesafe: {
    name: "TypeSafe",
    baseURL: "https://api.typesafe.ai",
    origin: "https://api.typesafe.ai/*",
    defaultModel: "jev-latest",
    keyURL: "https://console.typesafe.ai/keys",
    keyPlaceholder: "apikey_…",
  },
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api",
    origin: "https://openrouter.ai/*",
    defaultModel: "~typesafe/jev-latest",
    keyURL: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-v1-…",
  },
  openlux: {
    name: "OpenLux",
    baseURL: "https://api.openlux.ai",
    origin: "https://api.openlux.ai/*",
    defaultModel: "jev-1.13.0",
    keyURL: "https://www.openlux.ai/login",
    keyPlaceholder: "sk-…",
  },
} as const;

export interface ModelChoice {
  name: string;
  description: string;
}

export interface Settings {
  provider: Provider;
  apiKey: string;
  model: string;
}

export function defaultSettings(provider: Provider = "typesafe"): Settings {
  return { provider, apiKey: "", model: PROVIDERS[provider].defaultModel };
}

const STATUS_HINTS: Record<number, string> = {
  400: "请求被拒绝",
  401: "API 密钥无效或已过期",
  402: "账户余额或额度不足",
  403: "无权访问该模型",
  404: "模型或接口不存在，请检查模型名称",
  408: "服务商处理超时",
  413: "单批文字过长",
  422: "请求参数校验失败",
  429: "请求过于频繁或额度用尽",
};

// The provider's own words, plus status and request id, so a failure can be reported upstream as is.
export function describeError(error: unknown, provider: Provider): string {
  const name = PROVIDERS[provider].name;
  if (error instanceof APIError) {
    const hint = STATUS_HINTS[error.status] ?? (error.status >= 500 ? "服务商内部错误" : "请求失败");
    const id = error.requestId ? `（请求 ID：${error.requestId}）` : "";
    return `${name} 返回 HTTP ${error.status}：${hint}。原始信息：${error.message.replace(/^\d{3}\s+/, "")}${id}`;
  }
  if (error instanceof APITimeoutError) return `${name} 在 ${error.timeoutMs / 1000} 秒内没有返回结果（请求超时）。`;
  if (error instanceof APIConnectionError) return `无法连接 ${name}：${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function createClient(settings: Settings): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: settings.apiKey,
    baseURL: PROVIDERS[settings.provider].baseURL,
    defaultModel: settings.model,
    dangerouslyAllowBrowser: true,
    timeout: 15_000,
    retry: { maxRetries: 5, backoffInitialMs: 400, backoffMaxMs: 4_000 },
  });
}

export async function listModels(settings: Settings): Promise<ModelChoice[]> {
  if (settings.provider === "typesafe") return createClient(settings).models.list();
  if (settings.provider === "openlux") {
    // The dedicated System One docs pin the bare version; the site's generic example adds :stable.
    return [
      { name: "jev-1.13.0", description: "Jev 1.13.0（System One）" },
      { name: "jev-1.13.0:stable", description: "模型页面示例中的稳定路由" },
    ];
  }

  // OpenRouter returns { data: [...] }; the TypeSafe SDK expects { models: [...] }.
  const response = await fetch(`${PROVIDERS.openrouter.baseURL}/v1/models`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter 模型列表加载失败（HTTP ${response.status}）。`);
  const body = (await response.json()) as { data?: { id: string; name?: string }[] };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter 返回了无法识别的模型列表。");
  const models = body.data
    // Jev Router is a chat-model router, not a System One decision model.
    .filter((m) => typeof m.id === "string" && /^typesafe\/jev-(?:\d|latest)/.test(m.id))
    .map((m) => ({ name: m.id, description: m.name ?? "" }));
  // The public catalog currently omits System One models. Keep documented choices available.
  const choices = new Map<string, ModelChoice>([
    [PROVIDERS.openrouter.defaultModel, { name: PROVIDERS.openrouter.defaultModel, description: "最新 Jev" }],
    ["typesafe/jev-1.13", { name: "typesafe/jev-1.13", description: "Jev 1.13" }],
  ]);
  for (const model of models) choices.set(model.name, model);
  return [...choices.values()];
}
