import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

type ListedTest = {
  project: string;
  file: string;
  title: string;
};

function listProject(project: string): ListedTest[] {
  const output = execFileSync(
    "pnpm",
    ["exec", "playwright", "test", "--list", `--project=${project}`],
    { encoding: "utf8", cwd: repoRoot },
  );
  const prefix = `[${project}] › `;
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      const rest = line.slice(prefix.length);
      const sep = rest.indexOf(" › ");
      const location = sep === -1 ? rest : rest.slice(0, sep);
      const title = sep === -1 ? rest : rest.slice(sep + 3);
      const file = location.replace(/:\d+:\d+$/, "");
      return { project, file, title };
    });
}

function filesOf(tests: ListedTest[]): string[] {
  return [...new Set(tests.map((test) => test.file))].sort();
}

describe("Playwright iPad project filter", () => {
  it("runs touch, layout, and orientation tests on iPad and keeps the rest on desktop", () => {
    const desktop = listProject("desktop-chrome");
    const landscape = listProject("ipad-landscape");
    const portrait = listProject("ipad-portrait");

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

    expect(filesOf(landscape)).toEqual(filesOf(portrait));
    expect(landscape.map((test) => test.title).sort()).toEqual(
      portrait.map((test) => test.title).sort(),
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
        "p9-content.spec.ts",
        "texture-encode-ipad.spec.ts",
      ]),
    );
    for (const file of [
      "p2-accept.spec.ts",
      "p4-play.spec.ts",
      "p5-scripting.spec.ts",
      "editor-smoke.spec.ts",
      "editor-theme.spec.ts",
      "engine-settings.spec.ts",
      "debug-menu.spec.ts",
    ]) {
      expect(ipadFiles, `${file} is desktop-only`).not.toContain(file);
    }

    const ipadTitles = landscape.map((test) => test.title);
    expect(ipadTitles).toEqual(
      expect.arrayContaining([
        "Touch shell UX › dockview tabs meet pointer-aware height",
        "Touch shell UX › opens context menu after long press in viewport panel",
        "Windows menu › restores Outliner and Output Log to their default dock positions",
        "Editor density and IA › chrome is compact, has no Add tab, and Focus is disabled on Content Browser",
        "Editor density and IA › Content Browser folder tree pans vertically on touch before reparent hold",
        "Editor density and IA › Focus hides the Outliner; Place Actors catalog does not focus search",
        "Editor density and IA › gizmo tools look pressed and the joystick toggle is in viewport settings",
        "gallery composites meet the minimum touch target size",
        "Global project search › toolbar search opens a dialog and focuses a scene actor",
        "Global project search › dialog stays a fixed tall height and results scroll when they overflow",
        "P6 first-playable scene editing › scene panels expose touch-sized toolbar controls",
        "P9 content systems › UserInterface designer on iPad opens a Canvas-only document",
        "P9 content systems › Play overlay stick is reachable on iPad",
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
  }, 20_000);
});
