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
  waitForSceneViewportReady,
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

type Draws = { count: number; textureIds: number[] };
type Baseline = {
  frameCount: number;
  render: {
    width: number;
    height: number;
    shadowPasses: number;
    shadowDrawCalls: number;
  };
};
type TestHost = {
  __shadowCubeDraws: () => Draws;
  __babylonslateViewportTest: { renderingBaseline: () => Baseline };
};

/** Observe actual GPU draw entry points; preserve all real allocation/render behavior. */
async function observeCubeDraws(page: Page) {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const cubes = new WeakMap<WebGLFramebuffer, WebGLTexture>();
    const ids = new WeakMap<WebGLTexture, number>();
    const drawn = new Set<number>();
    let nextId = 0,
      count = 0;
    const attach = prototype.framebufferTexture2D;
    prototype.framebufferTexture2D = function (
      target,
      attachment,
      face,
      texture,
      level,
    ) {
      if (
        texture &&
        attachment === this.COLOR_ATTACHMENT0 &&
        face >= this.TEXTURE_CUBE_MAP_POSITIVE_X &&
        face <= this.TEXTURE_CUBE_MAP_NEGATIVE_Z
      ) {
        const framebuffer = this.getParameter(
          this.DRAW_FRAMEBUFFER_BINDING,
        ) as WebGLFramebuffer | null;
        if (framebuffer) cubes.set(framebuffer, texture);
        if (!ids.has(texture)) ids.set(texture, ++nextId);
      }
      attach.call(this, target, attachment, face, texture, level);
    };
    for (const method of [
      "drawElements",
      "drawArrays",
      "drawElementsInstanced",
      "drawArraysInstanced",
    ] as const) {
      const original = prototype[method];
      Object.defineProperty(prototype, method, {
        configurable: true,
        writable: true,
        value: function (this: WebGL2RenderingContext, ...args: number[]) {
          const target = this.getParameter(
            this.DRAW_FRAMEBUFFER_BINDING,
          ) as WebGLFramebuffer | null;
          const texture = target && cubes.get(target);
          if (texture) {
            count++;
            drawn.add(ids.get(texture)!);
          }
          return Reflect.apply(original, this, args);
        },
      });
    }
    (globalThis as unknown as TestHost).__shadowCubeDraws = () => ({
      count,
      textureIds: [...drawn],
    });
  });
}

async function state(page: Page) {
  return page.evaluate(() => {
    const host = globalThis as unknown as TestHost;
    return {
      ...host.__babylonslateViewportTest.renderingBaseline(),
      cubes: host.__shadowCubeDraws(),
    };
  });
}

async function frames(page: Page) {
  const before = (await state(page)).frameCount;
  await expect
    .poll(async () => (await state(page)).frameCount)
    .toBeGreaterThan(before + 3);
}

async function settled(page: Page) {
  await waitForSceneViewportReady(page);
  await expect
    .poll(async () => (await state(page)).render.shadowPasses)
    .toBe(6);
  await expect
    .poll(async () => (await state(page)).render.shadowDrawCalls)
    .toBe(0);
  const before = await state(page);
  expect(before.cubes.count).toBeGreaterThan(0);
  await frames(page);
  expect((await state(page)).cubes).toEqual(before.cubes);
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

test("cached local shadows match fresh maps after caster and light motion, resize and reload", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /shader|ERROR: 0:|VALIDATE_STATUS|context lost/i.test(message.text())
    )
      errors.push(message.text());
  });
  await observeCubeDraws(page);
  await openMinimalTestProject(page, await fixture());
  await openMainScene(page);

  const evidence = [];
  const verifyPose = async (pose: string) => {
    await page.getByTestId("tree-row-actor:key").click();
    await settled(page);
    const cached = await pixels(page);
    const cachedState = await state(page);
    // Empty then freshly render the map at the identical pose as the pixel
    // oracle. Keep the receiver's shader and the live allocation unchanged.
    const visibility = page.getByRole("button", {
      name: "Toggle visibility of Caster",
      exact: true,
    });
    await visibility.click();
    await settled(page);
    const unshadowed = await pixels(page);
    await visibility.click();
    await expect
      .poll(async () => (await state(page)).cubes.count)
      .toBeGreaterThan(cachedState.cubes.count);
    await settled(page);
    const fresh = await pixels(page);
    expect(cached.length).toBe(fresh.length);
    let receiverPixels = 0,
      mismatches = 0,
      shadowPixels = 0;
    for (let i = 0; i < fresh.length; i += 4) {
      // The unshadowed green surface identifies the receiver, including pixels
      // that turn completely black under the shadow in the other captures.
      if (!isReceiver(unshadowed, i)) continue;
      if (
        ![cached, fresh].every(
          (image) =>
            isReceiver(image, i) ||
            (image[i]! < 15 && image[i + 1]! < 15 && image[i + 2]! < 15),
        )
      )
        continue;
      receiverPixels++;
      if (Math.abs(cached[i + 1]! - fresh[i + 1]!) > 8) mismatches++;
      if (unshadowed[i + 1]! - fresh[i + 1]! > 20) shadowPixels++;
    }
    expect(receiverPixels).toBeGreaterThan(500);
    expect(
      shadowPixels,
      `${pose} must contain a visible cast shadow`,
    ).toBeGreaterThan(50);
    expect(
      mismatches / receiverPixels,
      `${pose} cached map must match a fresh map`,
    ).toBeLessThan(0.005);
    expect((await state(page)).cubes.textureIds).toEqual(
      cachedState.cubes.textureIds,
    );
    evidence.push({
      pose,
      receiverPixels,
      shadowPixels,
      mismatches,
      cachedState,
    });
    await page
      .getByTestId("viewport-canvas")
      .screenshot({ path: testInfo.outputPath(`${pose}.png`) });
  };
  await verifyPose("static");
  for (const [actor, position, pose] of [
    ["caster", "1.5", "caster-moved"],
    ["key", "4", "light-moved"],
  ] as const) {
    const before = (await state(page)).cubes;
    await page.getByTestId(`tree-row-actor:${actor}`).click();
    await page.getByTestId("property-actor-position-x").fill(position);
    await page.getByTestId("property-actor-position-x").press("Tab");
    await expect
      .poll(async () => (await state(page)).cubes.count)
      .toBeGreaterThan(before.count);
    expect((await state(page)).cubes.textureIds).toEqual(before.textureIds);
    await verifyPose(pose);
  }
  const oldSize = (await state(page)).render;
  await page.setViewportSize({ width: 1100, height: 820 });
  await expect
    .poll(async () => {
      const next = (await state(page)).render;
      return next.width !== oldSize.width || next.height !== oldSize.height;
    })
    .toBe(true);
  await verifyPose("resized");
  await saveAllIfEnabled(page, 30_000);
  await page.reload();
  await openTestProject(page);
  await openMainScene(page);
  await verifyPose("reloaded");
  expect(errors).toEqual([]);
  await testInfo.attach("shadow-refresh-correctness", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
});
