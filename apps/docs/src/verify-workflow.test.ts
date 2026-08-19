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

function jobBlock(yaml: string, job: "unit" | "e2e"): string {
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
    for (const job of ["unit", "e2e"] as const) {
      expect(jobBlock(yaml, job)).toMatch(
        /if:\s*github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.draft == false/,
      );
    }
  });

  it("fails hung jobs and Playwright installs instead of sitting for six hours", () => {
    const yaml = verifyWorkflow();
    expect(jobBlock(yaml, "unit")).toMatch(/timeout-minutes:\s*45/);
    const e2e = jobBlock(yaml, "e2e");
    expect(e2e).toMatch(/timeout-minutes:\s*25/);
    expect(e2e).toMatch(/timeout-minutes:\s*5/);
    expect(e2e).toContain("playwright install chromium");
    expect(e2e).toContain("playwright install-deps chromium");
    expect(e2e).not.toContain("playwright install chromium --with-deps");
  });

  it("shards Playwright e2e four ways on standard runners", () => {
    const e2e = jobBlock(verifyWorkflow(), "e2e");
    expect(e2e).toMatch(/fail-fast:\s*false/);
    expect(e2e).toMatch(/shard:\s*\[1,\s*2,\s*3,\s*4\]/);
    expect(e2e).toContain("playwright test --shard=${{ matrix.shard }}/4");
    expect(e2e).not.toContain("pnpm test:e2e");
  });

  it("caches Playwright browsers on standard ubuntu-latest runners", () => {
    const yaml = verifyWorkflow();
    expect(yaml).toContain("~/.cache/ms-playwright");
    expect(yaml).toContain("actions/cache@v4");
    expect(yaml.match(/runs-on:\s*ubuntu-latest/g)?.length).toBe(2);
    expect(yaml).not.toMatch(/ubuntu-latest-\d+-cores/);
    expect(yaml).not.toMatch(/macos-latest-xl/);
  });
});
