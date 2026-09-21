import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  normalizeRenderingQuality,
} from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import {
  exportGame,
  PREVIEW_STOP_MESSAGE,
} from "../packages/exporter/src/index.ts";
import { serveExportFiles } from "./export-static-server";
import { openMinimalTestProject } from "./minimal-project";
import {
  openMainScene,
  openTestProject,
  waitForSceneViewportReady,
} from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { expectGreenIllumination } from "./preview-parity";
import { saveAllIfEnabled } from "./save-all";

const GUID = "00000000-0000-4000-8000-000000000001";
const quality = normalizeRenderingQuality({
  lighting: { localLightMode: "manual", maxLocalLights: 24 },
});
function fixtureScene() {
  const scene = createDefaultScene();
  scene.settings.environmentTextureGuid = null;
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.shadowOverrides = { enabled: false };
  scene.settings.grid.showGrid = false;
  scene.actors = scene.actors.filter(
    (actor) => actor.id === scene.settings.mainCameraActorId,
  );
  scene.actors[0]!.transform.position = [0, 0, -12];
  scene.actors[0]!.transform.rotation = [0, 0, 0, 1];
  scene.actors.push(
    createActor("receiver", "Receiver", {
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [5, 5, 5],
      },
      components: [createMeshComponent("receiver-mesh", "sphere")],
    }),
  );
  for (let index = 0; index < 24; index++)
    scene.actors.push(
      createActor(`point-${index}`, `Point ${index}`, {
        transform: {
          position: [
            (index % 6) * 0.5 - 1.25,
            Math.floor(index / 6) * 0.5 - 0.75,
            -4,
          ],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            id: `light-${index}`,
            classId: "LightComponent",
            properties: {
              lightKind: "point",
              color: [0.02, 1, 0.02],
              intensity: 1,
              range: 20,
              enabled: true,
              castShadows: false,
            },
          },
        ],
      }),
    );
  return scene;
}

type Rendering = {
  pipeline: {
    requested: { renderPath: string };
    effective: { renderPath: string; gpuBackend: string };
    limits: string[];
  };
  clusteredLights: number;
};
async function rendering(
  canvas: Locator,
  host: "editor" | "play" | "player",
): Promise<Rendering | null> {
  return canvas.evaluate((_node, kind) => {
    const global = globalThis as unknown as {
      __babylonslateViewportTest?: {
        renderingBaseline(): { render: Rendering } | null;
      };
      __babylonslatePlayTest?: { rendering(): Rendering | null };
      __babylonslatePlayerTest?: { rendering(): Rendering | null };
    };
    return kind === "editor"
      ? (global.__babylonslateViewportTest?.renderingBaseline()?.render ?? null)
      : kind === "play"
        ? (global.__babylonslatePlayTest?.rendering() ?? null)
        : (global.__babylonslatePlayerTest?.rendering() ?? null);
  }, host);
}
async function choosePath(page: Page, label: string) {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("project-render-path").click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
  await waitForSceneViewportReady(page);
}
function errorsFor(page: Page) {
  const errors: string[] = [];
  const externalDiagnostics: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Existing Dockview community setup emits this unrelated enterprise notice.
    // Keep it in evidence; every other console error and all page errors still fail.
    if (
      message
        .text()
        .startsWith(
          'dockview: `createContextMenuItemComponent` requires the "ContextMenu" module, which ships in dockview-enterprise.',
        )
    ) {
      externalDiagnostics.push(message.text());
      return;
    }
    if (
      message.type() === "error" ||
      (message.type() === "warning" &&
        /shader|GL_INVALID|GL_OUT_OF_MEMORY|context lost/i.test(message.text()))
    )
      errors.push(message.text());
  });
  return { errors, externalDiagnostics };
}

test("editor path selection and Play use one admitted cluster and retain the requested Auto path", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { errors, externalDiagnostics } = errorsFor(page);
  const files = await minimalProjectFiles();
  const project = JSON.parse(
    new TextDecoder().decode(files.get(PROJECT_FILE)!),
  );
  project.settings.render.quality = quality;
  project.settings.render.customResolution = true;
  project.settings.render.width = 320;
  project.settings.render.height = 180;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  files.set(
    MAIN_SCENE_FILE,
    await encodeAssetDocument({
      guid: GUID,
      type: "Scene",
      name: "Main",
      version: createDefaultMigrationRegistry().currentVersion("Scene"),
      payload: fixtureScene() as unknown as Record<string, unknown>,
    }),
  );
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  const canvas = page.getByTestId("viewport-panel").locator("canvas").first();
  await expect
    .poll(
      async () =>
        (await rendering(canvas, "editor"))?.pipeline.effective.renderPath,
    )
    .toBe("forward");
  await choosePath(page, "Clustered Forward");
  await expect
    .poll(async () => (await rendering(canvas, "editor"))?.clusteredLights, {
      timeout: 30_000,
    })
    .toBe(24);
  await expectGreenIllumination(canvas);
  const explicit = await rendering(canvas, "editor");
  expect(explicit?.pipeline.requested.renderPath).toBe("clusteredForward");
  await choosePath(page, "Forward");
  await expect
    .poll(async () => (await rendering(canvas, "editor"))?.clusteredLights)
    .toBe(0);
  await choosePath(page, "Auto");
  await expect
    .poll(async () => (await rendering(canvas, "editor"))?.clusteredLights, {
      timeout: 30_000,
    })
    .toBe(24);
  const auto = await rendering(canvas, "editor");
  expect(auto?.pipeline.requested.renderPath).toBe("auto");
  expect(auto?.pipeline.effective.renderPath).toBe("clusteredForward");
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await expect(
    page.getByTestId("project-render-pipeline-status"),
  ).toContainText("Clustered Forward");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await clickPlayAndWaitForOverlay(page);
  const play = page.getByTestId("play-overlay").locator("canvas").first();
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await rendering(play, "play"))?.clusteredLights, {
      timeout: 30_000,
    })
    .toBe(24);
  await expectGreenIllumination(play);
  const played = await rendering(play, "play");
  expect(played?.pipeline.requested.renderPath).toBe("auto");
  await testInfo.attach("clustered-selection", {
    body: JSON.stringify({ explicit, auto, played, externalDiagnostics }),
    contentType: "application/json",
  });
  await testInfo.attach("clustered-play", {
    body: await play.screenshot(),
    contentType: "image/png",
  });
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  await waitForSceneViewportReady(page);
  await expect
    .poll(async () => (await rendering(canvas, "editor"))?.clusteredLights)
    .toBe(24);
  expect(errors).toEqual([]);
});

test("packed player resolves saved Auto to real WebGL2 clustering before presentation", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const { errors, externalDiagnostics } = errorsFor(page);
  const packed = await exportGame({
    bundleDebugger: false,
    startupSceneGuid: GUID,
    scripts: [],
    renderSettings: {
      ...DEFAULT_RENDER_PROJECT_SETTINGS,
      renderPath: "auto",
      gpuBackend: "webgl2",
      quality,
      customResolution: true,
      width: 320,
      height: 180,
      blackBars: true,
    },
    assets: [
      {
        guid: GUID,
        type: "Scene",
        sceneGuid: GUID,
        bytes: new TextEncoder().encode(JSON.stringify(fixtureScene())),
      },
    ],
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
    await expect
      .poll(async () => (await rendering(canvas, "player"))?.clusteredLights, {
        timeout: 30_000,
      })
      .toBe(24);
    await expectGreenIllumination(canvas);
    const result = await rendering(canvas, "player");
    expect(result?.pipeline).toMatchObject({
      requested: { renderPath: "auto" },
      effective: { renderPath: "clusteredForward", gpuBackend: "webgl2" },
    });
    await testInfo.attach("clustered-player", {
      body: JSON.stringify({ result, externalDiagnostics }),
      contentType: "application/json",
    });
    await testInfo.attach("clustered-player-canvas", {
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

test("a session renderpath request is global and non-persistent while scenes store no path", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const { errors, externalDiagnostics } = errorsFor(page);
  const files = await minimalProjectFiles();
  const project = JSON.parse(
    new TextDecoder().decode(files.get(PROJECT_FILE)!),
  );
  project.settings.render.quality = quality;
  project.settings.render.renderPath = "clusteredForward";
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  files.set(
    MAIN_SCENE_FILE,
    await encodeAssetDocument({
      guid: GUID,
      type: "Scene",
      name: "Main",
      version: createDefaultMigrationRegistry().currentVersion("Scene"),
      payload: fixtureScene() as unknown as Record<string, unknown>,
    }),
  );
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  const canvas = page.getByTestId("viewport-panel").locator("canvas").first();
  await expect
    .poll(async () => (await rendering(canvas, "editor"))?.clusteredLights, {
      timeout: 30_000,
    })
    .toBe(24);
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openMainScene(page);
  await expect
    .poll(async () => (await rendering(canvas, "editor"))?.clusteredLights, {
      timeout: 30_000,
    })
    .toBe(24);
  const details = page.getByTestId("scene-details-panel");
  await expect(details).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Rendering", exact: true }),
  ).toHaveCount(0);
  await expect(details.locator('[data-testid$="-render-path"]')).toHaveCount(0);
  const savedScene = await page.evaluate(async () => {
    const host = globalThis as {
      __babylonslateTest?: {
        readAssetChunk?: (
          path: string,
          chunk: string,
        ) => Promise<Uint8Array | null>;
      };
    };
    const bytes = await host.__babylonslateTest?.readAssetChunk?.(
      "assets/main.scene.babasset",
      "document",
    );
    return bytes
      ? (JSON.parse(new TextDecoder().decode(bytes)) as {
          settings?: Record<string, unknown>;
        })
      : null;
  });
  expect(savedScene?.settings).toBeDefined();
  expect(savedScene!.settings).not.toHaveProperty("renderPath");
  await clickPlayAndWaitForOverlay(page);
  const play = page.getByTestId("play-overlay").locator("canvas").first();
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await rendering(play, "play"))?.clusteredLights, {
      timeout: 30_000,
    })
    .toBe(24);
  await page.getByTestId("play-console-open").click();
  const input = page.getByTestId("debug-console-input");
  const submit = page.getByTestId("debug-console-submit");
  const transcript = page.getByTestId("debug-console-transcript");
  await input.fill("renderpath forward");
  await submit.click();
  await expect(transcript).toContainText("renderpath forward");
  await expect
    .poll(
      async () =>
        (await rendering(play, "play"))?.pipeline.effective.renderPath,
      { timeout: 30_000 },
    )
    .toBe("forward");
  await expect
    .poll(async () => (await rendering(play, "play"))?.clusteredLights)
    .toBe(0);
  await input.fill("renderpath");
  await submit.click();
  await expect(transcript).toContainText("effective forward");
  await input.fill("renderpath reset");
  await submit.click();
  await expect(transcript).toContainText("renderpath reset");
  await expect
    .poll(
      async () =>
        (await rendering(play, "play"))?.pipeline.effective.renderPath,
      { timeout: 30_000 },
    )
    .toBe("clusteredForward");
  await expect
    .poll(async () => (await rendering(play, "play"))?.clusteredLights, {
      timeout: 30_000,
    })
    .toBe(24);
  await input.fill("renderpath");
  await submit.click();
  await expect(transcript).toContainText("effective clusteredForward");
  const sessionStatus = await rendering(play, "play");
  await testInfo.attach("session-renderpath", {
    body: JSON.stringify({ sessionStatus, externalDiagnostics }),
    contentType: "application/json",
  });
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  await waitForSceneViewportReady(page);
  await expect
    .poll(async () => (await rendering(canvas, "editor"))?.clusteredLights, {
      timeout: 30_000,
    })
    .toBe(24);
  expect(errors).toEqual([]);
});
