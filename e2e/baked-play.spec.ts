import { expect, test, type Locator, type Page } from "@playwright/test";
import type { runBakedPlayerFixture } from "../apps/editor/src/testing/baked-player-fixture";
import { decodeAssetDocument } from "../packages/assets/src/asset-document";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import {
  DEFAULT_RENDER_PROJECT_SETTINGS,
  MAIN_SCENE_FILE,
} from "../packages/core/src/index.ts";
import {
  exportGame,
  PREVIEW_STOP_MESSAGE,
} from "../packages/exporter/src/index.ts";
import { serveExportFiles } from "./export-static-server";
import { openMinimalTestProject } from "./minimal-project";
import { clickPlayAndWaitForOverlay } from "./play";

type BakedReceiverDiag = {
  mesh: string;
  material: string | null;
  slateBaked: boolean;
  excludedLights: string[];
  lightDefines: number | null;
};
type BakedSession = {
  state: "idle" | "pending" | "applied" | "stale";
  staleReasons: string[];
  receivers: BakedReceiverDiag[];
};

function errorsFor(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function bakedSession(
  canvas: Locator,
  host: "play" | "player",
): Promise<BakedSession | null> {
  return canvas.evaluate((_node, kind) => {
    const global = globalThis as unknown as {
      __babylonslatePlayTest?: { bakedSession?: () => BakedSession | null };
      __babylonslatePlayerTest?: { bakedSession?: () => BakedSession | null };
    };
    return (
      (kind === "play"
        ? global.__babylonslatePlayTest?.bakedSession?.()
        : global.__babylonslatePlayerTest?.bakedSession?.()) ?? null
    );
  }, host);
}

/** Count the fixture's warm-atlas pixels; an unbaked run shades grey or unlit. */
function warmPixels(canvas: Locator): Promise<number> {
  return canvas.evaluate((node) => {
    if (!(node instanceof HTMLCanvasElement)) return 0;
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d");
    if (!context) return 0;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let warm = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const r = pixels[offset]!;
      const g = pixels[offset + 1]!;
      const b = pixels[offset + 2]!;
      if (r > 60 && r > g + 40 && r > b + 40) warm += 1;
    }
    return warm;
  });
}

async function expectAppliedSession(
  canvas: Locator,
  host: "play" | "player",
): Promise<BakedSession | null> {
  let session: BakedSession | null = null;
  await expect
    .poll(async () => (session = await bakedSession(canvas, host))?.state, {
      timeout: 30_000,
    })
    .toBe("applied");
  // The compiled effect's realtime light defines prove reduced per-draw work:
  // the bake's directAndIndirect source is excluded, so zero light defines
  // remain once the receiver effect exists.
  await expect
    .poll(
      async () =>
        (session = await bakedSession(canvas, host))?.receivers[0]
          ?.lightDefines ?? -1,
      { timeout: 30_000 },
    )
    .toBe(0);
  return session;
}

async function seedBakedProject(page: Page) {
  await page.goto("/?bakedPlayerFixture=1");
  await page.waitForFunction(() => "__bakedPlayerFixture" in window);
  const entries = await page.evaluate(() =>
    (
      window as unknown as { __bakedPlayerFixture: typeof runBakedPlayerFixture }
    ).__bakedPlayerFixture(),
  );
  const files = new Map(
    entries.map(([path, bytes]) => [path, Uint8Array.from(bytes)]),
  );
  await openMinimalTestProject(page, files);
  return files;
}

test("Editor Play applies the bake and the receiver compiles with no realtime light defines", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors = errorsFor(page);
  await seedBakedProject(page);
  await clickPlayAndWaitForOverlay(page);
  const canvas = page.getByTestId("play-overlay").locator("canvas").first();
  const session = await expectAppliedSession(canvas, "play");
  expect(session?.staleReasons).toEqual([]);
  expect(session?.receivers).toHaveLength(1);
  const receiver = session!.receivers[0]!;
  expect(receiver.slateBaked).toBe(true);
  // The Static lamp keeps lighting other meshes but is excluded on this
  // receiver; the Play visual names it AUTHORED_LIGHT_PREFIX + the slot id.
  expect(receiver.excludedLights).toHaveLength(1);
  expect(receiver.excludedLights[0]).toMatch(/^authoredLight:/);
  expect(receiver.lightDefines).toBe(0);
  await expect
    .poll(() => warmPixels(canvas), { timeout: 30_000 })
    .toBeGreaterThan(100);
  await testInfo.attach("baked-session.json", {
    body: JSON.stringify(session, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("play-canvas.png", {
    body: await canvas.screenshot(),
    contentType: "image/png",
  });
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a served export applies the bake and the receiver compiles with no realtime light defines", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors = errorsFor(page);
  const files = await seedBakedProject(page);
  // Reuse the fixture's seeded project bytes: decode the Scene and Material
  // documents back to payloads, and carry the BakedLighting/BakedGeometry
  // containers verbatim (the player decodes them from the boot pack).
  const sceneDoc = await decodeAssetDocument(files.get(MAIN_SCENE_FILE)!);
  const assets: Array<{
    guid: string;
    type: string;
    sceneGuid: string;
    bytes: Uint8Array;
    name?: string;
  }> = [
    {
      guid: sceneDoc.guid,
      type: "Scene",
      sceneGuid: sceneDoc.guid,
      bytes: new TextEncoder().encode(JSON.stringify(sceneDoc.payload)),
      name: sceneDoc.name,
    },
  ];
  for (const [path, bytes] of files) {
    const match = /^assets\/(.+?)\.material\.babasset$/.exec(path);
    if (match) {
      const doc = await decodeAssetDocument(bytes);
      assets.push({
        guid: doc.guid,
        type: "Material",
        sceneGuid: sceneDoc.guid,
        bytes: new TextEncoder().encode(JSON.stringify(doc.payload)),
        name: doc.name,
      });
      continue;
    }
    // Bake containers are binary babassets (no JSON document chunk); the
    // guid is the filename and the player decodes the whole container.
    const baked = /^assets\/(BakedLighting|BakedGeometry)\/([0-9a-f-]+)\.babasset$/.exec(
      path,
    );
    if (baked)
      assets.push({
        guid: baked[2]!,
        type: baked[1]!,
        sceneGuid: sceneDoc.guid,
        bytes,
      });
  }
  const packed = await exportGame({
    bundleDebugger: false,
    startupSceneGuid: sceneDoc.guid,
    scripts: [],
    customResolution: {
      ...DEFAULT_RENDER_PROJECT_SETTINGS,
      customResolution: true,
      width: 320,
      height: 180,
      blackBars: true,
    },
    assets,
    playerFiles: await loadPlayerDistFiles(new URL("/player/", baseURL!).href),
  });
  if (!packed.ok) throw new Error(packed.error);
  const server = await serveExportFiles(packed.value.files, {
    honorRange: true,
  });
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("player-root")).toHaveAttribute(
      "data-booted",
      "true",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({
      timeout: 30_000,
    });
    const canvas = page.getByTestId("player-canvas");
    const session = await expectAppliedSession(canvas, "player");
    expect(session?.staleReasons).toEqual([]);
    expect(session?.receivers).toHaveLength(1);
    const receiver = session!.receivers[0]!;
    expect(receiver.slateBaked).toBe(true);
    expect(receiver.excludedLights).toHaveLength(1);
    expect(receiver.excludedLights[0]).toMatch(/^authoredLight:/);
    expect(receiver.lightDefines).toBe(0);
    await expect
      .poll(() => warmPixels(canvas), { timeout: 30_000 })
      .toBeGreaterThan(100);
    await testInfo.attach("baked-session.json", {
      body: JSON.stringify(session, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("player-canvas.png", {
      body: await canvas.screenshot(),
      contentType: "image/png",
    });
    await page.evaluate(
      (type) => window.postMessage({ type }, window.location.origin),
      PREVIEW_STOP_MESSAGE,
    );
    await expect(page.getByTestId("player-root")).toHaveAttribute(
      "data-booted",
      "false",
    );
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
