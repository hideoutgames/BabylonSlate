import { expect, test } from "@playwright/test";

test.describe("Touch shell UX", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?test=1");
    await page.getByTestId("create-project-empty").click();
    await page.locator('[data-asset-path="assets/main.scene.babasset"]').click();
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
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("dockview tabs meet minimum touch height", async ({ page }) => {
    const tab = page.locator(".dockview-theme-babylonslate .dv-tab").first();
    await expect(tab).toBeVisible();
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
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
});
