import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const playwrightCli = createRequire(import.meta.url).resolve(
  "@playwright/test/cli",
);

type ListedTest = {
  project: string;
  file: string;
  title: string;
};

let cachedTests: ListedTest[] | undefined;
function allTests(): ListedTest[] {
  if (cachedTests) return cachedTests;
  const output = execFileSync(
    process.execPath,
    [playwrightCli, "test", "--list", "--reporter=json"],
    { encoding: "utf8", cwd: repoRoot },
  );
  type Suite = {
    title: string;
    line: number;
    suites?: Suite[];
    specs: Array<{
      file: string;
      title: string;
      tests: Array<{ projectName: string }>;
    }>;
  };
  const tests: ListedTest[] = [];
  function visit(suite: Suite, parents: string[]) {
    const titles = suite.line === 0 ? parents : [...parents, suite.title];
    for (const spec of suite.specs)
      for (const test of spec.tests)
        tests.push({
          project: test.projectName,
          file: spec.file,
          title: [...titles, spec.title].join(" › "),
        });
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  for (const suite of JSON.parse(output).suites) visit(suite, []);
  cachedTests = tests;
  return tests;
}

function listProject(project: string): ListedTest[] {
  return allTests().filter((test) => test.project === project);
}

function filesOf(tests: ListedTest[]): string[] {
  return [...new Set(tests.map((test) => test.file))].sort();
}

describe("Playwright iPad project filter", () => {
  it("runs touch and landscape tests on iPad and keeps the rest on desktop", () => {
    const listed = allTests()
      .map((test) => `[${test.project}]`)
      .join("\n");
    expect(listed).not.toMatch(/\[ipad-portrait\]/);

    const desktop = listProject("desktop-chrome");
    const landscape = listProject("ipad-landscape");

    expect(filesOf(desktop)).toEqual(
      expect.arrayContaining([
        "p2-accept.spec.ts",
        "p4-play.spec.ts",
        "p5-scripting.spec.ts",
        "p6-scene-editing.spec.ts",
        "p9-content.spec.ts",
        "touch-shell.spec.ts",
      ]),
    );

    const ipadFiles = filesOf(landscape);
    expect(ipadFiles).toEqual(
      expect.arrayContaining([
        "touch-shell.spec.ts",
        "windows-menu.spec.ts",
        "editor-density.spec.ts",
        "component-gallery.spec.ts",
        "global-search.spec.ts",
        "p6-scene-editing.spec.ts",
        "texture-encode-ipad.spec.ts",
      ]),
    );
    for (const file of [
      "p2-accept.spec.ts",
      "p5-scripting.spec.ts",
      "editor-smoke.spec.ts",
      "editor-theme.spec.ts",
      "engine-settings.spec.ts",
      "debug-menu.spec.ts",
      "p8-trace.spec.ts",
    ]) {
      expect(ipadFiles, `${file} is desktop-only`).not.toContain(file);
    }

    expect(landscape.filter((test) => test.file === "p9-content.spec.ts")).toEqual([
      expect.objectContaining({ title: expect.stringMatching(/Custom GLSL node compiles a function body in the Material editor @ipad$/) }),
    ]);

    expect(landscape.filter((test) => test.file === "p4-play.spec.ts")).toEqual([
      expect.objectContaining({
        title: expect.stringMatching(
          /framecap changes rendered FPS while simulation keeps ticking$/,
        ),
      }),
    ]);

    const ipadTitles = landscape.map((test) => test.title);
    expect(ipadTitles).toEqual(
      expect.arrayContaining([
        "Touch shell UX › dock and viewport geometry",
        "Touch shell UX › tab overflow",
        "Touch shell UX › pointer context menus",
        "Windows menu › restores Outliner and Output Log to their default dock positions",
        "Editor density and IA › chrome is compact, has no Add tab, and Focus is disabled on Content Browser",
        "Editor density and IA › Content Browser folder tree pans vertically on touch before reparent hold",
        "Editor density and IA › Focus hides the Outliner; Place Actors catalog does not focus search",
        "Editor density and IA › gizmo tools look pressed and the joystick toggle is in viewport settings",
        "gallery composites meet the minimum touch target size",
        "Global project search › toolbar search opens a dialog and focuses a scene actor",
        "Global project search › dialog stays a fixed tall height and results scroll when they overflow",
        "P6 first-playable scene editing › scene panels expose touch-sized toolbar controls",
        "Texture encode iPad › import encode settles to compressed or usable source fallback",
      ]),
    );
    expect(ipadTitles).not.toContain(
      "P9 content systems › Play overlay stick drives the same Move.x as the gamepad path",
    );
    expect(ipadTitles).not.toContain(
      "P6 first-playable scene editing › build, save, reopen, play in 3D and 2D with gamepad and gizmo undo",
    );
    expect(ipadTitles).not.toContain(
      "P5 visual scripting acceptance › a scripted actor compiles and runs in Preview",
    );
  }, 60_000);
});
