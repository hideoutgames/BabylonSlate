import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
} from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import {
  createDefaultMigrationRegistry,
  MATERIAL_PAYLOAD_VERSION,
} from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import {
  openMainScene,
  openTestProject,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function fixture() {
  const files = await minimalProjectFiles();
  const project = JSON.parse(
    new TextDecoder().decode(files.get(PROJECT_FILE)!),
  );
  project.settings.render.mode = "cel";
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const materialGuid = "00000000-0000-4000-8000-000000000051";
  const material = createDefaultMaterialDocument("Shadow Receiver");
  material.nodes[0]!.properties.value = [0.2, 0.6, 0.3];
  files.set(
    "assets/Receiver.material.babasset",
    await encodeAssetDocument({
      guid: materialGuid,
      type: "Material",
      name: "Shadow Receiver",
      version: MATERIAL_PAYLOAD_VERSION,
      payload: material as unknown as Record<string, unknown>,
    }),
  );
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.grid.showGrid = false;
  scene.settings.celShading = {
    specularEnabled: false,
    bandSoftness: 0,
    shadowStrength: 1,
  };
  scene.settings.shadowOverrides = {
    enabled: true,
    localMapSize: 512,
    localLightMode: "manual",
    maxLocalLights: 1,
  };
  const receiver = createMeshComponent("receiver-mesh", "plane");
  receiver.properties.materialGuid = materialGuid;
  receiver.properties.castShadows = false;
  scene.actors = [
    createActor("caster", "Caster", {
      transform: {
        position: [-1, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1.5, 1.5, 1.5],
      },
      components: [createMeshComponent("caster-mesh", "box")],
    }),
    createActor("receiver", "Receiver", {
      transform: {
        position: [0, 0, 3],
        rotation: [0, 0, 0, 1],
        scale: [10, 8, 1],
      },
      components: [receiver],
    }),
    createActor("key", "Key", {
      transform: {
        position: [-4, 4, -4],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      components: [
        {
          id: "key-light",
          classId: "LightComponent",
          properties: {
            lightKind: "point",
            color: [1, 1, 1],
            intensity: 2,
            range: 100,
            castShadows: true,
          },
        },
      ],
    }),
  ];
  files.set(
    MAIN_SCENE_FILE,
    await encodeAssetDocument(
      {
        guid: project.settings.startupSceneGuid,
        type: "Scene",
        name: "Main",
        version: createDefaultMigrationRegistry().currentVersion("Scene"),
        payload: scene as unknown as Record<string, unknown>,
      },
      { dependencies: [materialGuid] },
    ),
  );
  return files;
}

async function framePixels(page: Page) {
  const encoded = await page
    .getByTestId("viewport-canvas")
    .evaluate((canvas: HTMLCanvasElement) => {
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const data = context.getImageData(0, 0, copy.width, copy.height).data;
      let binary = "";
      for (let offset = 0; offset < data.length; offset += 8192)
        binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
      return btoa(binary);
    });
  return Buffer.from(encoded, "base64");
}

function isReceiver(image: Buffer, offset: number) {
  return (
    image[offset + 1]! > 20 &&
    image[offset + 1]! > image[offset]! * 1.5 &&
    image[offset + 1]! > image[offset + 2]! * 1.25
  );
}

async function pixels(page: Page) {
  let image = Buffer.alloc(0);
  // A live shadow toggle recompiles the receiver's material asynchronously;
  // several completed scene frames alone do not prove its shader has drawn.
  await expect
    .poll(async () => {
      image = await framePixels(page);
      let green = 0;
      for (let i = 0; i < image.length; i += 4)
        if (isReceiver(image, i)) green++;
      return green;
    })
    .toBeGreaterThan(500);
  return image;
}

test("CEL graph receiver stays illuminated after local shadows are disabled", async ({
  page,
}, testInfo) => {
  await openMinimalTestProject(page, await fixture());
  await openMainScene(page);
  await pixels(page);
  await page.getByTestId("tree-row-actor:key").click();
  await page
    .getByTestId("viewport-canvas")
    .screenshot({ path: testInfo.outputPath("shadows-on.png") });
  await page
    .getByRole("checkbox", { name: "Cast Shadows", exact: true })
    .uncheck();
  await page.evaluate(async () => {
    for (let frame = 0; frame < 8; frame++)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
  });
  try {
    await pixels(page);
  } finally {
    await page
      .getByTestId("viewport-canvas")
      .screenshot({ path: testInfo.outputPath("shadows-off.png") });
  }
});

test("CEL graph receiver presents a ready frame after edited project reload", async ({
  page,
}, testInfo) => {
  await openMinimalTestProject(page, await fixture());
  await openMainScene(page);
  await pixels(page);
  for (const [actor, position] of [
    ["caster", "1.5"],
    ["key", "4"],
  ] as const) {
    await page.getByTestId(`tree-row-actor:${actor}`).click();
    await page.getByTestId("property-actor-position-x").fill(position);
    await page.getByTestId("property-actor-position-x").press("Tab");
  }
  await page.setViewportSize({ width: 1100, height: 820 });
  await pixels(page);
  await saveAllIfEnabled(page, 30_000);
  await page
    .getByTestId("viewport-canvas")
    .screenshot({ path: testInfo.outputPath("before-reload.png") });
  await page.reload();
  await openTestProject(page);
  try {
    await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toHaveAttribute("data-scene-ready", "false");
    await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({
      timeout: 10_000,
    });
    await openMainScene(page);
    await pixels(page);
  } finally {
    await testInfo.attach("reload-render-state", {
      body: JSON.stringify(
        await page.evaluate(() => {
          const host = globalThis as unknown as {
            __babylonslateViewportTest?: {
              renderingBaseline(): unknown;
              sceneVisuals(): unknown;
            };
          };
          return {
            baseline: host.__babylonslateViewportTest?.renderingBaseline(),
            visuals: host.__babylonslateViewportTest?.sceneVisuals(),
          };
        }),
      ),
      contentType: "application/json",
    });
    await page.screenshot({ path: testInfo.outputPath("after-reload.png") });
  }
});
