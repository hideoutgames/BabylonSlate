#!/usr/bin/env node
/**
 * One-off rename of the old BabylonSlate code names to Haptic: the
 * `@babylonslate/*` scope, `.babasset` / `.babproject` / `.babplugin` /
 * `.babextension` / `.babtrace`, `BL_*` variables, `babylonslate:` keys and
 * URLs, and every other `babylonslate` identifier.
 *
 * Native app identity stays: bundle and app ids, native plugin and Keychain
 * names, the native `BabylonSlate/` storage folders, the Electron app name and
 * `app://babylonslate` origin, signing and distribution variables, and the
 * repository and Pages URLs.
 *
 * Run it from the repository root on a clean tree, for example on a branch
 * that predates the rename before merging `main`:
 *
 *   node scripts/rename-to-haptic.mjs
 *   pnpm install
 *   UPDATE_GOLDENS=1 pnpm exec vitest run packages/assets  # binary goldens
 *
 * It rewrites tracked text files and git-moves renamed paths. Binary files and
 * `pnpm-lock.yaml` are left for their own tooling.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Paths whose old names are native or distribution identity. */
const PROTECTED_PATHS = [
  /^apps\/editor\/ios\//,
  /^apps\/editor\/android\//,
  /^fastlane\//,
  /^scripts\/distribution\//,
  /^apps\/desktop\/electron-builder\.yml$/,
  /^scripts\/rename-to-haptic\.mjs$/,
];

/** Old names that stay verbatim wherever they appear. */
const PROTECTED_TOKENS = [
  /hideoutgames\/BabylonSlate/g,
  /hideoutgames\.github\.io\/BabylonSlate/g,
  // GitHub Pages and test base paths follow the repository name.
  /(?<![A-Za-z%])\/BabylonSlate(?=\/|$|["'`\s)])/g,
  /no[./]hideout[./]babylonslate/g,
  /BabylonSlate(?:ScopedStorage|Secrets|Memory|AudioLifecycle)/g,
  /BabylonSlate\.StorageRange/g,
  /com\.babylonslate\.editor\.source-control/g,
  /(?:Application Support\/)?BabylonSlate\/(?:projects|game-saves)/g,
  /app:\/\/babylonslate/g,
  /host === "babylonslate"/g,
  /name: "babylonslate", productName: "BabylonSlate", desktopName: "babylonslate\.desktop"/g,
  /BabylonSlate(?=-\$\{|-<|-\d|\.app\b|\.exe\b|\.AppImage\b)/g,
  /BabylonSlate\.app\/Contents\/MacOS\/BabylonSlate/g,
  /squashfs-root\/babylonslate/g,
  /babylonslate(?:VersionCode|VersionName|Keystore)/g,
  /babylonslate-(?:notarization|distribution|android|apple)-?/g,
  /BABYLONSLATE_(?:ANDROID|APNS|DISTRIBUTION|PROVISIONING)[A-Z_]*/g,
  /formerly BabylonSlate/g,
  /BabylonSlate(?=\*)/g,
];

/** Ordered rewrites applied outside protected tokens. */
const REWRITES = [
  [/@babylonslate\//g, "@haptic/"],
  [/%LOCALAPPDATA%\/BabylonSlate/g, "%LOCALAPPDATA%/Haptic"],
  [/BAB(ASSET|PROJECT|PLUGIN|EXTENSION|TRACE)/g, "H$1"],
  [/Bab(asset|project|plugin|extension|trace)/g, "H$1"],
  [/bab(asset|project|plugin|extension|trace)/g, "h$1"],
  [/BABYLONSLATE/g, "HAPTIC"],
  [/BabylonSlate/g, "Haptic"],
  [/babylonSlate/g, "haptic"],
  [/babylonslate/g, "haptic"],
  [/\bBL_(?=[A-Z0-9])/g, "HAPTIC_"],
];

const SKIP_CONTENT = new Set(["pnpm-lock.yaml"]);

function rename(text) {
  const kept = [];
  let masked = text;
  for (const pattern of PROTECTED_TOKENS) {
    masked = masked.replace(pattern, (match) => `\uE000${kept.push(match) - 1}\uE000`);
  }
  for (const [pattern, replacement] of REWRITES) masked = masked.replace(pattern, replacement);
  return masked.replace(/\uE000(\d+)\uE000/g, (_, index) => kept[Number(index)]);
}

const isProtected = (path) => PROTECTED_PATHS.some((pattern) => pattern.test(path));
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

const files = git("ls-files", "-z").split("\0").filter(Boolean);
let rewritten = 0;
let moved = 0;
for (const path of files) {
  if (isProtected(path)) continue;
  if (!SKIP_CONTENT.has(path)) {
    const bytes = readFileSync(path);
    if (!bytes.includes(0)) {
      const text = bytes.toString("utf8");
      const next = rename(text);
      if (next !== text) {
        writeFileSync(path, next);
        rewritten++;
      }
    }
  }
  const target = rename(path);
  if (target !== path) {
    mkdirSync(dirname(target), { recursive: true });
    git("mv", path, target);
    moved++;
  }
}
console.log(`Rewrote ${rewritten} files and moved ${moved} paths.`);
