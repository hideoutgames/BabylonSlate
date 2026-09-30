import { expect, test, type Locator, type Page } from "@playwright/test";
import { createMeshComponent, PROJECT_FILE } from "../packages/core/src/index.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry, MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openContentBrowser, openListedTestProject, selectContentBrowserAssetsFolder } from "./open-test-project";

const PROJECT_GUID = "00000000-0000-4000-8000-000000000100";
const MATERIAL_GUID = "00000000-0000-4000-8000-000000000101";
const BASE_GUID = "00000000-0000-4000-8000-000000000102";
const PREFAB_GUID = "00000000-0000-4000-8000-000000000103";
const MATERIAL_PATH = "assets/ThumbnailRed.material.babasset";
const PREFAB_PATH = "assets/ThumbnailPrefab.class.babasset";

async function thumbnailProjectFiles() {
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.guid = PROJECT_GUID;
  project.settings.render = { ...project.settings.render, gpuBackend: "webgl2" };
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const material = createDefaultMaterialDocument("ThumbnailRed");
  material.shadingModel = "unlit";
  material.preview.mesh = "cube"; // Browser thumbnails still use a sphere.
  material.nodes.find((node) => node.id === "baseColor")!.properties.value = [1, 0, 0];
  files.set(MATERIAL_PATH, await encodeAssetDocument({
    guid: MATERIAL_GUID, type: "Material", name: "ThumbnailRed", version: MATERIAL_PAYLOAD_VERSION,
    payload: material as unknown as Record<string, unknown>,
  }));

  const baseMesh = createMeshComponent("base-mesh", "box");
  baseMesh.properties.materialGuid = MATERIAL_GUID;
  baseMesh.transform = { position: [-2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const childMesh = createMeshComponent("child-mesh", "box");
  childMesh.properties.materialGuid = MATERIAL_GUID;
  childMesh.parentId = baseMesh.id;
  childMesh.transform = { position: [4, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const version = createDefaultMigrationRegistry().currentVersion("Class");
  files.set("assets/ThumbnailBase.class.babasset", await encodeAssetDocument({
    guid: BASE_GUID, type: "Class", name: "ThumbnailBase", version,
    payload: { nodes: [], edges: [], members: [], components: [baseMesh] },
  }, { parentClass: "Actor", dependencies: [MATERIAL_GUID] }));
  files.set(PREFAB_PATH, await encodeAssetDocument({
    guid: PREFAB_GUID, type: "Class", name: "ThumbnailPrefab", version,
    payload: { nodes: [], edges: [], members: [], components: [childMesh] },
  }, { parentClass: "ThumbnailBase", dependencies: [BASE_GUID, MATERIAL_GUID] }));
  return files;
}

/** Decode the real saved PNG, independently of the tile's CSS size/background. */
async function thumbnailPixels(image: Locator) {
  return image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(element, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const mask = new Uint8Array(canvas.width * canvas.height);
    let opaque = 0;
    let red = 0;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let pixel = 0; pixel < mask.length; pixel++) {
      const offset = pixel * 4;
      if (data[offset + 3]! < 128) continue;
      mask[pixel] = 1;
      opaque++;
      if (data[offset]! > 150 && data[offset + 1]! < 70 && data[offset + 2]! < 70) red++;
      const x = pixel % canvas.width;
      const y = Math.floor(pixel / canvas.width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const islands: number[] = [];
    for (let pixel = 0; pixel < mask.length; pixel++) {
      if (!mask[pixel]) continue;
      const pending = [pixel];
      mask[pixel] = 0;
      let size = 0;
      while (pending.length) {
        const next = pending.pop()!;
        size++;
        const x = next % canvas.width;
        const neighbors = [next - canvas.width, next + canvas.width,
          ...(x > 0 ? [next - 1] : []), ...(x < canvas.width - 1 ? [next + 1] : [])];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || neighbor >= mask.length || !mask[neighbor]) continue;
          mask[neighbor] = 0;
          pending.push(neighbor);
        }
      }
      if (size > 20) islands.push(size);
    }
    return {
      width: canvas.width, height: canvas.height, opaque, red, islands,
      boundsWidth: maxX - minX + 1, boundsHeight: maxY - minY + 1,
    };
  });
}

async function persistedCaptures(page: Page) {
  return page.evaluate(async ({ projectGuid, guids }) => {
    type Listable = FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
    let directory = await navigator.storage.getDirectory();
    for (const path of ["opfs:__babylonslate_derived__", "derived", projectGuid, "thumbnails"])
      directory = await directory.getDirectoryHandle(path);
    const captures: Array<{ name: string; size: number; modified: number }> = [];
    for await (const handle of (directory as Listable).values()) {
      if (handle.kind !== "file" || !guids.some((guid) => handle.name.startsWith(`${guid}.`))) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      captures.push({ name: handle.name, size: file.size, modified: file.lastModified });
    }
    return captures.sort((a, b) => a.name.localeCompare(b.name));
  }, { projectGuid: PROJECT_GUID, guids: [MATERIAL_GUID, PREFAB_GUID] });
}

async function showThumbnails(page: Page) {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-search").fill("Thumbnail");
  const material = page.locator(`[data-asset-path="${MATERIAL_PATH}"] img`);
  const prefab = page.locator(`[data-asset-path="${PREFAB_PATH}"] img`);
  await expect(material).toBeVisible({ timeout: 30_000 });
  await expect(prefab).toBeVisible({ timeout: 30_000 });
  return { material: await thumbnailPixels(material), prefab: await thumbnailPixels(prefab) };
}

test("Content Browser captures a material sphere and inherited actor geometry, then reuses saved thumbnails", async ({ page }) => {
  test.setTimeout(120_000);
  await openMinimalTestProject(page, await thumbnailProjectFiles());
  const pixels = await showThumbnails(page);
  for (const image of [pixels.material, pixels.prefab]) {
    expect([image.width, image.height]).toEqual([128, 128]);
    expect(image.red).toBeGreaterThan(100);
    expect(image.red / image.opaque).toBeGreaterThan(0.9);
    expect(image.opaque).toBeLessThan(128 * 128 * 0.8);
  }
  expect(pixels.material.islands).toHaveLength(1);
  expect(pixels.material.boundsWidth / pixels.material.boundsHeight).toBeGreaterThan(0.85);
  expect(pixels.material.boundsWidth / pixels.material.boundsHeight).toBeLessThan(1.15);
  // Two separated red boxes prove both inheritance and child offset/material binding.
  expect(pixels.prefab.islands).toHaveLength(2);
  expect(pixels.prefab.boundsWidth / pixels.prefab.boundsHeight).toBeGreaterThan(1.7);
  const persisted = await persistedCaptures(page);
  expect(persisted).toHaveLength(2);

  await page.reload();
  await expect(page.getByTestId("homepage")).toBeVisible({ timeout: 30_000 });
  await openListedTestProject(page);
  expect(await showThumbnails(page)).toEqual(pixels);
  // Unchanged write timestamps prove the reload read disk without another capture.
  expect(await persistedCaptures(page)).toEqual(persisted);
});
