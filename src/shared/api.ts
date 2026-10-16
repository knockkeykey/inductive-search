import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  type NoulResponse,
  noul,
  TypeSafeClient,
} from "@typesafe-ai/sdk";

export type Provider = "typesafe" | "openrouter" | "custom";
export type BuiltinProvider = Exclude<Provider, "custom">;

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
} as const;

// A relay the user points at themselves. It must serve Jev's System One API under {baseURL}/v1.
// Relays name their models differently, so there is no default model: the user picks or types one.
export const CUSTOM = {
  name: "自定义中转站",
  defaultModel: "",
  keyPlaceholder: "sk-…",
} as const;

export const isBuiltin = (provider: Provider): provider is BuiltinProvider => provider !== "custom";

export interface ModelChoice {
  name: string;
  description: string;
}

export interface Settings {
  provider: Provider;
  apiKey: string;
  model: string;
  // Only for the custom relay: its root address, normalized by normalizeBaseURL.
  baseURL?: string;
}

export function defaultSettings(provider: Provider = "typesafe"): Settings {
  if (!isBuiltin(provider)) return { provider, apiKey: "", model: CUSTOM.defaultModel, baseURL: "" };
  return { provider, apiKey: "", model: PROVIDERS[provider].defaultModel };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The relay's root address: https only (plain http just for local testing), without the
// trailing /v1 or slash that people copy from relay docs. Throws a message for the user.
export function normalizeBaseURL(input: string): string {
  const text = input.trim();
  if (!text) throw new Error("请填写中转站地址。");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("中转站地址无效，请填写完整地址，例如 https://api.example.com。");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error("中转站地址必须以 https:// 开头（仅本机地址可用 http://）。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("中转站地址不能包含账号、查询参数或 # 片段。");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1(?:\/systemone)?$/, "");
  return `${url.origin}${path}`;
}

export function baseURLOf(settings: Settings): string {
  return isBuiltin(settings.provider) ? PROVIDERS[settings.provider].baseURL : (settings.baseURL ?? "");
}

// The relay is named after its host, so errors say where the request actually went.
export function providerName(settings: Settings): string {
  if (isBuiltin(settings.provider)) return PROVIDERS[settings.provider].name;
  try {
    return new URL(settings.baseURL ?? "").host;
  } catch {
    return CUSTOM.name;
  }
}

// Host permission pattern for the provider; undefined while the relay address is missing or invalid.
export function originOf(settings: Settings): string | undefined {
  if (isBuiltin(settings.provider)) return PROVIDERS[settings.provider].origin;
  try {
    return `${new URL(settings.baseURL ?? "").origin}/*`;
  } catch {
    return undefined;
  }
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
export function describeError(error: unknown, settings: Settings): string {
  const name = providerName(settings);
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
    baseURL: baseURLOf(settings),
    defaultModel: settings.model,
    dangerouslyAllowBrowser: true,
    timeout: 15_000,
    retry: { maxRetries: 5, backoffInitialMs: 400, backoffMaxMs: 4_000 },
  });
}

export interface ConnectionResult {
  model: string;
  ms: number;
}

// One tiny System One request with fixed sample text, never page content: it proves the address,
// key and model work together. Each test is a real request and may be billed by the provider.
export async function testConnection(settings: Settings, signal?: AbortSignal): Promise<ConnectionResult> {
  const started = performance.now();
  let answer: unknown;
  let model = settings.model;
  try {
    const result = await createClient(settings).systemOne(
      {
        state: { url: "about:blank", title: "连接测试", page_text: "B000| 这是一段用于测试连接的示例文字。" },
        questions: {
          B000: noul("Is block `B000` a sample sentence used to test the connection?", {
            true: "It is a sample sentence",
            false: "It is not",
          }),
        },
      },
      { signal, retry: { maxRetries: 0 } },
    );
    answer = (result.answers as Record<string, NoulResponse> | undefined)?.B000;
    model = result.model || model;
  } catch (error) {
    throw new Error(describeError(error, settings));
  }
  const a = answer as NoulResponse | undefined;
  if (a?.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul)) {
    throw new Error(
      `${providerName(settings)} 有响应，但返回的不是 Jev System One 的结果。请确认它支持 /v1/systemone。`,
    );
  }
  return { model, ms: Math.round(performance.now() - started) };
}

export async function listModels(settings: Settings): Promise<ModelChoice[]> {
  if (settings.provider === "typesafe") return createClient(settings).models.list();
  if (settings.provider === "custom") return listRelayModels(settings);

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

// Relays answer in either TypeSafe's { models } or the OpenAI-style { data } shape. Only Jev
// models are offered; a relay without a list still works with a typed-in model name.
async function listRelayModels(settings: Settings): Promise<ModelChoice[]> {
  const name = providerName(settings);
  const response = await fetch(`${baseURLOf(settings)}/v1/models`, {
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${name} 模型列表加载失败（HTTP ${response.status}）。`);
  const body = (await response.json()) as {
    models?: { name?: string; description?: string }[];
    data?: { id?: string; name?: string }[];
  };
  const listed = Array.isArray(body.models)
    ? body.models.map((m) => ({ name: m.name, description: m.description ?? "" }))
    : Array.isArray(body.data)
      ? body.data.map((m) => ({ name: m.id, description: m.name ?? "" }))
      : undefined;
  if (!listed) throw new Error(`${name} 返回了无法识别的模型列表。`);
  const models = listed.filter(
    (m): m is ModelChoice => typeof m.name === "string" && /(?:^|\/)jev-(?:\d|latest)/.test(m.name),
  );
  if (!models.length) throw new Error(`${name} 的模型列表里没有 Jev 模型。`);
  return models;
}
