import { expect, test } from "./profile-context";
import type { Locator, Page } from "@playwright/test";

// Temporary diagnostic for the Theme Style disclosure in WebKit; not for main.
async function describe(page: Page, label: string, header: Locator) {
  await header.scrollIntoViewIfNeeded();
  const box = await header.boundingBox();
  const info = await header.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const legend = button.closest("legend")!;
    const fieldset = button.closest("fieldset")!;
    const style = (element: Element) => {
      const computed = getComputedStyle(element);
      return `${computed.display} float=${computed.float} pos=${computed.position} overflow=${computed.overflow}`;
    };
    const content = fieldset.querySelector(":scope > [data-slot=disclosure-section-content]");
    return {
      hit: hit ? `${hit.tagName} slot=${hit.getAttribute("data-slot")} text=${(hit.textContent ?? "").slice(0, 30)} isButtonOrInside=${button === hit || button.contains(hit)}` : null,
      legend: `${style(legend)} rect=${JSON.stringify(legend.getBoundingClientRect())}`,
      fieldset: `${style(fieldset)} rect=${JSON.stringify(fieldset.getBoundingClientRect())}`,
      content: content ? `hidden=${(content as HTMLElement).hidden} ${style(content)} rect=${JSON.stringify(content.getBoundingClientRect())} children=${content.childElementCount}` : "none",
      expanded: button.getAttribute("aria-expanded"),
      ua: navigator.userAgent,
    };
  });
  console.log(`[probe] ${label}`, JSON.stringify({ box, ...info }));
}

test("webkit probe: Account Style and Engine Settings disclosures @webkit-probe", async ({ page }) => {
  page.on("console", (message) => {
    if (message.type() === "error") console.log("[probe] console error", message.text().slice(0, 300));
  });
  await page.goto("/");
  await expect(page.locator(".slate-loading")).toHaveCount(0, { timeout: 60_000 });
  await page.getByTestId("homepage-account").click();
  await page.getByTestId("homepage-profile-menu").getByTestId("engine-settings").click();
  const engine = page.getByTestId("engine-settings-modal");
  await expect(engine).toBeVisible();
  const engineHeader = engine.locator("[data-slot=disclosure-section] > legend button").first();
  await describe(page, "engine before", engineHeader);
  const engineBefore = await engineHeader.getAttribute("aria-expanded");
  await engineHeader.click();
  await page.waitForTimeout(300);
  await describe(page, "engine after click", engineHeader);
  const engineAfter = await engineHeader.getAttribute("aria-expanded");
  await page.keyboard.press("Escape");
  await expect(engine).toHaveCount(0);

  await page.getByTestId("homepage-account").click();
  await page.getByTestId("homepage-account-open").click();
  const center = page.getByTestId("homepage-account-center");
  await center.getByTestId("homepage-account-center-category-application").click();
  const style = center.getByRole("button", { name: "Style", exact: true });
  await describe(page, "style before", style);
  await style.click();
  await page.waitForTimeout(300);
  await describe(page, "style after click", style);
  const afterClick = await style.getAttribute("aria-expanded");
  await style.click();
  await page.waitForTimeout(300);
  await style.tap();
  await page.waitForTimeout(300);
  await describe(page, "style after tap", style);
  const afterTap = await style.getAttribute("aria-expanded");
  await style.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const afterEnter = await style.getAttribute("aria-expanded");
  console.log("[probe] results", JSON.stringify({ engineBefore, engineAfter, afterClick, afterTap, afterEnter }));
  await page.screenshot({ path: test.info().outputPath("style.png") });
  expect({ engineChanged: engineBefore !== engineAfter, afterClick, afterTap }).toEqual({ engineChanged: true, afterClick: "true", afterTap: "true" });
});
