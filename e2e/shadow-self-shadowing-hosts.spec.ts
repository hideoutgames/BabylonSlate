import { execFileSync } from "node:child_process";
import { expect, test, type Locator } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  lookAtRotation,
  MAIN_SCENE_FILE,
  normalizeCelShadingSettings,
  normalizeRenderingQuality,
  normalizeShadowSettings,
  PROJECT_FILE,
  type RenderProjectSettings,
} from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import {
  createDefaultMigrationRegistry,
  MATERIAL_PAYLOAD_VERSION,
} from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import {
  exportGame,
  PREVIEW_STOP_MESSAGE,
} from "../packages/exporter/src/index.ts";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import type {
  ShadowDiagnostics,
  RenderShadingSettings,
} from "../packages/render/src/index";
import {
  SHADOW_BOXES,
  SHADOW_CAMERA_POSITION,
  SHADOW_CAMERA_TARGET,
  SHADOW_CAMERA_FOV,
  SHADOW_LIGHT_DIRECTION,
  shadowNormalize,
  shadowSurfaceSamples,
  shadowRegions,
  type ShadowTriple,
} from "../apps/editor/src/testing/shadow-self-shadowing-fixture";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { serveExportFiles } from "./export-static-server";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const SCENE_GUID = "00000000-0000-4000-8000-000000000001";
const MATERIAL_GUID = "00000000-0000-4000-8000-000000000088";
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
type Host = "editor" | "play" | "player";
type TestApi = {
  shadowDiagnostics(): ShadowDiagnostics | null;
  setRenderSettings(settings: RenderShadingSettings): void;
};

function fixture(mode: "pbr" | "cel") {
  const render: RenderProjectSettings = {
    ...DEFAULT_RENDER_PROJECT_SETTINGS,
    gpuBackend: "webgl2",
    renderPath: "forward",
    mode,
    // Pixel pairs must keep the same drawing buffer. Medium's adaptive scale
    // can change between shadow-on and shadow-off on software CI adapters.
    quality: normalizeRenderingQuality({
      resolution: { scale: 1, minScale: 1, dynamic: false },
    }),
    shadows: normalizeShadowSettings({ profile: "low" }),
    cel: normalizeCelShadingSettings({
      specularEnabled: false,
      shadowStrength: 1,
    }),
    customResolution: true,
    width: 384,
    height: 384,
    blackBars: true,
  };
  const scene = createDefaultScene();
  scene.settings.grid.showGrid = false;
  scene.settings.environmentColor = [0.04, 0.04, 0.04];
  scene.settings.environmentTextureGuid = null;
  const camera = scene.actors.find(
    (actor) => actor.id === scene.settings.mainCameraActorId,
  )!;
  camera.transform.position = [...SHADOW_CAMERA_POSITION];
  camera.transform.rotation = lookAtRotation(
    SHADOW_CAMERA_POSITION,
    SHADOW_CAMERA_TARGET,
  );
  Object.assign(camera.components[0]!.properties, {
    fieldOfView: (SHADOW_CAMERA_FOV * 180) / Math.PI,
    nearClip: 0.1,
    farClip: 100,
  });
  const meshActor = (
    name: string,
    center: ShadowTriple,
    size: ShadowTriple,
    kind = "box",
  ) => {
    const mesh = createMeshComponent(`${name}-mesh`, kind);
    mesh.properties.materialGuid = MATERIAL_GUID;
    // Authored Box is 1.5 units and Ground is 10 units; preserve oracle bounds.
    const divisor = kind === "ground" ? 10 : 1.5;
    return createActor(name, name, {
      transform: {
        position: [...center],
        rotation: [0, 0, 0, 1],
        scale: size.map((value) => value / divisor) as ShadowTriple,
      },
      components: [mesh],
    });
  };
  scene.actors = [
    camera,
    ...SHADOW_BOXES.map((box) => meshActor(box.name, box.center, box.size)),
    meshActor("ground", [0, 0, 0], [12, 10, 12], "ground"),
    createActor("sun", "Sun", {
      transform: {
        position: [0, 8, 0],
        rotation: lookAtRotation([0, 0, 0], SHADOW_LIGHT_DIRECTION),
        scale: [1, 1, 1],
      },
      components: [
        {
          id: "sun-light",
          classId: "LightComponent",
          properties: {
            lightKind: "directional",
            intensity: 2,
            color: [1, 1, 1],
            castShadows: true,
          },
        },
      ],
    }),
    createActor("fill", "Fill", {
      transform: {
        position: [0, 8, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      components: [
        {
          id: "fill-light",
          classId: "HemisphericFillLightComponent",
          properties: {
            intensity: 0.12,
            color: [1, 1, 1],
            groundColor: [0, 0, 0],
          },
        },
      ],
    }),
  ];
  const material = createDefaultMaterialDocument("Neutral Matte");
  material.nodes.find((node) => node.id === "baseColor")!.properties.value = [
    0.6, 0.6, 0.6,
  ];
  material.nodes.push({
    id: "roughness",
    type: "const.float",
    position: { x: 0, y: 100 },
    properties: { value: 1 },
  });
  material.edges.push({
    id: "roughness-output",
    sourceNodeId: "roughness",
    sourcePinId: "out",
    targetNodeId: "output",
    targetPinId: "roughness",
  });
  return { render, scene, material };
}

async function diagnostics(canvas: Locator, host: Host) {
  return canvas.evaluate((_node, kind) => {
    const global = globalThis as unknown as Record<string, TestApi>;
    const key =
      kind === "editor"
        ? "__babylonslateViewportTest"
        : kind === "play"
          ? "__babylonslatePlayTest"
          : "__babylonslatePlayerTest";
    return global[key]?.shadowDiagnostics() ?? null;
  }, host);
}
async function settings(
  canvas: Locator,
  host: Host,
  render: RenderShadingSettings,
) {
  await canvas.evaluate(
    (_node, { kind, value }) => {
      const global = globalThis as unknown as Record<string, TestApi>;
      const key =
        kind === "editor"
          ? "__babylonslateViewportTest"
          : kind === "play"
            ? "__babylonslatePlayTest"
            : "__babylonslatePlayerTest";
      global[key]!.setRenderSettings(value);
    },
    { kind: host, value: render },
  );
}
async function freshFrames(canvas: Locator, host: Host) {
  // Take the boundary after the requested settings/draw state was observed.
  // A counter captured before earlier screenshots and settings edits can
  // already be satisfied while the old image is still being presented.
  const before = (await diagnostics(canvas, host))!.provenance.renderId;
  await expect
    .poll(
      async () => (await diagnostics(canvas, host))?.provenance.renderId ?? 0,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(before + 2);
}
async function pixels(canvas: Locator, state: ShadowDiagnostics) {
  // Preserve native screenshot pixels: resizing can average narrow acne away.
  // A PNG IHDR supplies the exact dimensions before decoding the bounded image.
  const png = await canvas.screenshot({ type: "png" });
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 2048 || height > 2048)
    throw new Error("Shadow host capture exceeds the bounded 2048px surface");
  const points = shadowSurfaceSamples(
    state.camera!.position as ShadowTriple,
    state.camera!.viewProjection as number[],
    shadowNormalize(
      SHADOW_LIGHT_DIRECTION.map((value) => -value) as ShadowTriple,
    ),
    width,
    height,
    state.viewport.cameraViewport!,
    SHADOW_BOXES,
    sun(state)?.generator?.cascades === 1 ? {
      kind: "directional-single-pcf",
      view: sun(state)!.generator!.projections[0]!.view!,
      projection: sun(state)!.generator!.projections[0]!.matrix!,
      width: sun(state)!.generator!.map!.width,
      height: sun(state)!.generator!.map!.height,
    } : undefined,
  );
  if (points.length > 8192)
    throw new Error("Shadow sample population exceeds fixture limit");
  const sampled = await canvas.evaluate(
    async (_element, { base64, points, width, height }) => {
      const source = new Image();
      source.src = `data:image/png;base64,${base64}`;
      await source.decode();
      if (source.naturalWidth !== width || source.naturalHeight !== height)
        throw new Error(
          "Decoded shadow capture dimensions differ from PNG IHDR",
        );
      const copy = document.createElement("canvas");
      copy.width = width;
      copy.height = height;
      const ctx = copy.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(source, 0, 0);
      // Cache small tiles, returning only sampled RGBA values across the boundary.
      // Each sample is the exact native screenshot pixel, without interpolation.
      const tiles = new Map<string, ImageData>();
      return points.flatMap(({ x, y }) => {
        const left = Math.floor(x / 32) * 32;
        const top = Math.floor(y / 32) * 32;
        const key = `${left}:${top}`;
        let tile = tiles.get(key);
        if (!tile) {
          tile = ctx.getImageData(
            left,
            top,
            Math.min(32, width - left),
            Math.min(32, height - top),
          );
          tiles.set(key, tile);
        }
        const offset = ((y - top) * tile.width + x - left) * 4;
        return Array.from(tile.data.subarray(offset, offset + 4));
      });
    },
    { base64: png.toString("base64"), points, width, height },
  );
  return { width, height, pixels: sampled, points, png };
}
const sun = (state: ShadowDiagnostics | null) =>
  state?.lights.find(
    (light) => light.type === "DirectionalLight" && light.requested,
  );

for (const mode of ["pbr", "cel"] as const) {
  test(`synthetic self-shadowing retains authored Low settings and contact pixels in editor, Play and packed player: ${mode}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    const evidence: unknown[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        ["warning", "error"].includes(message.type()) &&
        /shader|ERROR: 0:|GL_INVALID|GL_OUT_OF_MEMORY|context lost/i.test(
          message.text(),
        )
      )
        errors.push(message.text());
    });
    try {
      const { render, scene, material } = fixture(mode);
      const files = await minimalProjectFiles();
      const project = JSON.parse(
        new TextDecoder().decode(files.get(PROJECT_FILE)!),
      );
      project.settings.render = render;
      files.set(PROJECT_FILE, encode(project));
      files.set(
        "assets/Shadow.material.babasset",
        await encodeAssetDocument({
          guid: MATERIAL_GUID,
          type: "Material",
          name: "Neutral Matte",
          version: MATERIAL_PAYLOAD_VERSION,
          payload: material as unknown as Record<string, unknown>,
        }),
      );
      files.set(
        MAIN_SCENE_FILE,
        await encodeAssetDocument(
          {
            guid: SCENE_GUID,
            type: "Scene",
            name: "Main",
            version: createDefaultMigrationRegistry().currentVersion("Scene"),
            payload: scene as unknown as Record<string, unknown>,
          },
          { dependencies: [MATERIAL_GUID] },
        ),
      );
      await openMinimalTestProject(page, files);
      await openMainScene(page);
      const setEditorView = () =>
        page.evaluate(
          ({ position, target, fov }) => {
            (
              globalThis as unknown as {
                __babylonslateViewportTest: {
                  setShadowCaptureView(
                    position: ShadowTriple,
                    target: ShadowTriple,
                    fov: number,
                  ): void;
                };
              }
            ).__babylonslateViewportTest.setShadowCaptureView(
              position,
              target,
              fov,
            );
          },
          {
            position: SHADOW_CAMERA_POSITION,
            target: SHADOW_CAMERA_TARGET,
            fov: SHADOW_CAMERA_FOV,
          },
        );
      await setEditorView();

      const verify = async (canvas: Locator, host: Host) => {
        await expect
          .poll(
            async () =>
              sun(await diagnostics(canvas, host))?.generator?.lastDrawBias[0]
                ?.mode,
            { timeout: 30_000 },
          )
          .toBe("directional-auto");
        await freshFrames(canvas, host);
        const automatic = (await diagnostics(canvas, host))!;
        await testInfo.attach(`${host}-automatic-settings`, {
          body: JSON.stringify(automatic),
          contentType: "application/json",
        });
        expect(automatic.backend.actual, host).toBe("webgl2");
        expect(automatic.backend.requested, host).toBe("webgl2");
        expect(automatic.surfaceMode, host).toBe(mode);
        expect(automatic.requestedShadows, host).toMatchObject(render.shadows);
        expect(automatic.viewport.scalingLevel, host).toBe(1);
        if (host !== "editor") {
          expect(automatic.viewport.renderWidth, host).toBe(render.width);
          expect(automatic.viewport.renderHeight, host).toBe(render.height);
        }
        const allocation = sun(automatic)!.generator!;
        expect(allocation.type, host).toBe("ShadowGenerator");
        expect(allocation.map, host).toMatchObject({
          width: 1024,
          height: 1024,
        });
        expect(allocation.lastDrawBias[0]!.depthBias, host).toBeGreaterThan(
          render.shadows.depthBias,
        );
        const shadowed = await pixels(canvas, automatic);
        await testInfo.attach(`${host}-shadowed`, {
          body: shadowed.png,
          contentType: "image/png",
        });
        const manual = {
          ...render,
          shadows: {
            ...render.shadows,
            autoBias: false,
            depthBias: 0.00037,
            normalBias: 0.004,
          },
        };
        await settings(canvas, host, manual);
        await expect
          .poll(
            async () =>
              sun(await diagnostics(canvas, host))?.generator?.lastDrawBias[0]
                ?.depthBias,
          )
          .toBe(0.00037);
        await freshFrames(canvas, host);
        const manualState = (await diagnostics(canvas, host))!;
        expect(sun(manualState)!.generator!.map!.id, host).toBe(
          allocation.map!.id,
        );
        expect(
          sun(manualState)!.generator!.lastDrawBias[0]!.normalBias,
          host,
        ).toBe(0.004);
        await settings(canvas, host, render);
        await expect
          .poll(
            async () =>
              sun(await diagnostics(canvas, host))?.generator?.lastDrawBias[0]
                ?.mode,
          )
          .toBe("directional-auto");
        await freshFrames(canvas, host);
        expect(
          sun((await diagnostics(canvas, host))!)!.generator!.map!.id,
          host,
        ).toBe(allocation.map!.id);
        await settings(canvas, host, {
          ...render,
          shadows: { ...render.shadows, enabled: false },
        });
        await expect
          .poll(async () => sun(await diagnostics(canvas, host))?.generator)
          .toBeNull();
        await freshFrames(canvas, host);
        const referenceState = (await diagnostics(canvas, host))!;
        expect(referenceState.viewport, `${host} fixed shadow reference output`)
          .toEqual(automatic.viewport);
        // The sparse values form a compact row only AFTER native pixel sampling;
        // adapt coordinates to the shared classifier without altering intensities.
        const points = shadowed.points.map((point, index) => ({
          ...point,
          x: index,
          y: 0,
        }));
        let reference = await pixels(canvas, automatic);
        // Scene frames alone do not prove that the replacement receiver
        // shader and any asynchronous canvas copy have presented. Require the
        // shadow-off image to brighten known occlusions before using it as an
        // oracle. The stricter quality assertions below remain independent.
        await expect
          .poll(
            async () => {
              reference = await pixels(canvas, automatic);
              if (
                reference.width !== shadowed.width ||
                reference.height !== shadowed.height
              )
                return false;
              const visible = shadowRegions(
                reference.pixels,
                shadowed.pixels,
                points,
                points.length,
              );
              return ["torso", "ground"].every(
                (name) => (visible[name]?.retainedContact ?? 0) > 5,
              );
            },
            {
              timeout: 30_000,
              message: `${host} must present the shadow-off receiver shader`,
            },
          )
          .toBe(true);
        await testInfo.attach(`${host}-shadow-contribution-off`, {
          body: reference.png,
          contentType: "image/png",
        });
        const regions = shadowRegions(
          reference.pixels,
          shadowed.pixels,
          points,
          points.length,
        );
        const hostEvidence = { host, automatic, manual: manualState, regions };
        evidence.push(hostEvidence);
        await testInfo.attach(`${host}-shadow-pixel-regions`, {
          body: JSON.stringify(hostEvidence),
          contentType: "application/json",
        });
        for (const name of [
          "head",
          "torso",
          "left-arm",
          "right-arm",
          "left-leg",
          "right-leg",
          "ground",
        ]) {
          expect(
            regions[name]?.lit ?? 0,
            `${host} ${name} lit population`,
          ).toBeGreaterThan(20);
          expect(
            regions[name]!.falseDark / regions[name]!.lit,
            `${host} ${name} spurious shadow samples`,
          ).toBeLessThan(0.05);
        }
        for (const name of ["torso", "ground"]) {
          expect(
            regions[name]?.contact ?? 0,
            `${host} ${name} contact population`,
          ).toBeGreaterThan(5);
          expect(
            regions[name]!.retainedContact / regions[name]!.contact,
            `${host} ${name} preserved contacts`,
          ).toBeGreaterThan(0.8);
        }
        await settings(canvas, host, render);
        await expect
          .poll(
            async () =>
              sun(await diagnostics(canvas, host))?.generator?.lastDrawBias[0]
                ?.mode,
          )
          .toBe("directional-auto");
        await freshFrames(canvas, host);
      };
      await verify(page.getByTestId("viewport-canvas"), "editor");
      await page.reload();
      await openTestProject(page);
      await openMainScene(page);
      await setEditorView();
      await expect
        .poll(
          async () =>
            (await diagnostics(page.getByTestId("viewport-canvas"), "editor"))
              ?.requestedShadows,
        )
        .toMatchObject(render.shadows);
      await clickPlayAndWaitForOverlay(page);
      await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({
        timeout: 30_000,
      });
      await verify(page.getByTestId("play-canvas"), "play");
      await page.getByTestId("play-overlay-close").click();
      await expect(page.getByTestId("play-overlay")).toHaveCount(0);

      const packed = await exportGame({
        bundleDebugger: false,
        startupSceneGuid: SCENE_GUID,
        scripts: [],
        renderSettings: render,
        assets: [
          {
            guid: SCENE_GUID,
            type: "Scene",
            sceneGuid: SCENE_GUID,
            bytes: encode(scene),
          },
          {
            guid: MATERIAL_GUID,
            type: "Material",
            sceneGuid: SCENE_GUID,
            bytes: encode(material),
          },
        ],
        playerFiles: await loadPlayerDistFiles(
          new URL("/player/", baseURL!).href,
        ),
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
        await verify(page.getByTestId("player-canvas"), "player");
        await page.evaluate(
          (type) => window.postMessage({ type }, window.location.origin),
          PREVIEW_STOP_MESSAGE,
        );
        await expect(page.getByTestId("player-root")).toHaveAttribute(
          "data-booted",
          "false",
        );
      } finally {
        await server.close();
      }
      expect(errors).toEqual([]);
    } finally {
      await testInfo.attach("synthetic-host-effective-settings", {
        body: JSON.stringify(
          {
            buildSha: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
            os: process.platform,
            qualification:
              "Synthetic browser WebGL2 host parity; no original asset or native A16 qualification",
            evidence,
            errors,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
  });
}
