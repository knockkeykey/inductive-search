import browser from "webextension-polyfill";
import { defaultSettings, isBuiltin, originOf, PROVIDERS, type Provider, type Settings } from "./api";

export type { Settings } from "./api";

interface Profile {
  apiKey: string;
  model: string;
  baseURL?: string;
}

interface StoredSettings extends Partial<Settings> {
  profiles?: Partial<Record<Provider, Profile>>;
}

const KNOWN: readonly Provider[] = ["typesafe", "openrouter", "custom"];

async function readSettings(): Promise<StoredSettings> {
  const stored = (await browser.storage.local.get("settings")) as { settings?: StoredSettings };
  return stored.settings ?? {};
}

function profileFor(stored: StoredSettings, provider: Provider): Settings {
  // Keep existing official keys on TypeSafe when upgrading from the original extension.
  const legacy = provider === "typesafe" && !stored.profiles ? stored : {};
  const credentials: Partial<Profile> = stored.profiles?.[provider] ?? legacy;
  const settings: Settings = {
    provider,
    apiKey: credentials.apiKey ?? "",
    model: credentials.model || defaultSettings(provider).model,
  };
  if (!isBuiltin(provider)) settings.baseURL = credentials.baseURL ?? "";
  return settings;
}

export async function loadSettings(provider?: Provider): Promise<Settings> {
  const stored = await readSettings();
  const activeProvider = stored.provider && KNOWN.includes(stored.provider) ? stored.provider : "typesafe";
  return profileFor(stored, provider ?? activeProvider);
}

export async function saveSettings(s: Settings): Promise<void> {
  const stored = await readSettings();
  const profiles = stored.profiles ?? { typesafe: profileFor(stored, "typesafe") };
  const profile: Profile = { apiKey: s.apiKey, model: s.model };
  if (!isBuiltin(s.provider)) profile.baseURL = s.baseURL ?? "";
  await browser.storage.local.set({
    settings: { provider: s.provider, profiles: { ...profiles, [s.provider]: profile } },
  });
}

const apiOrigin = (settings: Settings) => {
  const origin = originOf(settings);
  return origin ? { origins: [origin] } : undefined;
};
export const hasApiAccess = async (settings: Settings) => {
  const origins = apiOrigin(settings);
  return origins ? browser.permissions.contains(origins) : false;
};
// Must be the first await after a click: browsers only grant permissions during a user gesture.
export const requestApiAccess = (settings: Settings) => {
  const origins = apiOrigin(settings);
  return origins ? browser.permissions.request(origins) : Promise.resolve(false);
};

// Gives back access to a relay the user moved away from. The built-in hosts stay granted.
export async function releaseApiAccess(previous: Settings, next: Settings): Promise<void> {
  const old = originOf(previous);
  const builtin = Object.values(PROVIDERS).map((p) => p.origin as string);
  if (isBuiltin(previous.provider) || !old || old === originOf(next) || builtin.includes(old)) return;
  await browser.permissions.remove({ origins: [old] }).catch(() => false);
}
