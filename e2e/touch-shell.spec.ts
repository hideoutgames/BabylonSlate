import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openTestProject } from "./open-test-project";

test.describe("Touch shell UX", { tag: IPAD_TEST_TAG }, () => {
  test.beforeEach(async ({ page }) => {
    await openTestProject(page);
    await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("defaults to user-select none on the shell", async ({ page }) => {
    const userSelect = await page.evaluate(() =>
      getComputedStyle(document.documentElement).userSelect,
    );
    expect(userSelect).toBe("none");
  });

  test("locks document scroll on the root shell", async ({ page }) => {
    const overflow = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).overflow,
      body: getComputedStyle(document.body).overflow,
      root: getComputedStyle(document.getElementById("root")!).overflow,
    }));
    expect(overflow.html).toBe("hidden");
    expect(overflow.body).toBe("hidden");
    expect(overflow.root).toBe("hidden");
  });

  test("chrome document tabs meet minimum touch target size", async ({ page }) => {
    const tab = page
      .locator('[data-testid="document-tab"][data-document-kind="scene"]')
      .first();
    await expect(tab).toBeVisible();
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(28);
    expect(box!.height).toBeGreaterThanOrEqual(28);
  });

  test("chrome document tab bar hides scrollbars while remaining scrollable", async ({
    page,
  }) => {
    const scroller = page.getByTestId("document-tab-scroll");
    await expect(scroller).toBeVisible();
    const styles = await scroller.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        overflowX: cs.overflowX,
        scrollbarWidth: cs.scrollbarWidth,
      };
    });
    expect(styles.overflowX).toBe("auto");
    expect(styles.scrollbarWidth).toBe("none");
  });

  test("pinned Content Browser tab stays visible when closable tabs scroll", async ({
    page,
  }) => {
    const scroller = page.getByTestId("document-tab-scroll");
    const contentBrowser = page.locator(
      '[data-testid="document-tab"][data-document-kind="content-browser"]',
    );
    await expect(scroller).toBeVisible();
    await expect(contentBrowser).toBeVisible();

    await page.locator(".chrome-tab-closable").evaluateAll((tabs) => {
      for (const tab of tabs) {
        (tab as HTMLElement).style.minWidth = "480px";
      }
    });

    const overflowed = await scroller.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1,
    );
    expect(overflowed).toBe(true);

    const before = await contentBrowser.boundingBox();
    expect(before).not.toBeNull();

    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });

    const after = await contentBrowser.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.x).toBeCloseTo(before!.x, 0);
    expect(after!.width).toBeGreaterThan(0);

    const scrollerBox = await scroller.boundingBox();
    expect(scrollerBox).not.toBeNull();
    expect(after!.x + after!.width).toBeLessThanOrEqual(scrollerBox!.x + 1);
    expect(after!.x).toBeGreaterThanOrEqual(0);
  });

  test("dockview tabs meet pointer-aware height", async ({ page }) => {
    const tab = page.locator(".dockview-theme-babylonslate .dv-tab").first();
    await expect(tab).toBeVisible();
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();
    const coarse = await page.evaluate(() =>
      window.matchMedia("(pointer: coarse)").matches,
    );
    // Fine pointers use an 18px strip; coarse uses 26px.
    expect(box!.height).toBeGreaterThanOrEqual(coarse ? 26 : 18);
  });

  test("global toolbar buttons meet minimum touch target size", async ({
    page,
  }) => {
    const button = page.getByTestId("undo-document");
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(28);
  });

  test("content browser search meets minimum touch target size", async ({
    page,
  }) => {
    await page
      .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
      .click();
    const search = page.getByTestId("content-browser-search");
    await expect(search).toBeVisible({ timeout: 10_000 });
    const box = await search.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(28);
  });

  test("defines --touch-target on the document root", async ({ page }) => {
    const touchTarget = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--touch-target")
        .trim(),
    );
    expect(touchTarget).toBe("44px");
  });

  test("opens context menu on right click in viewport panel", async ({
    page,
  }) => {
    const panel = page.getByTestId("viewport-panel");
    await panel.click({ button: "right", position: { x: 40, y: 40 } });
    await expect(page.getByTestId("context-menu-panel")).toBeVisible();
    await expect(page.getByTestId("context-menu-item-reload-scene")).toBeVisible();
  });

  test("suppresses the native context menu across the shell", async ({
    page,
  }) => {
    const suppressed = await page.evaluate(() => {
      const targets = [
        '[data-testid="editor-chrome-bar"]',
        '[data-testid="viewport-panel"]',
        ".dockview-theme-babylonslate .dv-tab",
      ];
      return targets.map((selector) => {
        const el = document.querySelector(selector);
        if (!el) return { selector, found: false, prevented: false };
        const event = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
        return { selector, found: true, prevented: event.defaultPrevented };
      });
    });

    for (const result of suppressed) {
      expect(result.found, `${result.selector} should exist`).toBe(true);
      expect(
        result.prevented,
        `native menu should be suppressed on ${result.selector}`,
      ).toBe(true);
    }
  });

  test("keeps the native menu on opted-in selectable text", async ({ page }) => {
    const prevented = await page.evaluate(() => {
      const el = document.createElement("span");
      el.className = "selectable-text";
      document.body.appendChild(el);
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      el.remove();
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });

  test("dock sash exposes a widened hit area beyond its visual width", async ({
    page,
  }) => {
    const sash = page.locator(".dockview-theme-babylonslate .dv-sash").first();
    await expect(sash).toBeAttached();

    const box = await sash.boundingBox();
    expect(box).not.toBeNull();

    // The visual sash stays thin; the hit area is widened with a pseudo-element,
    // so probe it by hit-testing either side of the centre line.
    const hits = await page.evaluate(
      ({ x, y, width, height }) => {
        const centreX = x + width / 2;
        const centreY = y + height / 2;
        const probe = (offset: number) => {
          const el = document.elementFromPoint(centreX + offset, centreY);
          return Boolean(el?.closest(".dv-sash"));
        };
        return { minus: probe(-6), plus: probe(6) };
      },
      box!,
    );

    expect(box!.width).toBeLessThan(24);
    expect(hits.minus && hits.plus).toBe(true);
  });

  test("rounds shell surfaces using the radius token scale", async ({
    page,
  }) => {
    const audit = await page.evaluate(() => {
      // Token values compute to unresolved calc() strings, so resolve each one
      // to pixels through a probe element before comparing.
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const tokens = ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"]
        .map((token) => {
          probe.style.borderRadius = `var(${token})`;
          return getComputedStyle(probe).borderTopLeftRadius.trim();
        })
        .filter((value) => value && value !== "0px");
      probe.remove();

      const surfaces = [
        ".dockview-theme-babylonslate .dv-tab",
        ".chrome-tab",
      ];

      return surfaces.map((selector) => {
        const el = document.querySelector(selector);
        const radius = el
          ? getComputedStyle(el).borderTopLeftRadius.trim()
          : "";
        return { selector, found: Boolean(el), radius, tokens };
      });
    });

    for (const surface of audit) {
      expect(surface.found, `${surface.selector} should exist`).toBe(true);
      expect(
        surface.radius,
        `${surface.selector} must not have square corners`,
      ).not.toBe("0px");
      expect(
        surface.tokens,
        `${surface.selector} radius ${surface.radius} should come from the token scale`,
      ).toContain(surface.radius);
    }
  });

  test("opens context menu after long press in viewport panel", async ({
    page,
  }) => {
    const panel = page.getByTestId("viewport-panel");
    await panel.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + 40;
      const y = rect.top + 40;
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType: "touch",
        }),
      );
    });
    await page.waitForTimeout(600);
    await expect(page.getByTestId("context-menu-panel")).toBeVisible({
      timeout: 3_000,
    });
  });

  test("project settings close meets the 44px touch target", async ({
    page,
  }) => {
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    const dialog = page.getByTestId("settings-modal");
    await expect(dialog).toBeVisible();
    const close = dialog.locator('[data-slot="dialog-close"]');
    await expect(close).toBeVisible();
    await expect
      .poll(async () =>
        dialog.evaluate((el) => {
          const transform = getComputedStyle(el).transform;
          return (
            transform === "none" ||
            transform.startsWith("matrix(1,") ||
            transform.startsWith("matrix3d(1, 0, 0, 0, 0, 1,")
          );
        }),
      )
      .toBe(true);
    const box = await close.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
