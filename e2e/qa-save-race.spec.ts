import { expect, test } from "@playwright/test";
import { openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

type TestHost = {
  __babylonslateTest: {
    ensureMainGraphOpen: () => Promise<boolean>;
    nudgeActiveGraphNode: () => Promise<boolean>;
    activeGraphNodePosition: () => { x: number; y: number };
    hasRecoveryJournal: () => Promise<boolean>;
    clearDocumentDirtyTrace: () => void;
    saveAllTrace: () => { ok: boolean; dirtyAfter: number } | null;
    readAssetChunk: (path: string, chunk: string) => Promise<Uint8Array | null>;
  };
  __qaSaveGate: { entered: boolean; release: () => void };
};

test("H6: Save All preserves an edit and recovery journal created while its file write is pending", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  await page.evaluate(async () => {
    await (
      globalThis as unknown as TestHost
    ).__babylonslateTest.ensureMainGraphOpen();
  });
  await saveAllIfEnabled(page);
  const original = await page.evaluate(() =>
    (
      globalThis as unknown as TestHost
    ).__babylonslateTest.activeGraphNodePosition(),
  );
  await page.evaluate(async () => {
    const host = globalThis as unknown as TestHost;
    await host.__babylonslateTest.nudgeActiveGraphNode();
    host.__babylonslateTest.clearDocumentDirtyTrace();
    const originalCreate = FileSystemFileHandle.prototype.createWritable;
    let armed = true;
    host.__qaSaveGate = { entered: false, release: () => {} };
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (armed && this.name === "Mannequin.class.babasset") {
        armed = false;
        host.__qaSaveGate.entered = true;
        await new Promise<void>((resolve) => {
          host.__qaSaveGate.release = resolve;
        });
        FileSystemFileHandle.prototype.createWritable = originalCreate;
      }
      return originalCreate.call(this, options);
    };
  });
  await page.getByTestId("save-all-project").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as unknown as TestHost).__qaSaveGate.entered,
      ),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const host = globalThis as unknown as TestHost;
    await host.__babylonslateTest.nudgeActiveGraphNode();
    host.__qaSaveGate.release();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as TestHost).__babylonslateTest.saveAllTrace(),
      ),
    )
    .toMatchObject({ ok: true, dirtyAfter: 1 });
  await expect(page.getByTestId("save-all-project")).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (
        globalThis as unknown as TestHost
      ).__babylonslateTest.hasRecoveryJournal(),
    ),
  ).toBe(true);
  const saved = await page.evaluate(async () => {
    const bytes = await (
      globalThis as unknown as TestHost
    ).__babylonslateTest.readAssetChunk(
      "assets/Mannequin.class.babasset",
      "document",
    );
    return JSON.parse(new TextDecoder().decode(bytes!)).nodes[0].position;
  });
  expect(saved).toEqual({ x: original.x + 42, y: original.y + 17 });
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await page.evaluate(async () => {
    await (
      globalThis as unknown as TestHost
    ).__babylonslateTest.ensureMainGraphOpen();
  });
  expect(
    await page.evaluate(() =>
      (
        globalThis as unknown as TestHost
      ).__babylonslateTest.activeGraphNodePosition(),
    ),
  ).toEqual({ x: original.x + 84, y: original.y + 34 });
});
