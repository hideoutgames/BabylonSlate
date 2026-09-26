import { expect, test } from "@playwright/test";
import { openAssetFromBrowser, openListedTestProject, openTestProject } from "./open-test-project";
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
  await write.getByRole("button", { name: "Close", exact: true }).click();
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
  await check.getByRole("button", { name: "Close", exact: true }).click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(settings.getByRole("button", { name: "Check Project Code", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Delete Code Tools", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete Extension", exact: true })
    .getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toggle).toHaveCount(0);
});

test("GLSL Engine Extension creates a Material with editable native nodes", async ({ page }) => {
  test.setTimeout(90_000);
  await openTestProject(page);
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  const settings = page.getByTestId("settings-modal");
  await expect(settings).toBeVisible();
  await page.getByTestId("settings-modal-category-extensions").click();
  await page.getByRole("switch", { name: "Enable GLSL to Material", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Enable Experimental Extension" })
    .getByRole("button", { name: "Enable", exact: true }).click();
  // Activation loads and runs the real browser TypeScript compiler chunk.
  await settings.getByRole("button", { name: "GLSL to Material", exact: true }).click();
  const command = page.getByRole("dialog", { name: "GLSL to Material", exact: true });
  await command.getByRole("textbox", { name: "Material Name" }).fill("Extension Material");
  await command.getByRole("textbox", { name: "GLSL Source", exact: true }).fill(
    "void main() { float level = 0.25; gl_FragColor = vec4(level); }",
  );
  await command.getByRole("button", { name: "Run", exact: true }).click();
  await expect(command.getByText("Material Created", { exact: true })).toBeVisible();
  await command.locator('[data-slot="dialog-close"]').click();
  await expect(command).toHaveCount(0);
  await settings.locator('[data-slot="dialog-close"]').click();
  await expect(settings).toHaveCount(0);

  const assetPath = "assets/Extension Material.material.babasset";
  await openAssetFromBrowser(page, assetPath);
  const graph = page.getByTestId("material-graph-editor");
  await expect(graph).toBeVisible();
  const document = await page.evaluate(async (path) => {
    const host = globalThis as unknown as {
      __babylonslateTest: { readAssetChunk(path: string, chunk: string): Promise<Uint8Array | null> };
    };
    const bytes = await host.__babylonslateTest.readAssetChunk(path, "document");
    if (!bytes) throw new Error("Converted Material has no document payload");
    return JSON.parse(new TextDecoder().decode(bytes)) as {
      nodes: { id: string; type: string }[];
    };
  }, assetPath);
  expect(document.nodes.map((node) => node.type)).toEqual(expect.arrayContaining([
    "const.float", "vector.combine", "output.surface",
  ]));
  expect(document.nodes.some((node) => node.type === "custom.glsl")).toBe(false);

  await graph.getByRole("button", { name: "Size Graph To Fit" }).click();
  const scalar = document.nodes.find((node) => node.type === "const.float")!;
  await graph.locator(`.react-flow__node[data-id="${scalar.id}"]`).click();
  const value = page.getByTestId("material-node-details").getByTestId("property-value");
  await expect(value).toBeEditable();
  await expect(value).toHaveValue("0.25");
  await value.fill("0.75");
  await value.press("Tab");
  await expect(value).toHaveValue("0.75");
});
