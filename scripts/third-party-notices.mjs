#!/usr/bin/env node
// Builds the third-party notices from the installed production dependency tree
// plus the vendored runtime files listed in scripts/third-party-notices/vendored.json.
// The game scope keeps only the npm packages the player bundle really contains, as
// recorded in scripts/third-party-notices/game-packages.json; the player build fails
// when that list no longer matches its bundle.
//
// Writes two files:
// - apps/editor/public/legal/THIRD-PARTY-NOTICES.txt: what ships in exported games
//   (the player copies legal/ into every export and Preview Build).
// - apps/editor/src/lib/third-party-notices.json: everything the editor apps ship,
//   shown in Manage Account > Application > Third-Party Notices.
//
// Usage:
//   node scripts/third-party-notices.mjs           # regenerate both files
//   node scripts/third-party-notices.mjs --check   # fail when either file is stale
//   node scripts/third-party-notices.mjs --from-player-build
//     # after `pnpm --filter player build`: refresh game-packages.json, then regenerate

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(repoRoot, "scripts/third-party-notices");

export const GAME_NOTICES_PATH = "apps/editor/public/legal/THIRD-PARTY-NOTICES.txt";
export const EDITOR_NOTICES_PATH = "apps/editor/src/lib/third-party-notices.json";
export const GAME_PACKAGES_PATH = "scripts/third-party-notices/game-packages.json";
const PLAYER_BUNDLED_PACKAGES_PATH = "apps/player/dist/bundled-packages.json";

/** Workspace roots whose production dependencies each scope ships. */
const SCOPE_ROOTS = {
  game: [{ dir: "apps/player" }],
  editor: [
    { dir: "apps/editor" },
    // The desktop shell bundles these at build time; Electron ships its own licences.
    { dir: "apps/desktop", only: ["electron-updater"] },
  ],
};

/**
 * Dependencies whose own dependency tree never reaches a shipped bundle.
 * `shadcn` is a CLI; the editor imports only its stylesheet.
 */
const NO_TRANSITIVE = new Set(["shadcn"]);

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function resolvePackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    if (dir === path.dirname(dir)) return null;
  }
}

function isWorkspaceDir(dir) {
  return dir.startsWith(repoRoot + path.sep) && !dir.includes(`${path.sep}node_modules${path.sep}`);
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(entry => entry.type ?? entry).join(" OR ");
  return "UNKNOWN";
}

function sourceOf(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const url = repo ?? pkg.homepage;
  if (!url) return "";
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/")
    .replace(/^([\w.-]+\/[\w.-]+)$/, "https://github.com/$1")
    .replace(/\.git$/, "");
}

function licenseTexts(dir) {
  return readdirSync(dir)
    .filter(file => LICENSE_FILE.test(file))
    .sort()
    .map(file => normalizeText(readFileSync(path.join(dir, file), "utf8")))
    .filter(Boolean);
}

/** Every non-workspace package reachable through production dependencies of the scope's roots. */
function collectPackages(roots) {
  const found = new Map();
  const visited = new Set();
  const visit = (dir, pkg, only) => {
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(deps).sort()) {
      if (only && !only.includes(name)) continue;
      const depDir = resolvePackageDir(name, dir);
      if (!depDir) {
        if (pkg.optionalDependencies?.[name]) continue;
        throw new Error(`${pkg.name ?? dir} depends on ${name}, which is not installed. Run pnpm install.`);
      }
      if (visited.has(depDir)) continue;
      visited.add(depDir);
      const depPkg = readJson(path.join(depDir, "package.json"));
      // Type declarations never reach a bundle.
      if (!isWorkspaceDir(depDir) && !depPkg.name.startsWith("@types/")) {
        const key = `${depPkg.name}@${depPkg.version}`;
        found.set(key, {
          name: depPkg.name,
          version: depPkg.version,
          license: licenseOf(depPkg),
          source: sourceOf(depPkg),
          texts: licenseTexts(depDir),
          author: typeof depPkg.author === "string" ? depPkg.author : depPkg.author?.name,
        });
      }
      if (!NO_TRANSITIVE.has(depPkg.name)) visit(depDir, depPkg);
    }
  };
  for (const root of roots) {
    const dir = path.join(repoRoot, root.dir);
    visit(dir, readJson(path.join(dir, "package.json")), root.only);
  }
  return found;
}

function vendoredPackages(scope) {
  return readJson(path.join(dataDir, "vendored.json"))
    .filter(entry => entry.scopes.includes(scope))
    .map(entry => ({
      name: entry.name,
      version: entry.version,
      license: entry.license,
      source: entry.source,
      texts: [
        ...(entry.copyright ? [entry.copyright] : []),
        ...entry.files.map(file => normalizeText(readFileSync(path.join(dataDir, file), "utf8"))),
      ],
    }));
}

/** The game scope's npm packages: those of the player's dependency tree that its bundle contains. */
function gameNpmPackages() {
  const reachable = [...collectPackages(SCOPE_ROOTS.game).values()];
  const bundled = readJson(path.join(repoRoot, GAME_PACKAGES_PATH));
  const missing = bundled.filter(name => !reachable.some(entry => entry.name === name));
  if (missing.length > 0) {
    throw new Error(`${GAME_PACKAGES_PATH} lists ${missing.join(", ")}, which the player does not depend on.`);
  }
  return reachable.filter(entry => bundled.includes(entry.name));
}

function packagesFor(scope) {
  const npm = scope === "game" ? gameNpmPackages() : [...collectPackages(SCOPE_ROOTS[scope]).values()];
  const packages = [...npm, ...vendoredPackages(scope)];
  for (const entry of packages) {
    if (entry.texts.length === 0) {
      // A few packages publish no licence file; keep their declared licence and author.
      entry.texts = [
        `${entry.license} licence${entry.author ? `, copyright ${entry.author}` : ""}. The package publishes no licence file; see ${entry.source || "its npm page"}.`,
      ];
    }
    delete entry.author;
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
}

function gameNoticesText(packages) {
  const rule = "=".repeat(78);
  const lines = [
    "Third-party notices",
    "",
    "This game was made with Haptic and includes the open-source software listed",
    "below. Each entry gives the software's licence and the notice its authors ask",
    "to be included.",
  ];
  for (const entry of packages) {
    lines.push("", rule, `${entry.name}${entry.version ? ` ${entry.version}` : ""}`, `License: ${entry.license}`);
    if (entry.source) lines.push(`Source: ${entry.source}`);
    lines.push(rule, "", entry.texts.join("\n\n"));
  }
  return `${lines.join("\n")}\n`;
}

function editorNoticesJson(editorPackages, gameKeys) {
  const texts = [];
  const textIndex = new Map();
  const packages = editorPackages.map(entry => {
    const text = entry.texts.join("\n\n");
    if (!textIndex.has(text)) {
      textIndex.set(text, texts.length);
      texts.push(text);
    }
    return {
      name: entry.name,
      version: entry.version,
      license: entry.license,
      source: entry.source,
      inGames: gameKeys.has(`${entry.name}@${entry.version}`),
      text: textIndex.get(text),
    };
  });
  return `${JSON.stringify({ packages, texts }, null, 1)}\n`;
}

/** The generated file contents, keyed by repository-relative path. */
export function generateThirdPartyNotices() {
  const game = packagesFor("game");
  const editor = packagesFor("editor");
  const gameKeys = new Set(game.map(entry => `${entry.name}@${entry.version}`));
  // The editor runs games in Play, so it ships everything a game does.
  const editorKeys = new Set(editor.map(entry => `${entry.name}@${entry.version}`));
  for (const entry of game) {
    if (!editorKeys.has(`${entry.name}@${entry.version}`)) editor.push(entry);
  }
  editor.sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
  return new Map([
    [GAME_NOTICES_PATH, gameNoticesText(game)],
    [EDITOR_NOTICES_PATH, editorNoticesJson(editor, gameKeys)],
  ]);
}

/** Paths whose committed contents differ from a fresh generation. */
export function staleThirdPartyNotices(generated = generateThirdPartyNotices()) {
  return [...generated].filter(([file, contents]) => {
    const absolute = path.join(repoRoot, file);
    return !existsSync(absolute) || readFileSync(absolute, "utf8") !== contents;
  }).map(([file]) => file);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--from-player-build")) {
    const report = path.join(repoRoot, PLAYER_BUNDLED_PACKAGES_PATH);
    if (!existsSync(report)) {
      console.error(`${PLAYER_BUNDLED_PACKAGES_PATH} is missing. Run pnpm --filter player build first.`);
      process.exit(1);
    }
    writeFileSync(path.join(repoRoot, GAME_PACKAGES_PATH), readFileSync(report, "utf8"));
  }
  const generated = generateThirdPartyNotices();
  if (process.argv.includes("--check")) {
    const stale = staleThirdPartyNotices(generated);
    if (stale.length > 0) {
      console.error(`Third-party notices are out of date: ${stale.join(", ")}. Run node scripts/third-party-notices.mjs.`);
      process.exit(1);
    }
  } else {
    for (const [file, contents] of generated) writeFileSync(path.join(repoRoot, file), contents);
  }
}
