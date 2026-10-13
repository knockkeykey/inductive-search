import browser from "webextension-polyfill";
import { defaultSettings, PROVIDERS, type Provider, type Settings } from "./api";

export type { Settings } from "./api";

interface StoredSettings extends Partial<Settings> {
  profiles?: Partial<Record<Provider, { apiKey: string; model: string }>>;
}

async function readSettings(): Promise<StoredSettings> {
  const stored = (await browser.storage.local.get("settings")) as { settings?: StoredSettings };
  return stored.settings ?? {};
}

function profileFor(stored: StoredSettings, provider: Provider): Settings {
  // Keep existing official keys on TypeSafe when upgrading from the original extension.
  const legacy = provider === "typesafe" && !stored.profiles ? stored : {};
  const credentials = stored.profiles?.[provider] ?? legacy;
  return {
    provider,
    apiKey: credentials.apiKey ?? "",
    model: credentials.model || defaultSettings(provider).model,
  };
}

export async function loadSettings(provider?: Provider): Promise<Settings> {
  const stored = await readSettings();
  const activeProvider =
    stored.provider === "openrouter" || stored.provider === "openlux" ? stored.provider : "typesafe";
  return profileFor(stored, provider ?? activeProvider);
}

export async function saveSettings(s: Settings): Promise<void> {
  const stored = await readSettings();
  const profiles = stored.profiles ?? { typesafe: profileFor(stored, "typesafe") };
  await browser.storage.local.set({
    settings: { provider: s.provider, profiles: { ...profiles, [s.provider]: { apiKey: s.apiKey, model: s.model } } },
  });
}

export const apiOrigin = (provider: Provider) => ({ origins: [PROVIDERS[provider].origin] });
export const hasApiAccess = (provider: Provider) => browser.permissions.contains(apiOrigin(provider));
export const requestApiAccess = (provider: Provider) => browser.permissions.request(apiOrigin(provider));
