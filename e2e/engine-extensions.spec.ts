import { expect, test } from "@playwright/test";
import { openListedTestProject, openTestProject } from "./open-test-project";
import { closeProjectViaSettings } from "./close-project";
import { saveAllIfEnabled } from "./save-all";

test("authored TypeScript extensions persist code and enablement across a project reload", async ({ page }) => {
  test.setTimeout(90_000);
  await openTestProject(page);
  const openExtensions = async () => {
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-extensions").click();
  };
  await openExtensions();
  const settings = page.getByTestId("settings-modal");
  await settings.getByRole("button", { name: "New Extension", exact: true }).click();
  const create = page.getByRole("alertdialog", { name: "New Extension", exact: true });
  await create.getByRole("textbox", { name: "Display Name", exact: true }).fill("Code Tools");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit Extension", exact: true });
  await expect(editor.getByText(/index\.ts/)).toBeVisible();
  await editor.getByRole("textbox", { name: "Extension Source", exact: true }).fill(`
    export function activate(api) {
      const path: string = "code/extension-example.ts";
      const source: string = "export const value: number = 42;";
      api.registerCommand({ id: "write", title: "Write Project Code", async execute() {
        await api.code.write(path, source);
      } });
      api.registerCommand({ id: "check", title: "Check Project Code", async execute() {
        const persisted: string = await api.code.read(path);
        if (persisted !== source) throw new Error("Project code was not preserved.");
      } });
    }
  `);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const toggle = settings.getByRole("switch", { name: "Enable Code Tools", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await page.getByRole("alertdialog", { name: "Enable Extension", exact: true })
    .getByRole("button", { name: "Enable", exact: true }).click();
  await settings.getByRole("button", { name: "Write Project Code", exact: true }).click();
  const write = page.getByRole("dialog", { name: "Write Project Code", exact: true });
  await write.getByRole("button", { name: "Run", exact: true }).click();
  await expect(write.getByText("Command Completed", { exact: true })).toBeVisible();
  await write.locator('[data-slot="dialog-close"]').click();
  await expect(write).toHaveCount(0);
  await settings.locator('[data-slot="dialog-close"]').click();
  await saveAllIfEnabled(page);
  await closeProjectViaSettings(page);
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("homepage")).toBeVisible();
  await openListedTestProject(page);
  await openExtensions();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await settings.getByRole("button", { name: "Check Project Code", exact: true }).click();
  const check = page.getByRole("dialog", { name: "Check Project Code", exact: true });
  await check.getByRole("button", { name: "Run", exact: true }).click();
  await expect(check.getByText("Command Completed", { exact: true })).toBeVisible();
  await check.locator('[data-slot="dialog-close"]').click();
  await expect(check).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(settings.getByRole("button", { name: "Check Project Code", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Delete Code Tools", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete Extension", exact: true })
    .getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toggle).toHaveCount(0);
});
