import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = await mkdtemp(path.join(tmpdir(), "hunch-activation-"));
const outfile = path.join(temp, "background.mjs");
globalThis.hunchActivation = { events: [], injected: false, ready: true, callbacks: {} };
await build({
  entryPoints: ["src/background.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  plugins: [{
    name: "activation-browser",
    setup(build) {
      build.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: "browser", namespace: "mock" }));
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
        contents: `const state = globalThis.hunchActivation;
          const event = (name) => ({ addListener: callback => { state.callbacks[name] = callback; } });
          export default {
            runtime: {
              onInstalled: event("install"), onConnect: event("connect"), onMessage: event("message"),
              getURL: () => "chrome-extension://test/",
              getPlatformInfo: async () => ({ os: "mac" }),
              openOptionsPage: async () => { state.events.push("options"); }
            },
            action: {
              onClicked: event("activate"),
              setBadgeBackgroundColor: async () => {},
              setBadgeText: async () => {},
              setTitle: async () => {}
            },
            storage: { local: { get: async () => {
              state.events.push("storage");
              return { settings: { provider: "openlux", profiles: { openlux: { apiKey: "dummy-key", model: "jev-1.13.0" } } } };
            } } },
            permissions: {
              contains: async () => state.apiAccess ?? true,
              request: async () => {
                state.events.push("permission-request");
                throw new Error("This function must be called during a user gesture");
              }
            },
            tabs: { sendMessage: async (tabId, message) => {
              state.events.push(message.type);
              if (message.type === "ping" && !state.ready && !state.injected) throw new Error("No receiver");
              if (message.type === "toggle") state.toggledTab = tabId;
            } },
            scripting: {
              insertCSS: async () => { state.events.push("css"); },
              executeScript: async () => { state.events.push("inject"); state.injected = true; }
            },
            commands: { getAll: async () => [{ name: "_execute_action", shortcut: "Alt+F" }] }
          };`,
      }));
    },
  }],
});
await import(pathToFileURL(outfile).href);
after(async () => {
  delete globalThis.hunchActivation;
  await rm(temp, { recursive: true, force: true });
});

async function activate(tabId = 17) {
  const state = globalThis.hunchActivation;
  state.events = [];
  state.toggledTab = undefined;
  await state.callbacks.activate({ id: tabId });
  await new Promise(resolve => setImmediate(resolve));
}

test("action shortcut opens the bar even if a permission request would reject", async () => {
  globalThis.hunchActivation.ready = true;
  await activate();
  assert.equal(globalThis.hunchActivation.toggledTab, 17);
  assert.deepEqual(globalThis.hunchActivation.events, ["ping", "toggle"]);
});

test("activation injects the bar into an existing tab after extension reload", async () => {
  globalThis.hunchActivation.ready = false;
  globalThis.hunchActivation.injected = false;
  await activate(23);
  assert.equal(globalThis.hunchActivation.toggledTab, 23);
  assert.deepEqual(globalThis.hunchActivation.events, ["ping", "css", "inject", "toggle"]);
});

test("search without provider permission opens settings and explains how to recover", async () => {
  globalThis.hunchActivation.apiAccess = false;
  const messages = [];
  let onMessage;
  const port = {
    name: "hunch-search",
    onDisconnect: { addListener() {} },
    onMessage: { addListener(callback) { onMessage = callback; } },
    postMessage(message) { messages.push(message); },
  };
  globalThis.hunchActivation.callbacks.connect(port);
  onMessage({});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(globalThis.hunchActivation.events.includes("options"));
  assert.equal(messages.at(-1).type, "failure");
  assert.match(messages.at(-1).message, /OpenLux.*settings.*Save/);
});
