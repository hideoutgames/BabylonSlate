import { expect, test, type Locator, type Page } from "@playwright/test";
import { createEmptyProjectFiles } from "../packages/assets/src/babproject";
import { defaultEngineSettings } from "../packages/vfs/src/app-settings";
import { IPAD_TEST_TAG } from "./ipad-tag";

async function openTemplateLibrary(page: Page) {
  const response = await page.goto("/__test_identity");
  expect(response?.ok()).toBe(true);
  const settings = defaultEngineSettings();
  settings.recents = [
    {
      id: "opfs:TemplateLayout",
      name: "TemplateLayout",
      tier: "opfs",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const files = createEmptyProjectFiles({
    guid: "template-layout",
    name: "TemplateLayout",
  }).map(({ path, data }) => ({ path, data: [...data] }));
  await page.evaluate(
    async ({ files, settings }) => {
      const root = await navigator.storage.getDirectory();
      const project = await root.getDirectoryHandle("opfs:TemplateLayout", {
        create: true,
      });
      for (const { path, data } of files) {
        const parts = path.split("/");
        let directory = project;
        for (const part of parts.slice(0, -1))
          directory = await directory.getDirectoryHandle(part, {
            create: true,
          });
        const file = await directory.getFileHandle(parts.at(-1)!, {
          create: true,
        });
        const writer = await file.createWritable();
        await writer.write(new Uint8Array(data));
        await writer.close();
      }
      localStorage.setItem(
        "babylonslate:engine-settings",
        JSON.stringify(settings),
      );
      localStorage.setItem(
        "babylonslate:opfs-meta",
        JSON.stringify({
          currentId: null,
          projects: [{ id: "opfs:TemplateLayout", name: "TemplateLayout" }],
        }),
      );
    },
    { files, settings },
  );
  await page.goto("/?test=1");
  await expect(page.locator(".slate-loading")).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(page.getByTestId("homepage-start-blank")).toBeVisible();
}

async function expectContainedCards(browser: Locator) {
  await expect
    .poll(async () =>
      browser.evaluate((element) => {
        const bounds = (selector: string) =>
          element.querySelector(selector)!.getBoundingClientRect();
        const toolbar = bounds(".homepage-template-toolbar");
        const pages = bounds(".homepage-pages");
        const pagination = bounds(".homepage-pagination");
        const cards = [
          ...element.querySelectorAll(
            ".homepage-gallery-page:not([inert]) .homepage-template-card",
          ),
        ];
        return (
          cards.length > 0 &&
          pages.height > 0 &&
          pages.top >= toolbar.bottom - 1 &&
          pagination.top >= pages.bottom - 1 &&
          cards.every((card) => {
            const rect = card.getBoundingClientRect();
            const caption = card
              .querySelector('[data-slot="card-header"]')!
              .getBoundingClientRect();
            return (
              rect.top >= pages.top - 1 &&
              rect.bottom <= pages.bottom + 1 &&
              rect.left >= pages.left - 1 &&
              rect.right <= pages.right + 1 &&
              caption.top >= rect.top &&
              caption.bottom <= rect.bottom + 1 &&
              rect.height > caption.height
            );
          })
        );
      }),
    )
    .toBe(true);
}

test(`template cards stay inside their gallery through resize and import ${IPAD_TEST_TAG}`, async ({
  page,
}) => {
  await openTemplateLibrary(page);
  const browser = page.locator(
    ".homepage-library-view:not([hidden]) .homepage-template-browser",
  );
  await expectContainedCards(browser);
  for (const viewport of [
    { width: 1024, height: 600 },
    { width: 844, height: 390 },
    { width: 700, height: 500 },
  ]) {
    await page.setViewportSize(viewport);
    await expectContainedCards(browser);
  }
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Template" }).click();
  const chooser = await chooserPromise;
  await expect(
    page.getByRole("button", { name: "Add Template" }),
  ).toBeDisabled();
  await expect(page.getByText(/Importing Template/i)).toHaveCount(0);
  await expectContainedCards(browser);
  await chooser.setFiles([]);
  await expect(
    page.getByRole("button", { name: "Add Template" }),
  ).toBeEnabled();
});
