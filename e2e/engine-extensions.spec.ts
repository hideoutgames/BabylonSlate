import { expect, test } from "@playwright/test";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";

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
