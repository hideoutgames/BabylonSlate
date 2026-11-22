#!/usr/bin/env node
// Measures built web output: every file's raw and gzip size, largest first,
// plus totals, and optionally checks them against size budgets.
//
// Usage:
//   node scripts/bundle-report.mjs [--json] [--budgets <file>] [dist-dir ...]   # default apps/player/dist
//
// Markdown output is suitable for $GITHUB_STEP_SUMMARY. Gzip sizes use zlib's
// default level, close to a typical static host. With --budgets, the report is
// printed in full and the exit code is 1 when any budget is exceeded.

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

/**
 * Reads a budget file: `{ "budgets": [{ name, root, prefix?, extension, measure, maxGzipBytes }] }`, where `measure`
 * is `total` (the summed gzip size of the matching files) or `largest` (the largest matching file's gzip size).
 */
export function readBudgets(path) {
  const { budgets } = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(budgets) || budgets.length === 0) throw new Error(`No budgets in ${path}`);
  for (const budget of budgets) {
    const valid =
      typeof budget.name === "string" &&
      typeof budget.root === "string" &&
      (budget.prefix === undefined || typeof budget.prefix === "string") &&
      typeof budget.extension === "string" &&
      ["total", "largest"].includes(budget.measure) &&
      Number.isSafeInteger(budget.maxGzipBytes) &&
      budget.maxGzipBytes > 0;
    if (!valid) throw new Error(`Invalid budget in ${path}: ${JSON.stringify(budget)}`);
  }
  return budgets;
}

/** Each budget's measured gzip size against its limit. A budget whose root was not measured, or matches no file, fails. */
export function checkBudgets(reports, budgets) {
  return budgets.map((budget) => {
    const report = reports.find(({ root }) => resolve(root) === resolve(budget.root));
    if (!report) throw new Error(`Budget "${budget.name}" names ${budget.root}, which was not measured`);
    const files = report.files.filter(
      ({ path }) => path.startsWith(budget.prefix ?? "") && path.endsWith(budget.extension),
    );
    if (files.length === 0) throw new Error(`Budget "${budget.name}" matches no file in ${budget.root}`);
    const gzip =
      budget.measure === "total"
        ? files.reduce((sum, file) => sum + file.gzip, 0)
        : Math.max(...files.map((file) => file.gzip));
    return { name: budget.name, gzip, maxGzipBytes: budget.maxGzipBytes, exceeded: gzip > budget.maxGzipBytes };
  });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

export function formatMarkdown(reports, budgetResults = []) {
  const lines = [];
  if (budgetResults.length) {
    lines.push("### Size budgets", "");
    lines.push("| Budget | Gzip | Limit | Result |", "| --- | ---: | ---: | --- |");
    for (const result of budgetResults)
      lines.push(
        `| ${result.name} | ${formatBytes(result.gzip)} | ${formatBytes(result.maxGzipBytes)} | ${result.exceeded ? "**Over budget**" : "Within budget"} |`,
      );
    lines.push("");
  }
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

/** The report text, and whether any budget was exceeded. */
export function main(argv) {
  const args = [...argv];
  let budgetsPath = null;
  const budgetsAt = args.indexOf("--budgets");
  if (budgetsAt >= 0) {
    budgetsPath = args[budgetsAt + 1];
    if (!budgetsPath || budgetsPath.startsWith("-")) throw new Error("--budgets needs a budget file");
    args.splice(budgetsAt, 2);
  }
  const json = args.includes("--json");
  const unknown = args.filter((arg) => arg.startsWith("-") && arg !== "--json");
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);
  const roots = args.filter((arg) => !arg.startsWith("-"));
  const reports = (roots.length ? roots : ["apps/player/dist"]).map(
    measureBundle,
  );
  const budgets = budgetsPath ? checkBudgets(reports, readBudgets(budgetsPath)) : [];
  const text = json
    ? `${JSON.stringify({ reports, budgets }, null, 2)}\n`
    : formatMarkdown(reports, budgets);
  return { text, exceeded: budgets.some((result) => result.exceeded) };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { text, exceeded } = main(process.argv.slice(2));
    process.stdout.write(text);
    if (exceeded) {
      console.error("A bundle exceeds its size budget (scripts/bundle-budgets.json).");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
