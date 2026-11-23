import { expect, test, type Page } from "@playwright/test";
import { createContentBrowserAsset, openMainScene, openTestProject } from "./open-test-project";
import { guidForPath } from "./material-graph";
import { clickPlayAndWaitForOverlay, runConsoleCommand, showOverlayButtons } from "./play";
import { saveAllIfEnabled } from "./save-all";
import { SOFTWARE_GL_ARGS } from "./software-gl";

const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

/**
 * The Feature Test Check's Profile switches a setting on for a row and restores it for the next baseline (`quality
 * reset`, the Profile's resolution and the part's off command), and each switch builds Play's world graph again. Back in
 * a state already drawn, Play links no program again (a byte-identical relink once kept one more program per switch,
 * from a stack entry's post-process pass named by its Material's build id) and holds the WebGL objects it held after
 * the first round. A Post Process Material in the Scene's stack, as the Feature Test main scene has one.
 */

/** Live WebGL objects by kind, programs linked, and links of a program whose shader text was linked before. */
type GlCounts = Record<string, number>;

const ROUNDS = 4;
const STEPS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [["worlddebug mergedmarches on"], ["quality reset", "quality resolution scale 1", "worlddebug mergedmarches off"]],
  [["quality shadows medium"], ["quality reset", "quality resolution scale 1"]],
  [["rendertargets off"], ["quality reset", "quality resolution scale 1", "rendertargets on"]],
];

async function counts(page: Page): Promise<{ programs: number | null; gl: GlCounts }> {
  return page.evaluate(() => {
    const host = globalThis as unknown as { __hapticPlayTest?: { rendering(): { programs?: { programs: number } | null } | null }; __restoreGl: GlCounts };
    return { programs: host.__hapticPlayTest?.rendering()?.programs?.programs ?? null, gl: { ...host.__restoreGl } };
  });
}

/** Until the program count and links stop changing for three polls: the switch's rebuild has drawn. */
async function settle(page: Page): Promise<void> {
  let last = "";
  let same = 0;
  for (let poll = 0; poll < 60 && same < 3; poll++) {
    await page.waitForTimeout(500);
    const now = await counts(page);
    const key = `${now.programs}/${now.gl.links}`;
    same = key === last ? same + 1 : 0;
    last = key;
  }
}

test("Play links nothing and holds its WebGL objects across a Profile's step and restore rounds", async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => {
    const live: GlCounts = { links: 0, relinks: 0 };
    (globalThis as unknown as { __restoreGl: GlCounts }).__restoreGl = live;
    const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    // Not queries: the GPU timer pool holds one per frame in flight, whichever frame a round ends on.
    for (const kind of ["Buffer", "Framebuffer", "Renderbuffer", "Texture", "Program", "VertexArray", "Sampler"]) {
      live[kind] = 0;
      const made = new WeakSet<object>();
      const create = proto[`create${kind}`]!, remove = proto[`delete${kind}`]!;
      proto[`create${kind}`] = function (this: unknown, ...args: unknown[]) {
        const object = create.apply(this, args) as object | null;
        if (object) { made.add(object); live[kind]! += 1; }
        return object;
      };
      proto[`delete${kind}`] = function (this: unknown, object: unknown) {
        if (object && made.delete(object as object)) live[kind]! -= 1;
        return remove.call(this, object);
      };
    }
    const sources = new WeakMap<object, string>();
    const attached = new WeakMap<object, string[]>();
    const linked = new Set<string>();
    const shaderSource = proto.shaderSource!, attach = proto.attachShader!, link = proto.linkProgram!;
    proto.shaderSource = function (this: unknown, shader: unknown, source: unknown) {
      sources.set(shader as object, source as string);
      return shaderSource.call(this, shader, source);
    };
    proto.attachShader = function (this: unknown, program: unknown, shader: unknown) {
      attached.set(program as object, [...(attached.get(program as object) ?? []), sources.get(shader as object) ?? ""]);
      return attach.call(this, program, shader);
    };
    proto.linkProgram = function (this: unknown, program: unknown) {
      const text = (attached.get(program as object) ?? []).join("\n----\n");
      live.links! += 1;
      if (linked.has(text)) live.relinks! += 1;
      linked.add(text);
      return link.call(this, program);
    };
  });
  await openTestProject(page);
  await createContentBrowserAsset(page, "Material", "Grade");
  await page.locator('[data-asset-path="assets/Grade.material.hasset"]').dblclick();
  await expect(page.getByTestId("document-workspace-material")).toBeVisible();
  await page.getByTestId("property-domain").click();
  await page.getByRole("option", { name: "Post Process" }).click();
  await expect(page.getByTestId("property-domain")).toContainText("Post Process");
  await saveAllIfEnabled(page);
  await openMainScene(page);
  await page.getByTestId("scene-post-process-stack-add").click();
  await page.getByTestId(`search-item-${await guidForPath(page, "assets/Grade.material.hasset")}`).click();
  await expect(page.getByTestId("scene-post-process-0-material")).toContainText("Grade");
  await showOverlayButtons(page, ["console"]);
  await clickPlayAndWaitForOverlay(page);
  await expect.poll(async () => (await counts(page)).programs, { timeout: 60_000 }).toBeGreaterThan(0);
  await settle(page);
  const rounds: Array<{ programs: number | null; gl: GlCounts }> = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const [step, restore] of STEPS) {
      for (const line of step) await runConsoleCommand(page, line);
      await settle(page);
      for (const line of restore) await runConsoleCommand(page, line);
      await settle(page);
    }
    rounds.push(await counts(page));
  }
  const [first, ...later] = rounds;
  // The first round compiles each step's programs; every later one draws them from the Effect cache.
  for (const [index, round] of later.entries()) {
    const objects = (gl: GlCounts) => Object.fromEntries(Object.entries(gl).filter(([kind]) => kind !== "links" && kind !== "relinks"));
    expect({ programs: round.programs, relinks: round.gl.relinks! - first!.gl.relinks!, objects: objects(round.gl) }, `round ${index + 2}`)
      .toEqual({ programs: first!.programs, relinks: 0, objects: objects(first!.gl) });
  }
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
});
