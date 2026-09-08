import { expect, test, type Page } from "@playwright/test";
import { createContentBrowserAsset, openAssetFromBrowser, openTestProject } from "./open-test-project";
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
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const storage = await root.getDirectoryHandle("opfs:__babylonslate_derived__");
    const derived = await storage.getDirectoryHandle("derived");
    type Command = { type: string; to?: unknown; commands?: Command[] };
    const commands: Command[] = [];
    const append = (command: Command) => {
      if (command.type === "edit.batch") command.commands?.forEach(append);
      else commands.push(command);
    };
    const directories = derived as FileSystemDirectoryHandle & {
      values(): AsyncIterableIterator<FileSystemDirectoryHandle>;
    };
    for await (const directory of directories.values()) {
      if (directory.kind !== "directory") continue;
      try {
        const file = await (await directory.getFileHandle("journal.jsonl")).getFile();
        (await file.text()).trim().split("\n").filter(Boolean)
          .forEach((line) => append(JSON.parse(line).command));
      } catch { /* A project without unsaved edits has no journal. */ }
    }
    return commands;
  });
}

test("H6/M4: recovery retains Undo and survives a second reload before Save", async ({ page }) => {
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await saveAllIfEnabled(page);
  await expect.poll(() => page.evaluate(() =>
    (globalThis as unknown as TestHost).__babylonslateTest.activeGraphNodePosition())).not.toBeNull();
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
  await recoverAfterReload(page);
  expect(await page.evaluate(() =>
    (globalThis as unknown as TestHost).__babylonslateTest.activeGraphNodePosition())).toEqual(before);
  await saveAllIfEnabled(page);
  expect(await page.evaluate(() =>
    (globalThis as unknown as TestHost).__babylonslateTest.hasRecoveryJournal())).toBe(false);
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
