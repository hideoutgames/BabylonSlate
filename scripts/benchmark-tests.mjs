import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  commandSignal,
  pnpmCommand,
  repoRoot,
  runCommand,
} from "./process-runner.mjs";
import { sourceState } from "./source-state.mjs";

export function ownedProcesses(rows, roots, observed = new Map()) {
  const rootIds = new Set(roots);
  const owned = new Set(
    rows
      .filter((row) =>
        observed.has(row.pid)
          ? observed.get(row.pid) === row.started
          : rootIds.has(row.pid),
      )
      .map((row) => row.pid),
  );
  let previous;
  do {
    previous = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  } while (previous !== owned.size);
  return rows.filter((row) => owned.has(row.pid));
}

export async function waitForExit(sample, pause = () => delay(1000)) {
  let remaining = await sample();
  for (let attempt = 0; remaining.length && attempt < 3; attempt++) {
    await pause();
    remaining = await sample();
  }
  return remaining;
}

/** A slow OS query skips sampling ticks instead of building a post-run backlog. */
export function startSampling(sample, intervalMs = 2000) {
  let pending, failure;
  const timer = setInterval(() => {
    if (pending) return;
    pending = Promise.resolve()
      .then(sample)
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        pending = undefined;
      });
  }, intervalMs);
  return async () => {
    clearInterval(timer);
    await pending;
    if (failure) throw failure;
  };
}

async function processSnapshot(signal) {
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
    const result = await runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { capture: true, signal },
    );
    if (result.code) throw new Error("Cannot sample Windows process resources");
    return JSON.parse(result.output).map((row) => ({
      pid: row.ProcessId,
      parent: row.ParentProcessId,
      started: row.CreationDate,
      rss: Number(row.WorkingSetSize),
      cpuMs: (Number(row.KernelModeTime) + Number(row.UserModeTime)) / 10_000,
    }));
  }
  const result = await runCommand(
    "ps",
    ["-axo", "pid=,ppid=,rss=,time=,lstart="],
    {
      capture: true,
      signal,
    },
  );
  if (result.code) throw new Error("Cannot sample process resources");
  return result.output
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, rss, time, ...started] = line.trim().split(/\s+/);
      const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
      const seconds = clock
        .split(":")
        .reduce((value, part) => value * 60 + Number(part), 0);
      return {
        pid: +pid,
        parent: +parent,
        started: started.join(" "),
        rss: +rss * 1024,
        cpuMs: (+days * 86400 + seconds) * 1000,
      };
    });
}

export async function benchmarkTests(args, options = {}) {
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const forwarded = separator < 0 ? [] : args.slice(separator + 1);
  const count = Number(
    flags.find((arg) => arg.startsWith("--agents="))?.split("=")[1] ?? 1,
  );
  const script =
    flags.find((arg) => arg.startsWith("--script="))?.slice(9) ?? "test";
  const worktrees = flags
    .filter((arg) => arg.startsWith("--worktree="))
    .map((arg) => resolve(arg.slice(11)));
  if (
    ![1, 2, 4].includes(count) ||
    !["test", "test:e2e", "verify:local", "verify"].includes(script) ||
    flags.some((flag) => !/^--(agents|script|worktree)=/.test(flag)) ||
    (worktrees.length !== 0 && worktrees.length !== count) ||
    (count > 1 && script !== "test" && new Set(worktrees).size !== count)
  )
    throw new Error(
      "Use --agents=1|2|4 --script=test|test:e2e|verify:local|verify [--worktree=<path> per agent] -- <test arguments>; concurrent browser/verification runs need distinct worktrees",
    );
  const directory = join(
    repoRoot,
    ".cache/benchmarks",
    `${Date.now()}-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  const initial = await sourceState(repoRoot);
  const roots = new Set();
  const observed = new Map();
  const cpu = new Map();
  let peakRssBytes = 0;
  const sample = async () => {
    const rows = ownedProcesses(
      await processSnapshot(options.signal),
      roots,
      observed,
    );
    peakRssBytes = Math.max(
      peakRssBytes,
      rows.reduce((sum, row) => sum + row.rss, 0),
    );
    for (const row of rows) {
      observed.set(row.pid, row.started);
      const key = `${row.pid}:${row.started}`;
      cpu.set(key, Math.max(cpu.get(key) ?? 0, row.cpuMs));
    }
    return rows;
  };
  const stopSampling = startSampling(sample);
  const started = Date.now();
  const [command, commandArgs] = pnpmCommand(["run", script, ...forwarded]);
  let runs;
  try {
    runs = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const result = await runCommand(command, commandArgs, {
          ...options,
          cwd: worktrees[index] ?? repoRoot,
          capture: true,
          onSpawn: (pid) => roots.add(pid),
        });
        await writeFile(join(directory, `run-${index + 1}.log`), result.output);
        const stages = result.output.split("\n").flatMap((line) => {
          try {
            const row = JSON.parse(line);
            return row.event === "stage" ? [row] : [];
          } catch {
            return [];
          }
        });
        return {
          exitCode: result.code,
          elapsedMs: result.elapsedMs,
          queueMs: stages.reduce((sum, stage) => sum + stage.queueMs, 0),
          executionMs:
            result.elapsedMs -
            stages.reduce((sum, stage) => sum + stage.queueMs, 0),
          browserStarts: stages.filter((stage) => stage.profile === "browser")
            .length,
        };
      }),
    );
  } finally {
    await stopSampling();
  }
  const survivors = (await waitForExit(sample)).map((row) => row.pid);
  const report = {
    agents: count,
    worktrees: worktrees.length ? worktrees : [repoRoot],
    script,
    args: forwarded,
    initial,
    final: await sourceState(repoRoot),
    elapsedMs: Date.now() - started,
    sampledCpuMs: [...cpu.values()].reduce((sum, value) => sum + value, 0),
    sampledPeakRssBytes: peakRssBytes,
    samplingIntervalMs: 2000,
    runs,
    survivors,
  };
  const reportPath = join(directory, "result.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({ event: "benchmark", reportPath, ...report }) + "\n",
  );
  if (survivors.length || runs.some((run) => run.exitCode !== 0))
    throw new Error("Benchmark workload failed or left owned processes alive");
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const lifetime = commandSignal();
  try {
    await benchmarkTests(process.argv.slice(2), { signal: lifetime.signal });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    lifetime.dispose();
  }
}
