import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type IsTestModeEnabled = (win: unknown) => boolean;

/**
 * Build `test-mode.ts` into a real production IIFE and return its exported
 * `isTestModeEnabled` bound to an injectable `window`. Vitest always runs with
 * `import.meta.env.DEV === true`, so only compiled output can prove the
 * production boundary — `?test` must stay inert in flagless bundles.
 */
async function compileTestMode(
  env: Record<string, string>,
): Promise<{ enabled: IsTestModeEnabled; code: string }> {
  const saved = { ...process.env };
  // Vitest runs with NODE_ENV=test, which makes Vite emit import.meta.env.DEV
  // as true even in mode:"production" — force a real production env.
  for (const k of ["VITE_TEST_MODE", "VITE_TEST_QUERY"]) delete process.env[k];
  process.env.NODE_ENV = "production";
  Object.assign(process.env, env);
  try {
    const result = await build({
      configFile: false,
      envFile: false,
      logLevel: "silent",
      mode: "production",
      root: REPO_ROOT,
      build: {
        write: false,
        minify: false,
        lib: {
          entry: join(REPO_ROOT, "packages/vfs/src/test-mode.ts"),
          formats: ["iife"],
          name: "TestMode",
          fileName: "test-mode",
        },
      },
    });
    const bundle = Array.isArray(result) ? result[0]! : result;
    const chunk = (bundle as { output: { type: string; code?: string }[] })
      .output.find((o) => o.type === "chunk")!;
    const code = chunk.code!;
    // The bundle must bake every import.meta.env read; nothing env-shaped may
    // survive into the compiled artifact.
    expect(code).not.toMatch(/import\.meta/);
    const fn = new Function("window", `${code}\nreturn TestMode.isTestModeEnabled;`);
    return { enabled: (win) => (fn(win) as () => boolean)(), code };
  } finally {
    for (const k of ["VITE_TEST_MODE", "VITE_TEST_QUERY", "NODE_ENV"]) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const win = (search?: string) =>
  search === undefined ? undefined : { location: { search } };

describe("compiled test-mode bundle", { timeout: 60_000 }, () => {
  let flagless: IsTestModeEnabled;
  let bakedFlag: IsTestModeEnabled;
  let queryFlag: IsTestModeEnabled;

  beforeAll(async () => {
    flagless = (await compileTestMode({})).enabled;
    bakedFlag = (await compileTestMode({ VITE_TEST_MODE: "true" })).enabled;
    queryFlag = (await compileTestMode({ VITE_TEST_QUERY: "true" })).enabled;
  });

  it.each(["", "?test", "?test=1", "?test=false"])(
    "production bundle ignores the query flag (%s)",
    (search) => {
      expect(flagless(win(search))).toBe(false);
    },
  );

  it("production bundle stays off without a window", () => {
    expect(flagless(win())).toBe(false);
  });

  it.each(["", "?test", "?test=1", "?test=false"])(
    "VITE_TEST_MODE bakes test mode on (%s)",
    (search) => {
      expect(bakedFlag(win(search))).toBe(true);
    },
  );

  it("VITE_TEST_MODE bakes test mode on without a window", () => {
    expect(bakedFlag(win())).toBe(true);
  });

  it.each([
    ["", false],
    ["?test", true],
    ["?test=1", true],
    ["?test=false", false],
  ] as const)(
    "VITE_TEST_QUERY bundle honors the query flag (%s)",
    (search, expected) => {
      expect(queryFlag(win(search))).toBe(expected);
    },
  );

  it("VITE_TEST_QUERY bundle stays off without a window", () => {
    expect(queryFlag(win())).toBe(false);
  });
});
