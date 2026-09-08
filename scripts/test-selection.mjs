import { posix } from "node:path";

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const ROOT_STATIC_INPUT =
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.[^/]+)?\.json|vitest(?:\.[^/]+)?\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s)$/;

const RELATED_TESTS = new Map([
  [
    ".github/workflows/verify.yml",
    [
      "apps/docs/src/verify-workflow.test.ts",
      "scripts/verification-policy.test.mjs",
    ],
  ],
  [
    ".github/workflows/distribute.yml",
    ["scripts/distribution/workflow.test.mjs"],
  ],
  [".github/workflows/preview.yml", ["scripts/distribution/workflow.test.mjs"]],
  [
    ".github/workflows/security.yml",
    ["scripts/distribution/workflow.test.mjs"],
  ],
  ["scripts/test-selection.mjs", ["scripts/preflight-selection.test.mjs"]],
  ["scripts/browser-session.mjs", ["scripts/test-build.test.mjs"]],
  ["scripts/build-test-artifact.mjs", ["scripts/test-build.test.mjs"]],
  [
    "scripts/check-public-hygiene.mjs",
    ["packages/test-kit/src/public-hygiene.test.ts"],
  ],
  ["scripts/run-tests.mjs", ["scripts/test-runner.test.mjs"]],
  ["browser-timings.json", ["scripts/browser-partition.test.mjs"]],
]);

function isRepositoryMetadata(file) {
  return (
    file.endsWith(".md") ||
    file.endsWith(".mdc") ||
    file === "skills-lock.json" ||
    file === ".editorconfig" ||
    file === ".gitattributes" ||
    file === ".gitignore" ||
    file.startsWith(".agents/") ||
    file.startsWith(".cursor/") ||
    file.startsWith(".github/")
  );
}

/** Local preflight is deliberately narrower than the mandatory CI suite. */
export function selectChecks(files, workspace, availableTests = []) {
  const packages = new Set();
  const unitTests = new Set();
  const toolingTests = new Set();
  const distributionTests = new Set();
  const normalizedTests = availableTests.map((test) =>
    test.replaceAll("\\", "/"),
  );
  const existing = new Set(normalizedTests);
  let allTypes = false;
  let allTooling = false;
  let docs = false;

  const addTest = (test) => {
    if (!existing.has(test)) return;
    if (test.startsWith("scripts/distribution/")) distributionTests.add(test);
    else if (test.startsWith("scripts/")) toolingTests.add(test);
    else unitTests.add(test);
  };

  for (const originalFile of files) {
    const file = originalFile.replaceAll("\\", "/");
    addTest(file);
    if (SOURCE_FILE.test(file) && !TEST_FILE.test(file)) {
      const stem = file.replace(SOURCE_FILE, "");
      for (const candidate of normalizedTests) {
        if (
          posix.dirname(candidate) === posix.dirname(file) &&
          candidate.startsWith(`${stem}.`) &&
          TEST_FILE.test(candidate)
        )
          addTest(candidate);
      }
    }
    for (const related of RELATED_TESTS.get(file) ?? []) addTest(related);

    if (file.startsWith("docs/")) {
      docs = true;
      addTest("apps/docs/src/sidebar.test.ts");
      continue;
    }
    if (file.startsWith("apps/docs/")) {
      docs = true;
      if (!SOURCE_FILE.test(file) && !file.endsWith("/package.json")) {
        addTest("apps/docs/src/sidebar.test.ts");
        continue;
      }
    }
    if (file.startsWith(".github/workflows/")) continue;
    if (file.startsWith("e2e/")) {
      if (!file.endsWith(".spec.ts")) addTest("playwright.config.test.ts");
      continue;
    }
    if (
      file === "playwright.config.ts" ||
      file === "playwright.config.test.ts"
    ) {
      addTest("playwright.config.test.ts");
      continue;
    }
    if (file === "browser-timings.json") continue;
    if (file.startsWith("scripts/")) continue;
    if (isRepositoryMetadata(file)) continue;
    if (ROOT_STATIC_INPUT.test(file)) {
      allTypes = true;
      allTooling = true;
      continue;
    }

    const owner = workspace.find((pkg) => file.startsWith(`${pkg.path}/`));
    if (owner) packages.add(owner.name);
    else {
      allTypes = true;
      allTooling = true;
    }
  }

  if (allTypes) workspace.forEach((pkg) => packages.add(pkg.name));
  if (allTooling)
    for (const test of normalizedTests)
      if (
        test.startsWith("scripts/") &&
        !test.startsWith("scripts/distribution/")
      )
        toolingTests.add(test);

  return {
    packages: [...packages].sort(),
    unitTests: [...unitTests].sort(),
    toolingTests: [...toolingTests].sort(),
    distributionTests: [...distributionTests].sort(),
    docs,
  };
}
