import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, typecheckCommands } from "./typecheck-incremental.mjs";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/** A repository with `lib` and an `app` workspace whose project reads lib's source, as the editor reads packages. */
async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), "typecheck-incremental-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "lib"), { recursive: true });
  await mkdir(join(root, "app", "src"), { recursive: true });
  await writeFile(join(root, "lib", "label.ts"), "export function label(): string {\n  return 'a';\n}\n");
  await writeFile(
    join(root, "app", "src", "main.ts"),
    "import { label } from '../../lib/label';\nexport const text: string = label();\n",
  );
  await writeFile(join(root, "app", "src", "other.ts"), "export const count: number = 1;\n");
  const options = { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", types: [] };
  await writeFile(join(root, "app", "tsconfig.main.json"), JSON.stringify({ compilerOptions: options, files: ["src/main.ts"] }));
  await writeFile(join(root, "app", "tsconfig.other.json"), JSON.stringify({ compilerOptions: options, files: ["src/other.ts"] }));
  const run = (configs = ["tsconfig.main.json", "tsconfig.other.json"]) =>
    main(configs, { cwd: join(root, "app"), root, tsc, stdio: "ignore" });
  return { root, run };
}

test("each project's build info lives under .cache/typecheck at the workspace's path", () => {
  assert.deepEqual(typecheckCommands(["tsconfig.app.json"], "/repo/apps/editor", "/repo"), [
    [
      "-p",
      "tsconfig.app.json",
      "--noEmit",
      "--incremental",
      "--tsBuildInfoFile",
      join("/repo", ".cache", "typecheck", "apps/editor", "tsconfig.app.tsbuildinfo"),
    ],
  ]);
  assert.throws(() => typecheckCommands([], "/repo/apps/editor", "/repo"), /at least one/);
  assert.throws(() => typecheckCommands(["tsconfig.json"], "/elsewhere", "/repo"), /inside the repository/);
});

test("a change in another workspace's source is checked against warm build info, and errors are not forgotten", async (t) => {
  const { root, run } = await repository(t);
  assert.equal(run(), 0);
  assert.ok(existsSync(join(root, ".cache/typecheck/app/tsconfig.main.tsbuildinfo")));
  // Only the consumer in app sees this error; the file times of app's own sources do not change.
  await writeFile(join(root, "lib", "label.ts"), "export function label(): number {\n  return 1;\n}\n");
  assert.notEqual(run(), 0);
  // Unchanged sources with build info that recorded the error still fail.
  assert.notEqual(run(), 0);
  await writeFile(join(root, "lib", "label.ts"), "export function label(): string {\n  return 'b';\n}\n");
  assert.equal(run(), 0);
});

test("a changed compiler option does not reuse diagnostics recorded under the old options", async (t) => {
  const { root, run } = await repository(t);
  await writeFile(join(root, "app", "src", "other.ts"), "export const items = [1];\nexport const first: number = items[0];\n");
  assert.equal(run(), 0);
  const config = join(root, "app", "tsconfig.other.json");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], noUncheckedIndexedAccess: true },
      files: ["src/other.ts"],
    }),
  );
  assert.notEqual(run(), 0);
});

test("every project runs after one fails, and the failure decides the exit code", async (t) => {
  const { root, run } = await repository(t);
  await writeFile(join(root, "app", "src", "main.ts"), "export const text: string = 1;\n");
  assert.notEqual(run(), 0);
  assert.ok(existsSync(join(root, ".cache/typecheck/app/tsconfig.other.tsbuildinfo")), "the second project ran");
});
