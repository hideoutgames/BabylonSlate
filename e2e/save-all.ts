import { expect, type Page } from "@playwright/test";
import type { SaveAllProgress } from "../apps/editor/src/lib/dirty-trace";

type SaveAllDiagnostics = {
  dirty: { kind: string; id: string }[];
  trace: { kind: string; id: string; via?: string }[];
  progress: SaveAllProgress | null;
  save: {
    ok: boolean;
    reason: string;
    dirtyBefore: number;
    dirtyAfter: number;
    error?: string;
  } | null;
};

export async function readSaveAllDiagnostics(page: Page): Promise<SaveAllDiagnostics> {
  return page.evaluate(() => {
    const host = globalThis as {
      __babylonslateTest?: {
        documentDirtyTrace?: () => { kind: string; id: string; via?: string }[];
        saveAllTrace?: () => SaveAllDiagnostics["save"];
        saveAllProgress?: () => SaveAllProgress | null;
        dirtyDocuments?: () => { kind: string; id: string }[];
      };
    };
    const test = host.__babylonslateTest;
    return {
      dirty: test?.dirtyDocuments?.() ?? [],
      trace: test?.documentDirtyTrace?.() ?? [],
      save: test?.saveAllTrace?.() ?? null,
      progress: test?.saveAllProgress?.() ?? null,
    };
  });
}

/**
 * Click Save All when the project has unsaved documents; no-op when clean.
 * One click, then require clean document state and recheck the settled control.
 */
export async function saveAllIfEnabled(page: Page, timeout = 15_000): Promise<void> {
  const button = page.getByTestId("save-all-project");
  await expect(button).toBeVisible();
  // Save All is also disabled while writing; wait for that invocation to settle.
  await expect(button).toHaveAttribute("aria-busy", "false", { timeout });
  if (!(await button.isEnabled())) {
    return;
  }
  const invocationBeforeClick = await page.evaluate(() => {
    const test = (
      globalThis as {
        __babylonslateTest?: {
          clearDocumentDirtyTrace?: () => void;
          saveAllProgress?: () => SaveAllProgress | null;
        };
      }
    ).__babylonslateTest;
    test?.clearDocumentDirtyTrace?.();
    return test?.saveAllProgress?.()?.invocation ?? 0;
  });
  // Rendering changes can rebuild the viewport behind a blocking load dialog.
  // A forced click hits that backdrop instead of invoking Save All.
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 30_000 });
  await button.click();
  try {
    await expect
      .poll(
        async () => {
          const diagnostics = await readSaveAllDiagnostics(page);
          return {
            dirty: diagnostics.dirty.length,
            disabled: await button.isDisabled(),
            busy: await button.getAttribute("aria-busy"),
          };
        },
        { timeout },
      )
      .toEqual({ dirty: 0, disabled: true, busy: "false" });
  } catch (error) {
    const diagnostics = await readSaveAllDiagnostics(page);
    throw new Error(
      `Save All stayed dirty: ${JSON.stringify({
        ...diagnostics,
        invocationBeforeClick,
        buttonDisabled: await button.isDisabled(),
      })}`,
      { cause: error },
    );
  }
  try {
    await expect
      .poll(async () => button.isEnabled(), { timeout })
      .toBe(false);
  } catch (error) {
    const diagnostics = await readSaveAllDiagnostics(page);
    throw new Error(
      `Save All re-dirtied after markAllClean: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
}
