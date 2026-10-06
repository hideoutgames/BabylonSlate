import { expect, test } from "@playwright/test";
import type { SerializedGraph } from "../packages/core/src/index";
import { literalNodes } from "../packages/scripting-nodes/src/literal";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";

test("inline numeric defaults keep their scrub area inside the shared input", { tag: IPAD_TEST_TAG }, async ({ page }) => {
  await openMinimalTestProject(page);
  const literal = literalNodes.find((node) => node.id === "literal.makeFloat")!;
  const graph: SerializedGraph = {
    nodes: [{
      id: "literal", type: literal.id, position: { x: 80, y: 80 },
      data: { title: literal.title, __nodeType: literal.id, __pins: literal.pins({}), "default:in": 1 },
    }],
    edges: [],
  };
  expect(await page.evaluate(async (next) => {
    const host = globalThis as unknown as {
      __babylonslateTest: { setMainGraphContent: (graph: SerializedGraph) => Promise<boolean> };
    };
    return host.__babylonslateTest.setMainGraphContent(next);
  }, graph)).toBe(true);
  await openAssetFromBrowser(page, "assets/main.class.babasset");
  const node = page.locator('.react-flow__node[data-id="literal"]');
  await node.getByText("Make Float", { exact: true }).click();
  const input = page.getByTestId("pin-default-literal-in");
  const inspector = page.getByTestId("inspector-pin-defaults").getByTestId("property-in");
  const scrub = page.getByTestId("pin-default-literal-in-scrub");
  await expect(input).toBeVisible();
  await expect(inspector).toBeVisible();
  const inputBox = (await input.boundingBox())!;
  const scrubBox = (await scrub.boundingBox())!;
  expect(scrubBox.x).toBeGreaterThanOrEqual(inputBox.x);
  expect(scrubBox.x + scrubBox.width).toBeLessThanOrEqual(inputBox.x + inputBox.width + 1);
  expect(scrubBox.y).toBeGreaterThanOrEqual(inputBox.y - 1);
  expect(scrubBox.y + scrubBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height + 1);
  expect(await input.evaluate((element) => getComputedStyle(element).height))
    .toBe(await inspector.evaluate((element) => getComputedStyle(element).height));

  await input.fill("3*2");
  await input.press("Enter");
  await expect(input).toHaveValue("6");
  await expect(inspector).toHaveValue("6");
  const nodeTransform = await node.evaluate((element) => (element as HTMLElement).style.transform);
  const handle = (await scrub.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 30, handle.y + handle.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => Number(await input.inputValue())).toBeGreaterThan(6);
  expect(await node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(nodeTransform);
  await page.getByTestId("undo-document").click();
  await expect(input).toHaveValue("6");
  await expect(inspector).toHaveValue("6");
});

test("Add Component actions match the viewport island and Class tabs use their asset icon", { tag: IPAD_TEST_TAG }, async ({ page }, testInfo) => {
  await openMinimalTestProject(page);
  const tile = page.locator('[data-asset-path="assets/main.class.babasset"]');
  await expect(tile.locator('[data-type-icon="Actor"]')).toBeVisible();
  await tile.click();
  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Generate Thumbnail", exact: true }).click();
  const tileThumbnail = tile.locator("img");
  await expect(tileThumbnail).toBeVisible({ timeout: 30_000 });
  await openMainScene(page);
  await page.getByTestId("tree-row-actor:actor-1").click();
  const reference = (await page.getByTestId("gizmo-tool-translate").boundingBox())!;
  const detailsAdd = page.getByTestId("details-add-component");
  await expect(detailsAdd).toBeVisible();
  expect((await detailsAdd.boundingBox())!.height).toBe(reference.height);
  await detailsAdd.click();
  const detailsCatalog = page.getByTestId("add-component-catalog");
  await expect(detailsCatalog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detailsCatalog).toHaveCount(0);

  await openAssetFromBrowser(page, "assets/main.class.babasset");
  const prefabAdd = page.getByTestId("prefab-add-component");
  await expect(prefabAdd).toBeVisible();
  expect((await prefabAdd.boundingBox())!.height).toBe(reference.height);
  const tab = page.locator('[data-testid="document-tab"][data-document-kind="graph"]');
  await expect(tab.locator("[data-type-icon]")).toHaveAttribute("data-type-icon", "Actor");
  await page.getByTestId("document-switcher").click();
  await expect(page.getByTestId("open-documents-menu").locator('[data-document-id] [data-type-icon="Actor"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("compact-class-controls.png") });
  await prefabAdd.click();
  await expect(page.getByTestId("prefab-add-component-catalog")).toBeVisible();
});

test(
  "viewport island and Transform inputs stay compact and commit arithmetic",
  {
    tag: IPAD_TEST_TAG,
  },
  async ({ page }) => {
    await openMinimalTestProject(page);
    await openMainScene(page);
    const toolbar = page.getByTestId("viewport-toolbar");
    await expect(toolbar).toBeVisible();
    const heights = await toolbar.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => ({
        label: button.getAttribute("aria-label"),
        height: button.getBoundingClientRect().height,
      })),
    );
    const moveHeight = heights.find(({ label }) => label === "Move")!.height;
    expect(moveHeight).toBeLessThanOrEqual(30);
    for (const label of ["Snap Grid", "Drop", "Viewport Settings"]) {
      expect(
        heights.find((button) => button.label === label)?.height,
        label,
      ).toBe(moveHeight);
    }

    const mode = page.getByTestId("viewport-mode-toggle");
    await expect(mode).toHaveText("3D");
    await mode.click();
    await expect(mode).toHaveText("2D");
    await expect(page.getByTestId("save-all-dirty")).toBeVisible();
    await page.getByTestId("undo-document").click();
    await expect(mode).toHaveText("3D");

    await page.getByTestId("tree-row-actor:actor-1").click();
    const position = page.getByTestId("property-actor-position-x");
    await expect(position).toBeVisible();
    const metrics = await position.evaluate((input) => {
      const style = getComputedStyle(input);
      return {
        height: input.getBoundingClientRect().height,
        font: parseFloat(style.fontSize),
        padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
        width: input.clientWidth,
        scrollWidth: input.scrollWidth,
      };
    });
    expect(metrics.height).toBeLessThanOrEqual(30);
    expect(metrics.font).toBeLessThanOrEqual(13);
    expect(metrics.padding).toBeLessThanOrEqual(12);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
    await position.fill("30/2");
    await position.press("Enter");
    await expect(position).toHaveValue("15");
    await position.focus();
    await expect(position).toHaveValue("15");

    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    const close = page.getByTestId("close-project");
    const done = page.getByRole("button", { name: "Done", exact: true });
    await expect(close).toBeVisible();
    await expect(done).toBeVisible();
    const closeBox = (await close.boundingBox())!;
    const doneBox = (await done.boundingBox())!;
    expect(closeBox.x + closeBox.width).toBeLessThan(doneBox.x);
    expect(closeBox.y + closeBox.height / 2).toBeCloseTo(
      doneBox.y + doneBox.height / 2,
      0,
    );
  },
);

test(
  "snap settings open on hold and right-click without toggling",
  { tag: IPAD_TEST_TAG },
  async ({ page }) => {
    await openMinimalTestProject(page);
    await openMainScene(page);
    const snap = page.getByTestId("gizmo-snap-toggle");
    await expect(snap).toBeVisible();
    const pressed = await snap.getAttribute("aria-pressed");
    const box = (await snap.boundingBox())!;
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    const dialog = page.getByTestId("viewport-grid-size-dialog");
    await expect(dialog).toBeVisible();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(dialog).toBeVisible();
    await expect(snap).toHaveAttribute("aria-pressed", pressed!);
    await dialog.getByRole("textbox", { name: "Grid Size", exact: true }).fill("2");
    await dialog.getByLabel("Grid Snap", { exact: true }).fill("0.25");
    await dialog.getByLabel("Rotation Snap (Degrees)").fill("90/2");
    await dialog.getByLabel("Scale Snap", { exact: true }).fill("0.5");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(snap).toHaveText("0.25");
    await page.getByRole("button", { name: "Rotate", exact: true }).click();
    await expect(snap).toHaveText("45\u00b0");
    await page.getByRole("button", { name: "Scale", exact: true }).click();
    await expect(snap).toHaveText("0.5");
    await snap.click({ button: "right" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Grid Size", { exact: true })).toHaveValue("2");
    await expect(dialog.getByLabel("Grid Snap", { exact: true })).toHaveValue("0.25");
    await expect(dialog.getByLabel("Rotation Snap (Degrees)")).toHaveValue(
      "45",
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(snap).toHaveAttribute("aria-pressed", pressed!);
    await snap.click();
    await expect(snap).toHaveAttribute(
      "aria-pressed",
      pressed === "true" ? "false" : "true",
    );
    await session.detach();
  },
);
