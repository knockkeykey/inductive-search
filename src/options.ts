import browser from "webextension-polyfill";
import { defaultSettings, listModels, type ModelChoice, PROVIDERS, type Provider, type Settings } from "./shared/api";
import { loadSettings, requestApiAccess, saveSettings } from "./shared/settings";
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
const model = field<HTMLSelectElement>("model");
const modelNote = field("modelNote");
const banner = field("nokey");
const saved = field("saved");
const saveButton = field<HTMLButtonElement>("save");
const drafts: Record<Provider, Settings> = {
  typesafe: defaultSettings("typesafe"),
  openrouter: defaultSettings("openrouter"),
  openlux: defaultSettings("openlux"),
};
let activeProvider: Provider = "typesafe";
let modelRevision = 0;

function currentSettings(): Settings {
  return { provider: activeProvider, apiKey: apiKey.value.trim(), model: model.value || drafts[activeProvider].model };
}

function showProvider(s: Settings) {
  activeProvider = s.provider;
  provider.value = s.provider;
  const config = PROVIDERS[s.provider];
  keyLabel.textContent = `${config.name} API key`;
  keyLink.href = config.keyURL;
  keyLink.textContent = `${config.name} keys`;
  apiKey.placeholder = config.keyPlaceholder;
  apiKey.value = s.apiKey;
  // Set a usable selection immediately, including when model discovery is offline.
  model.replaceChildren(new Option(s.model, s.model, true, true));
  modelNote.textContent = "";
  showKeyBanner(Boolean(s.apiKey));
  void loadModels(s);
}

provider.addEventListener("change", () => {
  drafts[activeProvider] = currentSettings();
  showProvider(drafts[provider.value as Provider]);
  saved.textContent = "Save to use this provider.";
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
  if (!combo) return void showShortcut("Use Ctrl, Alt or Cmd together with a letter, number or function key.");
  try {
    await setShortcut(combo);
    await showShortcut("Saved");
  } catch (err) {
    await showShortcut(err instanceof Error ? err.message : "Firefox refused that shortcut.");
  }
  shortcut.blur();
}

shortcut.addEventListener("focus", () => (shortcut.value = "press keys…"));
shortcut.addEventListener("blur", () => void showShortcut(shortcutNote.textContent ?? ""));
shortcut.addEventListener("keydown", (e) => void recordShortcut(e));
field("resetShortcut").addEventListener("click", async () => {
  await resetShortcut();
  await showShortcut("Back to the default");
});

async function modelChoices(settings: Settings): Promise<{ models: ModelChoice[]; note: string }> {
  const current = { name: settings.model, description: "" };
  if (!settings.apiKey) return { models: [current], note: "Save an API key to see the models you can use." };
  try {
    const models = await listModels(settings);
    const selectedIsListed = models.some((m) => m.name === settings.model);
    return { models: selectedIsListed ? models : [current, ...models], note: "" };
  } catch (e) {
    return { models: [current], note: `Could not list models: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function loadModels(settings: Settings) {
  const revision = ++modelRevision;
  const { models, note } = await modelChoices(settings);
  if (revision !== modelRevision) return;
  const selected = model.value;
  model.replaceChildren(...models.map((m) => new Option(labelFor(m), m.name, false, m.name === selected)));
  modelNote.textContent = note;
}

const labelFor = (m: ModelChoice) => (m.description ? `${m.name} (${m.description})` : m.name);

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
      shortcutNote.replaceChildren("Change it at ", shortcutsPageButton);
    } else {
      shortcutNote.textContent = "This browser does not let extensions change their shortcut.";
    }
  }
  shortcut.value = await shortcutLabel();
  const [s, typesafe, openrouter, openlux] = await Promise.all([
    loadSettings(),
    loadSettings("typesafe"),
    loadSettings("openrouter"),
    loadSettings("openlux"),
  ]);
  drafts.typesafe = typesafe;
  drafts.openrouter = openrouter;
  drafts.openlux = openlux;
  showProvider(s);
  provider.disabled = false;
  saveButton.disabled = false;
}

async function save() {
  const s = currentSettings();
  saveButton.disabled = true;
  provider.disabled = true;
  try {
    if (!(await requestApiAccess(s.provider)))
      throw new Error(`Permission to reach ${PROVIDERS[s.provider].name} denied.`);
    await saveSettings(s);
    drafts[s.provider] = s;
    showKeyBanner(Boolean(s.apiKey));
    saved.textContent = "Saved";
    void loadModels(s);
  } catch (err) {
    saved.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    saveButton.disabled = false;
    provider.disabled = false;
  }
}

field("save").addEventListener("click", () => void save());
void load().catch((err: unknown) => {
  saved.textContent = err instanceof Error ? err.message : String(err);
});
