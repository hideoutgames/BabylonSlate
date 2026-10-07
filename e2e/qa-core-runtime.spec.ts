import { expect, test } from "@playwright/test";
import {
  createMeshComponent,
  type SerializedGraph,
} from "../packages/core/src/index.ts";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { guidForPath } from "./material-graph";

for (const preview of [true]) {
  test(`H2: Spawn Actor retains prefab components and transform in ${preview ? "Preview Build" : "Normal Play"}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openTestProject(page);
    const confirmAsset = await guidForPath(
      page,
      "assets/Input/Confirm.inputaction.babasset",
    );
    const spawnGraph: SerializedGraph = {
      components: [
        createMeshComponent("spawn-mesh", "box"),
        { id: "spawn-collider", classId: "ColliderComponent", properties: {} },
      ],
      nodes: [
        {
          id: "confirm",
          type: "input.actionEvent",
          data: {
            "default:binding": {
              Input: { Name: "Confirm", Asset: confirmAsset },
            },
            valueType: "button",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "spawn",
          type: "actor.spawn",
          data: { "default:classId": "Mannequin" },
          position: { x: 300, y: 0 },
        },
        {
          id: "pose",
          type: "struct.makeTransform",
          data: { "default:location": { x: 10, y: 20, z: 30 } },
          position: { x: 0, y: 200 },
        },
        {
          id: "has",
          type: "component.has",
          data: { "default:classId": "ColliderComponent" },
          position: { x: 600, y: 200 },
        },
        {
          id: "print",
          type: "debug.print",
          data: { key: "spawned", duration: 30 },
          position: { x: 600, y: 0 },
        },
      ],
      edges: [
        {
          id: "confirm-spawn",
          source: "confirm",
          sourceHandle: "started",
          target: "spawn",
          targetHandle: "execIn",
        },
        {
          id: "pose-spawn",
          source: "pose",
          sourceHandle: "out",
          target: "spawn",
          targetHandle: "transform",
        },
        {
          id: "spawn-print",
          source: "spawn",
          sourceHandle: "execOut",
          target: "print",
          targetHandle: "execIn",
        },
        {
          id: "spawn-has",
          source: "spawn",
          sourceHandle: "out",
          target: "has",
          targetHandle: "actor",
        },
        {
          id: "has-print",
          source: "has",
          sourceHandle: "out",
          target: "print",
          targetHandle: "value",
        },
      ],
    };
    expect(
      await page.evaluate(
        (next) =>
          (
            globalThis as unknown as {
              __babylonslateTest: {
                setMainGraphContent: (
                  graph: SerializedGraph,
                ) => Promise<boolean>;
              };
            }
          ).__babylonslateTest.setMainGraphContent(next),
        spawnGraph,
      ),
    ).toBe(true);
    await openMainScene(page);
    if (preview) {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
    } else await clickPlayAndWaitForOverlay(page);
    const frame = page.frameLocator('[data-testid="preview-build-iframe"]');
    await (
      preview ? frame.locator("canvas#game") : page.getByTestId("play-canvas")
    ).click();
    await page.keyboard.press("Enter");
    await expect(
      (preview ? frame : page).getByTestId("print-overlay"),
    ).toContainText("true");
    await expect
      .poll(
        async () => {
          const host = preview
            ? page.frames().find((entry) => entry.url().includes("player"))
            : page;
          if (!host) return [];
          return host.evaluate(() => {
            type Visuals = {
              visuals: () => Array<{ worldMatrixPosition: number[] }>;
            };
            const scope = globalThis as unknown as {
              __babylonslatePlayTest?: Visuals;
              __babylonslatePlayerTest?: Visuals;
            };
            return (
              (scope.__babylonslatePlayTest ?? scope.__babylonslatePlayerTest)
                ?.visuals()
                .map((visual) => visual.worldMatrixPosition) ?? []
            );
          });
        },
        { timeout: 15_000 },
      )
      .toContainEqual([10, 20, 30]);
    await page
      .getByTestId(preview ? "preview-build-close" : "play-overlay-close")
      .click();
  });
}
