import { expect, test, type Page } from "@playwright/test";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";

async function addFunction(page: Page, name: string): Promise<void> {
  await page.getByTestId("class-add-functions").click();
  await page
    .getByTestId("add-function-menu")
    .getByTestId("search-item-__new__")
    .click();
  const rename = page.getByRole("textbox", { name: "Rename NewFunction" });
  await rename.fill(name);
  await rename.press("Enter");
}

function dockTab(page: Page, title: string) {
  return page.locator(".dv-tab").filter({ hasText: new RegExp(`^${title}$`) });
}

test.describe("Class function graphs", () => {
  test("open as tabs beside the Event Graph and follow pin order", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("my-class-panel")).toBeVisible({
      timeout: 15_000,
    });
    await addFunction(page, "Jump");
    await expect(dockTab(page, "Event Graph")).toHaveCount(1);
    await expect(dockTab(page, "Jump")).toHaveCount(1);

    // Event Graph stays open; selecting the function again reuses its tab.
    await dockTab(page, "Event Graph").click();
    await expect(
      page.getByTestId("graph-panel").getByText("Event Begin Play"),
    ).toBeVisible();
    await page
      .getByTestId("my-class-panel")
      .getByText("Jump", { exact: true })
      .click();
    await expect(dockTab(page, "Jump")).toHaveCount(1);
    const inputNode = page
      .getByTestId("graph-panel")
      .locator('.react-flow__node[data-id$="-input"]');
    await expect(inputNode).toBeVisible();

    await page.getByTestId("class-fn-in-add").click();
    await page
      .getByTestId("class-fn-in-add-menu")
      .getByTestId("search-item-float")
      .click();
    const handles = inputNode.locator(".react-flow__handle");
    await expect(handles).toHaveCount(2);
    await expect(handles.first()).toHaveAttribute("data-handleid", "exec");

    await page
      .locator('[data-testid^="class-fn-in-"][data-testid$="-in-0-move-down"]')
      .click();
    await expect(handles.last()).toHaveAttribute("data-handleid", "exec");

    // The exec wire leaves from the moved handle, not its old row.
    const centerY = async (handle: ReturnType<typeof handles.first>) => {
      const box = await handle.boundingBox();
      return box ? box.y + box.height / 2 : Number.NaN;
    };
    const wire = page
      .getByTestId("graph-panel")
      .locator(".react-flow__edge-path")
      .first();
    await expect
      .poll(async () => {
        const sourceY = await wire.evaluate((path) => {
          const match = /M\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(
            path.getAttribute("d") ?? "",
          );
          const ctm = (path as SVGGraphicsElement).getScreenCTM();
          if (!match || !ctm) return Number.NaN;
          const point = new DOMPoint(Number(match[1]), Number(match[2]));
          return point.matrixTransform(ctm).y;
        });
        const execY = await centerY(handles.last());
        const oldRowY = await centerY(handles.first());
        return Math.abs(sourceY - execY) < Math.abs(sourceY - oldRowY) / 2;
      })
      .toBe(true);
  });
});
