import { expect, test, type Page } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function viewportPostProcessPassCount(page: Page): Promise<number | null> {
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

async function viewportHardwareScalingLevel(page: Page): Promise<number | null> {
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

test("viewport post-processing defaults on", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-viewport").click();
  await expect(page.getByTestId("setting-post-processing")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

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
  await field.press("Backspace");
  await expect(field).toHaveValue("");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await field.pressSequentially("45");
  await expect(field).toHaveValue("45");
});

test("graph default zoom shows 0.5", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-graph").click();

  const field = page.getByTestId("setting-graph-default-zoom");
  await expect(field).toHaveValue("0.5");
});

test("User Interface category can add a custom designer preset", async ({
  page,
}) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-ui").click();

  await expect(page.getByTestId("ui-preset-builtin-desktop-16-9")).toBeVisible();
  await page.getByTestId("ui-preset-add").click();
  await expect(page.locator('[data-testid^="ui-preset-custom-"]')).toHaveCount(1);
});

test("Focus keep-list can add a Material tab", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-focus").click();

  await expect(page.getByTestId("focus-keep-material-material-graph")).toBeVisible();
  await page.getByTestId("focus-keep-material-add").click();
  await page.getByTestId("focus-keep-material-add-material-preview").click();
  await expect(page.getByTestId("focus-keep-material-material-preview")).toBeVisible();
});

test("Focus keep-list can add a Class tab", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-focus").click();

  await expect(page.getByTestId("focus-keep-graph-graph")).toBeVisible();
  await expect(page.getByTestId("focus-keep-scene-viewport")).toBeVisible();
  await page.getByTestId("focus-keep-graph-add").click();
  await page.getByTestId("focus-keep-graph-add-inspector").click();
  await expect(page.getByTestId("focus-keep-graph-inspector")).toBeVisible();
});

test("create project dialog defaults to 1920×1080 stretch", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project").click();
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
    .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
    .click();
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
  await page.getByTestId("content-browser-new-asset").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
  await page.getByTestId("new-asset-type-Material").click();
  await page.getByTestId("new-asset-name").fill("Bloom");
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(
    0,
  );
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
    return host.__babylonslateTest?.guidForPath("assets/Bloom.material.babasset") ?? "";
  });
  expect(bloomGuid.length).toBeGreaterThan(0);
  await page.getByTestId(`search-item-${bloomGuid}`).click();

  await expect.poll(async () => viewportPostProcessPassCount(page)).toBe(1);

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
