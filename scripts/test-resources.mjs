import { readFile, readdir, realpath } from "node:fs/promises";
import { platform, release } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readLocalResourceConfig } from "./local-resource-config.mjs";
import { admissionDirectory, workloads } from "./resource-admission.mjs";
import { observeHostMemory } from "./host-memory.mjs";
import { resolveExecutionPlan } from "./execution-plan.mjs";

async function canonical(path) {
  if (!path) return null;
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function numericFields(value, keys) {
  return Object.fromEntries(
    keys.map((key) => [key, Number.isFinite(value?.[key]) ? value[key] : null]),
  );
}

export async function resourceReport(options = {}) {
  const env = options.env ?? process.env;
  const errors = [];
  let config = null;
  let plan = null;
  try {
    config = await readLocalResourceConfig(env);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    plan = await resolveExecutionPlan("unit", env);
  } catch (error) {
    if (!errors.includes(error.message)) errors.push(error.message);
  }
  const directory = options.directory ?? admissionDirectory;
  const tickets = [];
  try {
    for (const file of await readdir(join(directory, "queue"))) {
      if (!file.endsWith(".json")) continue;
      try {
        const row = JSON.parse(
          await readFile(join(directory, "queue", file), "utf8"),
        );
        // No arbitrary ticket fields, environment, commands, or tokens in reports.
        tickets.push({
          ...numericFields(row, ["pid", "childPid"]),
          active: row.active === true,
          reservation: numericFields(row.request, [
            "workers",
            "browsers",
            "memoryGiB",
          ]),
          policy: row.policy
            ? {
                ...numericFields(row.policy, [
                  "maxRoots",
                  "maxHeavy",
                  "maxBypasses",
                ]),
                capacity: numericFields(row.policy.capacity, [
                  "workers",
                  "browsers",
                  "memoryGiB",
                  "reserveGiB",
                ]),
              }
            : null,
          waitingReason: [
            "Active owned workload or reserved capacity",
            "Insufficient or unknown available memory above host reserve",
          ].includes(row.waitingReason)
            ? row.waitingReason
            : null,
        });
      } catch {
        errors.push("An admission ticket could not be observed");
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT")
      errors.push(`Admission state unavailable (${error.code ?? "I/O error"})`);
  }
  const memory = await (options.observeMemory ?? observeHostMemory)();
  const versions = {};
  for (const [name, path] of Object.entries({
    vitest: "vitest",
    playwright: "@playwright/test",
    typescript: "typescript",
  })) {
    try {
      versions[name] = JSON.parse(
        await readFile(
          new URL(`../node_modules/${path}/package.json`, import.meta.url),
          "utf8",
        ),
      ).version;
    } catch {
      versions[name] = "unavailable (no installed package observed)";
    }
  }
  const flags = Object.fromEntries(
    [
      "CI",
      "GITHUB_ACTIONS",
      "RUNNER_ENVIRONMENT",
      "BL_EXECUTION_POLICY",
      "BL_TEST_PROFILE",
      "BL_LOCAL_RESOURCE_CONFIG",
    ]
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  );
  const conflicts = [];
  if (env.CI === "true" && !plan?.hosted)
    conflicts.push(
      "CI=true enables test semantics only; local admission and worker limits still apply.",
    );
  conflicts.push(...(plan?.messages ?? []));
  if (env.BL_LOCAL_RESOURCE_CONFIG === "")
    conflicts.push(
      "An empty config override is rejected; it cannot disable the machine policy.",
    );
  return {
    version: 1,
    os: {
      platform: platform(),
      release: release(),
      environment:
        platform() === "win32"
          ? "native Windows"
          : env.WSL_DISTRO_NAME || /microsoft/i.test(release())
            ? "WSL (separate process accounting)"
            : "POSIX; container status not established",
    },
    tools: {
      node: process.version,
      pnpm:
        /pnpm\/([^ ]+)/.exec(env.npm_config_user_agent ?? "")?.[1] ?? "unknown",
      ...versions,
    },
    memory,
    config: config ? { ...config, path: await canonical(config.path) } : null,
    stateDirectory: await canonical(directory),
    tickets,
    reservations: workloads,
    workers: plan
      ? {
          vitest: plan.workers,
          playwright: plan.browserWorkers,
          workspace: plan.workspaceConcurrency,
          rootWorkloads: plan.config.maxRoots,
        }
      : null,
    flags,
    conflicts,
    waitingReason:
      "Updated waiting tickets report their reason; older tickets may not contain one. Compare available memory with the next workload plus reserve.",
    limitations: [
      "Read-only snapshot; PID liveness and complete owned process trees are not established.",
      "Reservations are estimates, not memory limits. No pressure watchdog in this revision.",
      "Native Windows and WSL/container workloads must not run concurrently on this host.",
    ],
    errors: [...errors, ...memory.errors],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const report = await resourceReport();
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.errors.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
