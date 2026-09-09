import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, verifyArtifactIdentity } from "./test-build.mjs";

const execute = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "slate shared artifacts "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, "shared");
  const worktree = async (name) => {
    const directory = join(root, name);
    await mkdir(join(directory, "scripts"), { recursive: true });
    await mkdir(join(directory, "apps/editor/src"), { recursive: true });
    await mkdir(join(directory, "apps/player"), { recursive: true });
    for (const script of [
      "test-build.mjs",
      "source-state.mjs",
      "process-runner.mjs",
      "shared-test-artifacts.mjs",
    ]) {
      try {
        await cp(join(scripts, script), join(directory, "scripts", script));
      } catch (error) {
        if (script !== "shared-test-artifacts.mjs" || error.code !== "ENOENT")
          throw error;
      }
    }
    await writeFile(join(directory, ".gitignore"), ".cache/\ndist/\n.env*\n");
    await writeFile(
      join(directory, "apps/editor/src/main.js"),
      "export const fixture = 1;\n",
    );
    // Only the expensive compiler and admission boundary are replaced. Source
    // fingerprinting, artifact validation/publication, and filesystem I/O stay real.
    await writeFile(
      join(directory, "scripts/local-resource-config.mjs"),
      `
export async function readLocalResourceConfig(env = process.env) {
  return { cacheDirectory: env.CI === 'true' ? null : env.FIXTURE_CACHE || null };
}
`,
    );
    await writeFile(
      join(directory, "scripts/test-runner.mjs"),
      `
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './process-runner.mjs';
export async function runStage(profile, command, args, options = {}) {
  const original = process.env;
  process.env = { ...process.env, ...options.env };
  try {
    if (process.env.FIXTURE_QUEUED_CACHE)
      await cp(process.env.FIXTURE_QUEUED_CACHE, process.env.FIXTURE_CACHE, { recursive: true });
    if (process.env.FIXTURE_QUEUE_CHANGE)
      await writeFile(join(repoRoot, 'apps/editor/src/main.js'), 'changed while queued');
    return await (await import('./test-build.mjs')).buildOwnedArtifact();
  } finally { process.env = original; }
}
export async function runPnpm() {
  const dist = join(repoRoot, 'apps/editor/dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await mkdir(join(repoRoot, '.cache'), { recursive: true });
  await appendFile(join(repoRoot, '.cache/compilations.log'), 'compile\\n');
  await writeFile(join(dist, 'index.html'), '<script type="module" src="/assets/main.js"></script>');
  await writeFile(join(dist, 'assets/main.js'), await readFile(join(repoRoot, 'apps/editor/src/main.js')));
  if (process.env.FIXTURE_BUILD_CHANGE)
    await writeFile(join(repoRoot, 'apps/editor/src/main.js'), 'changed during compile');
}
`,
    );
    await writeFile(
      join(directory, "run.mjs"),
      `
import { buildTestArtifact } from './scripts/test-build.mjs';
try {
  const result = await buildTestArtifact({ env: JSON.parse(process.env.FIXTURE_OPTIONS || '{}') });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
}
`,
    );
    const git = (...args) =>
      execute("git", args, { cwd: directory, windowsHide: true });
    await git("init", "-q");
    await git("-c", "core.autocrlf=false", "add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "Initial",
    );
    return directory;
  };
  const run = async (directory, env = {}, options = {}) => {
    const result = await execute(
      process.execPath,
      [join(directory, "run.mjs")],
      {
        cwd: directory,
        windowsHide: true,
        env: {
          ...process.env,
          CI: "false",
          FIXTURE_CACHE: cache,
          ...env,
          FIXTURE_OPTIONS: JSON.stringify(options),
        },
      },
    );
    return JSON.parse(result.stdout);
  };
  return { root, cache, worktree, run };
}

async function compilations(directory) {
  return (
    await readFile(join(directory, ".cache/compilations.log"), "utf8").catch(
      () => "",
    )
  )
    .split("\n")
    .filter(Boolean).length;
}

async function publishedArtifacts(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.isDirectory())
      result.push(...(await publishedArtifacts(join(directory, entry.name))));
    else if (entry.name === ".test-build.json") result.push(directory);
  }
  return result;
}

test("build identity changes with source, toolchain and build configuration", () => {
  const source = { commit: "a", digest: "one", clean: true };
  const first = artifactIdentity(source, {
    node: "22",
    platform: "linux",
    base: "/",
  });
  assert.notEqual(
    first.key,
    artifactIdentity(
      { ...source, digest: "two" },
      { node: "22", platform: "linux", base: "/" },
    ).key,
  );
  assert.notEqual(
    first.key,
    artifactIdentity(source, { node: "24", platform: "linux", base: "/" }).key,
  );
  assert.notEqual(
    first.key,
    artifactIdentity(source, {
      node: "22",
      platform: "linux",
      base: "/BabylonSlate/",
    }).key,
  );
  assert.equal(verifyArtifactIdentity(first, first), true);
  assert.equal(
    verifyArtifactIdentity(first, { ...first, key: "stale" }),
    false,
  );
});

test("unchanged build inputs reuse the artifact across test-only commits", () => {
  const first = artifactIdentity({
    commit: "one",
    digest: "same-build-inputs",
  });
  const second = artifactIdentity({
    commit: "two",
    digest: "same-build-inputs",
  });
  assert.equal(first.key, second.key);
  assert.equal(verifyArtifactIdentity(first, second), true);
});

test("an exact-source artifact is reused across worktrees without another compilation", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  const built = await f.run(first);
  const reused = await f.run(second);
  assert.equal(built.error, undefined);
  assert.equal(reused.error, undefined);
  assert.equal(reused.identity.key, built.identity.key);
  assert.equal(
    await readFile(join(reused.directory, "assets/main.js"), "utf8"),
    "export const fixture = 1;\n",
  );
  assert.equal(await compilations(first), 1);
  assert.equal(await compilations(second), 0);
  assert.equal((await publishedArtifacts(f.cache)).length, 1);
});

test("shared lookup includes inherited Vite values and caller build overrides without storing values", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  const built = await f.run(first, {
    VITE_FIXTURE_VALUE: "private-fixture-one",
  });
  const changed = await f.run(second, {
    VITE_FIXTURE_VALUE: "private-fixture-two",
  });
  const overridden = await f.run(
    second,
    { VITE_FIXTURE_VALUE: "ignored-value" },
    { VITE_FIXTURE_VALUE: "private-fixture-one" },
  );
  assert.equal(built.error, undefined);
  assert.equal(changed.error, undefined);
  assert.equal(overridden.error, undefined);
  assert.notEqual(changed.identity.key, built.identity.key);
  assert.equal(overridden.identity.key, built.identity.key);
  assert.equal(await compilations(second), 1);
  const metadata = await readFile(
    join(built.directory, ".test-build.json"),
    "utf8",
  );
  assert.equal(metadata.includes("private-fixture-one"), false);
});

test("ignored app env files and their inherited expansion variables invalidate reuse", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  const built = await f.run(first);
  for (const app of ["editor", "player"]) {
    await writeFile(
      join(second, `apps/${app}/.env.production.local`),
      "VITE_LOCAL_VALUE=${FIXTURE_ORIGIN}\n",
    );
    const local = await f.run(second, { FIXTURE_ORIGIN: "private-local-one" });
    const expanded = await f.run(second, {
      FIXTURE_ORIGIN: "private-local-two",
    });
    assert.equal(local.error, undefined);
    assert.equal(expanded.error, undefined);
    assert.notEqual(local.identity.key, built.identity.key, `${app} env file`);
    assert.notEqual(
      expanded.identity.key,
      local.identity.key,
      `${app} env expansion`,
    );
    assert.equal(
      JSON.stringify(expanded.identity).includes("private-local-two"),
      false,
    );
  }
});

test("recursively expanded inherited env values cannot share a different effective build", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  for (const directory of [first, second])
    await writeFile(
      join(directory, "apps/editor/.env.production.local"),
      "VITE_ENDPOINT=${FIXTURE_UPSTREAM}\n",
    );
  const built = await f.run(first, {
    FIXTURE_UPSTREAM: "${FIXTURE_ORIGIN}",
    FIXTURE_ORIGIN: "first-origin",
  });
  const changed = await f.run(second, {
    FIXTURE_UPSTREAM: "${FIXTURE_ORIGIN}",
    FIXTURE_ORIGIN: "second-origin",
  });
  assert.equal(built.error, undefined);
  assert.equal(changed.error, undefined);
  assert.notEqual(changed.identity.key, built.identity.key);
  assert.equal(await compilations(second), 1);
});

for (const location of ["env file", "inherited value"]) {
  test(`constructed dotenv keys in an ${location} fail before compilation without exposing values`, async (t) => {
    const f = await fixture(t);
    const directory = await f.worktree("constructed");
    const expression = "${${FIXTURE_LOOKUP}}";
    await writeFile(
      join(directory, "apps/editor/.env.production.local"),
      `VITE_ENDPOINT=${location === "env file" ? expression : "${FIXTURE_UPSTREAM}"}\n`,
    );
    const result = await f.run(directory, {
      FIXTURE_UPSTREAM: expression,
      FIXTURE_LOOKUP: "FIXTURE_PRIVATE_ORIGIN",
      FIXTURE_PRIVATE_ORIGIN: "private-sensitive-origin",
    });
    assert.match(result.error ?? "", /literal (?:dotenv )?variable names/i);
    assert.equal(JSON.stringify(result).includes(expression), false);
    assert.equal(
      JSON.stringify(result).includes("private-sensitive-origin"),
      false,
    );
    assert.equal(await compilations(directory), 0);
    assert.equal((await publishedArtifacts(f.cache)).length, 0);
  });
}

test("different ignored installed lockfiles do not share compiled output", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  for (const [directory, version] of [
    [first, "1.0.0"],
    [second, "2.0.0"],
  ]) {
    await writeFile(join(directory, ".git/info/exclude"), "node_modules/\n");
    await mkdir(join(directory, "node_modules/.pnpm"), { recursive: true });
    await writeFile(
      join(directory, "node_modules/.pnpm/lock.yaml"),
      `fixture: ${version}\n`,
    );
  }
  const built = await f.run(first);
  const changed = await f.run(second);
  assert.equal(built.error, undefined);
  assert.equal(changed.error, undefined);
  assert.notEqual(changed.identity.key, built.identity.key);
  assert.equal(await compilations(second), 1);
});

test("braced dotenv references include inherited keys containing punctuation", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  for (const directory of [first, second])
    await writeFile(
      join(directory, "apps/editor/.env.production.local"),
      "VITE_ENDPOINT=${BUILD.ORIGIN}\n",
    );
  const built = await f.run(first, { "BUILD.ORIGIN": "first-origin" });
  const changed = await f.run(second, { "BUILD.ORIGIN": "second-origin" });
  assert.equal(built.error, undefined);
  assert.equal(changed.error, undefined);
  assert.notEqual(changed.identity.key, built.identity.key);
  assert.equal(await compilations(second), 1);
});

test("nested dotenv defaults track both the outer override and its inherited fallback", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  for (const directory of [first, second])
    await writeFile(
      join(directory, "apps/editor/.env.production.local"),
      "VITE_ENDPOINT=${FIXTURE_UPSTREAM:-${FIXTURE_ORIGIN}}\n",
    );
  const built = await f.run(first, {
    FIXTURE_UPSTREAM: "first",
    FIXTURE_ORIGIN: "fallback",
  });
  const changed = await f.run(second, {
    FIXTURE_UPSTREAM: "second",
    FIXTURE_ORIGIN: "fallback",
  });
  const fallback = await f.run(second, {
    FIXTURE_UPSTREAM: "",
    FIXTURE_ORIGIN: "different-fallback",
  });
  assert.equal(built.error, undefined);
  assert.equal(changed.error, undefined);
  assert.equal(fallback.error, undefined);
  assert.notEqual(changed.identity.key, built.identity.key);
  assert.notEqual(fallback.identity.key, changed.identity.key);
});

test("corrupt shared chunks are ignored without replacing an artifact another browser may use", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  await f.run(first);
  const published = await publishedArtifacts(f.cache);
  assert.equal(published.length, 1, "the first build should be shared");
  const damagedChunk = join(published[0], "assets/main.js");
  await writeFile(damagedChunk, "damaged");
  const repaired = await f.run(second);
  assert.equal(repaired.error, undefined);
  assert.equal(
    await readFile(join(repaired.directory, "assets/main.js"), "utf8"),
    "export const fixture = 1;\n",
  );
  assert.equal(await compilations(second), 1);
  assert.equal(await readFile(damagedChunk, "utf8"), "damaged");
});

for (const filename of [".test-build.json", ".test-build-files.json"]) {
  test(`shared artifacts cannot use external symlinked ${filename} metadata`, async (t) => {
    const f = await fixture(t);
    const first = await f.worktree("first");
    const second = await f.worktree("second");
    await f.run(first);
    const [published] = await publishedArtifacts(f.cache);
    assert.ok(published);
    const path = join(published, filename);
    const external = join(f.root, "external-metadata.json");
    await writeFile(external, await readFile(path));
    await rm(path);
    try {
      await symlink(external, path, "file");
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") {
        t.skip("This Windows account cannot create file symlinks");
        return;
      }
      throw error;
    }
    const rebuilt = await f.run(second);
    assert.equal(rebuilt.error, undefined);
    assert.equal(await compilations(second), 1);
  });
}

test("a build queued behind another worktree rechecks the shared artifact after admission", async (t) => {
  const f = await fixture(t);
  const producer = await f.worktree("producer");
  const consumer = await f.worktree("consumer");
  const queuedCache = join(f.root, "published-while-queued");
  const built = await f.run(producer, { FIXTURE_CACHE: queuedCache });
  assert.equal((await publishedArtifacts(queuedCache)).length, 1);
  const reused = await f.run(consumer, { FIXTURE_QUEUED_CACHE: queuedCache });
  assert.equal(reused.error, undefined);
  assert.equal(reused.identity.key, built.identity.key);
  assert.equal(await compilations(consumer), 0);
});

test("a changed queued source is rejected before accepting the newly shared cache hit", async (t) => {
  const f = await fixture(t);
  const producer = await f.worktree("producer");
  const consumer = await f.worktree("consumer");
  const queuedCache = join(f.root, "published-while-queued");
  await f.run(producer, { FIXTURE_CACHE: queuedCache });
  assert.equal((await publishedArtifacts(queuedCache)).length, 1);
  const changed = await f.run(consumer, {
    FIXTURE_QUEUED_CACHE: queuedCache,
    FIXTURE_QUEUE_CHANGE: "1",
  });
  assert.match(
    changed.error ?? "",
    /Source changed while the build was queued/,
  );
  assert.equal(await compilations(consumer), 0);
  assert.equal(
    (await publishedArtifacts(join(consumer, ".cache/test-build"))).length,
    0,
  );
});

test("a source changed during compilation publishes neither local nor shared output", async (t) => {
  const f = await fixture(t);
  const directory = await f.worktree("changing");
  const result = await f.run(directory, { FIXTURE_BUILD_CHANGE: "1" });
  assert.match(result.error ?? "", /Source changed during the build/);
  assert.equal((await publishedArtifacts(f.cache)).length, 0);
  assert.equal(
    (await publishedArtifacts(join(directory, ".cache/test-build"))).length,
    0,
  );
});

test("concurrent same-key publishers leave complete independently verifiable artifacts", async (t) => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second");
  const results = await Promise.all([f.run(first), f.run(second)]);
  for (const result of results) assert.equal(result.error, undefined);
  const published = await publishedArtifacts(f.cache);
  assert.ok(
    published.length >= 1,
    "a completed shared publication should exist",
  );
  for (const directory of published) {
    assert.equal(
      await readFile(join(directory, "index.html"), "utf8"),
      '<script type="module" src="/assets/main.js"></script>',
    );
    assert.equal(
      await readFile(join(directory, "assets/main.js"), "utf8"),
      "export const fixture = 1;\n",
    );
  }
  const third = await f.worktree("third");
  assert.equal((await f.run(third)).error, undefined);
  assert.equal(await compilations(third), 0);
});

test("CI and unconfigured machines retain worktree-local artifacts", async (t) => {
  const f = await fixture(t);
  for (const [name, env] of [
    ["ci", { CI: "true" }],
    ["local", { FIXTURE_CACHE: "" }],
  ]) {
    const directory = await f.worktree(name);
    const result = await f.run(directory, env);
    assert.equal(result.error, undefined);
    assert.ok(
      result.directory.startsWith(join(directory, ".cache/test-build")),
    );
    assert.equal((await publishedArtifacts(f.cache)).length, 0);
  }
});
