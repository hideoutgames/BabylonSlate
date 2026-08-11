import { expect, test } from "@playwright/test";

test("component gallery renders shadcn primitives in test mode", async ({
  page,
}) => {
  await page.goto("/?test=1&gallery=1");
  await expect(page.getByTestId("component-gallery")).toBeVisible();
  await expect(page.getByTestId("gallery-panel-frame")).toBeVisible();
  await expect(page.getByTestId("gallery-toolbar-strip")).toBeVisible();
  await expect(page.getByText("Primary")).toBeVisible();
});
