import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireResources,
  inheritedLease,
  publish,
  workloadFor,
} from "./resource-admission.mjs";
import { runCommand } from "./process-runner.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "test admission "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    env: { BL_LOCAL_RESOURCE_CONFIG: "" },
    pollMs: 5,
    freeMemory: () => 16 * 1024 ** 3,
  };
}
const small = { workers: 1, memoryGiB: 1, browsers: 0 };

test("docs builds use a fixed one-worker reservation smaller than application builds", () => {
  const docs = { workers: 1, browsers: 0, memoryGiB: 1.5 };
  assert.deepEqual(workloadFor("docs", {}), docs);
  assert.deepEqual(workloadFor("docs", { BL_TEST_PROFILE: "fast" }), docs);
  assert.deepEqual(workloadFor("build", {}), {
    workers: 2,
    browsers: 0,
    memoryGiB: 2,
  });
});

test("Node tooling uses a small fixed reservation in shared and fast modes", () => {
  const tooling = { workers: 1, browsers: 0, memoryGiB: 0.75 };
  assert.deepEqual(workloadFor("tooling", {}), tooling);
  assert.deepEqual(
    workloadFor("tooling", { BL_TEST_PROFILE: "fast" }),
    tooling,
  );
});

test("routine typechecks and selected test files fit concurrent shared agents", () => {
  const typecheck = { workers: 1, browsers: 0, memoryGiB: 1.5 };
  assert.deepEqual(workloadFor("typecheck", {}), typecheck);
  assert.deepEqual(
    workloadFor("typecheck", { BL_TEST_PROFILE: "fast" }),
    typecheck,
  );
  assert.deepEqual(workloadFor("focused", {}), typecheck);
  assert.deepEqual(workloadFor("focused", { BL_TEST_PROFILE: "fast" }), {
    workers: 2,
    browsers: 0,
    memoryGiB: 3,
  });
});

test("shared browser work fits a six-GiB host budget while retaining headroom", async (t) => {
  const options = await fixture(t);
  const lease = await acquireResources(workloadFor("browser", {}), {
    ...options,
    freeMemory: () => 6 * 1024 ** 3,
    timeoutMs: 1000,
  });
  await lease.release();
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("application builds fit a six-GiB host budget while retaining headroom", async (t) => {
  const options = await fixture(t);
  const lease = await acquireResources(workloadFor("build", {}), {
    ...options,
    freeMemory: () => 6 * 1024 ** 3,
    timeoutMs: 1000,
  });
  await lease.release();
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("fast browser runs queue when overlapping work would exceed the memory budget", async (t) => {
  const options = await fixture(t);
  const fast = workloadFor("browser", { BL_TEST_PROFILE: "fast" });
  assert.deepEqual(fast, { workers: 2, browsers: 1, memoryGiB: 4 });
  assert.equal(workloadFor("dom", {}).workers, 1);
  assert.throws(
    () => workloadFor("dom", { BL_TEST_PROFILE: "unbounded" }),
    /profile/i,
  );
  const first = await acquireResources({ ...small, memoryGiB: 3 }, options);
  let queued;
  const observed = new Promise((resolve) => {
    queued = resolve;
  });
  let admitted = false;
  const pending = acquireResources(fast, { ...options, onQueued: queued }).then(
    (lease) => {
      admitted = true;
      return lease;
    },
  );
  await observed;
  assert.equal(admitted, false);
  await first.release();
  await (await pending).release();
});

test("a transient Windows replacement lock retains the old reservation until atomic publication", async (t) => {
  const options = await fixture(t);
  const path = join(options.directory, "ticket.json");
  const previous = { active: true, childPid: null };
  const next = { active: true, childPid: 42 };
  await writeFile(path, JSON.stringify(previous));
  let attempts = 0;
  await publish(path, next, async (from, to) => {
    assert.deepEqual(JSON.parse(await readFile(to, "utf8")), previous);
    if (++attempts < 3)
      throw Object.assign(new Error("file is open"), { code: "EPERM" });
    await rename(from, to);
  });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
  assert.deepEqual(await readdir(options.directory), ["ticket.json"]);
  let failures = 0;
  await assert.rejects(
    publish(path, previous, async () => {
      failures++;
      throw Object.assign(new Error("I/O failed"), { code: "EIO" });
    }),
    { code: "EIO" },
  );
  assert.equal(failures, 1);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
  assert.deepEqual(await readdir(options.directory), ["ticket.json"]);
});

test("four independent callers admit three shared workers and preserve FIFO progress", async (t) => {
  const options = await fixture(t);
  const events = [];
  let active = 0,
    peak = 0;
  let filled;
  const firstWave = new Promise((resolve) => {
    filled = resolve;
  });
  await Promise.all(
    [0, 1, 2, 3].map(async (id) => {
      const lease = await acquireResources(small, options);
      events.push(id);
      peak = Math.max(peak, ++active);
      if (active === 3) filled();
      await firstWave;
      active--;
      await lease.release();
    }),
  );
  assert.equal(peak, 3);
  assert.deepEqual([...events].sort(), [0, 1, 2, 3]);
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("lightweight work can bypass blocked older work only three times across processes", async (t) => {
  const options = await fixture(t);
  const browser = workloadFor("browser", {});
  const first = await acquireResources(browser, options);
  const abort = new AbortController();
  let reportQueued;
  const queued = new Promise((resolve) => { reportQueued = resolve; });
  const older = acquireResources(browser, {
    ...options,
    signal: abort.signal,
    onQueued: reportQueued,
  });
  // Keep rejection handled if a failed assertion cancels the queued owner.
  older.catch(() => {});
  const moduleUrl = new URL("./resource-admission.mjs", import.meta.url).href;
  const script = `import {acquireResources} from ${JSON.stringify(moduleUrl)};
    try {
      const lease = await acquireResources(
        {workers:1,browsers:0,memoryGiB:0.75},
        {directory:process.argv[1],env:{BL_LOCAL_RESOURCE_CONFIG:''},pollMs:5,timeoutMs:500,freeMemory:()=>16*1024**3});
      await lease.release();
      process.stdout.write('admitted');
    } catch (error) {
      if (!/deadline expired/.test(error.message)) throw error;
      process.stdout.write('queued');
    }`;
  try {
    await queued;
    for (const expected of ["admitted", "admitted", "admitted", "queued"]) {
      const result = await runCommand(
        process.execPath,
        ["--input-type=module", "-e", script, options.directory],
        { capture: true },
      );
      assert.equal(result.code, 0, result.output);
      assert.equal(result.output.trim(), expected);
    }
    // Protection does not prevent the old request progressing once it fits.
    await first.release();
    await (await older).release();
  } finally {
    abort.abort();
    await first.release();
    await (await older.catch(() => null))?.release();
  }
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("a fitting older ticket retains priority even when its owner is not polling", async (t) => {
  const options = await fixture(t);
  const queue = join(options.directory, "queue");
  await mkdir(queue, { recursive: true });
  // Older agents publish this shape without a bypass counter.
  await publish(join(queue, "0000000000000000-older.json"), {
    pid: process.pid,
    token: "older",
    request: small,
    active: false,
  });
  await assert.rejects(
    acquireResources(workloadFor("tooling", {}), { ...options, timeoutMs: 100 }),
    /deadline expired/,
  );
  await rm(join(queue, "0000000000000000-older.json"));
  await (await acquireResources(small, options)).release();
});

test("another heavy request cannot bypass an unfit older request", async (t) => {
  const options = await fixture(t);
  const browser = workloadFor("browser", {});
  const first = await acquireResources(browser, options);
  const abort = new AbortController();
  let reportQueued;
  const queued = new Promise((resolve) => { reportQueued = resolve; });
  const older = acquireResources(browser, {
    ...options,
    signal: abort.signal,
    onQueued: reportQueued,
  });
  older.catch(() => {});
  try {
    await queued;
    await assert.rejects(
      acquireResources(workloadFor("dom", {}), { ...options, timeoutMs: 100 }),
      /deadline expired/,
    );
  } finally {
    abort.abort();
    await first.release();
    await (await older.catch(() => null))?.release();
  }
});

test("machine low-memory settings serialize heavy phases while lightweight work still fits", async (t) => {
  const options = await fixture(t);
  const config = join(options.directory, "machine.json");
  await writeFile(config, JSON.stringify({
    version: 1,
    profile: "low-memory",
    reserveGiB: 3,
    maxHeavy: 1,
    maxBypasses: 3,
  }));
  options.env = { BL_LOCAL_RESOURCE_CONFIG: config };
  const first = await acquireResources(workloadFor("dom", {}), options);
  const abort = new AbortController();
  let reportQueued;
  const queued = new Promise((resolve) => { reportQueued = resolve; });
  let admitted = false;
  const pending = acquireResources(workloadFor("browser", {}), {
    ...options,
    signal: abort.signal,
    onQueued: reportQueued,
  }).then((lease) => {
    admitted = true;
    return lease;
  });
  pending.catch(() => {});
  try {
    await Promise.race([queued, pending]);
    assert.equal(admitted, false, "a second heavy phase must wait for the first");
    const light = await acquireResources(workloadFor("tooling", {}), {
      ...options,
      timeoutMs: 1000,
    });
    await light.release();
    assert.equal(admitted, false);
    await first.release();
    await (await pending).release();
  } finally {
    abort.abort();
    await first.release();
    await (await pending.catch(() => null))?.release();
  }
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("a queued browser cannot exceed the browser cap and cancellation releases its ticket", async (t) => {
  const options = await fixture(t);
  const browser = { ...small, browsers: 1 };
  const first = await acquireResources(browser, options);
  const abort = new AbortController();
  const queued = acquireResources(browser, {
    ...options,
    signal: abort.signal,
  });
  const rejection = assert.rejects(queued, /cancel/i);
  await delay(20);
  abort.abort();
  await rejection;
  await first.release();
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("memory pressure queues work until the request fits above the host reserve", async (t) => {
  const options = await fixture(t);
  let free = 4.5 * 1024 ** 3;
  let admitted = false;
  let reportQueued;
  const queued = new Promise((resolve) => {
    reportQueued = resolve;
  });
  const pending = acquireResources(small, {
    ...options,
    freeMemory: () => free,
    onQueued: reportQueued,
  }).then((lease) => {
    admitted = true;
    return lease;
  });
  await Promise.race([queued, pending]);
  assert.equal(admitted, false);
  free = 5 * 1024 ** 3;
  await (await pending).release();
});

test("abandoned tickets do not block work; an impossible request fails immediately", async (t) => {
  const options = await fixture(t);
  const first = await acquireResources(small, options);
  await first.release();
  await writeFile(
    join(options.directory, "queue", "000-dead.json"),
    JSON.stringify({ pid: 2147483647, request: small, active: true }),
  );
  const lease = await acquireResources(small, options);
  await lease.release();
  await assert.rejects(
    acquireResources({ ...small, workers: 4 }, options),
    /capacity/,
  );
});

test("separate processes share one browser budget and release all tickets", async (t) => {
  const options = await fixture(t);
  const eventsPath = join(options.directory, "events.jsonl");
  const moduleUrl = new URL("./resource-admission.mjs", import.meta.url).href;
  const script = `import {acquireResources} from ${JSON.stringify(moduleUrl)};
    import {appendFile} from 'node:fs/promises';
    import {setTimeout as delay} from 'node:timers/promises';
    const lease = await acquireResources({workers:1,browsers:1,memoryGiB:1}, {directory:process.argv[1],env:{BL_LOCAL_RESOURCE_CONFIG:''},pollMs:5,freeMemory:()=>16*1024**3});
    await appendFile(process.argv[2], JSON.stringify({event:'start',pid:process.pid})+'\\n');
    await delay(30);
    await appendFile(process.argv[2], JSON.stringify({event:'end',pid:process.pid})+'\\n');
    await lease.release();`;
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      runCommand(
        process.execPath,
        ["--input-type=module", "-e", script, options.directory, eventsPath],
        { capture: true },
      ),
    ),
  );
  for (const result of results) assert.equal(result.code, 0, result.output);
  let active = 0;
  const rows = (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const row of rows) {
    active += row.event === "start" ? 1 : -1;
    assert.ok(active >= 0 && active <= 1);
  }
  assert.equal(rows.length, 8);
  assert.equal(active, 0);
  assert.deepEqual(await readdir(join(options.directory, "queue")), []);
});

test("nested commands reuse only a live lease with a matching token and sufficient capacity", async (t) => {
  const options = await fixture(t);
  const lease = await acquireResources(small, options);
  const value = JSON.stringify({ ticket: lease.ticket, token: lease.token });
  assert.equal(await inheritedLease(value, small), true);
  assert.equal(
    await inheritedLease(
      JSON.stringify({ ticket: lease.ticket, token: "wrong" }),
      small,
    ),
    false,
  );
  assert.equal(await inheritedLease(value, { ...small, browsers: 1 }), false);
  await lease.release();
  assert.equal(await inheritedLease(value, small), false);
});
