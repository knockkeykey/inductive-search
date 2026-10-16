import browser from "webextension-polyfill";
import {
  CUSTOM,
  defaultSettings,
  isBuiltin,
  listModels,
  type ModelChoice,
  normalizeBaseURL,
  PROVIDERS,
  type Provider,
  providerName,
  type Settings,
  testConnection,
} from "./shared/api";
import { loadSettings, releaseApiAccess, requestApiAccess, saveSettings } from "./shared/settings";
import {
  canRebindShortcut,
  commandShortcutFromEvent,
  openShortcutsPage,
  resetShortcut,
  runningIn,
  SHORTCUTS_PAGE,
  setShortcut,
  shortcutLabel,
} from "./shared/shortcut";

const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const apiKey = field<HTMLInputElement>("apiKey");
const provider = field<HTMLSelectElement>("provider");
const keyLabel = field("keyLabel");
const keyLink = field<HTMLAnchorElement>("keyLink");
const keyHint = field("keyHint");
const baseURL = field<HTMLInputElement>("baseURL");
const baseURLRow = field("baseURLRow");
const model = field<HTMLSelectElement>("model");
// The relay's model: picked from its list when it reports one, otherwise typed in.
const customModel = field<HTMLInputElement>("customModel");
const MANUAL = "\u0000manual";
let relayListed = false;
const modelNote = field("modelNote");
const banner = field("nokey");
const saved = field("saved");
const saveButton = field<HTMLButtonElement>("save");
const testButton = field<HTMLButtonElement>("test");
const drafts: Record<Provider, Settings> = {
  typesafe: defaultSettings("typesafe"),
  openrouter: defaultSettings("openrouter"),
  custom: defaultSettings("custom"),
};
// What the custom relay was saved with, so a changed address can give up the old host's access.
let savedCustom = defaultSettings("custom");
let activeProvider: Provider = "typesafe";
let modelRevision = 0;

function currentSettings(): Settings {
  const key = apiKey.value.trim();
  if (isBuiltin(activeProvider)) {
    return { provider: activeProvider, apiKey: key, model: model.value || drafts[activeProvider].model };
  }
  const picked = relayListed && model.value !== MANUAL ? model.value : customModel.value;
  return { provider: activeProvider, apiKey: key, model: picked.trim(), baseURL: baseURL.value.trim() };
}

function showProvider(s: Settings) {
  activeProvider = s.provider;
  provider.value = s.provider;
  const builtin = isBuiltin(s.provider);
  baseURLRow.hidden = builtin;
  relayListed = false;
  model.hidden = !builtin;
  customModel.hidden = builtin;
  keyHint.hidden = !builtin;
  apiKey.value = s.apiKey;
  modelNote.textContent = "";
  if (isBuiltin(s.provider)) {
    const config = PROVIDERS[s.provider];
    keyLabel.textContent = `${config.name} API 密钥`;
    keyLink.href = config.keyURL;
    keyLink.textContent = `${config.name} 密钥`;
    apiKey.placeholder = config.keyPlaceholder;
    // Set a usable selection immediately, including when model discovery is offline.
    model.replaceChildren(new Option(s.model, s.model, true, true));
  } else {
    keyLabel.textContent = "中转站 API 密钥";
    apiKey.placeholder = CUSTOM.keyPlaceholder;
    baseURL.value = s.baseURL ?? "";
    customModel.value = s.model;
  }
  showKeyBanner(Boolean(s.apiKey));
  void loadModels(s);
}

provider.addEventListener("change", () => {
  drafts[activeProvider] = currentSettings();
  showProvider(drafts[provider.value as Provider]);
  saved.textContent = "保存后即可使用此服务商。";
});

function showKeyBanner(hasKey: boolean) {
  banner.style.display = hasKey ? "none" : "block";
  if (!hasKey) apiKey.focus();
}

const shortcut = field<HTMLInputElement>("shortcut");
const shortcutNote = field("shortcutNote");

async function showShortcut(note = "") {
  shortcut.value = await shortcutLabel();
  shortcutNote.textContent = note;
}

async function recordShortcut(e: KeyboardEvent) {
  e.preventDefault();
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return; // wait for the real key
  const mac = (await browser.runtime.getPlatformInfo()).os === "mac";
  const combo = commandShortcutFromEvent(e, mac);
  if (!combo) return void showShortcut("请同时按下 Ctrl、Alt 或 Cmd 与字母、数字或功能键。");
  try {
    await setShortcut(combo);
    await showShortcut("已保存");
  } catch (err) {
    await showShortcut(err instanceof Error ? err.message : "Firefox 不接受此快捷键。");
  }
  shortcut.blur();
}

shortcut.addEventListener("focus", () => (shortcut.value = "请按下快捷键…"));
shortcut.addEventListener("blur", () => void showShortcut(shortcutNote.textContent ?? ""));
shortcut.addEventListener("keydown", (e) => void recordShortcut(e));
field("resetShortcut").addEventListener("click", async () => {
  await resetShortcut();
  await showShortcut("已恢复默认快捷键。");
});

// The relay's list as a menu, ending with 手动输入… for a name the list doesn't have. A model the
// relay no longer lists, or none yet, gives way to the first Jev model it does list.
function showRelayModels(models: ModelChoice[], current: string) {
  model.replaceChildren(
    ...models.map((m) => new Option(relayLabel(m), m.name, false, m.name === current)),
    new Option("手动输入…", MANUAL),
  );
  if (!models.some((m) => m.name === current)) model.selectedIndex = 0;
  relayListed = true;
  model.hidden = false;
  showManualModel();
}
function showManualModel() {
  const manual = model.value === MANUAL;
  customModel.hidden = !manual;
  if (manual && !customModel.value) customModel.focus();
}
model.addEventListener("change", () => {
  if (relayListed) showManualModel();
});

async function modelChoices(settings: Settings): Promise<{ models: ModelChoice[]; note: string }> {
  const current = { name: settings.model, description: "" };
  if (!settings.apiKey) return { models: [current], note: "保存 API 密钥后即可查看可用模型。" };
  try {
    const models = await listModels(settings);
    const selectedIsListed = models.some((m) => m.name === settings.model);
    return { models: selectedIsListed ? models : [current, ...models], note: "" };
  } catch (e) {
    return { models: [current], note: `无法获取模型列表：${e instanceof Error ? e.message : String(e)}` };
  }
}

async function loadModels(settings: Settings) {
  const revision = ++modelRevision;
  if (!isBuiltin(settings.provider)) return loadRelayModels(settings, revision);
  const { models, note } = await modelChoices(settings);
  if (revision !== modelRevision) return;
  const selected = model.value;
  model.replaceChildren(...models.map((m) => new Option(labelFor(m), m.name, false, m.name === selected)));
  modelNote.textContent = note;
}

// Without a list from the relay, the typed-in name is used as is.
async function loadRelayModels(settings: Settings, revision: number) {
  if (!settings.apiKey || !settings.baseURL) {
    modelNote.textContent = "填好地址和密钥并保存后，会尝试读取中转站的模型列表。";
    return;
  }
  try {
    const models = await listModels(settings);
    if (revision !== modelRevision) return;
    showRelayModels(models, settings.model);
    modelNote.textContent = "";
  } catch (e) {
    if (revision !== modelRevision) return;
    modelNote.textContent = `无法获取模型列表，请手动填写模型名。${e instanceof Error ? e.message : ""}`;
  }
}

const LOCALIZED_MODEL_DESCRIPTIONS: Record<string, string> = {
  "~typesafe/jev-latest": "最新 Jev",
  "typesafe/jev-1.13": "Jev 1.13",
};
// A relay's models show only what the relay itself reported, nothing added here.
const relayLabel = (m: ModelChoice) =>
  m.description && m.description !== m.name ? `${m.name}（${m.description}）` : m.name;
const labelFor = (m: ModelChoice) => {
  const description = LOCALIZED_MODEL_DESCRIPTIONS[m.name];
  return description ? `${m.name}（${description}）` : m.name;
};

async function load() {
  if (!canRebindShortcut) {
    shortcut.disabled = true;
    field("shortcutHint").hidden = true;
    field("resetShortcut").hidden = true;
    if (runningIn() === "chrome") {
      const shortcutsPageButton = document.createElement("button");
      shortcutsPageButton.type = "button";
      shortcutsPageButton.className = "link";
      shortcutsPageButton.textContent = SHORTCUTS_PAGE;
      shortcutsPageButton.addEventListener("click", () => void openShortcutsPage());
      shortcutNote.replaceChildren("请在此页面修改：", shortcutsPageButton);
    } else {
      shortcutNote.textContent = "此浏览器不允许扩展修改快捷键。";
    }
  }
  shortcut.value = await shortcutLabel();
  const [s, typesafe, openrouter, custom] = await Promise.all([
    loadSettings(),
    loadSettings("typesafe"),
    loadSettings("openrouter"),
    loadSettings("custom"),
  ]);
  drafts.typesafe = typesafe;
  drafts.openrouter = openrouter;
  drafts.custom = custom;
  savedCustom = custom;
  showProvider(s);
  setBusy(false);
}

function setBusy(busy: boolean) {
  saveButton.disabled = busy;
  testButton.disabled = busy;
  provider.disabled = busy;
}

function report(text: string, error = false) {
  saved.textContent = text;
  saved.toggleAttribute("data-error", error);
}

// What Save and Test both send: checked here, before anything awaits, so the permission prompt
// that follows still counts as part of the click.
function checkedSettings(): Settings {
  const s = currentSettings();
  if (!s.apiKey) throw new Error("请填写 API 密钥。");
  if (!isBuiltin(s.provider)) {
    s.baseURL = normalizeBaseURL(s.baseURL ?? "");
    baseURL.value = s.baseURL;
  }
  return s;
}

// A new relay has no model yet: take the first Jev model it lists, once access is granted.
async function withModel(s: Settings): Promise<Settings> {
  if (isBuiltin(s.provider) || s.model) return s;
  const revision = ++modelRevision;
  const models = await listModels(s).catch(() => []);
  if (revision !== modelRevision || !models.length) throw new Error("请填写模型名。");
  showRelayModels(models, "");
  return { ...s, model: models[0]!.name };
}

// Tests what is filled in now, saved or not.
async function test() {
  setBusy(true);
  try {
    const checked = checkedSettings();
    if (!(await requestApiAccess(checked))) throw new Error(`未获准访问 ${providerName(checked)}。`);
    const s = await withModel(checked);
    report("正在测试连接…");
    const { model: answered, ms } = await testConnection(s, AbortSignal.timeout(20_000));
    const unsaved = JSON.stringify(await loadSettings()) !== JSON.stringify(s);
    report(`连接正常：${providerName(s)} · ${answered} · ${ms} 毫秒${unsaved ? "。点“保存”后生效" : ""}`);
  } catch (err) {
    report(`连接失败：${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    setBusy(false);
  }
}

async function save() {
  setBusy(true);
  try {
    const checked = checkedSettings();
    // The permission request has to come first, while the click still counts as a user gesture.
    if (!(await requestApiAccess(checked))) throw new Error(`未获准访问 ${providerName(checked)}。`);
    const s = await withModel(checked);
    await saveSettings(s);
    if (!isBuiltin(s.provider)) {
      await releaseApiAccess(savedCustom, s);
      savedCustom = s;
    }
    drafts[s.provider] = s;
    showKeyBanner(Boolean(s.apiKey));
    report("已保存");
    void loadModels(s);
  } catch (err) {
    report(err instanceof Error ? err.message : String(err), true);
  } finally {
    setBusy(false);
  }
}

saveButton.addEventListener("click", () => void save());
testButton.addEventListener("click", () => void test());
void load().catch((err: unknown) => report(err instanceof Error ? err.message : String(err), true));
