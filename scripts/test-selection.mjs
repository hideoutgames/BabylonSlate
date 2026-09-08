import { posix } from "node:path";

/** Local preflight is deliberately narrower than the mandatory CI suite. */
export function selectChecks(files, workspace, availableTests = []) {
  const selected = new Set();
  const unitTests = new Set();
  const existing = new Set(availableTests);
  let tooling = false;
  let allTypes = false;
  let docs = false;
  for (const file of files) {
    if (existing.has(file)) unitTests.add(file);
    if (/\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\./.test(file)) {
      const stem = file.replace(/\.[cm]?[jt]sx?$/, "");
      for (const test of availableTests) {
        if (
          posix.dirname(test) === posix.dirname(file) &&
          test.startsWith(`${stem}.`) &&
          /\.test\.[cm]?[jt]sx?$/.test(test)
        )
          unitTests.add(test);
      }
    }
    if (
      file.endsWith(".md") ||
      file.startsWith("docs/") ||
      file.startsWith("apps/docs/")
    )
      docs = true;
    if (
      /^(scripts\/|\.github\/|\.agents\/|AGENTS\.md$|vitest|playwright\.config|eslint\.config|tsconfig|pnpm-|package\.json$)/.test(
        file,
      )
    ) {
      tooling = true;
      allTypes = true;
      continue;
    }
    if (file.startsWith("e2e/")) {
      tooling = true;
      continue;
    }
    const owner = workspace.find((pkg) => file.startsWith(`${pkg.path}/`));
    if (owner) {
      selected.add(owner.name);
      if (file.endsWith("/package.json")) tooling = true;
    } else if (!file.endsWith(".md") && !file.startsWith("docs/")) {
      tooling = true;
      allTypes = true;
    }
  }
  if (allTypes) workspace.forEach((pkg) => selected.add(pkg.name));
  let size;
  do {
    size = selected.size;
    for (const pkg of workspace)
      if (pkg.dependencies.some((name) => selected.has(name)))
        selected.add(pkg.name);
  } while (size !== selected.size);
  return {
    packages: [...selected].sort(),
    unitTests: [...unitTests].sort(),
    tooling,
    docs,
  };
}
