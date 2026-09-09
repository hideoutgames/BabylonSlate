import {
  acquireResources,
  inheritedLease,
  workloadFor,
} from "./resource-admission.mjs";
import {
  pnpmCommand,
  repoRoot,
  runCommand,
  toolCli,
} from "./process-runner.mjs";
import { cachedVerificationPhase } from "./verification-cache.mjs";

export async function runStage(profile, command, args, options = {}) {
  const signal = options.signal;
  const environment = { ...process.env, ...options.env };
  const request = workloadFor(profile, environment);
  const inherited = await inheritedLease(environment.BL_TEST_LEASE, request);
  const ci = environment.CI === "true";
  const lease =
    ci || inherited
      ? null
      : await acquireResources(request, {
          signal,
          env: environment,
          onQueued: () =>
            process.stdout.write(
              JSON.stringify({ event: "queued", profile }) + "\n",
            ),
        });
  const env = {
    ...environment,
    VITEST_MAX_WORKERS: ci ? "2" : String(request.workers),
    BL_TEST_BROWSER_WORKERS: ci
      ? "1"
      : environment.BL_TEST_PROFILE === "fast"
        ? "2"
        : "1",
    ...(lease
      ? {
          BL_TEST_LEASE: JSON.stringify({
            ticket: lease.ticket,
            token: lease.token,
          }),
        }
      : {}),
  };
  process.stdout.write(
    JSON.stringify({ event: "stage", profile, queueMs: lease?.queueMs ?? 0 }) +
      "\n",
  );
  try {
    const result = await runCommand(command, args, {
      ...options,
      env,
      onSpawn: (pid) => lease?.child(pid),
    });
    process.stdout.write(
      JSON.stringify({
        event: "stage-result",
        profile,
        exitCode: result.code,
        executionMs: result.elapsedMs,
        queueMs: lease?.queueMs ?? 0,
      }) + "\n",
    );
    if (result.code !== 0)
      throw Object.assign(
        new Error(`${profile} command failed (${result.code})`),
        { exitCode: result.code },
      );
    return result;
  } finally {
    await lease?.release();
  }
}

export async function runPnpm(profile, args, options) {
  const [command, commandArgs] = pnpmCommand(args);
  return runStage(profile, command, commandArgs, options);
}

async function vitest(args, options = {}) {
  const environment = { ...process.env, ...options.env };
  return runStage(
    options.profile ?? "dom",
    process.execPath,
    [
      toolCli("vitest"),
      "run",
      "--config",
      "vitest.workspace.ts",
      ...args,
      "--maxWorkers",
      environment.CI === "true"
        ? "2"
        : String(
            workloadFor(options.profile ?? "dom", {
              ...environment,
            }).workers,
          ),
    ],
    options,
  );
}

export function unitProfile(args) {
  const projectIndex = args.indexOf("--project");
  const project =
    projectIndex >= 0
      ? args[projectIndex + 1]
      : args
          .find((arg) => arg.startsWith("--project="))
          ?.slice("--project=".length);
  if (project === "node") return "unit";
  if (
    args.length &&
    args.every(
      (arg) =>
        arg === "playwright.config.test.ts" ||
        /^(?:apps\/docs|apps\/player|apps\/desktop)\//.test(arg),
    )
  )
    return "unit";
  return args.length ? "focused" : "dom";
}

export async function editorTests(options = {}) {
  await vitest(["--project", "node", "apps/editor"], {
    ...options,
    profile: "unit",
    env: { VITEST_COVERAGE: "0" },
  });
  const listed = await runCommand(
    process.execPath,
    [
      toolCli("vitest"),
      "list",
      "--config",
      "vitest.workspace.ts",
      "--project",
      "jsdom",
      "apps/editor",
      "--filesOnly",
      "--json",
    ],
    {
      signal: options.signal,
      capture: true,
      env: { ...process.env, VITEST_COVERAGE: "0" },
    },
  );
  if (listed.code) throw new Error(listed.output);
  const files = JSON.parse(listed.output)
    .map((entry) => entry.file)
    .sort();
  if (!files.length)
    throw new Error("Editor DOM discovery unexpectedly selected no tests");
  for (let index = 0; index < files.length; index += 50) {
    await vitest(["--project", "jsdom", ...files.slice(index, index + 50)], {
      ...options,
      env: { VITEST_COVERAGE: "0" },
    });
  }
}

export async function fullVerification(options = {}) {
  const phase = (id, command, execute, scope) =>
    cachedVerificationPhase({ id, command, scope }, execute, {
      env: { ...process.env, ...options.env },
    });
  await phase("full-tooling", ["test:tooling"], () =>
    runPnpm("unit", ["run", "test:tooling"], options),
  );
  await phase("full-distribution", ["test:distribution"], () =>
    runPnpm("unit", ["run", "test:distribution"], options),
  );
  await phase(
    "full-typecheck",
    ["typecheck"],
    () =>
      runPnpm(
        "build",
        ["--workspace-concurrency=1", "-r", "typecheck"],
        options,
      ),
    "typecheck",
  );
  await phase("full-lint", ["lint"], () =>
    runPnpm("unit", ["run", "lint"], options),
  );
  await phase("full-unit", ["test:coverage"], () =>
    runTests("coverage", [], options),
  );
  // Browser outcomes are always exercised when full verification is explicitly requested.
  await runTests("e2e", [], options);
  await phase("full-docs", ["docs-site", "build"], () =>
    runPnpm("build", ["--filter", "docs-site", "build"], options),
  );
}

export async function runTests(mode, args, options = {}) {
  if (mode === "unit")
    return vitest(args, { ...options, profile: unitProfile(args) });
  if (mode === "tooling")
    return runStage(
      "tooling",
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        ...(args.length ? args : ["scripts/*.test.mjs"]),
      ],
      options,
    );
  if (mode === "watch")
    return runStage(
      "dom",
      process.execPath,
      [
        toolCli("vitest"),
        "--config",
        "vitest.workspace.ts",
        ...args,
        `--maxWorkers=${process.env.CI === "true" ? 2 : workloadFor("dom").workers}`,
      ],
      options,
    );
  if (["typecheck", "build-all", "lint"].includes(mode)) {
    const command =
      mode === "lint"
        ? ["exec", "eslint", ".", ...args]
        : [
            "--workspace-concurrency=1",
            "-r",
            mode === "build-all" ? "build" : "typecheck",
            ...args,
          ];
    return runPnpm(mode === "lint" ? "unit" : "build", command, options);
  }
  if (args.length && ["coverage", "editor", "verify"].includes(mode))
    throw new Error(
      `${mode} does not accept filters; use pnpm test for focused checks`,
    );
  if (mode === "editor") return editorTests(options);
  if (mode === "coverage") {
    await vitest(["--coverage"], {
      ...options,
      profile: "coverage",
      env: { VITEST_COVERAGE: "1", NODE_DISABLE_COMPILE_CACHE: "1" },
    });
    return editorTests(options);
  }
  if (mode === "verify") return fullVerification(options);
  if (mode === "e2e" || mode === "build") {
    const { runBrowserTests, buildTestArtifact } =
      await import("./test-build.mjs");
    return mode === "build"
      ? buildTestArtifact(options)
      : runBrowserTests(args, options);
  }
  throw new Error(`Unknown test mode: ${mode}`);
}
