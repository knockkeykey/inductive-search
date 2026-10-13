import browser from "webextension-polyfill";

/** The browser's built-in "activate the extension" command; it fires action.onClicked, which toggles the bar. */
const COMMAND = "_execute_action";

export async function shortcutLabel(): Promise<string> {
  if (!browser.commands) return "工具栏按钮"; // iOS Safari has no keyboard shortcuts at all
  const [command, platform] = await Promise.all([
    browser.commands.getAll().then((all) => all.find((c) => c.name === COMMAND)),
    browser.runtime.getPlatformInfo(),
  ]);
  const bound = command?.shortcut;
  if (!bound) return "工具栏按钮";

  const mac = platform.os === "mac";
  return bound
    .split("+")
    .map((key) => (key === "MacCtrl" ? "Ctrl" : key === "Ctrl" && mac ? "Cmd" : key === "Command" ? "Cmd" : key))
    .join("+");
}

// As far as I can tell, only on firefox this works, but who knows
export const canRebindShortcut = typeof browser.commands?.update === "function";

export const runningIn = (): "firefox" | "chrome" | "safari" | "other" => {
  const scheme = browser.runtime.getURL("").split(":")[0];
  return scheme === "moz-extension"
    ? "firefox"
    : scheme === "chrome-extension"
      ? "chrome"
      : scheme === "safari-web-extension"
        ? "safari"
        : "other";
};

/** Where Chrome users change it instead. A plain href to a chrome:// URL is blocked, tabs.create is not. */
export const SHORTCUTS_PAGE = "chrome://extensions/shortcuts";
export const openShortcutsPage = () => browser.tabs.create({ url: SHORTCUTS_PAGE });

export const setShortcut = (shortcut: string) => browser.commands.update({ name: COMMAND, shortcut });

export const resetShortcut = () => browser.commands.reset(COMMAND);

export function commandShortcutFromEvent(e: KeyboardEvent, mac: boolean): string | null {
  const key = commandKeyName(e.code);
  if (!key) return null;
  const mods = [
    e.ctrlKey && (mac ? "MacCtrl" : "Ctrl"),
    e.metaKey && mac && "Command",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
  ].filter((m): m is string => Boolean(m));
  if (!mods.some((m) => m !== "Shift")) return null;
  return [...mods, key].join("+");
}

function commandKeyName(code: string): string | undefined {
  const KEYS: Record<string, string> = {
    Comma: "Comma",
    Period: "Period",
    Space: "Space",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };

  if (/^Key[A-Z]$/.test(code)) return code.slice("Key".length); // KeyF -> F
  if (/^Digit[0-9]$/.test(code)) return code.slice("Digit".length); // Digit3 -> 3
  if (/^F([1-9]|1[0-2])$/.test(code)) return code; // F5 -> F5
  return KEYS[code]; // ArrowUp -> Up, Comma -> Comma, ...
}
