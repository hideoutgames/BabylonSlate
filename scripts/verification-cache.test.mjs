import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process-runner.mjs";
import { cachedVerificationPhase } from "./verification-cache.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "verification cache "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => {
    const result = await runCommand("git", args, { cwd, capture: true });
    assert.equal(result.code, 0, result.output);
  };
  const save = async (file, text) => {
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), text);
  };
  const commit = async () => {
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "Fixture",
    );
  };
  await git("init", "-q");
  await save(".gitignore", ".cache/\n");
  await save("packages/core/src/index.ts", "export const value = 1;");
  await save("pnpm-lock.yaml", "lock-one");
  await save("e2e/example.spec.ts", "browser-one");
  await commit();
  return {
    cwd,
    save,
    commit,
    env: {},
    toolchain: "fixture-toolchain",
    emit: () => {},
  };
}

test("typecheck reuses successful inputs across browser-only commits but invalidates dependencies and configuration", async (t) => {
  const f = await fixture(t);
  const phase = { id: "types", command: ["typecheck"], scope: "typecheck" };
  let executions = 0;
  const execute = async () => {
    executions++;
  };
  assert.equal(
    (await cachedVerificationPhase(phase, execute, f)).cached,
    false,
  );
  assert.equal((await cachedVerificationPhase(phase, execute, f)).cached, true);
  await f.save("e2e/example.spec.ts", "browser-two");
  await f.commit();
  assert.equal((await cachedVerificationPhase(phase, execute, f)).cached, true);
  for (const [file, content] of [
    ["packages/core/src/index.ts", "export const value = 2;"],
    ["pnpm-lock.yaml", "lock-two"],
    ["new.config.mjs", "export default {};"],
  ]) {
    await f.save(file, content);
    await f.commit();
    assert.equal(
      (await cachedVerificationPhase(phase, execute, f)).cached,
      false,
      file,
    );
  }
  assert.equal(executions, 4);
  assert.equal(
    (
      await cachedVerificationPhase(
        { ...phase, command: ["different"] },
        execute,
        f,
      )
    ).cached,
    false,
  );
  assert.equal(
    (
      await cachedVerificationPhase(phase, execute, {
        ...f,
        env: { NODE_OPTIONS: "--stack-trace-limit=30" },
      })
    ).cached,
    false,
  );
  assert.equal(
    (
      await cachedVerificationPhase(phase, execute, {
        ...f,
        toolchain: "new-toolchain",
      })
    ).cached,
    false,
  );
});

test("failures, dirty trees, and source changes cannot publish passing results", async (t) => {
  const f = await fixture(t);
  const phase = { id: "unit", command: ["test"] };
  await assert.rejects(
    cachedVerificationPhase(
      phase,
      async () => {
        throw new Error("regression");
      },
      f,
    ),
    /regression/,
  );
  assert.equal(
    (await cachedVerificationPhase(phase, async () => {}, f)).cached,
    false,
  );
  await f.save("packages/core/src/index.ts", "dirty");
  assert.equal(
    (await cachedVerificationPhase(phase, async () => {}, f)).cached,
    false,
  );
  await f.commit();
  await assert.rejects(
    cachedVerificationPhase(
      phase,
      async () => {
        await f.save("packages/core/src/index.ts", "changed during test");
      },
      f,
    ),
    /Source changed/,
  );
  await f.commit();
  assert.equal(
    (await cachedVerificationPhase(phase, async () => {}, f)).cached,
    false,
  );
});

test("CI and explicit cache bypass always execute, and repository contracts invalidate on commit changes", async (t) => {
  const f = await fixture(t);
  const phase = { id: "unit", command: ["test"] };
  await cachedVerificationPhase(phase, async () => {}, f);
  for (const env of [{ CI: "true" }, { BL_VERIFY_CACHE: "0" }]) {
    assert.equal(
      (await cachedVerificationPhase(phase, async () => {}, { ...f, env }))
        .cached,
      false,
    );
  }
  await f.save("e2e/example.spec.ts", "updated browser contract");
  await f.commit();
  assert.equal(
    (await cachedVerificationPhase(phase, async () => {}, f)).cached,
    false,
  );
});

test("a changed execution environment cannot publish a reusable success", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    cachedVerificationPhase(
      { id: "environment", command: ["test"] },
      async () => {
        f.env.TEST_SETTING = "changed while executing";
      },
      f,
    ),
    /inputs changed/i,
  );
});
