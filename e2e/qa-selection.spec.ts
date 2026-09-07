import { expect, test } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  identitySerializedTransform,
  type SerializedScene,
} from "../packages/core/src/index";
import { openMainScene, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

test("H8: repeated viewport marquee selects the actor without placing duplicates", async ({
  page,
}) => {
  await openTestProject(page);
  await openMainScene(page);
  await saveAllIfEnabled(page);
  const actors = page.locator('[data-testid^="tree-row-actor:"]');
  const count = await actors.count();
  expect(count).toBeGreaterThan(0);
  const tool = page.getByTestId("viewport-drag-select");
  const canvas = page.getByTestId("viewport-canvas");
  for (let attempt = 0; attempt < 3; attempt++) {
    await tool.click();
    await expect(tool).toHaveAttribute("aria-pressed", "true");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 12, box.y + 70);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 12, box.y + box.height - 20, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(tool).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("tree-row-actor:actor-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(actors).toHaveCount(count);
    await expect(page.getByTestId("save-all-project")).toBeDisabled();
  }
  await page.getByTestId("focus-layout").click();
  await expect(canvas).toBeVisible();
  await page.getByTestId("focus-layout").click();
  await expect(page.getByTestId("tree-row-actor:actor-1")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(actors).toHaveCount(count);
});

test("M5: shared Details edits preserve other axes and survive group Undo and reload", async ({
  page,
}) => {
  await openTestProject(page);
  await openMainScene(page);
  const scene: SerializedScene = {
    ...createDefaultScene(),
    actors: [
      createActor("a", "Alpha", {
        transform: { ...identitySerializedTransform(), position: [1, 2, 3] },
      }),
      createActor("b", "Beta", {
        transform: { ...identitySerializedTransform(), position: [4, 5, 6] },
      }),
      createActor("control", "Control"),
    ],
  };
  await page.evaluate(async (next) => {
    await (
      globalThis as unknown as {
        __babylonslateTest: {
          setActiveSceneContent: (scene: SerializedScene) => Promise<boolean>;
        };
      }
    ).__babylonslateTest.setActiveSceneContent(next);
  }, scene);
  await saveAllIfEnabled(page);
  const a = page.getByTestId("tree-row-actor:a");
  const b = page.getByTestId("tree-row-actor:b");
  const x = page.getByTestId("property-actor-position-x");
  const y = page.getByTestId("property-actor-position-y");
  await a.click();
  await b.click({ modifiers: ["Control"] });
  await expect(a).toHaveAttribute("aria-selected", "true");
  await expect(b).toHaveAttribute("aria-selected", "true");
  await expect(x).toHaveAttribute("placeholder", "Mixed");
  await x.fill("9");
  await x.press("Tab");
  await expect(page.getByTestId("save-all-project")).toBeEnabled();
  await b.click();
  await expect(x).toHaveValue("9");
  await expect(y).toHaveValue("5");
  await a.click();
  await expect(x).toHaveValue("9");
  await expect(y).toHaveValue("2");
  await page.getByTestId("undo-document").click();
  await expect(x).toHaveValue("1");
  await b.click();
  await expect(x).toHaveValue("4");
  await page.getByTestId("redo-document").click();
  await expect(x).toHaveValue("9");
  await a.click();
  await expect(x).toHaveValue("9");
  await b.click({ modifiers: ["Control"] });
  await page.getByTestId("property-actor-visible").click();
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openMainScene(page);
  for (const [id, wantY] of [
    ["a", "2"],
    ["b", "5"],
  ]) {
    await page.getByTestId(`tree-row-actor:${id}`).click();
    await expect(x).toHaveValue("9");
    await expect(y).toHaveValue(wantY!);
    await expect(page.getByTestId("property-actor-visible")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  }
  await page.getByTestId("tree-row-actor:control").click();
  await expect(x).toHaveValue("0");
  await expect(page.getByTestId("property-actor-visible")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
