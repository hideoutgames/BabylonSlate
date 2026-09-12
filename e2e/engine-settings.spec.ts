import { expect, test, type Page } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";
import { openMinimalTestProject } from "./minimal-project";

test("project settings keep descriptions below their controls and above separators", async ({ page }) => {
  await openMinimalTestProject(page);
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  for (const [category, controlId] of [
    ["general", "settings-infinite-loop-detection"],
    ["twoD", "settings-pixel-perfect"],
    ["twoD", "settings-integer-zoom"],
    ["audio", "settings-audio-occlusion"],
    ["rendering", "setting-render-custom"],
  ] as const) {
    await page.getByTestId(`settings-modal-category-${category}`).click();
    const control = page.getByTestId(controlId);
    await control.scrollIntoViewIfNeeded();
    const positions = await control.evaluate((element) => {
      const field = element.closest('[data-slot="field"]')!;
      const label = field.querySelector('[data-slot="field-label"]')!;
      const description = document.getElementById(element.getAttribute("aria-describedby")!)!;
      return {
        controlBottom: element.getBoundingClientRect().bottom,
        labelBottom: label.getBoundingClientRect().bottom,
        descriptionTop: description.getBoundingClientRect().top,
        descriptionBottom: description.getBoundingClientRect().bottom,
        fieldBottom: field.getBoundingClientRect().bottom,
        borderWidth: parseFloat(getComputedStyle(field).borderBottomWidth),
      };
    });
    expect(positions.descriptionTop, controlId).toBeGreaterThanOrEqual(positions.controlBottom);
    expect(positions.descriptionTop, controlId).toBeGreaterThanOrEqual(positions.labelBottom);
    expect(positions.descriptionBottom, controlId).toBeLessThan(positions.fieldBottom);
    expect(positions.borderWidth, controlId).toBeGreaterThan(0);
  }
  await page.getByTestId("settings-modal-category-export").click();
  for (const id of ["export-game", "export-project"]) {
    const button = page.getByTestId(id);
    await button.scrollIntoViewIfNeeded();
    const positions = await button.evaluate((element) => {
      const field = element.closest('[data-slot="field"]')!;
      const description = field.querySelector('[data-slot="field-description"]')!;
      return {
        buttonWidth: element.getBoundingClientRect().width,
        fieldWidth: field.getBoundingClientRect().width,
        buttonBottom: element.getBoundingClientRect().bottom,
        descriptionTop: description.getBoundingClientRect().top,
      };
    });
    expect(positions.buttonWidth, id).toBeLessThan(positions.fieldWidth / 2);
    expect(positions.descriptionTop, id).toBeGreaterThanOrEqual(positions.buttonBottom);
  }
});

test("settings retain visible slider tracks and full switch travel", async ({ page }) => {
  await page.goto("/?test=1");
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-assets").click();
  const toggle = page.getByTestId("setting-editor-texture-lod");
  if (await toggle.getAttribute("aria-checked") !== "true") await toggle.click();
  const control = page.getByTestId("setting-editor-texture-lod-quality");
  const track = control.locator('[data-slot="slider-track"]');
  const trackBounds = await track.boundingBox();
  expect(trackBounds?.height).toBeGreaterThan(0);
  expect(trackBounds?.width).toBeGreaterThan(100);
  const slider = control.getByRole("slider");
  await slider.focus();
  await slider.press("Home");
  await expect(slider).toHaveValue("25");
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("30");
  const thumb = toggle.locator('[data-slot="switch-thumb"]');
  const on = await thumb.boundingBox();
  await toggle.click();
  await expect(slider).toBeDisabled();
  await expect.poll(async () => (await thumb.boundingBox())?.x ?? 0).toBeLessThan(on!.x);
});

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

test("viewport frame cap can be emptied then retyped", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-viewport").click();

  const field = page.getByTestId("setting-frame-cap");
  await expect(field).toHaveValue("30");
  await field.click();
  // Select-all on activate re-selects on pointerup via rAF. Wait until "30"
  // is selected so a late reselect cannot swallow digits while retyping.
  await expect
    .poll(async () =>
      field.evaluate((el) => {
        const input = el as HTMLInputElement;
        return input.selectionEnd - input.selectionStart;
      }),
    )
    .toBe(2);
  await field.fill("");
  await expect(field).toHaveValue("");
  await field.fill("45");
  await expect(field).toHaveValue("45");
});

test("create project dialog defaults to 1920×1080 stretch", async ({
  page,
}) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project").click();
  await page.getByTestId("create-project-empty").click();
  await page.getByText("Options", { exact: true }).click();
  await expect(page.getByTestId("create-project-width")).toHaveValue("1920");
  await expect(page.getByTestId("create-project-height")).toHaveValue("1080");
  await expect(page.getByTestId("create-project-black-bars")).toBeVisible();
});

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

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-viewport").click();
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
