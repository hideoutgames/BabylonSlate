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
async function pixels(canvas: Locator) {
  // Screenshot observes the presented canvas even when WebGL has discarded its
  // default framebuffer. Decode that exact image for both the oracle and evidence.
  const png = await canvas.screenshot();
  const image = await canvas.evaluate(async (_element, base64) => {
    const source = new Image();
    source.src = `data:image/png;base64,${base64}`;
    await source.decode();
    const copy = document.createElement("canvas");
    const scale = Math.min(1, 384 / Math.max(source.width, source.height));
    copy.width = Math.max(1, Math.round(source.width * scale));
    copy.height = Math.max(1, Math.round(source.height * scale));
    const ctx = copy.getContext("2d")!;
    ctx.drawImage(source, 0, 0, copy.width, copy.height);
    return {
      width: copy.width,
      height: copy.height,
      pixels: Array.from(ctx.getImageData(0, 0, copy.width, copy.height).data),
    };
  }, png.toString("base64"));
  return { ...image, png };
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
        const automatic = (await diagnostics(canvas, host))!;
        await testInfo.attach(`${host}-automatic-settings`, {
          body: JSON.stringify(automatic),
          contentType: "application/json",
        });
        expect(automatic.backend.actual, host).toBe("webgl2");
        expect(automatic.backend.requested, host).toBe("webgl2");
        expect(automatic.surfaceMode, host).toBe(mode);
        expect(automatic.requestedShadows, host).toMatchObject(render.shadows);
        const allocation = sun(automatic)!.generator!;
        expect(allocation.type, host).toBe("ShadowGenerator");
        expect(allocation.map, host).toMatchObject({
          width: 1024,
          height: 1024,
        });
        expect(allocation.lastDrawBias[0]!.depthBias, host).toBeGreaterThan(
          render.shadows.depthBias,
        );
        const shadowed = await pixels(canvas);
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
        await expect
          .poll(
            async () =>
              (await diagnostics(canvas, host))?.provenance.renderId ?? 0,
          )
          .toBeGreaterThan(automatic.provenance.renderId + 3);
        const reference = await pixels(canvas);
        await testInfo.attach(`${host}-shadow-contribution-off`, {
          body: reference.png,
          contentType: "image/png",
        });
        expect([reference.width, reference.height], host).toEqual([
          shadowed.width,
          shadowed.height,
        ]);
        const points = shadowSurfaceSamples(
          automatic.camera!.position as ShadowTriple,
          automatic.camera!.viewProjection as number[],
          shadowNormalize(
            SHADOW_LIGHT_DIRECTION.map((value) => -value) as ShadowTriple,
          ),
          shadowed.width,
          shadowed.height,
          automatic.viewport.cameraViewport!,
        );
        const regions = shadowRegions(
          reference.pixels,
          shadowed.pixels,
          points,
          shadowed.width,
        );
        const hostEvidence = { host, automatic, manual: manualState, regions };
        evidence.push(hostEvidence);
        await testInfo.attach(`${host}-shadow-pixel-regions`, {
          body: JSON.stringify(hostEvidence),
          contentType: "application/json",
        });
        for (const name of ["head", "torso", "ground"]) {
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
        customResolution: render,
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
