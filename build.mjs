import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const base = JSON.parse(readFileSync("src/manifest.json", "utf8"));

const manifests = {
  firefox: {
    ...base,
    background: { scripts: ["background.js"], type: "module" },
    browser_specific_settings: {
      gecko: {
        id: "hunch@tymscar.com",
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["websiteContent"] },
      },
      gecko_android: { strict_min_version: "142.0" },
    },
  },
  chrome: {
    ...base,
    background: { service_worker: "background.js" },
  },
  safari: {
    ...base,
    background: { scripts: ["background.js"], persistent: false },
    options_ui: { page: "options.html" },
  },
};

const assets = {
  "src/options.html": "options.html",
  "src/viewer.html": "viewer.html",
  "src/content.css": "content.css",
  "src/content/ui.css": "ui.css",
  "src/icons": "icons",
  // pdf.js runs its parser in a module worker and loads CJK character maps on demand.
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs": "pdf.worker.min.mjs",
  "node_modules/pdfjs-dist/cmaps": "pdfjs/cmaps",
  "node_modules/pdfjs-dist/standard_fonts": "pdfjs/standard_fonts",
};

rmSync("dist", { recursive: true, force: true });
const bundler = await esbuild.context({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    options: "src/options.ts",
  },
  bundle: true,
  format: "iife",
  target: ["firefox128", "chrome120"],
  outdir: "dist/bundle",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  plugins: [{ name: "layout", setup: (build) => build.onEnd(layoutBrowserFolders) }],
});
// pdf.js ships as ES modules with top-level await, so the viewer page loads a module bundle.
const viewer = await esbuild.context({
  entryPoints: { viewer: "src/viewer/viewer.ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["firefox128", "chrome120"],
  outdir: "dist/bundle",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  plugins: [{ name: "layout", setup: (build) => build.onEnd(layoutBrowserFolders) }],
});

function layoutBrowserFolders() {
  for (const [browser, manifest] of Object.entries(manifests)) {
    const dir = `dist/${browser}`;
    rmSync(dir, { recursive: true, force: true });
    cpSync("dist/bundle", dir, { recursive: true });
    for (const [from, to] of Object.entries(assets)) cpSync(from, `${dir}/${to}`, { recursive: true });
    writeFileSync(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (watch) await Promise.all([bundler.watch(), viewer.watch()]);
else {
  await Promise.all([bundler.rebuild(), viewer.rebuild()]);
  await Promise.all([bundler.dispose(), viewer.dispose()]);
}
