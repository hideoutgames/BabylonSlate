import { defaultEngineSettings } from "../packages/vfs/src/app-settings";
import { expect, type Page } from "@playwright/test";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { clickListedTestProject, waitForEditorInteractive } from "./open-test-project";

/** Fresh per-test OPFS fixture for generic chrome, history, and graph tests. */
export async function openMinimalTestProject(
  page: Page,
  projectFiles?: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const files = [...(projectFiles ?? (await minimalProjectFiles()))].map(
    ([path, bytes]) => [path, [...bytes]] as const,
  );
  // Seed the owned origin without booting the editor twice.
  const response = await page.goto("/__test_identity");
  expect(response?.ok()).toBe(true);
  const settings = defaultEngineSettings();
  settings.recents = [
    {
      id: "opfs:TestProject",
      name: "TestProject",
      tier: "opfs",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  await page.evaluate(
    async ({ entries, settings }) => {
      const root = await navigator.storage.getDirectory();
      const project = await root.getDirectoryHandle("opfs:TestProject", {
        create: true,
      });
      for (const [path, bytes] of entries) {
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
        await writer.write(new Uint8Array(bytes));
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
          projects: [{ id: "opfs:TestProject", name: "TestProject" }],
        }),
      );
    },
    { entries: files, settings },
  );
  await page.goto("/?test=1");
  await page.waitForFunction(() => window.crossOriginIsolated, undefined, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("homepage")).toBeVisible();
  await expect(
    page.getByTestId("open-listed-project-TestProject"),
  ).toBeVisible();
  await clickListedTestProject(page);
  await waitForEditorInteractive(page);
}
