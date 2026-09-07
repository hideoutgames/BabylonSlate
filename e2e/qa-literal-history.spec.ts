import { expect, test } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index.ts";
import { literalNodes } from "../packages/scripting-nodes/src/literal.ts";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";
import { clickPlayAndWaitForOverlay } from "./play";

test("H25/M4: Float defaults persist and separately committed edits undo independently", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  const literal = literalNodes.find(
    (entry) => entry.id === "literal.makeFloat",
  )!;
  const graph: SerializedGraph = {
    nodes: [
      {
        id: "begin",
        type: "flow.event.beginPlay",
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: "literal",
        type: "literal.makeFloat",
        position: { x: 0, y: 180 },
        data: {
          title: literal.title,
          __nodeType: literal.id,
          __pins: literal.pins({}),
          "default:in": 0,
        },
      },
      {
        id: "print",
        type: "debug.print",
        position: { x: 320, y: 0 },
        data: { key: "literal", duration: 30 },
      },
    ],
    edges: [
      {
        id: "exec",
        source: "begin",
        sourceHandle: "execOut",
        target: "print",
        targetHandle: "execIn",
      },
      {
        id: "value",
        source: "literal",
        sourceHandle: "out",
        target: "print",
        targetHandle: "value",
      },
    ],
  };
  await page.evaluate(async (next) => {
    await (
      globalThis as unknown as {
        __babylonslateTest: {
          setMainGraphContent: (value: SerializedGraph) => Promise<boolean>;
        };
      }
    ).__babylonslateTest.setMainGraphContent(next);
  }, graph);
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await saveAllIfEnabled(page);
  await page.locator('.react-flow__node[data-id="literal"]').click();
  const input = page
    .getByTestId("inspector-pin-defaults")
    .getByTestId("property-in");
  await expect(input).toBeVisible();
  await input.fill("42");
  await input.press("Tab");
  await expect(input).toHaveValue("42");
  await expect(page.getByTestId("save-all-project")).toBeEnabled();
  await input.fill("43");
  await input.press("Tab");
  await expect(input).toHaveValue("43");
  await page.getByTestId("undo-document").click();
  await expect(input).toHaveValue("42");
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await page.locator('.react-flow__node[data-id="literal"]').click();
  await expect(input).toHaveValue("42");
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("print-overlay")).toContainText("42", {
    timeout: 30_000,
  });
  await page.getByTestId("play-overlay-close").click();
});
