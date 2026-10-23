import { expect, test } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedGraph,
} from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, showOverlayButtons } from "./play";
import { setPreviewScene } from "./preview-parity";

type TestHost = typeof globalThis & {
  __hapticTest: { setMainGraphContent(graph: SerializedGraph): Promise<boolean> };
};

const node = (id: string, type: string, data: Record<string, unknown> = {}, x = 0) =>
  ({ id, type, position: { x, y: 0 }, data });

/** Each tick runs Event Tick and then Do N. */
const TICK_GRAPH = {
  nodes: [node("tick", "flow.event.tick"), node("count", "flow.doN", { "default:n": 100_000 }, 320)],
  edges: [{ id: "tick.execOut>count.execIn", source: "tick", sourceHandle: "execOut", target: "count", targetHandle: "execIn" }],
} as unknown as SerializedGraph;

test("the Profiler's Scripts view lists what each Class ran and opens an entry's graph at its node", async ({ page }) => {
  test.setTimeout(180_000);
  await openMinimalTestProject(page);
  await showOverlayButtons(page, ["profiler"]);
  await openMainScene(page);
  expect(await page.evaluate((graph) => (globalThis as TestHost).__hapticTest.setMainGraphContent(graph), TICK_GRAPH)).toBe(true);
  const scene = createDefaultScene();
  scene.actors = [
    ...scene.actors.filter((actor) => actor.classId !== "main"),
    ...["hero", "sidekick"].map((id) => createActor(id, id, { classId: "main", transform: identitySerializedTransform(),
      components: [createMeshComponent(`${id}-mesh`, "box")] })),
  ];
  await setPreviewScene(page, scene);
  await clickPlayAndWaitForOverlay(page);

  await page.getByTestId("play-profiler-open").click();
  const dialog = page.getByRole("dialog", { name: "Profiler and Frame Debugger" });
  const results = dialog.getByTestId("session-diagnostic-results");
  await dialog.getByRole("button", { name: "Record Performance" }).first().click();
  await dialog.getByRole("button", { name: "Stop Recording" }).click({ delay: 1500 });
  await expect(results).toContainText(/\d+ completed frame samples · \d+ runtime tick samples/, { timeout: 30_000 });

  await dialog.getByRole("button", { name: "Scripts" }).click();
  const tickRow = results.getByTestId("profile-script-entry").filter({ hasText: "Event Tick" });
  await expect(tickRow).toHaveCount(1);
  // Both actors ran Event Tick on every recorded tick.
  const calls = Number(await tickRow.locator("td").first().textContent());
  expect(calls).toBeGreaterThan(2);
  expect(calls % 2).toBe(0);

  // After Play, the recording stays, and its entry opens the Class graph at Event Tick.
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 30_000 });
  await tickRow.getByRole("button", { name: "Event Tick" }).click();
  await expect(page.getByTestId("focused-graph-node")).toHaveAttribute("data-node-id", "tick", { timeout: 15_000 });
});
