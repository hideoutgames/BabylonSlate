// Builds the node page previews: renders Class and Material nodes with the
// editor's graph components and every node's pin glyphs
// (src/node-previews/render.tsx), and compiles the Tailwind utilities and editor
// tokens they use, scoped to `.haptic-graph`. The docs Markdown plugin and theme
// read the output from .vitepress/cache/node-previews.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compile, optimize } from "@tailwindcss/node";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const outDir = path.join(appRoot, ".vitepress/cache/node-previews");
const SCOPE = ".haptic-graph";

mkdirSync(outDir, { recursive: true });
const bundle = path.join(outDir, "render.mjs");
await build({
  entryPoints: [path.join(appRoot, "src/node-previews/render.tsx")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  // Editor-only assets never reach static markup.
  loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".wasm": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});
const { renderNodePreviews } = await import(pathToFileURL(bundle).href);
const previews = renderNodePreviews();

const markup = Object.values(previews).flatMap((preview) => [
  preview.html ?? "",
  ...[...preview.inputs, ...preview.outputs].map((pin) => pin.glyph),
]);
const candidates = [
  ...new Set(markup.flatMap((html) => [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)))),
];

// The editor's light (:root) and dark (.dark) tokens, re-rooted on `.haptic-graph`. Node
// previews carry `.dark` themselves, so they stay dark like the editor's graph canvas; the
// table glyphs follow the page theme.
const tokens = readFileSync(path.join(repoRoot, "packages/ui/src/styles/tokens.css"), "utf8")
  .replace(/^:root \{/m, `${SCOPE} {`)
  .replace(/^\.dark \{/m, `.dark ${SCOPE}, ${SCOPE}.dark {`);
if (!tokens.includes(`${SCOPE}.dark {`)) throw new Error("tokens.css no longer has top-level :root and .dark blocks");
const graphCss = readFileSync(path.join(repoRoot, "packages/graph-ui/src/graph-editor.css"), "utf8");
const input = [
  '@import "tailwindcss/theme.css";',
  tokens,
  `${SCOPE} { @tailwind utilities; }`,
  graphCss,
].join("\n");
const compiler = await compile(input, { base: appRoot, onDependency() {} });
const css = compiler.build(candidates).replace(/:root, :host \{/g, `${SCOPE} {`);
writeFileSync(path.join(outDir, "node-previews.css"), optimize(css, { minify: true }).code);
writeFileSync(path.join(outDir, "previews.json"), JSON.stringify(previews));
console.log(`node previews: ${Object.keys(previews).length} nodes, ${candidates.length} classes`);
