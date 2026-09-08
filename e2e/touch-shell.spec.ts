import { expect, test, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { waitForSceneViewportReady } from "./open-test-project";
import { closeProjectViaSettings } from "./close-project";

async function openClassAndOverflowClosableTabs(page: Page) {
  await page
    .locator(
      '[data-testid="document-tab"][data-document-kind="content-browser"]',
    )
    .getByTestId("document-tab-select")
    .click();
  await page
    .locator('[data-asset-path="assets/main.class.babasset"]')
    .dblclick();
  const graphTab = page.locator(
    '[data-testid="document-tab"][data-document-kind="graph"]',
  );
  await expect(graphTab).toBeVisible();

  const scroller = page.getByTestId("document-tab-scroll");
  await expect(scroller).toBeVisible();
  await scroller.evaluate((el) => {
    const extra = el.clientWidth + 80;
    for (const tab of el.querySelectorAll(".chrome-tab-closable")) {
      (tab as HTMLElement).style.minWidth = `${extra}px`;
    }
  });
  const overflowed = await scroller.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
  expect(overflowed).toBe(true);
  return scroller;
}

import { openMinimalTestProject } from "./minimal-project";

test.describe("Touch shell UX", { tag: IPAD_TEST_TAG }, () => {
  test("project long-press stays open after release and can edit", async ({
    page,
  }) => {
    await openMinimalTestProject(page);
    await closeProjectViaSettings(page);
    const project = page.getByTestId("open-listed-project-TestProject");
    await project.click({ trial: true });
    const well = await project.locator(".homepage-project-well").boundingBox();
    expect(well).not.toBeNull();
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: well!.x + well!.width / 2, y: well!.y + well!.height / 2 },
      ],
    });
    await expect(page.getByTestId("homepage-project-menu")).toBeVisible();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.getByTestId("homepage-project-menu")).toBeVisible();
    await page.getByTestId("homepage-project-rename").click();
    await expect(page.getByTestId("homepage-rename-dialog")).toBeVisible();
    await page.getByTestId("homepage-rename-input").fill("Touch Project");
    await page.getByTestId("homepage-rename-confirm").click();
    await expect(project).toContainText("Touch Project");
  });

  test("shell styles and targets", async ({ page }) => {
    await openMinimalTestProject(page);
    await test.step("defaults to user-select none on the shell", async () => {
      const userSelect = await page.evaluate(
        () => getComputedStyle(document.documentElement).userSelect,
      );
      expect(userSelect).toBe("none");
    });
    await test.step("restores user-select on input and textarea", async () => {
      const styles = await page.evaluate(() => {
        const input = document.createElement("input");
        const textarea = document.createElement("textarea");
        document.body.append(input, textarea);
        const result = {
          input: getComputedStyle(input).userSelect,
          textarea: getComputedStyle(textarea).userSelect,
        };
        input.remove();
        textarea.remove();
        return result;
      });
      expect(styles.input).toBe("text");
      expect(styles.textarea).toBe("text");
    });
    await test.step("locks document scroll on the root shell", async () => {
      const offsets = await page.evaluate(() => {
        const root = document.getElementById("root")!;
        const excessContent = document.createElement("div");
        excessContent.style.height = "400px";
        root.append(excessContent);
        try {
          root.scrollTop = 200;
          document.body.scrollTop = 200;
          window.scrollTo(0, 200);
          return [window.scrollY, document.body.scrollTop, root.scrollTop];
        } finally {
          excessContent.remove();
        }
      });
      expect(offsets).toEqual([0, 0, 0]);
    });
    await test.step("global toolbar buttons meet minimum touch target size", async () => {
      const button = page.getByTestId("undo-document");
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(28);
    });
    await test.step("content browser search meets minimum touch target size", async () => {
      await page
        .locator(
          '[data-testid="document-tab"][data-document-kind="content-browser"]',
        )
        .click();
      const search = page.getByTestId("content-browser-search");
      await expect(search).toBeVisible({ timeout: 10_000 });
      const box = await search.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(28);
    });
    await test.step("defines --touch-target on the document root", async () => {
      const touchTarget = await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--touch-target")
          .trim(),
      );
      expect(touchTarget).toBe("44px");
    });
    await test.step("project settings close meets the 44px touch target", async () => {
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
  test("dock and viewport geometry", async ({ page }) => {
    await openMinimalTestProject(page);

    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });
    await waitForSceneViewportReady(page);
    await test.step("chrome document tabs meet minimum touch target size", async () => {
      const tab = page
        .locator('[data-testid="document-tab"][data-document-kind="scene"]')
        .first();
      await expect(tab).toBeVisible();
      const box = await tab.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(28);
      expect(box!.height).toBeGreaterThanOrEqual(28);
    });
    await test.step("dockview tabs meet pointer-aware height", async () => {
      const tab = page.locator(".dockview-theme-babylonslate .dv-tab").first();
      await expect(tab).toBeVisible();
      const box = await tab.boundingBox();
      expect(box).not.toBeNull();
      const coarse = await page.evaluate(
        () => window.matchMedia("(pointer: coarse)").matches,
      );
      // Fine pointers use an 18px strip; coarse uses 26px.
      expect(box!.height).toBeGreaterThanOrEqual(coarse ? 26 : 18);
    });
    await test.step("dock sash exposes a widened hit area beyond its visual width", async () => {
      const sash = page
        .locator(".dockview-theme-babylonslate .dv-sash")
        .first();
      await expect(sash).toBeAttached();

      const box = await sash.boundingBox();
      expect(box).not.toBeNull();

      // The visual sash stays thin; the hit area is widened with a pseudo-element,
      // so probe it by hit-testing either side of the centre line.
      const hits = await page.evaluate(({ x, y, width, height }) => {
        const centreX = x + width / 2;
        const centreY = y + height / 2;
        const probe = (offset: number) => {
          const el = document.elementFromPoint(centreX + offset, centreY);
          return Boolean(el?.closest(".dv-sash"));
        };
        return { minus: probe(-6), plus: probe(6) };
      }, box!);

      expect(box!.width).toBeLessThan(24);
      expect(hits.minus && hits.plus).toBe(true);
    });
    await test.step("rounds shell surfaces using the radius token scale", async () => {
      const audit = await page.evaluate(() => {
        // Token values compute to unresolved calc() strings, so resolve each one
        // to pixels through a probe element before comparing.
        const probe = document.createElement("div");
        document.body.appendChild(probe);
        const tokens = [
          "--radius-sm",
          "--radius-md",
          "--radius-lg",
          "--radius-xl",
        ]
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
  });
  test("tab overflow", async ({ page }) => {
    await openMinimalTestProject(page);

    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });
    await waitForSceneViewportReady(page);
    await test.step("chrome document tab bar hides scrollbars while remaining scrollable", async () => {
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
    await test.step("pinned Content Browser and Scene tabs stay visible when closable tabs scroll", async () => {
      const scroller = await openClassAndOverflowClosableTabs(page);
      const pinned = page.getByTestId("document-tab-pinned");
      const contentBrowser = pinned.locator(
        '[data-testid="document-tab"][data-document-kind="content-browser"]',
      );
      const scene = pinned.locator(
        '[data-testid="document-tab"][data-document-kind="scene"]',
      );
      await expect(contentBrowser).toBeVisible();
      await expect(scene).toBeVisible();
      await expect(scene).toHaveAttribute("data-pinned", "true");
      await expect(scene.getByTestId("document-tab-close")).toBeVisible();
      await expect(
        scroller.locator(
          '[data-testid="document-tab"][data-document-kind="scene"]',
        ),
      ).toHaveCount(0);

      const cbBefore = await contentBrowser.boundingBox();
      const sceneBefore = await scene.boundingBox();
      expect(cbBefore).not.toBeNull();
      expect(sceneBefore).not.toBeNull();
      expect(sceneBefore!.x).toBeGreaterThan(cbBefore!.x);

      await scroller.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });

      const cbAfter = await contentBrowser.boundingBox();
      const sceneAfter = await scene.boundingBox();
      expect(cbAfter).not.toBeNull();
      expect(sceneAfter).not.toBeNull();
      expect(cbAfter!.x).toBeCloseTo(cbBefore!.x, 0);
      expect(sceneAfter!.x).toBeCloseTo(sceneBefore!.x, 0);
      expect(cbAfter!.width).toBeGreaterThan(0);
      expect(sceneAfter!.width).toBeGreaterThan(0);

      const scrollerBox = await scroller.boundingBox();
      expect(scrollerBox).not.toBeNull();
      expect(cbAfter!.x).toBeGreaterThanOrEqual(0);
      expect(cbAfter!.x + cbAfter!.width).toBeLessThanOrEqual(
        sceneAfter!.x + 1,
      );
      expect(sceneAfter!.x + sceneAfter!.width).toBeLessThanOrEqual(
        scrollerBox!.x + 1,
      );
    });
  });
  test("pointer context menus", async ({ page }) => {
    await openMinimalTestProject(page);
    const closeContextMenu = async () => {
      await page
        .getByTestId("context-menu-backdrop")
        .click({ position: { x: 1, y: 1 } });
      await expect(page.getByTestId("context-menu-backdrop")).toHaveCount(0);
    };

    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });
    await waitForSceneViewportReady(page);
    await test.step("suppresses the native context menu across the shell", async () => {
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
    await closeContextMenu();
    await test.step("keeps the native menu on opted-in selectable text", async () => {
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
    await test.step("opens context menu on right click in viewport panel", async () => {
      const panel = page.getByTestId("viewport-panel");
      await panel.click({ button: "right", position: { x: 40, y: 40 } });
      await expect(page.getByTestId("context-menu-panel")).toBeVisible();
      await expect(
        page.getByTestId("context-menu-item-reload-scene"),
      ).toBeVisible();
    });
    await closeContextMenu();
    await test.step("opens context menu after long press in viewport panel", async () => {
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
    await closeContextMenu();
  });
});
