import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import verifyConfig from "./playwright.config";
import webkitConfig from "./playwright.webkit.config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const playwrightCli = createRequire(import.meta.url).resolve(
  "@playwright/test/cli",
);

type ListedTest = {
  project: string;
  file: string;
  title: string;
};

const cachedTests = new Map<string, ListedTest[]>();
function allTests(config = "playwright.config.ts"): ListedTest[] {
  const cached = cachedTests.get(config);
  if (cached) return cached;
  const output = execFileSync(
    process.execPath,
    [playwrightCli, "test", "--config", config, "--list", "--reporter=json"],
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
  cachedTests.set(config, tests);
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

    // Performance and profiling routes run only through playwright.perf.config.ts.
    for (const file of [
      "editor-edit-profile.spec.ts",
      "feature-test-perf-route.spec.ts",
      "play-performance-route.spec.ts",
      "play-sustained-route.spec.ts",
      "rendering-baseline.spec.ts",
    ])
      expect(filesOf(desktop), `${file} is perf-only`).not.toContain(file);

    // Only touch-driven journeys are tagged for iPad; every iPad run is also a desktop run.
    expect(filesOf(landscape)).toEqual([
      "p10-tilemap.spec.ts",
      "scene-layer-joystick.spec.ts",
      "scene-modes.spec.ts",
      "touch-shell.spec.ts",
      "tree-view-touch.spec.ts",
    ]);
    expect(landscape.map((test) => test.title).sort()).toEqual([
      "@ipad SceneLayer joystick touch moves its custom material and resets on cancellation in Play",
      "P10 tilemaps › 2D project paints tiles, plays an animated sprite, and reports physics",
      "Scene modes › sculpts terrain and restores independent mode layouts, Focus, and saved content",
      "Touch shell UX › pointer context menus",
      "Touch shell UX › project long-press stays open after release and can edit",
      "TreeView native touch swipes scroll and a short hold reparents without scrolling",
    ]);
    const desktopKeys = new Set(desktop.map((test) => `${test.file} › ${test.title}`));
    for (const test of landscape)
      expect(desktopKeys, `${test.title} also runs on desktop`).toContain(`${test.file} › ${test.title}`);
  }, 60_000);
});

describe("Playwright WebKit smoke lane", () => {
  it("keeps PR Verify on Chromium and runs a small tagged desktop subset in WebKit", () => {
    // verify.yml installs only Chromium; a WebKit project there would fail every shard.
    for (const project of verifyConfig.projects ?? [])
      expect(
        project.use?.browserName ?? project.use?.defaultBrowserType,
        project.name,
      ).toBe("chromium");
    expect(
      (webkitConfig.projects ?? []).map((project) => [
        project.name,
        project.use?.browserName,
      ]),
    ).toEqual([["ipad-webkit", "webkit"]]);

    const webkit = allTests("playwright.webkit.config.ts");
    expect(webkit.map((test) => `${test.file} › ${test.title}`).sort()).toEqual([
      "editor-smoke.spec.ts › BabylonSlate editor smoke › loads shell, opens project, and shows viewport canvas",
      "p14-export.spec.ts › P14 export smoke › unzip-serve-boot-tick on range and range-blind servers",
      "p4-play.spec.ts › P4 Play overlay and session report › Play opens overlay; fixture throw shows report and focuses node",
    ]);
    const desktopKeys = new Set(
      listProject("desktop-chrome").map((test) => `${test.file} › ${test.title}`),
    );
    for (const test of webkit)
      expect(desktopKeys, `${test.title} also runs on desktop`).toContain(`${test.file} › ${test.title}`);
  }, 60_000);
});
