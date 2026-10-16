import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedScene,
} from "../packages/core/src/index";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openMainScene, openTestProject } from "./open-test-project";

/** Two boxes either side of the view centre: a pick that samples the centre pixel hits neither. */
function offCentreBoxes(): SerializedScene {
  const base = createDefaultScene();
  const sun = base.actors.find((actor) =>
    actor.components.some((component) => component.classId === "LightComponent"),
  );
  const box = (id: string, name: string, x: number) =>
    createActor(id, name, {
      transform: { ...identitySerializedTransform(), position: [x, 0, 0] },
      components: [createMeshComponent(`${id}-mesh`, "box")],
    });
  return {
    ...base,
    actors: [...(sun ? [sun] : []), box("left-box", "Left Box", -3), box("right-box", "Right Box", 3)],
  };
}

/** Where an actor's mesh sits in the viewport canvas, as fractions of its width and height. */
async function actorCanvasFraction(page: Page, actorId: string) {
  return page.evaluate(
    (id) =>
      (
        globalThis as unknown as {
          __babylonslateViewportTest: {
            actorCanvasFraction: (actorId: string) => { x: number; y: number } | null;
          };
        }
      ).__babylonslateViewportTest.actorCanvasFraction(id),
    actorId,
  );
}

async function tap(page: Page, touch: boolean, point: { x: number; y: number }) {
  if (!touch) {
    await page.mouse.click(point.x, point.y);
    return;
  }
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}

test("a viewport tap selects the actor under it, not the one at the view centre", { tag: IPAD_TEST_TAG }, async ({
  page,
  isMobile,
}) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  await openMainScene(page);
  await page.evaluate(
    (scene) =>
      (
        globalThis as unknown as {
          __babylonslateTest: { setActiveSceneContent: (scene: SerializedScene) => Promise<boolean> };
        }
      ).__babylonslateTest.setActiveSceneContent(scene),
    offCentreBoxes(),
  );
  const rows = {
    "left-box": page.getByTestId("tree-row-actor:left-box"),
    "right-box": page.getByTestId("tree-row-actor:right-box"),
  };
  await expect(rows["left-box"]).toBeVisible();
  await expect(rows["right-box"]).toBeVisible();

  const canvas = page.getByTestId("viewport-canvas");
  const box = (await canvas.boundingBox())!;
  for (const [tapped, other] of [["left-box", "right-box"], ["right-box", "left-box"]] as const) {
    // Mesh sync trails the document change, so wait for the actor to be placed.
    await expect.poll(() => actorCanvasFraction(page, tapped)).not.toBeNull();
    const at = (await actorCanvasFraction(page, tapped))!;
    expect(Math.abs(at.x - 0.5), `${tapped} must sit clear of the view centre`).toBeGreaterThan(0.1);
    await tap(page, isMobile, { x: box.x + at.x * box.width, y: box.y + at.y * box.height });
    await expect(rows[tapped]).toHaveAttribute("aria-selected", "true");
    await expect(rows[other]).toHaveAttribute("aria-selected", "false");
  }
});
