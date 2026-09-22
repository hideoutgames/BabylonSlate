import { expect, test, type Locator } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { PROJECT_FILE } from "../packages/core/src/project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";
import { addMaterialPaletteNode, compileMaterialPreview } from "./material-graph";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import type { EngineSceneDiagnostics } from "../apps/editor/src/testing/webgpu-previews-proof";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type NoiseKind = "perlin" | "voronoi" | "worley";

function noiseMaterial(kind: NoiseKind) {
  const doc = createDefaultMaterialDocument(`Noise ${kind}`);
  doc.shadingModel = "unlit";
  doc.preview.mesh = "sphere";
  const node = (id: string, type: string, properties = {}) => {
    doc.nodes.push({ id, type, position: { x: 0, y: 0 }, properties });
  };
  const wire = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) => {
    doc.edges.push({ id: `${sourceNodeId}-${sourcePinId}-${targetNodeId}-${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
  };
  doc.nodes = doc.nodes.filter((entry) => entry.id === "output");
  doc.nodes[0]!.properties["default:baseColor"] = [0, 0, 0];
  doc.edges = [];
  node("noise", `noise.${kind}`);
  node("channels", "vector.combine");
  if (kind !== "voronoi") {
    node("position", "input.worldPosition");
    node("frequency", "math.multiply", { "default:b": [8] });
    wire("position", "position", "frequency", "a");
    wire("frequency", "out", "noise", "coordinates");
  }
  if (kind === "worley") {
    node("length", "vector.length");
    wire("noise", "out", "length", "value");
    wire("length", "out", "channels", "x");
    wire("noise", "f1", "channels", "y");
    wire("noise", "f2", "channels", "z");
  } else if (kind === "voronoi") {
    wire("noise", "out", "channels", "x");
    wire("noise", "cells", "channels", "y");
    wire("noise", "out", "channels", "z");
  } else {
    // Remap signed simplex output into the visible color range.
    node("half", "math.multiply", { "default:b": [0.5] });
    node("bias", "math.add", { "default:b": [0.5] });
    wire("noise", "out", "half", "a");
    wire("half", "out", "bias", "a");
    for (const channel of ["x", "y", "z"]) wire("bias", "out", "channels", channel);
  }
  wire("channels", "xyz", "output", "emissive");
  return doc;
}

/** Sample inside the unlit sphere: background and lighting cannot supply variation. */
async function colorRanges(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const x = Math.floor(copy.width * 0.4);
    const y = Math.floor(copy.height * 0.4);
    const data = context.getImageData(x, y, Math.floor(copy.width * 0.2), Math.floor(copy.height * 0.2)).data;
    const min = [255, 255, 255];
    const max = [0, 0, 0];
    for (let index = 0; index < data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        min[channel] = Math.min(min[channel]!, data[index + channel]!);
        max[channel] = Math.max(max[channel]!, data[index + channel]!);
      }
    }
    return max.map((value, channel) => value - min[channel]!);
  });
}

for (const backend of ["webgl2", "webgpu"] as const) {
  for (const kind of ["perlin", "voronoi", "worley"] as const) {
    test(`${kind} noise outputs render spatial variation on ${backend}`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID/i.test(message.text())) errors.push(message.text());
      });
      const files = await minimalProjectFiles();
      const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
      project.settings.render.gpuBackend = backend;
      files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
      const assetPath = `assets/Noise-${kind}.material.babasset`;
      files.set(assetPath, await encodeAssetDocument({
        guid: "00000000-0000-4000-8000-000000000010", type: "Material", name: `Noise ${kind}`,
        version: MATERIAL_PAYLOAD_VERSION, payload: noiseMaterial(kind) as unknown as Record<string, unknown>,
      }));
      await openMinimalTestProject(page, files);
      // The viewport installs diagnostics for the Engine shared by previews.
      await openMainScene(page);
      await openAssetFromBrowser(page, assetPath);
      if (kind === "perlin") await addMaterialPaletteNode(page, "+", "math.add");
      await compileMaterialPreview(page);
      await expect.poll(() => page.evaluate(async () => {
        const host = globalThis as unknown as {
          __babylonslateViewportTest?: {
            engineSceneDiagnostics: () => Promise<EngineSceneDiagnostics | null>;
          };
        };
        return host.__babylonslateViewportTest?.engineSceneDiagnostics();
      })).toMatchObject({
        backend,
        scenes: expect.arrayContaining([expect.objectContaining({ kind: "preview" })]),
      });
      const canvas = page.getByTestId("material-preview-canvas");
      await expect.poll(async () => Math.min(...await colorRanges(canvas))).toBeGreaterThan(25);
      await canvas.screenshot({ path: testInfo.outputPath(`${kind}-${backend}.png`) });
      expect(await page.getByTestId("material-preview-error").count()).toBe(0);
      expect(errors).toEqual([]);
    });
  }
}
