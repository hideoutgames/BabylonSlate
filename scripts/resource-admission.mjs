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
import { freemem, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const admissionDirectory = join(
  tmpdir(),
  "babylonslate-test-admission-v1",
);
export const capacity = {
  workers: 2,
  browsers: 1,
  memoryGiB: 6,
  reserveGiB: 4,
};
export const workloads = {
  unit: { workers: 1, browsers: 0, memoryGiB: 1.5 },
  dom: { workers: 1, browsers: 0, memoryGiB: 2 },
  coverage: { workers: 1, browsers: 0, memoryGiB: 3 },
  build: { workers: 2, browsers: 0, memoryGiB: 4 },
  browser: { workers: 1, browsers: 1, memoryGiB: 3 },
};

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
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
      if (error.code !== "EEXIST") throw error;
      const owner = await readJson(path);
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
  const limits = options.capacity ?? capacity;
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
    // Sequence allocation is inside the same lock as admission: FIFO even within one millisecond.
    const counterPath = join(directory, "sequence.json");
    const sequence = ((await readJson(counterPath))?.value ?? 0) + 1;
    await publish(counterPath, { value: sequence });
    ticket = join(queue, `${String(sequence).padStart(16, "0")}-${token}.json`);
    await publish(ticket, { pid: process.pid, token, request, active: false });
  });
  let announced = false;
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
          if (!row || (!alive(row.pid) && !alive(row.childPid))) {
            await rm(path, { force: true });
            continue;
          }
          rows.push({ ...row, path });
        }
        if (rows.find((row) => !row.active)?.path !== ticket) return false;
        const active = rows.filter((row) => row.active);
        if (
          ["workers", "browsers", "memoryGiB"].some(
            (key) =>
              active.reduce(
                (sum, row) => sum + row.request[key],
                request[key],
              ) > limits[key],
          )
        )
          return false;
        if ((options.freeMemory ?? freemem)() < limits.reserveGiB * 1024 ** 3)
          return false;
        await publish(ticket, {
          pid: process.pid,
          token,
          request,
          active: true,
        });
        return true;
      });
      if (admitted) break;
      if (!announced) {
        options.onQueued?.();
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
        await publish(ticket, {
          pid: process.pid,
          childPid: pid,
          token,
          request,
          active: true,
        });
      },
      async release() {
        await rm(ticket, { force: true });
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
