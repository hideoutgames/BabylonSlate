import { expect, type Page } from "@playwright/test";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { clickListedTestProject } from "./open-test-project";

/** Fresh per-test OPFS fixture for generic chrome, history, and graph tests. */
export async function openMinimalTestProject(page: Page): Promise<void> {
  const files = [...(await minimalProjectFiles())].map(
    ([path, bytes]) => [path, [...bytes]] as const,
  );
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.evaluate(async (entries) => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("opfs:TestProject", {
      create: true,
    });
    for (const [path, bytes] of entries) {
      const parts = path.split("/");
      let directory = project;
      for (const part of parts.slice(0, -1))
        directory = await directory.getDirectoryHandle(part, { create: true });
      const file = await directory.getFileHandle(parts.at(-1)!, {
        create: true,
      });
      const writer = await file.createWritable();
      await writer.write(new Uint8Array(bytes));
      await writer.close();
    }
    localStorage.setItem(
      "babylonslate:opfs-meta",
      JSON.stringify({
        currentId: null,
        projects: [{ id: "opfs:TestProject", name: "TestProject" }],
      }),
    );
  }, files);
  await page.reload();
  await expect(page.getByTestId("homepage")).toBeVisible();
  await clickListedTestProject(page);
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}
