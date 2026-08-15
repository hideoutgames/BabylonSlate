import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";

test.describe("P7 Play physics timings", () => {
  test("2D rigid body Play reports non-zero physics ms on the worker HUD", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);

    await expect(page.getByTestId("scene-settings-grid")).toBeVisible();
    await page.getByTestId("property-scene-physics-world").click();
    await page.getByRole("option", { name: "2D (Rapier)" }).click();

    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-shape-box").click();

    await page.getByTestId("details-add-component").click();
    await page.getByTestId("add-component-catalog-item-RigidBodyComponent").click();
    await page.getByTestId("details-add-component").click();
    await page.getByTestId("add-component-catalog-item-ColliderComponent").click();

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await page.getByTestId("play-stats-toggle").click();
    await expect(page.getByTestId("stats-hud")).toBeVisible();
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("play-physics-ms")
          .getAttribute("data-ms");
        return Number(attr ?? "0");
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);

    await page.getByTestId("play-overlay-close").click();
  });
});
