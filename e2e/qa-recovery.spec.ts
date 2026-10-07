import { expect, test, type Page } from "@playwright/test";
import { createContentBrowserAsset, openAssetFromBrowser, openTestProject } from "./open-test-project";
import { findOpfsProjectDirectory } from "./opfs-project";
import { saveAllIfEnabled } from "./save-all";

type TestHost = {
  __babylonslateTest: {
    nudgeActiveGraphNode: () => Promise<boolean>;
    activeGraphNodePosition: () => { x: number; y: number } | null;
    cancelDebouncedSave: () => void;
    hasRecoveryJournal: () => Promise<boolean>;
    dirtyDocuments: () => { kind: string; id: string }[];
  };
};

async function recoverAfterReload(page: Page) {
  await page.reload();
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("open-listed-project-TestProject").click();
  await expect(page.getByTestId("recovery-prompt")).toBeVisible();
  await page.getByTestId("recover-journal").click();
  await expect(page.getByTestId("recovery-prompt")).toHaveCount(0);
}

async function journalCommands(page: Page) {
  const directoryName = await findOpfsProjectDirectory(page, "opfs:__babylonslate_derived__");
  // The first poll may precede creation of the derived store.
  if (directoryName === null) return [];
  return page.evaluate(async (storageDirectory) => {
    type Command = { type: string; to?: unknown; commands?: Command[] };
    const commands: Command[] = [];
    const root = await navigator.storage.getDirectory();
    const storage = await root.getDirectoryHandle(storageDirectory);
    let derived: FileSystemDirectoryHandle;
    try {
      derived = await storage.getDirectoryHandle("derived");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      // Journal writes are batched, so the first poll can precede the first
      // flush that creates the derived-data folders.
      return commands;
    }
    const append = (command: Command) => {
      if (command.type === "edit.batch") command.commands?.forEach(append);
      else commands.push(command);
    };
    type Listable = FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemHandle>;
    };
    const readLines = async (file: FileSystemFileHandle) =>
      (await (await file.getFile()).text()).trim().split("\n").filter(Boolean)
        .forEach((line) => append(JSON.parse(line).command));
    for await (const directory of (derived as Listable).values()) {
      if (directory.kind !== "directory") continue;
      const project = directory as FileSystemDirectoryHandle;
      // An older single-file journal, then the ordered segments.
      try {
        await readLines(await project.getFileHandle("journal.jsonl"));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
      try {
        const segments = await project.getDirectoryHandle("journal");
        const files: FileSystemFileHandle[] = [];
        for await (const entry of (segments as Listable).values()) {
          if (entry.kind === "file") files.push(entry as FileSystemFileHandle);
        }
        files.sort((a, b) => a.name.localeCompare(b.name));
        for (const file of files) await readLines(file);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
    }
    return commands;
  }, directoryName);
}

test("H6/M4: recovery of an undone edit stays clean and clears its journal", async ({ page }) => {
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await expect(
    page.getByTestId("graph-panel").locator(".react-flow__node").first(),
  ).toBeVisible();
  await saveAllIfEnabled(page);
  const before = await page.evaluate(() =>
    (globalThis as unknown as TestHost).__babylonslateTest.activeGraphNodePosition());
  await page.evaluate(async () => {
    const api = (globalThis as unknown as TestHost).__babylonslateTest;
    await api.nudgeActiveGraphNode();
    api.cancelDebouncedSave();
  });
  await page.getByTestId("undo-document").click();
  await expect.poll(() => page.evaluate(() =>
    (globalThis as unknown as TestHost).__babylonslateTest.activeGraphNodePosition())).toEqual(before);
  await page.evaluate(() => (globalThis as unknown as TestHost).__babylonslateTest.cancelDebouncedSave());
  await expect.poll(async () => (await journalCommands(page))
    .filter((command) => command.type === "graph.moveNode").at(-1)?.to).toEqual(before);
  await recoverAfterReload(page);
  expect(await page.evaluate(() =>
    (globalThis as unknown as TestHost).__babylonslateTest.activeGraphNodePosition())).toEqual(before);
  expect(await page.evaluate(() =>
    (globalThis as unknown as TestHost).__babylonslateTest.dirtyDocuments())).toEqual([]);
  expect(await page.evaluate(() =>
    (globalThis as unknown as TestHost).__babylonslateTest.hasRecoveryJournal())).toBe(false);
  await page.reload();
  await page.getByTestId("open-listed-project-TestProject").click();
  await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
  await expect(page.getByTestId("recovery-prompt")).toHaveCount(0);
});

test("H6: recovery restores a journalled Enum edit", async ({ page }) => {
  await openTestProject(page);
  await createContentBrowserAsset(page, "Enum", "RecoverableEnum");
  await openAssetFromBrowser(page, "assets/RecoverableEnum.babasset");
  await saveAllIfEnabled(page);
  await page.getByTestId("enum-add-member").click();
  await expect(page.getByTestId("enum-row-1")).toBeVisible();
  await expect.poll(async () => (await journalCommands(page))
    .filter((command) => command.type === "asset.setDocument").length).toBe(1);
  await recoverAfterReload(page);
  await openAssetFromBrowser(page, "assets/RecoverableEnum.babasset");
  await expect(page.getByTestId("enum-row-1")).toBeVisible();
  expect(await page.evaluate(() => (globalThis as unknown as TestHost)
    .__babylonslateTest.dirtyDocuments().map((doc) => doc.kind))).toEqual(["enum"]);
});
