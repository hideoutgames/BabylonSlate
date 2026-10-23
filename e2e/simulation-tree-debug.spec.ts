import { expect, test, type Page } from "@playwright/test";
import { createContentBrowserAsset, openMainScene, openTestProject } from "./open-test-project";
import { pickCatalogItem } from "./pick-catalog-item";

type TestHost = typeof globalThis & {
  __hapticSimulationTest: { start(): Promise<void> };
  __hapticPlayTest: { tickIndex(): number };
  __hapticTest: { guidForPath(path: string): string | null };
};

const select = (page: Page) => page.getByTestId("graph-debug-instance-select");

async function openAsset(page: Page, path: string, editor: string) {
  await page.locator('[data-testid="document-tab"][data-document-kind="content-browser"]').click();
  await page.locator(`[data-asset-path="${path}"]`).dblclick();
  await expect(page.getByTestId(editor)).toBeVisible({ timeout: 15_000 });
}

/** Places an Empty actor, which is selected afterwards; they are named Empty, Empty 2 and so on. */
async function placeEmptyActor(page: Page) {
  await page.getByTestId("outliner-add-actor").click();
  await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
  await page.getByTestId("place-actors-catalog-search").fill("empty");
  await page.getByTestId("place-actors-item-empty").click();
}

async function addAssetComponent(page: Page, componentId: string, label: string, property: string, guid: string) {
  await page.getByTestId("details-add-component").click();
  await pickCatalogItem(page, "add-component-catalog", componentId, label);
  const card = page.locator("[data-testid^='component-card-']").filter({
    has: page.getByRole("button", { name: new RegExp(`^${label}(?: \\(|$)`) }),
  });
  await card.locator(`button[data-testid$="-${property}"]`).click();
  await expect(page.getByTestId("details-asset-picker")).toBeVisible();
  await page.getByTestId(`search-item-${guid}`).click();
  await expect(page.getByTestId("details-asset-picker")).toBeHidden();
}

/** What the canvas inside `editorTestId` animates over `ms`: its Web Animations by target, and how the wires' stroke looked. */
async function watchCanvas(page: Page, editorTestId: string, ms: number) {
  return page.evaluate(async ({ ms: window, editorTestId }) => {
    const editor = document.querySelector(`[data-testid="${editorTestId}"]`)!;
    const nodes = new Set<string>();
    const wires = new Set<string>();
    const wireFades: string[] = [];
    const strokes = new Set<string>();
    const started = performance.now();
    while (performance.now() - started < window) {
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null;
        const target = effect?.target;
        if (!(target instanceof Element) || !editor.contains(target)) continue;
        if (target.matches("[data-node-role]")) nodes.add(target.closest(".react-flow__node")?.getAttribute("data-id") ?? "");
        const edge = target.matches(".react-flow__edge-path") ? target.closest(".react-flow__edge")?.getAttribute("data-id") : null;
        if (edge) {
          wires.add(edge);
          const first = effect!.getKeyframes()[0] as Record<string, unknown>;
          wireFades.push(`${first.computedOffset}:${String(first["--run-flash"])}`);
        }
      }
      for (const path of editor.querySelectorAll(".react-flow__edge-path")) strokes.add(getComputedStyle(path).stroke);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { nodes: [...nodes].sort(), wires: [...wires].sort(), wireFades: [...new Set(wireFades)], strokes: [...strokes] };
  }, { ms, editorTestId });
}

test("a Simulation shows a Behaviour Tree and an Animation Graph run for the instance picked in the toolbar", async ({ page }) => {
  test.setTimeout(240_000);
  await openTestProject(page);
  await createContentBrowserAsset(page, "BehaviourTree", "Patrol");
  await createContentBrowserAsset(page, "AnimationGraph", "Loco");
  await openAsset(page, "assets/Patrol.bt.hasset", "behaviour-tree-editor");
  await openAsset(page, "assets/Loco.anim.hasset", "anim-graph-editor");
  const guid = (path: string) => page.evaluate((assetPath) => (globalThis as TestHost).__hapticTest.guidForPath(assetPath) ?? "", path);
  const [treeGuid, graphGuid] = [await guid("assets/Patrol.bt.hasset"), await guid("assets/Loco.anim.hasset")];
  expect(treeGuid).not.toBe("");
  expect(graphGuid).not.toBe("");

  await openMainScene(page);
  await placeEmptyActor(page);
  await addAssetComponent(page, "BehaviourTreeComponent", "Behaviour Tree", "treeGuid", treeGuid);
  await addAssetComponent(page, "AnimationGraphComponent", "Animation Graph", "graphGuid", graphGuid);
  await placeEmptyActor(page);
  await addAssetComponent(page, "BehaviourTreeComponent", "Behaviour Tree", "treeGuid", treeGuid);

  await page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  await expect(page.getByTestId("scene-loading-dialog")).toHaveCount(0, { timeout: 60_000 });

  // Editing a tree shows no instance picker; the Simulation shows one once the tree is in focus.
  await page.locator('[data-testid="document-tab"][data-document-kind="behaviour-tree"]').click();
  await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
  await expect(select(page)).toContainText("Empty", { timeout: 15_000 });
  await select(page).click();
  await expect(page.getByRole("option")).toHaveText(["None", "Empty", "Empty 2"]);
  await page.keyboard.press("Escape");

  // The tree's nodes and wires light up, and each node reports the status of the followed instance.
  const tree = await watchCanvas(page, "behaviour-tree-editor", 1500);
  expect(tree.nodes).toEqual(["root", "sequence", "task"]);
  expect(tree.wires).toEqual(["bt-root-sequence", "bt-sequence-task"]);
  // The wire fades `--run-flash` from full strength (offset 0), because its stylesheet stroke is !important.
  expect(tree.wireFades).toEqual(["0:100%"]);
  // ...and the stroke really changes while it does: it passes through colours other than its resting grey.
  expect(tree.strokes.length).toBeGreaterThan(2);
  await expect(page.getByTestId("bt-node-task")).toHaveAttribute("data-bt-state", "success");
  await page.getByTestId("bt-node-task").hover();
  await expect(page.getByTestId("graph-node-status-tip")).toHaveText("Success");

  // None stops watching: the node forgets its status.
  await select(page).click();
  await page.getByRole("option", { name: "None" }).click();
  await expect(page.getByTestId("bt-node-task")).toHaveAttribute("data-bt-state", "idle");
  await select(page).click();
  await page.getByRole("option", { name: "Empty 2" }).click();
  await expect(page.getByTestId("bt-node-task")).toHaveAttribute("data-bt-state", "success");

  // The Animation Graph lists its own component, and its State Machine lights the state it plays.
  await page.locator('[data-testid="document-tab"][data-document-kind="anim-graph"]').click();
  await expect(page.getByTestId("anim-graph-editor")).toBeVisible();
  await expect(select(page)).toContainText("Empty", { timeout: 15_000 });
  const machine = await watchCanvas(page, "anim-graph-editor", 1000);
  expect(machine.nodes).toEqual(["idle"]);
});

test("a breakpoint on a Behaviour Tree node stops a Simulation when the node starts, naming the tree, node and object", async ({ page }) => {
  test.setTimeout(240_000);
  await openTestProject(page);
  await createContentBrowserAsset(page, "BehaviourTree", "Patrol");
  await openAsset(page, "assets/Patrol.bt.hasset", "behaviour-tree-editor");
  const treeGuid = await page.evaluate(() => (globalThis as TestHost).__hapticTest.guidForPath("assets/Patrol.bt.hasset") ?? "");
  expect(treeGuid).not.toBe("");
  const task = page.getByTestId("behaviour-tree-editor").locator('.react-flow__node[data-id="task"]');
  await page.getByTestId("bt-node-task").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add Breakpoint" }).click();
  await expect(task.locator('[data-breakpoint="enabled"]')).toHaveCount(1);

  await openMainScene(page);
  await placeEmptyActor(page);
  await addAssetComponent(page, "BehaviourTreeComponent", "Behaviour Tree", "treeGuid", treeGuid);

  await page.evaluate(() => (globalThis as TestHost).__hapticSimulationTest.start());
  await expect(page.getByTestId("play-overlay")).toHaveAttribute("data-mode", "simulate", { timeout: 60_000 });
  // The first tick starts the task: the Simulation pauses and the tree opens, following the actor that stopped.
  await expect(page.getByTestId("simulation-step")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
  await expect(page.getByTestId("simulation-breakpoint-stop")).toHaveAttribute("aria-label", "Stopped At Patrol › Succeed (Started) on Empty");
  await expect(select(page)).toContainText("Empty", { timeout: 15_000 });
  const tickIndex = () => page.evaluate(() => (globalThis as TestHost).__hapticPlayTest.tickIndex());
  const stoppedAt = await tickIndex();
  await page.waitForTimeout(300);
  expect(await tickIndex()).toBe(stoppedAt);

  // Switched off while the tree is read-only, it no longer stops the Simulation.
  await page.getByTestId("bt-node-task").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Disable Breakpoint" }).click();
  await expect(task.locator('[data-breakpoint="disabled"]')).toHaveCount(1);
  await page.getByTestId("simulation-pause").click();
  await expect.poll(tickIndex, { timeout: 30_000 }).toBeGreaterThan(stoppedAt + 2);
  await expect(page.getByTestId("simulation-breakpoint-stop")).toHaveCount(0);
});
