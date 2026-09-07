import { expect, test } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

const nodes: [string, string, Record<string, unknown>][] = [
  ["begin", "flow.event.beginPlay", {}],
  [
    "alive",
    "debug.print",
    { value: "QA_HOTRELOAD_MARKER", key: "alive", duration: 30 },
  ],
  ["delay", "timers.delay", { duration: 0.5 }],
  [
    "delayed",
    "debug.print",
    { value: "DELAY_COMPLETED", key: "delayed", duration: 30 },
  ],
  ["confirm", "input.onAction", { action: "Confirm", phase: "pressed" }],
  ["key", "literal.makeString", { "default:in": "a" }],
  ["value", "literal.makeString", { "default:in": "v" }],
  ["make", "map.make", { count: 1 }],
  ["has", "map.has", {}],
  ["get", "map.get", {}],
  ["printHas", "debug.print", { key: "has", duration: 30 }],
  ["printValue", "debug.print", { key: "value", duration: 30 }],
];
const wires: [string, string, string, string][] = [
  ["begin", "execOut", "alive", "execIn"],
  ["alive", "execOut", "delay", "execIn"],
  ["delay", "execOut", "delayed", "execIn"],
  ["key", "out", "make", "key0"],
  ["value", "out", "make", "value0"],
  ["make", "out", "has", "map"],
  ["make", "out", "get", "map"],
  ["key", "out", "has", "key"],
  ["key", "out", "get", "key"],
  ["confirm", "execOut", "printHas", "execIn"],
  ["printHas", "execOut", "printValue", "execIn"],
  ["has", "out", "printHas", "value"],
  ["get", "out", "printValue", "value"],
];
const graph: SerializedGraph = {
  nodes: nodes.map(([id, type, data], index) => ({
    id,
    type,
    data,
    position: { x: (index % 4) * 260, y: Math.floor(index / 4) * 180 },
  })),
  edges: wires.map(([source, sourceHandle, target, targetHandle], index) => ({
    id: `edge-${index}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  })),
};

for (const preview of [false, true]) {
  test(`H4/H5/H14 fresh control: BeginPlay, Delay and Map Has in ${preview ? "Preview Build" : "Normal Play"}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openTestProject(page);
    expect(
      await page.evaluate(
        async (next) =>
          (
            globalThis as unknown as {
              __babylonslateTest: {
                setMainGraphContent: (
                  value: SerializedGraph,
                ) => Promise<boolean>;
              };
            }
          ).__babylonslateTest.setMainGraphContent(next),
        graph,
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
    const prints = preview
      ? frame.getByTestId("print-overlay")
      : page.getByTestId("print-overlay");
    await expect(prints).toContainText("QA_HOTRELOAD_MARKER", {
      timeout: 30_000,
    });
    await expect(prints).toContainText("DELAY_COMPLETED");
    await (
      preview ? frame.locator("canvas#game") : page.getByTestId("play-canvas")
    ).click();
    await page.keyboard.press("Enter");
    await expect(prints.getByText("true", { exact: true })).toBeVisible();
    await expect(prints.getByText("v", { exact: true })).toBeVisible();
    await page
      .getByTestId(preview ? "preview-build-close" : "play-overlay-close")
      .click();
  });
}
