#!/usr/bin/env node
// Typechecks the editor's TypeScript programs, each in its own `tsc -p --noEmit --incremental` process with an explicit
// heap and build info under `.cache/typecheck` (scripts/typecheck-incremental.mjs says why `-p`, never `-b`): the
// shipped app, its unit tests, the Node-side config and tests, and the Playwright specs, the projects tsconfig.json
// references. Each program reloads Babylon's declarations and most workspace sources, so one process holding all of
// them peaked above 4 GB.
//
//   node scripts/typecheck.mjs                 every program, as many at once as this machine's memory allows
//   node scripts/typecheck.mjs app             only the shipped app (the production build)
//   node scripts/typecheck.mjs --jobs 1        one program at a time (also HAPTIC_TYPECHECK_JOBS=1)
//
// How many run at once: 4 (all) needs about 8.5 GB for the processes plus a reserve, 2 runs the unit tests with
// the Node program and then the app with the Playwright specs (about 4.7 GB at most), 1 runs them one by one (about
// 3 GB). Memory is the smaller of total and available memory on Linux (cgroup limits included) and total memory
// less a reserve elsewhere, where the free figure leaves out reclaimable memory. Every selected program runs even
// after one fails, so one run reports every error; each program's output is printed whole, in program order, and
// the exit code is nonzero when any failed. SIGINT and SIGTERM stop every running program before exiting.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { typecheckCommands } from "../../../scripts/typecheck-incremental.mjs";

const GIB = 1024 ** 3;
/**
 * Programs in report order, with each one's measured peak resident memory plus a margin, in GiB: exactly the projects
 * tsconfig.json references (scripts/editor-typecheck.test.mjs).
 */
export const PROGRAMS = [
  { name: "app", config: "tsconfig.app.json", peakGiB: 2.6 },
  { name: "test", config: "tsconfig.test.json", peakGiB: 3.1 },
  { name: "node", config: "tsconfig.node.json", peakGiB: 0.7 },
  { name: "e2e", config: "tsconfig.e2e.json", peakGiB: 2.1 },
];
const HEAP_MB = 4096;
/** Memory left for everything else while the programs run. */
const RESERVE_GIB = 1.5;

const editorRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(join(editorRoot, "package.json")).resolve("typescript/bin/tsc");

/** The programs in batches that run together, for `jobs` at once; pairs keep the two largest apart. */
export function batches(selected, jobs) {
  if (jobs >= 4) return [selected];
  if (jobs >= 2) {
    return [["test", "node"], ["app", "e2e"]]
      .map((pair) => selected.filter((program) => pair.includes(program.name)))
      .filter((batch) => batch.length > 0);
  }
  return selected.map((program) => [program]);
}

/** Memory the programs may use: Linux reports available memory and cgroup limits; elsewhere only total is reliable. */
export function memoryBudgetGiB({ platform, total, available, constrained }) {
  const limit = constrained > 0 ? Math.min(total, constrained) : total;
  if (platform === "linux" && available > 0) return Math.min(limit, available) / GIB;
  return (limit - 2 * GIB) / GIB;
}

/** How many programs run at once on a machine with `budgetGiB` to spare and `cpus` CPUs. */
export function chooseJobs(selected, budgetGiB, cpus) {
  for (const jobs of [4, 2]) {
    if (cpus < jobs) continue;
    const peak = Math.max(...batches(selected, jobs).map((batch) => batch.reduce((sum, program) => sum + program.peakGiB, 0)));
    if (peak + RESERVE_GIB <= budgetGiB) return jobs;
  }
  return 1;
}

function parseJobs(value, source) {
  if (value === undefined) return undefined;
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`${source} must be a whole number of at least 1, not "${value}"`);
  return jobs;
}

/** The inherited NODE_OPTIONS without a heap size: each program gets its own. */
function childNodeOptions(inherited = "") {
  return inherited.split(/\s+/).filter((option) => option && !option.startsWith("--max-old-space-size")).join(" ");
}

async function main(argv) {
  const args = [...argv];
  const jobsAt = args.indexOf("--jobs");
  let requestedJobs = parseJobs(process.env.HAPTIC_TYPECHECK_JOBS || undefined, "HAPTIC_TYPECHECK_JOBS");
  if (jobsAt >= 0) {
    requestedJobs = parseJobs(args[jobsAt + 1] ?? "", "--jobs");
    args.splice(jobsAt, 2);
  }
  const unknown = args.filter((name) => !PROGRAMS.some((program) => program.name === name));
  if (unknown.length > 0) {
    console.error(`Unknown typecheck program: ${unknown.join(", ")}. Choose from ${PROGRAMS.map((program) => program.name).join(", ")}.`);
    return 2;
  }
  const selected = args.length > 0 ? PROGRAMS.filter((program) => args.includes(program.name)) : PROGRAMS;

  const machine = {
    platform: process.platform,
    total: os.totalmem(),
    available: process.availableMemory?.() ?? os.freemem(),
    constrained: process.constrainedMemory?.() ?? 0,
  };
  const cpus = os.availableParallelism();
  const budget = memoryBudgetGiB(machine);
  const jobs = requestedJobs ?? chooseJobs(selected, budget, cpus);
  const plan = batches(selected, jobs);
  if (selected.length > 1) {
    console.log(
      `Editor typecheck: ${plan.map((batch) => batch.map((program) => program.name).join(" + ")).join(", then ")} ` +
        `(${requestedJobs ? "requested" : `${budget.toFixed(1)} GiB to spare, ${cpus} CPUs`})`,
    );
  }

  const running = new Set();
  let stopping = null;
  const stop = (signal) => {
    stopping ??= signal;
    for (const child of running) child.kill("SIGTERM");
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const env = { ...process.env, NODE_OPTIONS: childNodeOptions(process.env.NODE_OPTIONS) };
  const run = (program) =>
    new Promise((resolve) => {
      const started = Date.now();
      const output = [];
      const [args] = typecheckCommands([program.config], editorRoot);
      mkdirSync(dirname(args.at(-1)), { recursive: true });
      const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, tsc, ...args], {
        cwd: editorRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      running.add(child);
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => output.push(chunk));
      const finish = (status) => {
        running.delete(child);
        resolve({ program, status, output: Buffer.concat(output).toString(), seconds: (Date.now() - started) / 1000 });
      };
      child.on("error", (error) => finish(error.message));
      child.on("close", (code, signal) => finish(code === 0 ? 0 : signal ?? `exit ${code}`));
    });

  const failed = [];
  for (const batch of plan) {
    if (stopping) break;
    const results = await Promise.all(batch.map(run));
    for (const { program, status, output, seconds } of results) {
      process.stdout.write(output);
      const outcome = status === 0 ? "passed" : stopping ? "stopped" : "failed";
      console.log(`Editor typecheck: ${program.name} (${program.config}) ${outcome} in ${seconds.toFixed(1)} s`);
      if (status !== 0) failed.push(`${program.name} (${status})`);
    }
  }
  if (stopping) {
    console.error(`Editor typecheck stopped by ${stopping}.`);
    return stopping === "SIGINT" ? 130 : 143;
  }
  if (failed.length > 0) {
    console.error(`Editor typecheck failed: ${failed.join(", ")}.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    },
  );
}
