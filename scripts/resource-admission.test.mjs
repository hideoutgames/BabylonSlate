import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
  return { directory, pollMs: 5, freeMemory: () => 16 * 1024 ** 3 };
}
const small = { workers: 1, memoryGiB: 1, browsers: 0 };

test("fast runs reserve both workers and cannot overlap another admitted workload", async (t) => {
  const options = await fixture(t);
  const fast = workloadFor("browser", { BL_TEST_PROFILE: "fast" });
  assert.deepEqual(fast, { workers: 2, browsers: 1, memoryGiB: 6 });
  assert.equal(workloadFor("dom", {}).workers, 1);
  assert.throws(
    () => workloadFor("dom", { BL_TEST_PROFILE: "unbounded" }),
    /profile/i,
  );
  const first = await acquireResources(small, options);
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

test("four independent callers respect capacity and progress in FIFO order", async (t) => {
  const options = await fixture(t);
  const events = [];
  let active = 0,
    peak = 0;
  let filled;
  const firstPair = new Promise((resolve) => {
    filled = resolve;
  });
  await Promise.all(
    [0, 1, 2, 3].map(async (id) => {
      const lease = await acquireResources(small, options);
      events.push(id);
      peak = Math.max(peak, ++active);
      if (active === 2) filled();
      await firstPair;
      active--;
      await lease.release();
    }),
  );
  assert.equal(peak, 2);
  assert.deepEqual([...events].sort(), [0, 1, 2, 3]);
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
    acquireResources({ ...small, workers: 3 }, options),
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
    const lease = await acquireResources({workers:1,browsers:1,memoryGiB:1}, {directory:process.argv[1],pollMs:5,freeMemory:()=>16*1024**3});
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
