import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedGraph,
} from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { enableTouchLayout, openMainScene } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";

type TestHost = typeof globalThis & {
  __hapticSimulationTest: { start(): Promise<void> };
  __hapticPlayTest: { tickIndex(): number };
  __hapticTest: { setMainGraphContent(graph: SerializedGraph): Promise<boolean> };
};

const CLASS_GRAPH = {
  nodes: [{ id: "tick", type: "flow.event.tick", position: { x: 0, y: 0 }, data: {} }],
  edges: [],
} as unknown as SerializedGraph;

const PINNED = ["save-all-project", "simulation-pause", "simulation-session-stop", "simulation-input-mode"];

/** Every displayed control in the global toolbar, by test id or accessible name. */
async function toolbarControls(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="editor-global-toolbar"]') as HTMLElement;
    return [...bar.querySelectorAll<HTMLElement>('button, [role="combobox"]')]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .map(({ element, rect }) => ({
        id: element.getAttribute("data-testid") ?? element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "?",
        left: rect.left,
        right: rect.right,
      }));
  });
}

async function expectNoOverlap(page: Page) {
  const controls = await toolbarControls(page);
  const overlaps: string[] = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!;
      const b = controls[j]!;
      if (a.left < b.right - 1 && b.left < a.right - 1) overlaps.push(`${a.id} / ${b.id}`);
    }
  }
  expect(overlaps).toEqual([]);
  const width = page.viewportSize()!.width;
  for (const control of controls) expect(control.right, `${control.id} stays on screen`).toBeLessThanOrEqual(width + 1);
}

async function startSimulation(page: Page) {
  await page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  await expect(page.getByTestId("scene-loading-dialog")).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => (globalThis as TestHost).__hapticPlayTest.tickIndex()), { timeout: 30_000 })
    .toBeGreaterThan(2);
}

/** A project with a Class graph and an instance of it, opened at tablet size so every window is reachable. */
async function openProject(page: Page) {
  await page.setViewportSize({ width: 1194, height: 834 });
  await openMinimalTestProject(page);
  await openMainScene(page);
  expect(await page.evaluate((graph) => (globalThis as TestHost).__hapticTest.setMainGraphContent(graph), CLASS_GRAPH)).toBe(true);
  const scene = createDefaultScene();
  scene.actors = [
    ...scene.actors.filter((actor) => actor.classId !== "main"),
    createActor("alpha", "Alpha", {
      classId: "main",
      transform: identitySerializedTransform(),
      components: [createMeshComponent("alpha-mesh", "box")],
    }),
  ];
  await setPreviewScene(page, scene);
}

async function focusClassGraph(page: Page) {
  const tab = page.locator('[data-testid="document-tab"][data-document-kind="graph"]').getByTestId("document-tab-select");
  if (await tab.count()) {
    await tab.click();
    return;
  }
  // The phone layout lists documents in the Open Documents menu.
  await page.getByTestId("document-switcher").click();
  await page.locator("[data-document-id]").filter({ hasNotText: /Content Browser|scene/i }).first().click();
}

test.describe("Global toolbar overflow", () => {
  test.use({ hasTouch: true });

  test("at 390 px nothing overlaps while a Simulation runs and the rest moves into More Actions", async ({ page }) => {
    test.setTimeout(240_000);
    await enableTouchLayout(page);
    await openProject(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoOverlap(page);

    await startSimulation(page);
    for (const where of ["scene", "class graph"]) {
      if (where === "class graph") await focusClassGraph(page);
      await expect.poll(async () => (await toolbarControls(page)).length).toBeGreaterThan(0);
      // Play and Simulate controls and Save All stay; whatever does not fit is behind More Actions.
      for (const id of PINNED) await expect(page.getByTestId(id), `${id} on the ${where}`).toBeVisible();
      await expect(page.getByTestId("toolbar-overflow")).toBeVisible();
      await expectNoOverlap(page);
      // Compact controls: nothing is enlarged beyond the phone touch target.
      for (const control of await page.getByTestId("editor-global-toolbar").locator("button:visible").all()) {
        expect((await control.boundingBox())!.height).toBeLessThanOrEqual(44.5);
      }
    }

    // Collapsed controls keep their labels and touch-sized rows in the menu.
    await page.getByTestId("toolbar-overflow").tap();
    const items = page.getByTestId("toolbar-overflow-menu-content").getByRole("menuitem");
    await expect(items.first()).toBeVisible();
    expect((await items.first().boundingBox())!.height).toBeGreaterThanOrEqual(43);
    expect(await items.allInnerTexts()).not.toContain("");
    await page.keyboard.press("Escape");

    await page.getByTestId("simulation-session-stop").tap();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 30_000 });
    await expectNoOverlap(page);
  });

  test("at a desktop width every toolbar control stays in place", async ({ page }) => {
    test.setTimeout(240_000);
    await openProject(page);
    await expect(page.getByTestId("toolbar-overflow")).toBeHidden();
    for (const id of ["undo-document", "redo-document", "windows-menu", "focus-layout", "global-search", "settings-menu"]) {
      await expect(page.getByTestId(id), id).toBeVisible();
    }
    await expectNoOverlap(page);

    await startSimulation(page);
    await focusClassGraph(page);
    await expect(page.getByTestId("simulation-return-to-scene")).toBeVisible();
    await expect(page.getByTestId("graph-debug-instance-select")).toBeVisible();
    await expect(page.getByTestId("compile-graph")).toBeVisible();
    await expect(page.getByTestId("toolbar-overflow")).toBeHidden();
    await expectNoOverlap(page);
  });
});
