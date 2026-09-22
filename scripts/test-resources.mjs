import { readFile, readdir, realpath } from "node:fs/promises";
import { platform, release } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalResourceConfig } from "./local-resource-config.mjs";
import { admissionDirectory, workloads } from "./resource-admission.mjs";
import { observeHostMemory } from "./host-memory.mjs";

async function canonical(path) {
  if (!path) return null;
  try { return await realpath(path); } catch { return resolve(path); }
}

export async function resourceReport(options = {}) {
  const env = options.env ?? process.env;
  const errors = [];
  let config = null;
  try { config = await readLocalResourceConfig(env); }
  catch (error) { errors.push(error.message); }
  const directory = options.directory ?? admissionDirectory;
  const tickets = [];
  try {
    for (const file of await readdir(join(directory, "queue"))) {
      if (!file.endsWith(".json")) continue;
      try {
        const row = JSON.parse(await readFile(join(directory, "queue", file), "utf8"));
        // No arbitrary ticket fields, environment, commands, or tokens in reports.
        tickets.push({ pid: row.pid, childPid: row.childPid ?? null, active: row.active === true, reservation: row.request, policy: row.policy ?? null });
      } catch { errors.push("An admission ticket could not be observed"); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push(`Admission state unavailable (${error.code ?? "I/O error"})`); }
  const memory = await (options.observeMemory ?? observeHostMemory)();
  const flags = Object.fromEntries(["CI", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "BL_TEST_PROFILE", "BL_LOCAL_RESOURCE_CONFIG"].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  const conflicts = [];
  if (env.CI === "true") conflicts.push("This runner revision bypasses local admission when CI=true; remove it for local workloads.");
  if (env.BL_TEST_PROFILE === "fast" && config?.profile === "low-memory") conflicts.push("Fast workers and low-memory host policy conflict; use BL_TEST_PROFILE=shared.");
  if (env.BL_LOCAL_RESOURCE_CONFIG === "") conflicts.push("An empty config override disables the machine configuration in this revision.");
  return {
    version: 1, os: { platform: platform(), release: release(), environment: platform() === "win32" ? "native Windows" : env.WSL_DISTRO_NAME || /microsoft/i.test(release()) ? "WSL (separate process accounting)" : "POSIX; container status not established" },
    tools: { node: process.version, pnpm: /pnpm\/([^ ]+)/.exec(env.npm_config_user_agent ?? "")?.[1] ?? "unknown" },
    memory,
    config: config ? { ...config, path: await canonical(config.path) } : null,
    stateDirectory: await canonical(directory), tickets,
    reservations: workloads,
    workers: { vitest: env.CI === "true" || env.BL_TEST_PROFILE === "fast" ? 2 : 1, playwright: env.CI !== "true" && env.BL_TEST_PROFILE === "fast" ? 2 : 1, workspace: 1 },
    flags, conflicts,
    waitingReason: "Per-ticket waiting reasons are not recorded by this runner revision; compare active reservations and available memory with the next workload plus reserve.",
    limitations: ["Read-only snapshot; PID liveness and complete owned process trees are not established.", "Reservations are estimates, not memory limits. No pressure watchdog in this revision.", "Native Windows and WSL/container workloads must not run concurrently on this host."],
    errors: [...errors, ...memory.errors],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const report = await resourceReport(); process.stdout.write(JSON.stringify(report, null, 2) + "\n"); process.exitCode = report.errors.length ? 1 : 0; }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
