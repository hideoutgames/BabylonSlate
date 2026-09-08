import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

async function fixture(t, action = "success") {
  const cwd = await mkdtemp(join(tmpdir(), "agent wait fixture "));
  await writeFile(join(cwd, ".gitignore"), "gh-state.json\n");
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        verify: "node fixture.mjs",
        test: "node fixture.mjs",
      },
    }),
  );
  await writeFile(
    join(cwd, "fixture.mjs"),
    `
import { writeFileSync } from 'node:fs';
console.log(JSON.stringify({args:process.argv.slice(2), inherited:process.env.WAIT_FIXTURE_VALUE}));
const action = process.env.WAIT_FIXTURE_ACTION;
if (action === 'large') { for (let i=0;i<5000;i++) console.log(i + ' héllo 🌍 '.repeat(20)); process.exitCode=7; }
if (action === 'fail') { console.error('fixture failure'); process.exitCode=9; }
if (action === 'change') writeFileSync('source.txt', 'changed');
if (action === 'untracked') writeFileSync('new-source.txt', 'new');
if (action === 'commit') {
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Changed head']);
}
if (action === 'slow-success') { for(let i=0;i<10;i++) { console.log('tick '+i); await new Promise(resolve=>setTimeout(resolve,100)); } }
if (action === 'tree') {
  const { spawn } = await import('node:child_process');
  const child=spawn(process.execPath,['-e',"setInterval(()=>console.log('descendant alive'),30)"],{stdio:'inherit'});
  console.log('descendant-pid='+child.pid);
  setInterval(()=>{},100);
}
if (action === 'slow') { console.log('ready'); setInterval(() => console.log('quiet heartbeat 🌍'), 30); }
`,
  );
  await writeFile(join(cwd, "source.txt"), "original");
  const git = (...args) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Fixture",
  );
  let output = "";
  const env = {
    ...process.env,
    WAIT_FIXTURE_ACTION: action,
    WAIT_FIXTURE_VALUE: "preserved 🌍",
  };
  const context = {
    cwd,
    env,
    write: (chunk) => {
      output += chunk;
    },
    pollMs: 30,
    discoveryMs: 250,
  };
  return { cwd, env, context, git, output: () => output };
}

async function run(options, context) {
  const { runAgentWait } = await import("./agent-wait.mjs");
  return runAgentWait(options, context);
}
const local = { mode: "local", script: "verify", args: [], timeoutMs: 10000 };

test("local preserves argument boundaries, environment, commit, and bounded output in a path with spaces", async (t) => {
  const f = await fixture(t);
  const result = await run(
    { ...local, args: ["test filter with spaces", "🌍", "--reporter=dot"] },
    f.context,
  );
  assert.equal(result.status, "success");
  assert.equal(result.exitCode, 0);
  assert.equal(result.commitSha, f.git("rev-parse", "HEAD"));
  assert.equal(result.deliveryEligible, false); // Forwarded filters cannot certify full verification.
  assert.equal(result.initialState.digest, result.finalState.digest);
  assert.ok(Buffer.byteLength(f.output()) < 1024);
  assert.equal(f.output().trim().split("\n").length, 2);
  const log = await readFile(result.logPath, "utf8");
  const actual = JSON.parse(
    log.split("\n").find((line) => line.startsWith('{"args":')),
  );
  assert.deepEqual(actual.args, [
    "test filter with spaces",
    "🌍",
    "--reporter=dot",
  ]);
  assert.equal(actual.inherited, "preserved 🌍");
  assert.equal(
    JSON.parse(await readFile(result.resultPath, "utf8")).exitCode,
    0,
  );
});

test("unfiltered verification certifies a clean unchanged commit", async (t) => {
  const f = await fixture(t);
  const result = await run(local, f.context);
  assert.equal(result.status, "success");
  assert.equal(result.deliveryEligible, true);
});

test("local retains recursive package diagnostics with a silent parent reporter", async (t) => {
  const f = await fixture(t, "fail");
  await writeFile(
    join(f.cwd, "package.json"),
    JSON.stringify({ scripts: { verify: "pnpm -r typecheck" } }),
  );
  await writeFile(
    join(f.cwd, "pnpm-workspace.yaml"),
    "packages:\n  - fixture-*\n",
  );
  for (const name of ["fixture-package", "fixture-other"]) {
    await mkdir(join(f.cwd, name));
    await writeFile(
      join(f.cwd, name, "package.json"),
      JSON.stringify({ name, scripts: { typecheck: "node ../fixture.mjs" } }),
    );
  }
  f.env.npm_config_reporter = "silent";
  // Nested pnpm processes and the final Git snapshot need startup headroom on
  // contended hosts; this case checks diagnostics, not deadline enforcement.
  const result = await run({ ...local, timeoutMs: 60000 }, f.context);
  assert.equal(result.status, "failure");
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.deliveryEligible, false);
  const log = await readFile(result.logPath, "utf8");
  assert.match(log, /"inherited":"preserved 🌍"/);
  assert.match(log, /fixture failure/);
  assert.ok(
    log.lastIndexOf('["git","rev-parse","HEAD"]') >
      log.indexOf("fixture failure"),
    "final snapshot metadata follows the complete child output",
  );
});

for (const [action, code] of [
  ["fail", 9],
  ["large", 7],
]) {
  test(`local ${action} preserves failure code with bounded Unicode tail and complete disk log`, async (t) => {
    const f = await fixture(t, action);
    const result = await run(local, f.context);
    assert.equal(result.status, "failure");
    assert.equal(result.exitCode, code);
    assert.ok(Buffer.byteLength(f.output()) < 5120);
    assert.ok(f.output().trim().split("\n").length <= 43);
    assert.ok(!f.output().includes("\uFFFD"));
    const log = await readFile(result.logPath, "utf8");
    if (action === "large") {
      assert.ok(log.length > 1000000);
      assert.match(log, /4999 héllo/);
    } else assert.match(log, /fixture failure/);
  });
}

test("missing package-manager entry point reports a prerequisite failure", async (t) => {
  const f = await fixture(t);
  f.env.npm_execpath = join(f.cwd, "missing pnpm.cjs");
  const result = await run(local, f.context);
  assert.equal(result.status, "failure");
  assert.notEqual(result.exitCode, 0);
  assert.match(result.message, /pnpm|package.manager/i);
});

test("other scripts do not qualify as full verification", async (t) => {
  const f = await fixture(t);
  const result = await run({ ...local, script: "test" }, f.context);
  assert.equal(result.status, "success");
  assert.equal(result.deliveryEligible, false);
});

for (const action of ["change", "untracked", "commit"]) {
  test(`${action} source invalidates a passing full verification`, async (t) => {
    const f = await fixture(t, action);
    const result = await run(local, f.context);
    assert.equal(result.status, "stale");
    assert.equal(result.deliveryEligible, false);
    assert.notEqual(result.exitCode, 0);
    if (action === "commit")
      assert.notEqual(result.initialState.commit, result.finalState.commit);
    else assert.notEqual(result.initialState.digest, result.finalState.digest);
  });
}

test("an initially dirty tree cannot certify a committed PR head even if unchanged", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "source.txt"), "dirty");
  const result = await run(local, f.context);
  assert.equal(result.deliveryEligible, false);
  assert.equal(result.status, "stale");
});

test("large working-tree state stays on disk without bloating the result file", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 80; i++)
    await writeFile(join(f.cwd, `${i}-${"x".repeat(90)}.txt`), "untracked");
  const result = await run(local, f.context);
  assert.equal(result.status, "stale");
  assert.ok((await readFile(result.resultPath)).length < 4096);
  const state = JSON.parse(
    await readFile(join(result.resultPath, "..", "initial-state.json"), "utf8"),
  );
  assert.match(state.status, /79-xxxx/);
});

test("successful slow process has only start/end records and retains every tick in its log", async (t) => {
  const f = await fixture(t, "slow-success");
  let finished = false;
  const pending = run(local, f.context).finally(() => {
    finished = true;
  });
  for (let i = 0; !f.output() && i < 100; i++) await delay(10);
  const start = f.output();
  let observedWaits = 0;
  while (!finished) {
    assert.equal(f.output(), start);
    observedWaits++;
    await delay(50);
  }
  const result = await pending;
  assert.equal(result.status, "success");
  assert.ok(observedWaits >= 10);
  assert.equal(f.output().trim().split("\n").length, 2);
  const log = await readFile(result.logPath, "utf8");
  for (let i = 0; i < 10; i++) assert.match(log, new RegExp(`tick ${i}`));
});

test("cancellation stops descendants but leaves an unrelated process alive", async (t) => {
  const f = await fixture(t, "tree");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], {
    stdio: "ignore",
  });
  t.after(() => unrelated.kill());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = run(local, { ...f.context, signal: controller.signal });
  for (let i = 0; !f.output() && i < 100; i++) await delay(10);
  const { logPath } = JSON.parse(f.output());
  let pid;
  for (let i = 0; !pid && i < 150; i++) {
    pid = (await readFile(logPath, "utf8")).match(/descendant-pid=(\d+)/)?.[1];
    await delay(20);
  }
  assert.ok(pid, "fixture descendant launched");
  controller.abort();
  assert.equal((await pending).status, "cancellation");
  assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test("slow operation emits nothing between start and cancellation while retaining full logs", async (t) => {
  const f = await fixture(t, "slow");
  const controller = new AbortController();
  const pending = run(local, { ...f.context, signal: controller.signal });
  t.after(() => controller.abort());
  for (let i = 0; !f.output() && i < 100; i++) await delay(10);
  assert.ok(f.output(), "helper must announce its start");
  const start = f.output();
  const record = JSON.parse(start);
  for (let i = 0; i < 150; i++) {
    if ((await readFile(record.logPath, "utf8")).includes("ready")) break;
    await delay(20);
  }
  await delay(200);
  assert.equal(f.output(), start);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancellation");
  assert.equal(result.exitCode, 130);
  assert.ok(
    result.finalState,
    "capture the final tree after owned children stop",
  );
  const log = await readFile(result.logPath, "utf8");
  assert.match(log, /quiet heartbeat/);
  await delay(150);
  assert.equal(await readFile(result.logPath, "utf8"), log);
});

test("deadline terminates a slow owned process and cannot pass", async (t) => {
  const f = await fixture(t, "slow");
  const result = await run({ ...local, timeoutMs: 1500 }, f.context);
  assert.equal(result.status, "timeout");
  assert.equal(result.exitCode, 124);
  assert.ok(result.finalState, "capture the final tree after deadline cleanup");
});

const goodRun = {
  databaseId: 100,
  headSha: "a".repeat(40),
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  url: "https://example.invalid/runs/100",
  createdAt: "2026-09-07T00:00:00Z",
  attempt: 1,
};
const jobs = [
  "static",
  "unit",
  ...Array.from({ length: 7 }, (_, i) => `e2e (${i + 1})`),
].map((name) => ({ name, status: "completed", conclusion: "success" }));
async function github(t, scenario = {}) {
  const f = await fixture(t);
  const fake = join(f.cwd, "fake gh.mjs");
  await writeFile(
    fake,
    `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const scenario = JSON.parse(process.env.WAIT_GH_SCENARIO);
const args = process.argv.slice(2);
appendFileSync('gh-calls.jsonl', JSON.stringify(args)+'\\n');
let state; try { state=JSON.parse(readFileSync('gh-state.json','utf8')); } catch { state={}; }
const key=args.slice(0,2).join(' '); state[key]=(state[key]||0)+1;
writeFileSync('gh-state.json',JSON.stringify(state));
let value;
if(key==='pr view') value={headRefOid:scenario.changedHead && state[key]>1 ? 'b'.repeat(40) : '${goodRun.headSha}',headRefName:scenario.branch || 'feature',isDraft:!!scenario.draft};
else if(key==='pr list') value=(scenario.slots || [[]])[Math.min(state[key]-1,(scenario.slots || [[]]).length-1)];
else if(key==='run list') {
 if(args[args.indexOf('--branch')+1] !== (scenario.branch || 'feature')) throw Error('branch corrupted');
 value=scenario.missing || (scenario.discover && state[key]===1) ? [] : [ {...${JSON.stringify(goodRun)},...scenario.run,...(scenario.superseded && state[key]>1 ? {databaseId:101} : {})} ];
}
else if(key==='run watch') {
 if(JSON.stringify(args.slice(2))!==JSON.stringify(['100','--exit-status','--interval','60'])) throw Error('wrong watch arguments');
 console.log('watch output'); process.exit(scenario.watchCode || 0);
}
else if(key==='run view') value={...${JSON.stringify(goodRun)},jobs:${JSON.stringify(jobs)},...scenario.run,...(scenario.missingJob ? {jobs:[]} : {}),...(scenario.rerun ? {attempt:2} : {})};
else throw Error('Unexpected gh call: '+JSON.stringify(args));
if(scenario.splitUnicode && key==='pr view') {
 const bytes=Buffer.from(JSON.stringify(value)); const cut=bytes.indexOf(Buffer.from('🌍'))+2;
 process.stdout.write(bytes.subarray(0,cut)); await new Promise(resolve=>setTimeout(resolve,30)); process.stdout.write(bytes.subarray(cut));
} else console.log(JSON.stringify(value));
`,
  );
  f.env.WAIT_GH_SCENARIO = JSON.stringify(scenario);
  f.context.gh = [process.execPath, fake];
  return f;
}

test("CI discovers a delayed Verify run, watches once, and returns its identity", async (t) => {
  const f = await github(t, { discover: true });
  f.context.discoveryMs = 3000;
  const result = await run({ mode: "ci", pr: 42, timeoutMs: 10000 }, f.context);
  assert.equal(result.status, "success");
  assert.equal(result.runId, 100);
  assert.equal(result.commitSha, goodRun.headSha);
  assert.equal(result.runUrl, goodRun.url);
  const calls = (await readFile(join(f.cwd, "gh-calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    calls.filter((c) => c[0] === "run" && c[1] === "watch").length,
    1,
  );
  assert.ok(
    calls.some(
      (c) =>
        c.includes("verify.yml") &&
        c.includes("pull_request") &&
        c.includes(goodRun.headSha),
    ),
  );
  assert.ok(Buffer.byteLength(f.output()) < 1024);
});

test("Unicode split across process chunks does not corrupt the PR branch", async (t) => {
  const f = await github(t, { branch: "feature-🌍", splitUnicode: true });
  const result = await run({ mode: "ci", pr: 42, timeoutMs: 10000 }, f.context);
  assert.equal(result.status, "success");
});

for (const [name, scenario, status] of [
  ["failure", { run: { conclusion: "failure" }, watchCode: 1 }, "failure"],
  [
    "cancelled",
    { run: { conclusion: "cancelled" }, watchCode: 1 },
    "cancellation",
  ],
  ["skipped", { run: { conclusion: "skipped" } }, "failure"],
  ["draft", { draft: true }, "failure"],
  ["missing", { missing: true }, "timeout"],
  ["superseded", { superseded: true }, "stale"],
  ["changed head", { changedHead: true }, "stale"],
  ["rerun attempt", { rerun: true }, "stale"],
  ["missing jobs", { missingJob: true }, "failure"],
  [
    "skipped job",
    {
      run: {
        jobs: jobs.map((job) =>
          job.name === "static" ? { ...job, conclusion: "skipped" } : job,
        ),
      },
    },
    "failure",
  ],
  ["wrong event", { run: { event: "push" } }, "timeout"],
  ["timed out", { run: { conclusion: "timed_out" } }, "timeout"],
  ["watch failure", { watchCode: 1 }, "failure"],
]) {
  test(`CI ${name} cannot produce success`, async (t) => {
    const f = await github(t, scenario);
    const result = await run(
      { mode: "ci", pr: 42, timeoutMs: 10000 },
      f.context,
    );
    assert.equal(result.status, status);
    assert.notEqual(result.exitCode, 0);
  });
}

test("slot waits until fewer than two other non-draft main PRs remain, excluding self and 271", async (t) => {
  const f = await github(t, {
    slots: [
      [
        { number: 1, isDraft: false },
        { number: 2, isDraft: false },
        { number: 42, isDraft: false },
        { number: 271, isDraft: false },
      ],
      [
        { number: 1, isDraft: false },
        { number: 2, isDraft: true },
        { number: 42, isDraft: false },
        { number: 271, isDraft: false },
      ],
    ],
  });
  const result = await run(
    { mode: "slot", pr: 42, timeoutMs: 10000 },
    f.context,
  );
  assert.equal(result.status, "success");
  assert.equal(result.otherReadyPrs, 1);
  const calls = (await readFile(join(f.cwd, "gh-calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.filter((c) => c[0] === "pr" && c[1] === "list").length, 2);
  assert.ok(
    calls.some(
      (c) => c.includes("--base") && c.includes("main") && c.includes("open"),
    ),
  );
});

test("missing GitHub CLI is a bounded launch failure", async (t) => {
  const f = await fixture(t);
  const result = await run(
    { mode: "ci", pr: 42, timeoutMs: 10000 },
    { ...f.context, gh: [join(f.cwd, "missing-gh")] },
  );
  assert.equal(result.status, "failure");
  assert.equal(result.exitCode, 127);
  assert.match(result.message, /Cannot launch/);
});

test("occupied slots expire rather than granting capacity", async (t) => {
  const f = await github(t, {
    slots: [
      [
        { number: 1, isDraft: false },
        { number: 2, isDraft: false },
      ],
    ],
  });
  const result = await run(
    { mode: "slot", pr: 42, timeoutMs: 1200 },
    f.context,
  );
  assert.equal(result.status, "timeout");
});

test("CLI validates modes and forwards literal arguments only after the separator", async () => {
  const { parseArgs } = await import("./agent-wait.mjs");
  assert.deepEqual(
    parseArgs([
      "local",
      "--script",
      "test",
      "--timeout-seconds",
      "4",
      "--",
      "--filter",
      "a b",
    ]),
    {
      mode: "local",
      script: "test",
      timeoutMs: 4000,
      args: ["--filter", "a b"],
    },
  );
  assert.equal(parseArgs(["ci", "--pr", "42"]).timeoutMs, 7200000);
  for (const args of [
    [],
    ["ci", "--pr", "0"],
    ["local", "--script", "test", "--timeout-seconds", "NaN"],
    ["slot", "--pr", "42", "--", "extra"],
  ])
    assert.throws(() => parseArgs(args));
});
