#!/usr/bin/env node
// Measures built web output: every file's raw and gzip size, largest first,
// plus totals. Measurement only — no thresholds, never fails on size.
//
// Usage:
//   node scripts/bundle-report.mjs [--json] [dist-dir ...]   # default apps/player/dist
//
// Markdown output is suitable for $GITHUB_STEP_SUMMARY. Gzip sizes use zlib's
// default level, close to a typical static host.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Sizes of every file under `root`, sorted by raw size descending. */
export function measureBundle(root) {
  const absolute = resolve(root);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Bundle directory not found: ${root} (build it first)`);
  const files = listFiles(absolute)
    .map((path) => {
      const bytes = readFileSync(path);
      return {
        path: relative(absolute, path).split(sep).join("/"),
        raw: bytes.length,
        gzip: gzipSync(bytes).length,
      };
    })
    .sort((a, b) => b.raw - a.raw || a.path.localeCompare(b.path));
  const total = { files: files.length, raw: 0, gzip: 0 };
  for (const file of files) {
    total.raw += file.raw;
    total.gzip += file.gzip;
  }
  return { root, files, total };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

export function formatMarkdown(reports) {
  const lines = [];
  for (const { root, files, total } of reports) {
    lines.push(`### Bundle sizes: \`${root}\``, "");
    lines.push("| File | Raw | Gzip |", "| --- | ---: | ---: |");
    for (const file of files)
      lines.push(
        `| \`${file.path}\` | ${formatBytes(file.raw)} | ${formatBytes(file.gzip)} |`,
      );
    lines.push(
      `| **Total (${total.files} files)** | **${formatBytes(total.raw)}** | **${formatBytes(total.gzip)}** |`,
      "",
    );
  }
  return lines.join("\n");
}

export function main(argv) {
  const json = argv.includes("--json");
  const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--json");
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);
  const roots = argv.filter((arg) => !arg.startsWith("-"));
  const reports = (roots.length ? roots : ["apps/player/dist"]).map(
    measureBundle,
  );
  return json
    ? `${JSON.stringify({ reports }, null, 2)}\n`
    : formatMarkdown(reports);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
