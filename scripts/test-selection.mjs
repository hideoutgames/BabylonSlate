/** Explicit browser integration seams; pure package logic uses unit coverage. */
export const browserChecks = [
  [
    /^packages\/(render|physics)\//,
    [
      "e2e/editor-smoke.spec.ts",
      "e2e/p4-play.spec.ts",
      "e2e/p14-preview-build.spec.ts",
    ],
  ],
  [
    /^packages\/(runtime|bridge)\//,
    ["e2e/p4-play.spec.ts", "e2e/qa-core-runtime.spec.ts"],
  ],
  [
    /^packages\/(vfs|assets)\//,
    ["e2e/p2-accept.spec.ts", "e2e/qa-save-race.spec.ts"],
  ],
  [
    /^packages\/exporter\/|^apps\/player\//,
    ["e2e/p14-export.spec.ts", "e2e/p14-preview-build.spec.ts"],
  ],
  [/^packages\/navigation\//, ["e2e/p11-ai.spec.ts"]],
  [/^packages\/source-control\//, ["e2e/p15-source-control.spec.ts"]],
  [
    /^packages\/(graph-ui|scripting|scripting-nodes)\//,
    ["e2e/p5-scripting.spec.ts"],
  ],
  [/^packages\/anim-graph\//, ["e2e/p9-content.spec.ts"]],
  [
    /^packages\/behaviour-tree\//,
    ["e2e/bt-editor.spec.ts", "e2e/p11-ai.spec.ts"],
  ],
  [
    /^packages\/shader-graph\//,
    ["e2e/p9-content.spec.ts", "e2e/p17-particles.spec.ts"],
  ],
  [
    /^packages\/(ui|editor-kit)\/|^apps\/editor\//,
    ["e2e/editor-smoke.spec.ts", "e2e/touch-shell.spec.ts"],
  ],
];

export function selectChecks(files, workspace) {
  const selected = new Set();
  const e2e = new Set();
  let full = false;
  let docs = false;
  for (const file of files) {
    if (
      /^(scripts\/|\.github\/|\.agents\/|AGENTS\.md$|vitest|playwright\.config|eslint\.config|tsconfig|pnpm-|package\.json$)/.test(
        file,
      )
    ) {
      full = true;
      continue;
    }
    if (
      file.startsWith("docs/") ||
      file.endsWith(".md") ||
      file.startsWith("apps/docs/")
    )
      docs = true;
    if (file.startsWith("e2e/")) {
      // Helpers can affect every spec and cannot safely be selected by imports alone.
      if (file.endsWith(".spec.ts")) e2e.add(file);
      else full = true;
      continue;
    }
    const owner = workspace.find((pkg) => file.startsWith(`${pkg.path}/`));
    if (owner) {
      selected.add(owner.name);
      if (file.endsWith("/package.json") || /\/tsconfig[^/]*\.json$/.test(file))
        full = true;
      if (
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) &&
        !file.includes("/test-support/")
      ) {
        for (const [pattern, specs] of browserChecks)
          if (pattern.test(file)) specs.forEach((spec) => e2e.add(spec));
      }
    } else if (!file.endsWith(".md") && !file.startsWith("docs/")) full = true;
  }
  let size;
  do {
    size = selected.size;
    for (const pkg of workspace)
      if (pkg.dependencies.some((name) => selected.has(name)))
        selected.add(pkg.name);
  } while (size !== selected.size);
  return { full, packages: [...selected].sort(), e2e: [...e2e], docs };
}
