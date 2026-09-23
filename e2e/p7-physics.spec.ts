import { expect, test } from "@playwright/test";
import { openMainScene } from "./open-test-project";
import { openMinimalTestProject } from "./minimal-project";
import { clickPlayAndWaitForOverlay } from "./play";

test.describe("P7 Play physics timings", () => {
  test("2D rigid body Play reports non-zero physics ms on the worker HUD", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // This test authors a 2D body. The full 3D scaffold includes a Mannequin
    // capsule, which is intentionally rejected by the 2D native shape contract.
    await openMinimalTestProject(page);
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

    await clickPlayAndWaitForOverlay(page);
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
