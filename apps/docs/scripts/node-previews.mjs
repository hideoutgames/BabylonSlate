// Builds the node page previews: renders Class, Animation Graph, Material, Particle Graph and Behaviour Tree nodes
// with the editor's graph components and every node's pin glyphs (src/node-previews/render.tsx), and compiles the
// Tailwind utilities and editor tokens they use, scoped to `.haptic-graph`. The docs Markdown plugin and theme read
// the output from .vitepress/cache/node-previews.
//
// The output is kept when nothing it is built from changed: inputs.json records a fingerprint of every input (this
// script, Node, the lockfile and workspace manifests, each source file the last bundle read, the folders holding
// them, and the stylesheets compiled below) and of the output files. Any difference, or a missing or unreadable
// record, rebuilds.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compile, optimize } from "@tailwindcss/node";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const outDir = path.join(appRoot, ".vitepress/cache/node-previews");
const SCOPE = ".haptic-graph";
const bundle = path.join(outDir, "render.mjs");
const recordFile = path.join(outDir, "inputs.json");
const OUTPUTS = ["render.mjs", "previews.json", "node-previews.css"];
const STYLESHEETS = ["packages/ui/src/styles/tokens.css", "packages/graph-ui/src/graph-editor.css"];

/** Workspace manifests: a changed `exports` map or dependency can change what the bundle resolves. */
function workspaceManifests() {
  const manifests = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      const manifest = path.posix.join(group, entry.name, "package.json");
      if (entry.isDirectory() && existsSync(path.join(repoRoot, manifest))) manifests.push(manifest);
    }
  }
  return manifests;
}

/**
 * Fingerprint of everything the output is built from. Installed packages are covered by the lockfile and their
 * paths; repository sources by their contents and their folders' listings, so a new file that would now resolve
 * first also changes it.
 */
function fingerprint(sources) {
  const hash = createHash("sha256");
  const add = (label, value) => hash.update(`${label}\0${value.length}\0`).update(value);
  add("script", readFileSync(fileURLToPath(import.meta.url)));
  add("node", process.version);
  const folders = new Set();
  for (const file of [...workspaceManifests(), ...STYLESHEETS, ...sources].sort()) {
    add("path", file);
    if (file.split("/").includes("node_modules")) continue;
    add("content", readFileSync(path.join(repoRoot, file)));
    folders.add(path.posix.dirname(file));
  }
  for (const folder of [...folders].sort()) add(`folder ${folder}`, readdirSync(path.join(repoRoot, folder)).sort().join("\n"));
  return hash.digest("hex");
}

function outputDigests() {
  return OUTPUTS.map((name) => createHash("sha256").update(readFileSync(path.join(outDir, name))).digest("hex"));
}

function unchanged() {
  try {
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    if (!Array.isArray(record.sources) || record.sources.length === 0) return false;
    return (
      record.fingerprint === fingerprint(record.sources) &&
      JSON.stringify(record.outputs) === JSON.stringify(outputDigests())
    );
  } catch {
    // A missing record, output or source means a rebuild.
    return false;
  }
}

mkdirSync(outDir, { recursive: true });
if (unchanged()) {
  console.log("node previews: inputs unchanged, kept the previous build");
  process.exit(0);
}
rmSync(recordFile, { force: true });
// A source saved while this build reads it may be missing from the output, so such a build records nothing.
const startedAt = Date.now() - 2000;

const { metafile } = await build({
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
  absWorkingDir: repoRoot,
  metafile: true,
});
const sources = Object.keys(metafile.inputs).map((input) => {
  const relative = path.relative(repoRoot, path.resolve(repoRoot, input)).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`Node preview input outside the repository: ${input}`);
  return relative;
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
const tokens = readFileSync(path.join(repoRoot, STYLESHEETS[0]), "utf8")
  .replace(/^:root \{/m, `${SCOPE} {`)
  .replace(/^\.dark \{/m, `.dark ${SCOPE}, ${SCOPE}.dark {`);
if (!tokens.includes(`${SCOPE}.dark {`)) throw new Error("tokens.css no longer has top-level :root and .dark blocks");
const graphCss = readFileSync(path.join(repoRoot, STYLESHEETS[1]), "utf8");
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
const savedDuringBuild = [...STYLESHEETS, ...sources].some(
  (file) => !file.split("/").includes("node_modules") && statSync(path.join(repoRoot, file)).mtimeMs >= startedAt,
);
if (!savedDuringBuild) {
  writeFileSync(recordFile, JSON.stringify({ fingerprint: fingerprint(sources), outputs: outputDigests(), sources }) + "\n");
}
console.log(`node previews: ${Object.keys(previews).length} nodes, ${candidates.length} classes`);
