import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { freemem, tmpdir, homedir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_RESOURCE_CAPACITY,
  readLocalResourceConfig,
} from "./local-resource-config.mjs";

export function resourceStateDirectory(
  env = process.env,
  platform = process.platform,
) {
  // Retain the existing v1 namespace at the normal per-user Windows TEMP path.
  // Shell-specific TEMP/TMP values must not create independent coordinators.
  return resolve(
    platform === "win32"
      ? join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Temp")
      : tmpdir(),
    "babylonslate-test-admission-v1",
  );
}
export const admissionDirectory = resourceStateDirectory();
export const capacity = DEFAULT_RESOURCE_CAPACITY;
const standardPolicy = { capacity, maxHeavy: 3, maxRoots: 3, maxBypasses: 3 };
export const workloads = {
  tooling: { workers: 1, browsers: 0, memoryGiB: 0.75 },
  unit: { workers: 1, browsers: 0, memoryGiB: 1.5 },
  focused: { workers: 1, browsers: 0, memoryGiB: 1.5 },
  typecheck: { workers: 1, browsers: 0, memoryGiB: 1.5 },
  dom: { workers: 1, browsers: 0, memoryGiB: 2 },
  coverage: { workers: 1, browsers: 0, memoryGiB: 3 },
  docs: { workers: 1, browsers: 0, memoryGiB: 1.5 },
  build: { workers: 2, browsers: 0, memoryGiB: 2 },
  browser: { workers: 1, browsers: 1, memoryGiB: 2 },
};

/** Fast mode reserves two worker slots; the browser slot counts admitted commands. */
export function workloadFor(name, env = process.env) {
  const request = workloads[name];
  if (!request) throw new Error(`Unknown workload: ${name}`);
  const profile = env.BL_TEST_PROFILE ?? "shared";
  if (!["shared", "fast"].includes(profile))
    throw new Error(`Unknown test profile: ${profile}`);
  if (
    profile === "shared" ||
    ["tooling", "typecheck", "docs", "build"].includes(name) ||
    env.BL_EXECUTION_POLICY === "hosted-ci"
  )
    return { ...request };
  return { ...request, workers: 2, memoryGiB: request.memoryGiB * 2 };
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function isHeavy(request) {
  return request.workers >= 2 || request.memoryGiB >= 2 || request.browsers > 0;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Atomic publication prevents readers observing a partially written owner. */
export async function publish(path, value, replace = rename) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
    const deadline = Date.now() + 1000;
    for (;;) {
      try {
        await replace(temporary, path);
        break;
      } catch (error) {
        if (
          !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
          Date.now() >= deadline
        )
          throw error;
        // Windows readers/antivirus can briefly deny replacement. Keep the last
        // published reservation intact until the atomic rename succeeds.
        await delay(25);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function locked(directory, check, operation) {
  const path = join(directory, "lock");
  for (;;) {
    check();
    let handle;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if (["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
        await delay(20);
        continue;
      }
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = await readJson(path);
      } catch (readError) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(readError.code))
          throw readError;
        // A Windows sharing denial does not prove the lock is abandoned.
        // Retry through the outer cancellation/deadline check before inspecting it.
        await delay(20);
        continue;
      }
      // A killed owner may leave a lock; an unpublished owner gets a grace period.
      let age = 0;
      try {
        age = Date.now() - (await stat(path)).mtimeMs;
      } catch {
        continue;
      }
      if ((owner && !alive(owner.pid)) || (!owner && age > 10_000))
        await rm(path, { force: true });
      else await delay(20);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return await operation();
    } finally {
      await handle.close();
      await rm(path, { force: true });
    }
  }
}

/** Per-user admission shared by every worktree. Limits are reservations, not OS quotas. */
export async function acquireResources(request, options = {}) {
  const directory = options.directory ?? admissionDirectory;
  if (!options.directory && process.platform === "win32") {
    const legacy = resolve(tmpdir(), "babylonslate-test-admission-v1", "queue");
    if (legacy.toLowerCase() !== join(directory, "queue").toLowerCase()) {
      const entries = await readdir(legacy).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (entries.some((file) => file.endsWith(".json")))
        throw new Error(
          "A different TEMP directory contains legacy admission tickets; quiesce those runs before using the canonical per-user queue",
        );
    }
  }
  const config =
    options.config ??
    (options.capacity
      ? { ...standardPolicy, capacity: options.capacity }
      : await readLocalResourceConfig(options.env ?? process.env));
  request = {
    ...request,
    ...(config.profile === "low-memory"
      ? { workers: config.capacity.workers }
      : {}),
  };
  const policy = {
    capacity: { ...config.capacity },
    maxHeavy: config.maxHeavy,
    maxRoots: config.maxRoots ?? 3,
    maxBypasses: config.maxBypasses,
  };
  const limits = policy.capacity;
  for (const key of ["workers", "browsers", "memoryGiB"]) {
    if (
      !Number.isFinite(request[key]) ||
      request[key] < 0 ||
      request[key] > limits[key]
    )
      throw new Error(`Request exceeds ${key} capacity`);
  }
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 2 * 60 * 60 * 1000);
  const check = () => {
    if (options.signal?.aborted) throw new Error("Resource wait cancelled");
    if (Date.now() >= deadline)
      throw new Error("Resource wait deadline expired");
  };
  const queue = join(directory, "queue");
  await mkdir(queue, { recursive: true });
  const token = randomUUID();
  let ticket;
  await locked(directory, check, async () => {
    // Sequence allocation shares the admission lock: stable age even within one millisecond.
    const counterPath = join(directory, "sequence.json");
    const sequence = ((await readJson(counterPath))?.value ?? 0) + 1;
    await publish(counterPath, { value: sequence });
    ticket = join(queue, `${String(sequence).padStart(16, "0")}-${token}.json`);
    await publish(ticket, {
      pid: process.pid,
      token,
      request,
      active: false,
      bypasses: 0,
      policy,
    });
  });
  let announced = false;
  let waitingReason = "Waiting for an older queued workload";
  try {
    for (;;) {
      check();
      const admitted = await locked(directory, check, async () => {
        const rows = [];
        for (const name of (await readdir(queue))
          .filter((file) => file.endsWith(".json"))
          .sort()) {
          const path = join(queue, name),
            row = await readJson(path);
          if (!row)
            throw new Error(
              `Unreadable admission ticket: ${path}; ownership must be established before retrying`,
            );
          if (!alive(row.pid) && !alive(row.childPid)) {
            // Updated roots retain uncertain ownership after abrupt death.
            // Never assume a dead immediate parent proves its whole tree exited.
            if (row.active && row.ownershipVersion === 2)
              throw new Error(
                `Uncertain owned process cleanup: ${path}; inspect the stopped run before releasing its reservation`,
              );
            await rm(path, { force: true });
            continue;
          }
          rows.push({ ...row, path });
        }
        const active = rows.filter((row) => row.active);
        const waiting = rows.filter((row) => !row.active);
        const position = waiting.findIndex((row) => row.path === ticket);
        if (position < 0) return false;
        const keys = ["workers", "browsers", "memoryGiB"];
        const used = Object.fromEntries(
          keys.map((key) => [
            key,
            active.reduce((sum, row) => sum + row.request[key], 0),
          ]),
        );
        const heavyCount = active.filter((row) => isHeavy(row.request)).length;
        const freeMemory = (
          options.freeMemory ?? (() => process.availableMemory?.() ?? freemem())
        )();
        const effectiveLimit =
          options.memoryLimit?.() ??
          Math.min(totalmem(), process.constrainedMemory?.() || Infinity);
        const currentConfig = options.capacity
          ? config
          : await readLocalResourceConfig(options.env ?? process.env);
        const restrictive = (candidatePolicy) => {
          const policies = [
            candidatePolicy,
            currentConfig,
            ...active.map((row) => row.policy ?? standardPolicy),
          ];
          return {
            capacity: {
              ...Object.fromEntries(
                keys.map((key) => [
                  key,
                  Math.min(...policies.map((value) => value.capacity[key])),
                ]),
              ),
              reserveGiB: Math.max(
                ...policies.map((value) => value.capacity.reserveGiB),
              ),
            },
            maxRoots: Math.min(...policies.map((value) => value.maxRoots ?? 3)),
            maxHeavy: Math.min(...policies.map((value) => value.maxHeavy)),
            maxBypasses: Math.min(
              ...policies.map((value) => value.maxBypasses),
            ),
          };
        };
        const fits = (candidate, originalPolicy) => {
          const candidatePolicy = restrictive(originalPolicy);
          // Until resident usage is measured, reserve the complete unallocated
          // promise conservatively. This may queue more work, never less.
          const requiredGiB =
            candidatePolicy.capacity.reserveGiB +
            candidate.memoryGiB +
            used.memoryGiB;
          return (
            Number.isFinite(freeMemory) &&
            freeMemory > 0 &&
            active.length < candidatePolicy.maxRoots &&
            keys.every(
              (key) =>
                used[key] + candidate[key] <= candidatePolicy.capacity[key],
            ) &&
            (!isHeavy(candidate) || heavyCount < candidatePolicy.maxHeavy) &&
            used.memoryGiB + candidate.memoryGiB <=
              effectiveLimit / 1024 ** 3 -
                candidatePolicy.capacity.reserveGiB &&
            freeMemory >= requiredGiB * 1024 ** 3
          );
        };
        if (!fits(request, policy)) {
          waitingReason = active.length
            ? "Active owned workload or reserved capacity"
            : "Insufficient or unknown available memory above host reserve";
          await publish(ticket, {
            ...rows.find((row) => row.path === ticket),
            path: undefined,
            waitingReason,
          });
          return false;
        }
        const older = waiting.slice(0, position);
        if (
          older.length &&
          (isHeavy(request) ||
            older.some((row) => {
              // Waiting commands retain the policy they started with. Tickets
              // from older schedulers used the standard four-GiB headroom.
              const olderPolicy = row.policy ?? standardPolicy;
              return (
                fits(row.request, olderPolicy) ||
                (row.bypasses ?? 0) >= olderPolicy.maxBypasses
              );
            }))
        )
          return false;
        // Only light work may use otherwise idle capacity. Charge every older
        // ticket before admission so independent processes share starvation protection.
        for (const row of older) {
          const { path, ...value } = row;
          await publish(path, { ...value, bypasses: (row.bypasses ?? 0) + 1 });
        }
        await publish(ticket, {
          pid: process.pid,
          token,
          request,
          active: true,
          policy: {
            ...restrictive(policy),
            maxBypasses: Math.min(
              policy.maxBypasses,
              currentConfig.maxBypasses,
            ),
          },
          ...(options.owned ? { ownershipVersion: 2, scopes: [] } : {}),
        });
        return true;
      });
      if (admitted) break;
      if (!announced) {
        options.onQueued?.({
          reason: waitingReason,
          request,
          reserveGiB: policy.capacity.reserveGiB,
        });
        announced = true;
      }
      await delay(options.pollMs ?? 1000);
    }
    return {
      token,
      ticket,
      request,
      queueMs: Date.now() - started,
      async child(pid) {
        await locked(directory, check, async () => {
          const row = await readJson(ticket);
          if (row?.token !== token)
            throw new Error(
              "Resource ownership changed before child registration",
            );
          await publish(ticket, { ...row, childPid: pid });
        });
      },
      async release() {
        const releaseDeadline = Date.now() + 10_000;
        await locked(
          directory,
          () => {
            if (Date.now() > releaseDeadline)
              throw new Error(
                "Resource release deadline expired; reservation retained",
              );
          },
          async () => {
            const row = await readJson(ticket);
            if (row?.scopes?.length)
              throw new Error(
                "Owned nested stages remain; reservation retained",
              );
            if (options.owned && row?.childPid && alive(row.childPid))
              throw new Error(
                "Owned child cleanup is uncertain; reservation retained",
              );
            await rm(ticket, { force: true });
          },
        );
      },
    };
  } catch (error) {
    await rm(ticket, { force: true });
    throw error;
  }
}

export async function inheritedLease(value, request) {
  if (!value) return false;
  try {
    const { ticket, token } = JSON.parse(value);
    const row = await readJson(ticket);
    return Boolean(
      row?.active &&
      row.token === token &&
      alive(row.pid) &&
      ["workers", "browsers", "memoryGiB"].every(
        (key) => request[key] <= row.request[key],
      ),
    );
  } catch {
    return false;
  }
}

/** Nested stages are sequential within each inherited scope, with no upgrades. */
export async function claimInheritedLease(value, request) {
  if (!value) return null;
  const { ticket, token, scope = token } = JSON.parse(value);
  const directory = resolve(ticket, "../..");
  const id = randomUUID();
  const deadline = Date.now() + 10_000;
  const check = () => {
    if (Date.now() > deadline)
      throw new Error(
        "Nested ownership lock deadline expired; reservation retained",
      );
  };
  await locked(directory, check, async () => {
    const row = await readJson(ticket);
    if (!row?.active || row.token !== token || !alive(row.pid))
      throw new Error("Inherited resource ownership is stale or invalid");
    const scopes = row.scopes ?? [];
    if (scope !== token && !scopes.some((item) => item.id === scope))
      throw new Error("Inherited execution scope is stale");
    const parentRequest =
      scope === token
        ? row.request
        : scopes.find((item) => item.id === scope).request;
    if (
      !["workers", "browsers", "memoryGiB"].every(
        (key) => request[key] <= parentRequest[key],
      )
    )
      throw new Error(
        "Nested workload exceeds its inherited reservation; release the parent before acquiring a larger workload",
      );
    if (scopes.some((item) => item.parent === scope))
      throw new Error(
        "Parallel nested workloads cannot share one execution budget",
      );
    await publish(ticket, {
      ...row,
      scopes: [...scopes, { id, parent: scope, pid: process.pid, request }],
    });
  });
  return {
    ticket,
    token,
    scope: id,
    async child(pid) {
      await locked(directory, check, async () => {
        const row = await readJson(ticket);
        if (row?.token !== token)
          throw new Error("Inherited ownership disappeared");
        await publish(ticket, {
          ...row,
          scopes: row.scopes.map((item) =>
            item.id === id ? { ...item, childPid: pid } : item,
          ),
        });
      });
    },
    async release() {
      const releaseDeadline = Date.now() + 10_000;
      await locked(
        directory,
        () => {
          if (Date.now() > releaseDeadline)
            throw new Error(
              "Nested release deadline expired; reservation retained",
            );
        },
        async () => {
          const row = await readJson(ticket);
          if (row?.token !== token)
            throw new Error("Inherited ownership disappeared");
          if (row.scopes.some((item) => item.parent === id))
            throw new Error(
              "Nested descendants still own the execution budget",
            );
          const childPid = row.scopes.find((item) => item.id === id)?.childPid;
          if (childPid && alive(childPid))
            throw new Error(
              "Nested child cleanup is uncertain; reservation retained",
            );
          await publish(ticket, {
            ...row,
            scopes: row.scopes.filter((item) => item.id !== id),
          });
        },
      );
    },
  };
}
