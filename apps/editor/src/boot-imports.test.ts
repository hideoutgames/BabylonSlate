import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-read audit: the editor's static relative imports are the contract
// here. The editor package has no `sideEffects` declaration, so every module
// a boot module imports statically, even through a re-export barrel, is in
// the Homepage's preload; `import type` and `import()` are not.
const SRC = dirname(fileURLToPath(import.meta.url));
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm;

function resolveModule(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Static imports of CodeMirror and its Lezer parsers. */
const CODE_EDITOR_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']@(?:codemirror|lezer)\//m;

/** Editor modules (relative to `src`) that `entry` reaches through static relative imports. */
function staticClosure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [join(SRC, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      const next = resolveModule(file, match[1]!);
      if (next) stack.push(next);
    }
  }
  return [...seen].map((file) => relative(SRC, file));
}

describe("editor boot imports", () => {
  it("keep the Content Browser helpers barrel and its New Asset factories out of the Homepage preload", () => {
    const closure = staticClosure("main.tsx");
    // The audit follows the provider's services, so an empty result is a finding.
    expect(closure).toContain("services/project-service.ts");
    expect(closure).toContain("services/play-content-service.ts");
    expect(closure.filter((file) => file === "lib/content-browser-helpers.ts" || file === "lib/new-asset-result.ts")).toEqual([]);
  });

  it("keep CodeMirror out of the editor route and the asset editor families, which load it with the first code body shown", () => {
    const families = readdirSync(join(SRC, "shell/asset-panels")).map((file) => `shell/asset-panels/${file}`);
    const closure = [...new Set(["routes/editor-route.tsx", ...families].flatMap((entry) => staticClosure(entry)))];
    // Every screen that shows code is reached, so an empty result is a finding.
    for (const screen of ["panels/graph-panel.tsx", "panels/inspector-graph-node-details.tsx", "components/material-editor.tsx",
      "components/material-custom-glsl.tsx", "components/project-extension-dialogs.tsx", "components/lazy-code-editors.tsx"])
      expect(closure).toContain(screen);
    expect(closure.filter((file) => CODE_EDITOR_IMPORT.test(readFileSync(join(SRC, file), "utf8")))).toEqual([]);
  });

  it("keep the Text Editor tab's page out of the Editor route, which loads it with the first Text Editor tab", () => {
    const closure = staticClosure("routes/editor-route.tsx");
    // The workspace that mounts it is reached, so an empty result is a finding.
    expect(closure).toContain("components/document-workspace.tsx");
    expect(closure).not.toContain("components/text-editor-workspace.tsx");
  });

  // The lazy Homepage route: the miniature editor in Theme Settings brings Dockview and the graph editor, and the
  // Feature Test Check's runner is needed only when a Breakdown waits to resume.
  it("keep the Theme Settings preview and the Feature Test Check runner out of the Homepage route", () => {
    const closure = staticClosure("routes/home-route.tsx");
    expect(closure).toContain("components/homepage-theme-settings.tsx");
    expect(closure).toContain("components/feature-test-check-resume.tsx");
    expect(closure.filter((file) => [
      "components/editor-theme-preview.tsx",
      "services/feature-test-check.ts",
      "lib/feature-test-breakdown-ab.ts",
    ].includes(file))).toEqual([]);
  });

  // Asset editor panels load by family on first use (`shell/asset-panels/`); the Scene's panels stay in the route.
  it("keep the asset editor panel families out of the Editor route's first load", () => {
    const closure = staticClosure("routes/editor-route.tsx");
    expect(closure).toContain("shell/panel-registry.tsx");
    expect(closure).toContain("panels/viewport-panel.tsx");
    const familyDir = join(SRC, "shell/asset-panels");
    const families = readdirSync(familyDir).filter((file) => file.endsWith(".ts"));
    expect(families.length).toBeGreaterThan(0);
    const familyModules = families.flatMap((family) => {
      const file = join(familyDir, family);
      return [...readFileSync(file, "utf8").matchAll(STATIC_IMPORT)].map((match) =>
        relative(SRC, resolveModule(file, match[1]!)!),
      );
    });
    expect(familyModules).toContain("components/tilemap-editor.tsx");
    expect(familyModules.filter((file) => closure.includes(file))).toEqual([]);
  });

  it("keep the Feature Test Check dialog and its report out of the Editor route's first load", () => {
    const closure = staticClosure("routes/editor-route.tsx");
    expect(closure).toContain("components/editor-chrome-bar.tsx");
    expect(closure).toContain("lib/use-is-feature-test-project.ts");
    expect(closure.filter((file) => [
      "components/feature-test-check-dialog.tsx",
      "lib/feature-test-check-report.ts",
      "services/feature-test-check.ts",
    ].includes(file))).toEqual([]);
  });

  // A project whose source control mode is Off loads none of it: the credential store, device sign-in, the host REST
  // APIs, the pushed-lock check, the Git core (isomorphic-git) and its port factory, Clone, Publish, the Pull flow and
  // the Source Control tab's windows load on first use, and the Debug Mode Git benchmark's dialog on its first open
  // and its runner only when it runs.
  it("keep Source Control's accounts, sign-in, host APIs, Git core and windows out of the Homepage and the Editor route", () => {
    const ASSET_DIFF_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']@haptic\/assets\/asset-diff(?:-client)?["']/m;
    const SOURCE_CONTROL_SUBPATH = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["'](?:@haptic\/source-control\/(?:device-flow|host-api|pushed-locks|token-refresh|fake-host|git|git-benchmark|fake-sync)|isomorphic-git(?:\/[^'"]*)?)["']/m;
    const closure = [...new Set(["main.tsx", "routes/home-route.tsx", "routes/editor-route.tsx"].flatMap((entry) => staticClosure(entry)))];
    expect(closure).toContain("services/source-control-service.ts");
    expect(closure).toContain("services/source-control-sync.ts");
    expect(closure).toContain("components/source-control-actions.tsx");
    expect(closure).toContain("components/source-control-sign-in-banner.tsx");
    expect(closure).toContain("lib/git-benchmark-hook.ts");
    expect(closure.filter((file) => [
      "services/source-control-accounts.ts",
      "services/source-control-pushed.ts",
      "lib/use-source-control-credentials.ts",
      "lib/git-benchmark-runner.ts",
      "components/git-benchmark-dialog.tsx",
      "components/engine-source-control-settings.tsx",
      "components/project-source-control-host-fields.tsx",
      "components/source-control-sign-in-dialog.tsx",
      "components/source-control-host-account.tsx",
      "lib/source-control-host-accounts.ts",
      "components/source-control-pull-flow.tsx",
      "components/clone-project-dialog.tsx",
      "components/publish-project-dialog.tsx",
      "components/new-project-repository-fields.tsx",
      "services/source-control-sync-port.ts",
      "services/source-control-publish.ts",
      "panels/locks-panel.tsx",
      "panels/changes-panel.tsx",
      "panels/diff-actors-panel.tsx",
      "panels/diff-panel.tsx",
      "panels/diff-graph-view.tsx",
      "panels/diff-graph-canvas.tsx",
      "panels/diff-texture-view.tsx",
      "components/source-control-revert-flow.tsx",
      "components/source-control-branch-flow.tsx",
      "components/source-control-new-branch-dialog.tsx",
      "components/source-control-rewrite.tsx",
      "panels/history-panel.tsx",
      "services/source-control-diff-loader.ts",
      "services/source-control-restore.ts",
      "services/source-control-unused-files.ts",
      "components/source-control-unused-files-flow.tsx",
    ].includes(file))).toEqual([]);
    expect(closure.filter((file) => SOURCE_CONTROL_SUBPATH.test(readFileSync(join(SRC, file), "utf8")))).toEqual([]);
    // The diff model and its worker client load with the first diff; the open diff's service imports only their types.
    expect(closure).toContain("services/source-control-diff.ts");
    expect(closure.filter((file) => ASSET_DIFF_IMPORT.test(readFileSync(join(SRC, file), "utf8")))).toEqual([]);
  });

  // A Material, Particle Graph, Behaviour Tree or Animation Graph diff draws on a canvas its family's chunk exports, so
  // neither the Source Control windows nor the graph diff view bring a family's editors.
  it("load each graph family's diff canvas with that family's editors, never with the Diff window", () => {
    const canvases = [
      "components/material-diff-canvas.tsx",
      "panels/particle-diff-canvas.tsx",
      "components/behaviour-tree-diff-canvas.tsx",
      "components/anim-graph-diff-canvas.tsx",
    ];
    const familyClosure = ["shell/asset-panels/rendering.ts", "shell/asset-panels/animation-ai.ts"].flatMap((entry) => staticClosure(entry));
    for (const canvas of canvases) expect(familyClosure).toContain(canvas);
    const diffWindow = [...new Set(["shell/asset-panels/source-control.ts", "panels/diff-graph-view.tsx"].flatMap((entry) => staticClosure(entry)))];
    expect(diffWindow).toContain("panels/diff-panel.tsx");
    expect(diffWindow).toContain("panels/diff-graph-canvas.tsx");
    expect(diffWindow.filter((file) => [
      ...canvases,
      "components/material-editor.tsx",
      "panels/particle-graph-panels.tsx",
      "components/behaviour-tree-editor.tsx",
      "components/anim-graph-editor.tsx",
    ].includes(file))).toEqual([]);
  });
});
