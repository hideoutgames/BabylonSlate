import { expect, test, type Page } from "@playwright/test";
import { createContentBrowserAsset, openMainScene, openTestProject } from "./open-test-project";
import { guidForPath } from "./material-graph";
import { saveAllIfEnabled } from "./save-all";

async function viewportPostProcessPassCount(
  page: Page,
): Promise<number | null> {
  return page.evaluate(
    () =>
      (
        globalThis as {
          __babylonslateViewportTest?: {
            postProcessPassCount: () => number | null;
          };
        }
      ).__babylonslateViewportTest?.postProcessPassCount() ?? null,
  );
}

async function viewportHardwareScalingLevel(
  page: Page,
): Promise<number | null> {
  return page.evaluate(
    () =>
      (
        globalThis as {
          __babylonslateViewportTest?: {
            hardwareScalingLevel: () => number | null;
          };
        }
      ).__babylonslateViewportTest?.hardwareScalingLevel() ?? null,
  );
}

test("editor viewport applies hardware scaling and the post-processing gate", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openTestProject(page);
  await page
    .locator(
      '[data-testid="document-tab"][data-document-kind="content-browser"]',
    )
    .click();
  await expect(
    page.getByTestId("document-workspace-content-browser"),
  ).toBeVisible();
  await page.getByTestId("content-browser-new-asset").click();
  await expect(
    page.getByTestId("content-browser-new-asset-dialog"),
  ).toBeVisible();
  await page.getByTestId("new-asset-type-Material").click();
  await page.getByTestId("new-asset-name").fill("Bloom");
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(
    page.getByTestId("content-browser-new-asset-dialog"),
  ).toHaveCount(0);
  await page
    .locator('[data-asset-path="assets/Bloom.material.babasset"]')
    .dblclick();
  await expect(page.getByTestId("document-workspace-material")).toBeVisible();
  await page.getByTestId("property-domain").click();
  await page.getByRole("option", { name: "Post Process" }).click();
  await saveAllIfEnabled(page);
  await createContentBrowserAsset(page, "SceneLayer", "Foreground_Layer_With_A_Long_Name");
  await openMainScene(page);
  await expect(page.getByTestId("scene-post-process-stack")).toBeVisible();
  await page.getByTestId("scene-post-process-stack-add").click();
  await expect(page.getByTestId("scene-post-process-picker")).toBeVisible();
  const bloomGuid = await page.evaluate(() => {
    const host = globalThis as {
      __babylonslateTest?: { guidForPath: (path: string) => string | null };
    };
    return (
      host.__babylonslateTest?.guidForPath("assets/Bloom.material.babasset") ??
      ""
    );
  });
  expect(bloomGuid.length).toBeGreaterThan(0);
  await page.getByTestId(`search-item-${bloomGuid}`).click();

  // Adding a pass asynchronously recollects viewport assets before attaching it.
  await expect
    .poll(async () => viewportPostProcessPassCount(page), { timeout: 30_000 })
    .toBe(1);

  await page.getByRole("textbox", { name: "Filter Properties" }).fill("Enabled");
  await page.getByTestId("scene-layers-stack-add").click();
  const layerGuid = await guidForPath(page, "assets/Foreground_Layer_With_A_Long_Name.scenelayer.babasset");
  expect(layerGuid).not.toBe("");
  await page.getByTestId(`search-item-${layerGuid}`).click();

  // Measure the actual docked panel, including a long name and Open Asset.
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  for (const id of ["scene-post-process-stack-0-row", "scene-layers-stack-0-row"]) {
    const row = page.getByTestId(id);
    await expect(row).toBeVisible();
    const layout = await row.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const controls = Array.from(element.querySelectorAll("button, input, [role=switch]"))
        .filter((control) => control.getAttribute("aria-hidden") !== "true")
        .map((control) => {
          const rect = control.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
      return { width: box.width, height: box.height, left: box.left, right: box.right, controls };
    });
    await row.screenshot({ path: test.info().outputPath(`${id}.png`) });
    expect(layout.width).toBeLessThanOrEqual(300);
    expect(layout.height).toBeLessThanOrEqual(coarse ? 152 : 68);
    for (const control of layout.controls) {
      expect(control.left).toBeGreaterThanOrEqual(layout.left);
      expect(control.right).toBeLessThanOrEqual(layout.right);
    }
    for (let index = 0; index < layout.controls.length; index++) {
      for (const other of layout.controls.slice(index + 1)) {
        const control = layout.controls[index]!;
        const overlaps = Math.min(control.right, other.right) - Math.max(control.left, other.left) > 1 &&
          Math.min(control.bottom, other.bottom) - Math.max(control.top, other.top) > 1;
        expect(overlaps, `${id} controls overlap`).toBe(false);
      }
    }
  }
  const entryIdAction = page.getByRole("button", { name: "Pass 1 Entry ID", exact: true });
  if (coarse) {
    await entryIdAction.tap();
  } else {
    await entryIdAction.focus();
    await entryIdAction.press("Enter");
  }
  const entryIdDialog = page.getByRole("dialog", { name: "Pass 1 Entry ID", exact: true });
  const entryIdField = entryIdDialog.getByRole("textbox", { name: "Entry ID", exact: true });
  await expect(entryIdField).toHaveAttribute("readonly", "");
  await expect(entryIdField).not.toHaveValue("");
  await entryIdField.focus();
  await expect.poll(() => entryIdField.evaluate((element) => {
    const input = element as HTMLInputElement;
    return input.value.slice(input.selectionStart!, input.selectionEnd!) === input.value;
  })).toBe(true);
  if (coarse) {
    await entryIdDialog.getByRole("button", { name: "Close", exact: true }).tap();
  } else {
    await entryIdField.press("Escape");
    await expect(entryIdAction).toBeFocused();
  }
  await expect(entryIdDialog).toHaveCount(0);
  await page.getByTestId("scene-layer-0-z-order").fill("5");
  await page.getByTestId("scene-layer-0-z-order").press("Enter");
  await expect(page.getByTestId("scene-layer-0-z-order")).toHaveValue("5");
  await page.getByTestId("scene-layer-0-enabled").click();
  await expect(page.getByTestId("scene-layer-0-enabled")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("scene-post-process-0-enabled").click();
  await expect.poll(async () => viewportPostProcessPassCount(page)).toBe(0);
  await page.getByTestId("scene-post-process-0-enabled").click();
  await expect.poll(async () => viewportPostProcessPassCount(page)).toBe(1);

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-viewport").click();
  await page.getByRole("switch", { name: "Override Project Rendering", exact: true }).check();
  await expect(page.getByTestId("setting-post-processing")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByTestId("setting-post-processing").click();
  await expect(page.getByTestId("setting-post-processing")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect.poll(async () => viewportPostProcessPassCount(page)).toBe(0);

  const scale = page.getByTestId("setting-hardware-scale");
  await expect(scale).toHaveValue("1");
  await scale.click();
  await scale.fill("2");
  await expect.poll(async () => viewportHardwareScalingLevel(page)).toBe(2);
});
