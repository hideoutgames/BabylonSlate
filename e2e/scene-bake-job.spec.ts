import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  MAIN_SCENE_FILE,
  type SerializedScene,
} from "../packages/core/src/index";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/index";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  decodeAssetDocument,
  encodeAssetDocument,
} from "../packages/assets/src/asset-document";
import {
  decodeBabasset,
  encodeBabasset,
  readBabassetHeader,
} from "../packages/assets/src/babasset";
import { decodeBakedLightingAsset } from "../packages/assets/src/baked-lighting";
import { decodeBakedGeometryAsset } from "../packages/assets/src/baked-geometry";
import { collectExportClosure } from "../packages/exporter/src/closure";
import { encodeBabpack, decodeBabpack } from "../packages/exporter/src/babpack";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, openListedTestProject } from "./open-test-project";
import { closeProjectViaSettings } from "./close-project";
import { saveAllIfEnabled } from "./save-all";

test.use({
  launchOptions: {
    args: [
      process.platform === "win32"
        ? "--use-angle=d3d11-warp"
        : "--use-angle=swiftshader",
    ],
  },
});

type TestHost = {
  __babylonslateTest: {
    activeSceneContent(): SerializedScene | null;
    setActiveSceneContent(scene: SerializedScene): Promise<boolean>;
  };
};
async function currentScene(page: Page) {
  return page.evaluate(() =>
    (window as unknown as TestHost).__babylonslateTest.activeSceneContent()!,
  );
}
async function openBake(page: Page) {
  const disclosure = page.getByRole("button", {
    name: "Baked Lighting",
    exact: true,
  });
  if ((await disclosure.getAttribute("aria-expanded")) === "false")
    await disclosure.click();
  await page
    .getByRole("button", { name: "Bake Lighting", exact: true })
    .click();
  return page.getByTestId("scene-bake-dialog");
}
async function fixtureFiles() {
  const files = await minimalProjectFiles();
  const original = await decodeAssetDocument(files.get(MAIN_SCENE_FILE)!);
  const scene = createDefaultScene();
  scene.settings.bakeSettings = {
    resolution: 32,
    paddingTexels: 2,
    samples: 1,
    bounces: 2,
  };
  const mesh = createMeshComponent("receiver-component", "ground");
  mesh.properties.materialGuid = "20000000-0000-4000-8000-000000000001";
  mesh.properties.bakeParticipation = "staticReceiver";
  scene.actors = [
    createActor("receiver-actor", "Receiver", {
      transform: { ...identitySerializedTransform(), scale: [0.2, 0.2, 0.2] },
      components: [mesh],
    }),
    createActor("source-actor", "Static Point", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [
        {
          id: "source-component",
          classId: "LightComponent",
          properties: { mobility: "static", intensity: 4, castShadows: false },
        },
      ],
    }),
    ...scene.actors.filter(
      (actor) => actor.id === scene.settings.mainCameraActorId,
    ),
  ];
  const material = createDefaultMaterialDocument();
  material.twoSided = true;
  material.nodes[0]!.properties.value = [0.1, 0.3, 0.7];
  files.set(
    "assets/Diffuse.material.babasset",
    await encodeAssetDocument({
      guid: mesh.properties.materialGuid as string,
      type: "Material",
      version: createDefaultMigrationRegistry().currentVersion("Material"),
      name: "Diffuse",
      payload: material as unknown as Record<string, unknown>,
    }),
  );
  files.set(
    MAIN_SCENE_FILE,
    await encodeAssetDocument(
      { ...original, payload: scene as unknown as Record<string, unknown> },
      { dependencies: [mesh.properties.materialGuid as string] },
    ),
  );
  return files;
}

/** Copy only this small authored fixture, never a user's filesystem. */
async function readFixtureFiles(page: Page) {
  const entries = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("opfs:TestProject");
    const entries: Array<[string, number[]]> = [];
    let total = 0;
    async function walk(directory: FileSystemDirectoryHandle, prefix: string) {
      for await (const [name, entry] of (
        directory as unknown as {
          entries(): AsyncIterable<[string, FileSystemHandle]>;
        }
      ).entries()) {
        const path = `${prefix}${name}`;
        if (entry.kind === "directory")
          await walk(entry as FileSystemDirectoryHandle, `${path}/`);
        else if (
          path.endsWith(".babasset") ||
          path.startsWith("assets/.blobs/")
        ) {
          const file = await (entry as FileSystemFileHandle).getFile();
          total += file.size;
          if (total > 8 * 1024 * 1024)
            throw new Error("Unexpected fixture size.");
          entries.push([path, [...new Uint8Array(await file.arrayBuffer())]]);
        }
      }
    }
    await walk(await project.getDirectoryHandle("assets"), "assets/");
    return entries;
  });
  return new Map(entries.map(([path, data]) => [path, new Uint8Array(data)]));
}

test("Bake Lighting saves offline output, cancels and rejects stale jobs, and retains references on reopen and export", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [],
    external: string[] = [],
    phases: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      external.push(url.href);
  });
  await openMinimalTestProject(page, await fixtureFiles());
  await openMainScene(page);
  // CI software GL cannot finish a real path-traced bake inside the shard
  // budget (the first sample's shader compilation alone exceeds the cancel
  // assertion), so the real job/unwrap/dialog path runs against a deterministic
  // provider held until released or aborted. Real provider cancellation is
  // covered by bake-provider.spec.ts; numerical quality needs
  // BL_BAKE_QUALITY_E2E=1 on a GPU run.
  await page.evaluate(() => {
    const host = window as unknown as {
      __babylonslateSceneBakeAdapter?: {
        bake: (
          input: { size: number; samples: number },
          options: {
            signal?: AbortSignal;
            onProgress?: (progress: {
              phase: "sampling";
              samples: number;
              totalSamples: number;
            }) => void;
            onDisposed?: (result: {
              contextReleased: boolean;
              renderer: string | null;
              texturesBeforeDisposal: number;
              geometriesBeforeDisposal: number;
            }) => void;
          },
        ) => Promise<unknown>;
      };
      __bakeHold?: boolean;
      __bakeRelease?: () => void;
    };
    host.__bakeHold = false;
    host.__babylonslateSceneBakeAdapter = {
      bake(input, options) {
        const size = input.size;
        const irradiance = new Float32Array(size * size * 4);
        for (let index = 0; index < irradiance.length; index += 4) {
          irradiance[index] = 0.25;
          irradiance[index + 1] = 0.5;
          irradiance[index + 2] = 0.75;
          irradiance[index + 3] = 1;
        }
        const disposal = {
          contextReleased: true,
          renderer: "e2e-deterministic",
          texturesBeforeDisposal: 0,
          geometriesBeforeDisposal: 0,
        };
        const finish = () => {
          options.onDisposed?.(disposal);
          return {
            irradiance,
            size,
            samples: input.samples,
            coveredTexels: size * size,
            estimatedWorkingBytes: irradiance.byteLength,
            elapsedMs: 0,
          };
        };
        options.onProgress?.({
          phase: "sampling",
          samples: 0,
          totalSamples: input.samples,
        });
        if (options.signal?.aborted) {
          options.onDisposed?.(disposal);
          return Promise.reject(
            new DOMException("Bake cancelled", "AbortError"),
          );
        }
        if (!host.__bakeHold) return Promise.resolve(finish());
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              options.onDisposed?.(disposal);
              reject(new DOMException("Bake cancelled", "AbortError"));
            },
            { once: true },
          );
          host.__bakeRelease = () => resolve(finish());
        });
      },
    };
  });
  let dialog = await openBake(page);
  await expect(
    dialog.getByText("Current Bake Support", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Samples", { exact: true })).toHaveValue("1");
  // Hold the deterministic provider so the cancel lands while the job is in
  // its sampling phase; restarting offline below proves the job uses its
  // bundled transport/UV resources.
  await page.evaluate(() => {
    (window as unknown as { __bakeHold?: boolean }).__bakeHold = true;
  });
  await dialog
    .getByRole("button", { name: "Bake Lighting", exact: true })
    .click();
  await expect(page.getByTestId("scene-bake-phase")).toHaveText(
    "Baking Lighting",
    { timeout: 30_000 },
  );
  phases.push("first-provider");
  await dialog.getByRole("button", { name: "Cancel Bake" }).click();
  await expect(dialog.getByText(/Bake Cancelled/)).toBeVisible({
    timeout: 20_000,
  });
  expect(
    (await currentScene(page)).settings.bakedLightingAssetGuid,
  ).toBeUndefined();
  await dialog.getByLabel("Samples", { exact: true }).fill("1");
  await dialog.getByLabel("Samples", { exact: true }).press("Tab");
  await context.setOffline(true);
  await page.evaluate(() => {
    (window as unknown as { __bakeHold?: boolean }).__bakeHold = false;
  });
  await dialog
    .getByRole("button", { name: "Bake Lighting", exact: true })
    .click();
  await expect(dialog.getByRole("button", { name: "Cancel Bake" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  expect(await dialog.innerText()).toContain("Bake Saved.");
  const saved = await currentScene(page);
  const guid = saved.settings.bakedLightingAssetGuid!;
  expect(guid).toBeTruthy();
  expect(
    saved.actors.find((actor) => actor.id === "source-actor")!.components[0]!
      .properties,
  ).toMatchObject({ mobility: "static", intensity: 4, castShadows: false });
  await dialog
    .locator('[data-slot="dialog-footer"]')
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByTestId("scene-bake-validity")).toHaveText("Valid", {
    timeout: 20_000,
  });
  await saveAllIfEnabled(page, 30_000);
  // The second job sees an actual authored edit while its provider is active.
  // It must retain the prior immutable result instead of publishing stale data.
  dialog = await openBake(page);
  // Hold the provider again so the authored edit lands while the job is active.
  await page.evaluate(() => {
    (window as unknown as { __bakeHold?: boolean }).__bakeHold = true;
  });
  await dialog
    .getByRole("button", { name: "Bake Lighting", exact: true })
    .click();
  await expect(page.getByTestId("scene-bake-phase")).toHaveText(
    "Baking Lighting",
    { timeout: 30_000 },
  );
  const edited = structuredClone(saved);
  edited.actors.find(
    (actor) => actor.id === "source-actor",
  )!.components[0]!.properties.intensity = 5;
  expect(
    await page.evaluate(
      (scene) =>
        (
          window as unknown as TestHost
        ).__babylonslateTest.setActiveSceneContent(scene),
      edited,
    ),
  ).toBe(true);
  // Release the held provider so the job reaches its pre-publish staleness check.
  await page.evaluate(() => {
    const host = window as unknown as {
      __bakeHold?: boolean;
      __bakeRelease?: () => void;
    };
    host.__bakeHold = false;
    host.__bakeRelease?.();
  });
  await expect(dialog.getByText("Bake Not Saved", { exact: true })).toBeVisible(
    { timeout: 30_000 },
  );
  expect((await currentScene(page)).settings.bakedLightingAssetGuid).toBe(guid);
  await dialog
    .locator('[data-slot="dialog-footer"]')
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.getByTestId("scene-bake-validity")).toHaveText("Stale", {
    timeout: 20_000,
  });
  // Restoring the authored source can validate the existing result; no rebake.
  expect(
    await page.evaluate(
      (scene) =>
        (
          window as unknown as TestHost
        ).__babylonslateTest.setActiveSceneContent(scene),
      saved,
    ),
  ).toBe(true);
  await expect(page.getByTestId("scene-bake-validity")).toHaveText("Valid", {
    timeout: 20_000,
  });
  await saveAllIfEnabled(page, 30_000);
  await context.setOffline(false);
  await closeProjectViaSettings(page);
  await expect(page.getByTestId("homepage")).toBeVisible();
  await openListedTestProject(page);
  await openMainScene(page);
  const disclosure = page.getByRole("button", {
    name: "Baked Lighting",
    exact: true,
  });
  if ((await disclosure.getAttribute("aria-expanded")) === "false")
    await disclosure.click();
  await expect(page.getByTestId("scene-bake-validity")).toHaveText("Valid", {
    timeout: 30_000,
  });
  expect((await currentScene(page)).settings.bakedLightingAssetGuid).toBe(guid);

  const files = await readFixtureFiles(page);
  const readBlob = async (hash: string) => {
    const bytes = files.get(`assets/.blobs/${hash}`);
    if (!bytes) throw new Error(`Missing fixture blob ${hash}`);
    return bytes;
  };
  const assets = [...files]
    .filter(([path]) => path.endsWith(".babasset"))
    .map(([path, bytes]) => ({
      path,
      bytes,
      header: readBabassetHeader(bytes),
    }));
  const bake = assets.find((asset) => asset.header.guid === guid)!;
  const loaded = await decodeBakedLightingAsset(bake.bytes, readBlob);
  const atlas = loaded.atlases.values().next().value!;
  const values = new DataView(atlas.buffer, atlas.byteOffset, atlas.byteLength);
  let covered = 0,
    maximum = 0,
    colorDelta = 0;
  for (let offset = 0; offset < atlas.byteLength; offset += 16) {
    if (!values.getFloat32(offset + 12, true)) continue;
    covered++;
    const red = values.getFloat32(offset, true);
    maximum = Math.max(maximum, red);
    colorDelta = Math.max(
      colorDelta,
      Math.abs(red - values.getFloat32(offset + 4, true)),
      Math.abs(red - values.getFloat32(offset + 8, true)),
    );
  }
  expect(covered).toBeGreaterThan(100);
  expect(maximum).toBeGreaterThan(0.9);
  expect(maximum).toBeLessThanOrEqual(1.01);
  expect(colorDelta).toBeLessThan(0.001);
  const geometryGuid =
    loaded.manifest.receivers[0]!.generatedGeometry!.assetGuid;
  const closure = collectExportClosure({
    startupSceneGuid: loaded.manifest.sceneGuid,
    assets: assets.map(({ path, header }) => ({
      ...header,
      path,
      rootId: "project",
    })),
    pluginEnabledGuids: new Set(),
    parentOf: () => null,
    sceneByGuid: (id) => (id === loaded.manifest.sceneGuid ? saved : null),
    graphByGuid: () => null,
  });
  expect(closure.ok).toBe(true);
  if (!closure.ok) throw new Error(closure.error);
  expect(closure.value).toContain(guid);
  expect(closure.value).toContain(geometryGuid);
  const blobs = [];
  for (const id of closure.value) {
    const entry = assets.find((asset) => asset.header.guid === id)!;
    const decoded = await decodeBabasset(entry.bytes, readBlob);
    blobs.push({
      guid: id,
      bytes: await encodeBabasset({
        header: { ...decoded.header, mode: "bundled" },
        chunks: decoded.header.chunks.map((chunk) => ({
          ...chunk,
          data: decoded.chunks.get(chunk.id)!,
        })),
      }),
    });
  }
  const pack = decodeBabpack(await encodeBabpack(blobs));
  const packedBake = await decodeBakedLightingAsset(pack.read(guid));
  expect(packedBake.atlases.get(loaded.manifest.atlases[0]!.guid)).toEqual(
    atlas,
  );
  const geometry = await decodeBakedGeometryAsset(pack.read(geometryGuid));
  expect(geometry.manifest.receiver).toEqual(
    loaded.manifest.receivers[0]!.identity,
  );
  await testInfo.attach("scene-bake-job", {
    body: JSON.stringify({
      guid,
      geometryGuid,
      covered,
      maximum,
      colorDelta,
      exported: closure.value,
      phases,
      errors,
      external,
    }),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
