#!/usr/bin/env node
// Measures built web output: every file's raw and gzip size, largest first,
// plus totals. The report alone never fails on size.
//
// Usage:
//   node scripts/bundle-report.mjs [--json] [dist-dir ...]   # default apps/player/dist
//   node scripts/bundle-report.mjs --budget <budget.json>     # gzip ceilings for named entries
//
// Markdown output is suitable for $GITHUB_STEP_SUMMARY. Report gzip sizes use
// zlib's default level, close to a typical static host. The budget check gzips
// at a fixed level of its own (`budgetGzipSize`) and fails when an entry is
// missing or over its ceiling.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { constants, gzipSync } from "node:zlib";

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

/**
 * The budget's gzip size: level 9 with zlib's default window, memory and strategy, so the size does not follow a
 * change of Node's default level. Node writes no file name and a zero modification time into the gzip header, so
 * the same bytes give the same size on every run with the same zlib.
 */
export function budgetGzipSize(bytes) {
  return gzipSync(bytes, {
    level: 9,
    windowBits: 15,
    memLevel: 8,
    strategy: constants.Z_DEFAULT_STRATEGY,
  }).length;
}

const BUDGET_RULE =
  "A change that legitimately grows an entry raises its ceiling in scripts/bundle-budget.json in the same pull request and says why in the description; one that shrinks an entry by more than the headroom lowers the ceiling.";

/**
 * Checks each budgeted entry's gzip size against its ceiling. `budget.root` is relative to the budget file's
 * repository (its parent's parent), `budget.entries` maps a path inside the root to `{ gzip: ceilingBytes }`.
 */
export function checkBudget(budget, repoDir) {
  const problems = [];
  const rows = [];
  const entries = Object.entries(budget?.entries ?? {});
  if (typeof budget?.root !== "string" || !entries.length)
    throw new Error("Bundle budget needs a root and at least one entry");
  const root = resolve(repoDir, budget.root);
  for (const [path, limit] of entries) {
    const ceiling = limit?.gzip;
    if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
      problems.push(`${path}: the budget has no gzip ceiling for this entry.`);
      continue;
    }
    const file = join(root, path);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
      problems.push(
        `${path}: not found in ${budget.root}. Build the player first; an entry that was renamed moves its ceiling to the new name.`,
      );
      continue;
    }
    const gzip = budgetGzipSize(readFileSync(file));
    const row = { path, gzip, ceiling, delta: gzip - ceiling };
    rows.push(row);
    if (gzip > ceiling)
      problems.push(
        `${path}: ${gzip} bytes gzip is over its ceiling of ${ceiling} bytes by ${gzip - ceiling} bytes (${formatBytes(gzip)} against ${formatBytes(ceiling)}).`,
      );
  }
  return { rows, problems };
}

export function formatBudget({ rows, problems }) {
  const lines = [
    "### Bundle budget (gzip, level 9)",
    "",
    "| Entry | Gzip | Ceiling | Delta |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(
      ({ path, gzip, ceiling, delta }) =>
        `| \`${path}\` | ${gzip} B | ${ceiling} B | ${delta > 0 ? "+" : ""}${delta} B |`,
    ),
    "",
  ];
  if (problems.length)
    lines.push("Over budget or missing:", ...problems.map((p) => `- ${p}`), "", BUDGET_RULE, "");
  return lines.join("\n");
}

export function main(argv) {
  const budgetIndex = argv.indexOf("--budget");
  if (budgetIndex >= 0) {
    const path = argv[budgetIndex + 1];
    if (!path || path.startsWith("-") || argv.length !== 2)
      throw new Error("Usage: bundle-report.mjs --budget <budget.json>");
    const file = resolve(path);
    const result = checkBudget(
      JSON.parse(readFileSync(file, "utf8")),
      resolve(dirname(file), ".."),
    );
    const output = formatBudget(result);
    if (result.problems.length) throw new Error(output);
    return output;
  }
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
