import { expect, test } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";

test("independent contexts isolate OPFS projects and settings on the same owned server", async ({
  browser,
  baseURL,
}) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  try {
    const firstPage = await first.newPage();
    await openMinimalTestProject(firstPage);
    const secondPage = await second.newPage();
    await secondPage.goto("/?test=1");
    await expect(secondPage.getByTestId("homepage")).toBeVisible();
    const other = await secondPage.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      let projectExists = true;
      try {
        await root.getDirectoryHandle("opfs:TestProject");
      } catch (error) {
        if ((error as DOMException).name !== "NotFoundError") throw error;
        projectExists = false;
      }
      return {
        projectExists,
        settings: localStorage.getItem("babylonslate:engine-settings"),
        projects: localStorage.getItem("babylonslate:opfs-meta"),
      };
    });
    expect(other.projectExists).toBe(false);
    expect(other.projects).toBeNull();
    // App initialization may persist defaults; the first context's recent project must not leak.
    expect(JSON.parse(other.settings ?? "{}").recents ?? []).toEqual([]);
    await expect(firstPage.getByTestId("project-name")).toContainText(
      "TestProject",
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
