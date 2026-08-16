import { expect, type Page } from "@playwright/test";

type SaveAllDiagnostics = {
  dirty: { kind: string; id: string }[];
  trace: { kind: string; id: string; via?: string }[];
  save: {
    ok: boolean;
    reason: string;
    dirtyBefore: number;
    dirtyAfter: number;
    error?: string;
  } | null;
};

async function readSaveAllDiagnostics(page: Page): Promise<SaveAllDiagnostics> {
  return page.evaluate(() => {
    const host = globalThis as {
      __babylonslateTest?: {
        documentDirtyTrace?: () => { kind: string; id: string; via?: string }[];
        saveAllTrace?: () => SaveAllDiagnostics["save"];
        dirtyDocuments?: () => { kind: string; id: string }[];
      };
    };
    const test = host.__babylonslateTest;
    return {
      dirty: test?.dirtyDocuments?.() ?? [],
      trace: test?.documentDirtyTrace?.() ?? [],
      save: test?.saveAllTrace?.() ?? null,
    };
  });
}

/**
 * Click Save All when the project has unsaved documents; no-op when clean.
 * One click, then a short window that must stay clean so a post-save mutation
 * cannot hide behind retries.
 */
export async function saveAllIfEnabled(page: Page): Promise<void> {
  const button = page.getByTestId("save-all-project");
  await expect(button).toBeVisible();
  if (!(await button.isEnabled())) {
    return;
  }
  await page.evaluate(() => {
    (
      globalThis as {
        __babylonslateTest?: { clearDocumentDirtyTrace?: () => void };
      }
    ).__babylonslateTest?.clearDocumentDirtyTrace?.();
  });
  await button.click({ force: true });
  try {
    await expect(button).toBeDisabled({ timeout: 8_000 });
  } catch (error) {
    const diagnostics = await readSaveAllDiagnostics(page);
    throw new Error(
      `Save All stayed dirty: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
  try {
    await expect
      .poll(async () => button.isEnabled(), { timeout: 1_500 })
      .toBe(false);
  } catch (error) {
    const diagnostics = await readSaveAllDiagnostics(page);
    throw new Error(
      `Save All re-dirtied after markAllClean: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
}
