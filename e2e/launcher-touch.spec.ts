import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";
import { createEmptyProjectFiles } from "../packages/assets/src/babproject";
import { defaultEngineSettings } from "../packages/vfs/src/app-settings";

/** Tiny, per-context libraries exercise the launcher without starting an engine. */
async function openLauncher(page: Page) {
  const response = await page.goto("/__test_identity");
  expect(response?.ok()).toBe(true);
  const names = ["Touch One", "Touch Two", "Touch Three", "Touch Four"];
  const settings = defaultEngineSettings();
  settings.recents = names.map((name) => ({
    id: `opfs:${name}`,
    name,
    tier: "opfs",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  }));
  const libraries = [
    ...names.map((name) => ({
      root: `opfs:${name}`.replaceAll(" ", "_"),
      name,
    })),
    {
      root: "opfs:__slate_templates__/Touch Starter One",
      name: "Touch Starter One",
    },
    {
      root: "opfs:__slate_templates__/Touch Starter Two",
      name: "Touch Starter Two",
    },
  ].map(({ root, name }) => ({
    root,
    files: createEmptyProjectFiles({ guid: name, name }).map(
      ({ path, data }) => ({
        path,
        data: [...data],
      }),
    ),
  }));
  await page.evaluate(
    async ({ libraries, settings }) => {
      const origin = await navigator.storage.getDirectory();
      for (const library of libraries) {
        for (const { path, data } of library.files) {
          const parts = `${library.root}/${path}`.split("/");
          let directory = origin;
          for (const part of parts.slice(0, -1))
            directory = await directory.getDirectoryHandle(part, {
              create: true,
            });
          const file = await directory.getFileHandle(parts.at(-1)!, {
            create: true,
          });
          const writer = await file.createWritable();
          await writer.write(new Uint8Array(data));
          await writer.close();
        }
      }
      localStorage.setItem(
        "babylonslate:engine-settings",
        JSON.stringify(settings),
      );
      localStorage.setItem(
        "babylonslate:opfs-meta",
        JSON.stringify({
          currentId: null,
          projects: settings.recents.map(({ id, name }) => ({ id, name })),
        }),
      );
    },
    { libraries, settings },
  );
  await page.goto("/?test=1");
  await page.waitForFunction(() => window.crossOriginIsolated, undefined, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("homepage")).toBeVisible();
  await expect(page.locator(".slate-loading")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.locator(".homepage-project-card").first()).toBeVisible();

  // These observations are diagnostic, not timing gates: CI scheduling and CDP
  // transport vary. Attaching them after failures also permits baseline runs.
  await page.evaluate(() => {
    const samples: Array<Record<string, unknown>> = [];
    Object.assign(window, { __launcherTouchSamples: samples });
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.pointerType !== "touch") return;
        const element =
          event.target instanceof Element
            ? event.target.closest("[data-testid], [aria-label], button")
            : null;
        const started = performance.now();
        const sample: Record<string, unknown> = {
          target:
            element?.getAttribute("data-testid") ??
            element?.getAttribute("aria-label") ??
            element?.textContent?.trim(),
        };
        samples.push(sample);
        requestAnimationFrame(() => {
          const first = performance.now();
          sample.firstFrameMs = first - started;
          requestAnimationFrame(() => {
            sample.secondFrameMs = performance.now() - started;
            sample.frameGapMs = performance.now() - first;
          });
        });
      },
      { capture: true, passive: true },
    );
  });
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

async function touch(
  session: CDPSession,
  type: "touchStart" | "touchMove",
  point: { x: number; y: number },
) {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: [point],
  });
}

async function cancelTouch(session: CDPSession) {
  await session.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
}

async function appearance(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderColor };
  });
}

for (const device of [
  { name: "phone", viewport: { width: 390, height: 844 }, keyboardHeight: 420 },
  {
    name: "tablet",
    viewport: { width: 1194, height: 834 },
    keyboardHeight: 480,
  },
]) {
  test.describe(`Launcher touch on ${device.name}`, () => {
    test.use({ hasTouch: true, viewport: device.viewport });

    test.afterEach(async ({ page }, testInfo) => {
      const samples = await page
        .evaluate(
          () =>
            (window as unknown as { __launcherTouchSamples?: unknown[] })
              .__launcherTouchSamples ?? [],
        )
        .catch(() => []);
      await testInfo.attach("launcher-touch-frames.json", {
        body: JSON.stringify({ viewport: device.viewport, samples }, null, 2),
        contentType: "application/json",
      });
    });

    test("contact feedback cancels cleanly and a native template swipe never activates a card", async ({
      page,
    }) => {
      await openLauncher(page);
      const session = await page.context().newCDPSession(page);
      const project = page.locator(".homepage-project-card").first();
      const idle = await appearance(project);
      await touch(
        session,
        "touchStart",
        await center(project.locator(".homepage-project-well")),
      );
      const pressed = await appearance(project);
      await cancelTouch(session);
      expect
        .soft(pressed, "contact should visibly respond before release")
        .not.toEqual(idle);
      await expect.poll(() => appearance(project)).toEqual(idle);
      await expect(page.getByTestId("homepage-project-menu")).toHaveCount(0);
      await expect(page.getByTestId("editor-chrome-bar")).toHaveCount(0);

      await page.getByRole("button", { name: "Templates", exact: true }).tap();
      const region = page.getByRole("region", {
        name: "Templates",
        exact: true,
      });
      const firstPage = region.locator(".homepage-gallery-page:not([inert])");
      const card = firstPage.locator(".homepage-template-card").last();
      await expect(card).toBeVisible();
      const bounds = (await region.boundingBox())!;
      const cardBounds = (await card.boundingBox())!;
      const start = {
        x: cardBounds.x + cardBounds.width - 24,
        y: cardBounds.y + cardBounds.height / 2,
      };
      const endX = bounds.x + 24;
      const templateIdle = await appearance(card);
      await touch(session, "touchStart", start);
      const templatePressed = await appearance(card);
      for (let step = 1; step <= 12; step++) {
        await touch(session, "touchMove", {
          x: start.x + ((endX - start.x) * step) / 12,
          y: start.y,
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      }
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      expect
        .soft(templatePressed, "template contact should visibly respond")
        .not.toEqual(templateIdle);
      await expect
        .poll(() => region.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(bounds.width / 2);
      await expect(
        region.locator(".homepage-gallery-page:not([inert])"),
      ).toHaveAttribute("aria-label", /Page [2-9] of/);
      await expect(region.locator('[data-touch-pressed="true"]')).toHaveCount(
        0,
      );
      await expect(page.getByTestId("create-project-dialog")).toHaveCount(0);

      const freshCard = region
        .locator(".homepage-gallery-page:not([inert]) .homepage-template-card")
        .first();
      await freshCard.tap();
      await expect(page.getByTestId("create-project-name")).toBeVisible();
      await expect(page.getByTestId("create-project-name")).not.toBeFocused();
    });

    test("creator retains its draft and keeps touch controls reachable above the keyboard", async ({
      page,
    }) => {
      // Chromium touch emulation does not open an OS keyboard. Override only the
      // visual viewport boundary; layout, scrolling, controls, and input stay real.
      await page.addInitScript(() => {
        const viewport = Object.assign(new EventTarget(), {
          width: window.innerWidth,
          height: window.innerHeight,
          offsetTop: 0,
          offsetLeft: 0,
          pageTop: 0,
          pageLeft: 0,
          scale: 1,
        });
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: viewport,
        });
      });
      await openLauncher(page);
      await page.getByTestId("create-project").tap();
      const dialog = page.getByTestId("create-project-dialog");
      await dialog.getByTestId("create-project-blank").tap();
      const name = dialog.getByTestId("create-project-name");
      await expect(name).not.toBeFocused();
      await name.tap();
      await name.fill("Touch Draft");
      const rocket = dialog.getByRole("button", {
        name: "Rocket",
        exact: true,
      });
      const violet = dialog.getByRole("button", {
        name: "Violet",
        exact: true,
      });
      await rocket.tap();
      await violet.tap();
      await dialog
        .getByRole("button", { name: "Choose Template", exact: true })
        .tap();
      await dialog.getByTestId("homepage-template-search").fill("Basic 3D");
      await dialog.getByTestId("create-project-empty").tap();
      await expect(name).toHaveValue("Touch Draft");
      await expect(rocket).toHaveAttribute("aria-pressed", "true");
      await expect(violet).toHaveAttribute("aria-pressed", "true");

      const controls = dialog.locator(
        [
          ".homepage-icon-choice",
          ".homepage-color-choice",
          'button[aria-label="Choose Template"]',
          '[data-slot="dialog-close"]',
          ".homepage-composer-upload button",
          '[data-testid="create-project-submit"]',
        ].join(","),
      );
      const sizes = await controls.evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.getAttribute("aria-label") ?? element.textContent,
            width: rect.width,
            height: rect.height,
          };
        }),
      );
      for (const size of sizes) {
        expect
          .soft(size.width, `${size.label} touch width`)
          .toBeGreaterThanOrEqual(44);
        expect
          .soft(size.height, `${size.label} touch height`)
          .toBeGreaterThanOrEqual(44);
      }

      await name.tap();
      await page.evaluate((height) => {
        Object.assign(window.visualViewport!, { height, offsetTop: 24 });
        window.visualViewport!.dispatchEvent(new Event("resize"));
        window.visualViewport!.dispatchEvent(new Event("scroll"));
      }, device.keyboardHeight);
      const submit = dialog.getByTestId("create-project-submit");
      await expect
        .poll(async () => {
          const box = await submit.boundingBox();
          return box ? box.y + box.height : Infinity;
        })
        .toBeLessThanOrEqual(device.keyboardHeight + 25);
      await name.fill("Touch Draft With Keyboard");
      await expect(submit).toBeEnabled();
      expect(
        await submit.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ),
          );
        }),
      ).toBe(true);
      await expect(page.getByTestId("editor-chrome-bar")).toHaveCount(0);
    });
  });
}
