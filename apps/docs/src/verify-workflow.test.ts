import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function verifyWorkflow(): string {
  return readFileSync(
    path.join(repoRoot, ".github/workflows/verify.yml"),
    "utf8",
  );
}

function jobBlock(yaml: string, job: "static" | "unit" | "e2e"): string {
  const start = yaml.search(new RegExp(`^ {2}${job}:`, "m"));
  expect(start, `${job} job`).toBeGreaterThanOrEqual(0);
  const rest = yaml.slice(start + 1);
  const next = rest.search(/^ {2}[a-z]/m);
  return next === -1 ? yaml.slice(start) : yaml.slice(start, start + 1 + next);
}

describe("Verify GitHub Actions workflow", () => {
  it("cancels superseded runs for the same pull request or branch", () => {
    const yaml = verifyWorkflow();
    expect(yaml).toMatch(/^concurrency:/m);
    expect(yaml).toMatch(/cancel-in-progress:\s*true/);
    expect(yaml).toContain(
      "${{ github.event.pull_request.number || github.ref }}",
    );
  });

  it("does not occupy runners for draft pull-request churn", () => {
    const yaml = verifyWorkflow();
    expect(yaml).toMatch(/ready_for_review/);
    for (const job of ["static", "unit", "e2e"] as const) {
      expect(jobBlock(yaml, job)).toMatch(
        /if:\s*github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.draft == false/,
      );
    }
  });

  it("fails hung jobs and Playwright installs instead of sitting for six hours", () => {
    const yaml = verifyWorkflow();
    expect(jobBlock(yaml, "static")).toMatch(/timeout-minutes:\s*[1-9]\d*/);
    expect(jobBlock(yaml, "unit")).toMatch(/timeout-minutes:\s*[1-9]\d*/);
    const e2e = jobBlock(yaml, "e2e");
    expect(e2e).toMatch(/timeout-minutes:\s*[1-9]\d*/);
    expect(e2e).toMatch(/timeout-minutes:\s*[1-9]\d*/);
    expect(e2e).toContain("playwright install chromium");
    // ubuntu-latest already has Chromium shared libraries. install-deps still
    // apt-gets CJK fonts and times out when seven shards hit the archive.
    expect(e2e).not.toContain("playwright install-deps");
    expect(e2e).not.toContain("playwright install chromium --with-deps");
  });

  it("splits static checks from unsharded unit coverage", () => {
    const yaml = verifyWorkflow();
    const staticJob = jobBlock(yaml, "static");
    expect(staticJob).toContain("pnpm typecheck");
    expect(staticJob).toContain("pnpm lint");
    expect(staticJob).toContain("pnpm --filter docs-site build");
    expect(staticJob).not.toContain("pnpm test:coverage");
    const unit = jobBlock(yaml, "unit");
    expect(unit).toContain("pnpm test:coverage");
    expect(unit).not.toContain("--shard=");
    expect(unit).not.toContain("pnpm typecheck");
  });

  it("reuses the static build and retains a complete browser partition", () => {
    const yaml = verifyWorkflow();
    const e2e = jobBlock(yaml, "e2e");
    expect(e2e).toMatch(/needs:\s*static/);
    expect(e2e).toContain("actions/download-artifact@v4");
    expect(e2e).toContain("BL_TEST_ARTIFACT:");
    expect(e2e).toContain("pnpm test:e2e");
    const staticJob = jobBlock(yaml, "static");
    expect(staticJob).toContain("pnpm test:build");
    expect(staticJob).toContain("actions/upload-artifact@v4");
    expect(staticJob).toContain("include-hidden-files: true");
    expect(e2e).toContain("test-results/");
    expect(e2e).toContain("always()");
  });

  it("caches Playwright browsers on standard ubuntu-latest runners", () => {
    const yaml = verifyWorkflow();
    expect(yaml).toContain("~/.cache/ms-playwright");
    expect(yaml).toContain("actions/cache@v4");
    for (const runner of yaml.matchAll(/runs-on:\s*(\S+)/g)) {
      expect(runner[1]).toBe("ubuntu-latest");
    }
    expect(yaml).not.toMatch(/ubuntu-latest-\d+-cores/);
    expect(yaml).not.toMatch(/macos-latest-xl/);
  });
});
