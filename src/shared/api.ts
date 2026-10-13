import { TypeSafeClient } from "@typesafe-ai/sdk";

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
      { name: "jev-1.13.0", description: "Jev 1.13.0 (System One)" },
      { name: "jev-1.13.0:stable", description: "Stable route from the model page example" },
    ];
  }

  // OpenRouter returns { data: [...] }; the TypeSafe SDK expects { models: [...] }.
  const response = await fetch(`${PROVIDERS.openrouter.baseURL}/v1/models`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter model listing failed (HTTP ${response.status}).`);
  const body = (await response.json()) as { data?: { id: string; name?: string }[] };
  if (!Array.isArray(body.data)) throw new Error("Unexpected OpenRouter model list response.");
  const models = body.data
    // Jev Router is a chat-model router, not a System One decision model.
    .filter((m) => typeof m.id === "string" && /^typesafe\/jev-(?:\d|latest)/.test(m.id))
    .map((m) => ({ name: m.id, description: m.name ?? "" }));
  // The public catalog currently omits System One models. Keep documented choices available.
  const choices = new Map<string, ModelChoice>([
    [PROVIDERS.openrouter.defaultModel, { name: PROVIDERS.openrouter.defaultModel, description: "Latest Jev" }],
    ["typesafe/jev-1.13", { name: "typesafe/jev-1.13", description: "Jev 1.13" }],
  ]);
  for (const model of models) choices.set(model.name, model);
  return [...choices.values()];
}
