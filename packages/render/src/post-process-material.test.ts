import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import { MaterialLibrary } from "./material-library";
import { createMaterialPreviewScene } from "./material-preview";
import {
  attachPostProcessStack,
  normalizePostProcessStack,
  probePostProcessDeviceBuffers,
  type PostProcessStackDiagnostic,
} from "./post-process-material";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function host() {
  const engine = new NullEngine();
  const preview = createMaterialPreviewScene(engine as never);
  const library = new MaterialLibrary();
  disposers.push(() => {
    library.dispose();
    preview.dispose();
    engine.dispose();
  });
  return { preview, library };
}

function depthSamplingDocument(): MaterialDocument {
  const document = createDefaultMaterialDocument("Depth", "postProcess");
  document.nodes.push(
    {
      id: "depth",
      type: "input.sceneDepth",
      position: { x: 0, y: 0 },
      properties: {},
    },
    {
      id: "mul",
      type: "math.multiply",
      position: { x: 0, y: 0 },
      properties: {},
    },
  );
  document.edges.push({
    id: "e-uv-depth",
    sourceNodeId: "screenUv",
    sourcePinId: "uv",
    targetNodeId: "depth",
    targetPinId: "uv",
  });
  document.edges = document.edges.map((edge) =>
    edge.id === "e-scene-output"
      ? { ...edge, sourceNodeId: "mul", sourcePinId: "out" }
      : edge,
  );
  document.edges.push(
    {
      id: "e-color-mul",
      sourceNodeId: "sceneColor",
      sourcePinId: "color",
      targetNodeId: "mul",
      targetPinId: "a",
    },
    {
      id: "e-depth-mul",
      sourceNodeId: "depth",
      sourcePinId: "depth",
      targetNodeId: "mul",
      targetPinId: "b",
    },
  );
  return document;
}

function normalSamplingDocument(): MaterialDocument {
  const document = createDefaultMaterialDocument("Normals", "postProcess");
  document.nodes.push(
    {
      id: "n",
      type: "input.sceneNormal",
      position: { x: 0, y: 0 },
      properties: {},
    },
    {
      id: "len",
      type: "vector.length",
      position: { x: 0, y: 0 },
      properties: {},
    },
    {
      id: "mul",
      type: "math.multiply",
      position: { x: 0, y: 0 },
      properties: {},
    },
  );
  document.edges.push({
    id: "e-uv-normal",
    sourceNodeId: "screenUv",
    sourcePinId: "uv",
    targetNodeId: "n",
    targetPinId: "uv",
  });
  document.edges = document.edges.map((edge) =>
    edge.id === "e-scene-output"
      ? { ...edge, sourceNodeId: "mul", sourcePinId: "out" }
      : edge,
  );
  document.edges.push(
    {
      id: "e-normal-len",
      sourceNodeId: "n",
      sourcePinId: "normal",
      targetNodeId: "len",
      targetPinId: "value",
    },
    {
      id: "e-color-mul",
      sourceNodeId: "sceneColor",
      sourcePinId: "color",
      targetNodeId: "mul",
      targetPinId: "a",
    },
    {
      id: "e-len-mul",
      sourceNodeId: "len",
      sourcePinId: "out",
      targetNodeId: "mul",
      targetPinId: "b",
    },
  );
  return document;
}

describe("post-process stack", () => {
  it("sorts entries by their authored order", () => {
    const stack = normalizePostProcessStack([
      { materialGuid: "b", order: 2 },
      { materialGuid: "a", order: 1 },
    ]);
    expect(stack.map((entry) => entry.materialGuid)).toEqual(["a", "b"]);
  });

  it("defaults an entry to enabled", () => {
    expect(normalizePostProcessStack([{ materialGuid: "a" }])[0]?.enabled).toBe(
      true,
    );
  });

  it("drops entries with no material guid", () => {
    expect(normalizePostProcessStack([{ enabled: true }, null, 4])).toEqual([]);
  });

  it("skips a disabled entry", () => {
    const { preview, library } = host();
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: false, order: 0 }],
      documentFor: () => createDefaultMaterialDocument("Blur", "postProcess"),
    });
    disposers.push(() => attached.dispose());
    expect(attached.passes).toHaveLength(0);
  });

  it("reports a surface material used as a post-process pass", () => {
    const { preview, library } = host();
    const diagnostics: PostProcessStackDiagnostic[] = [];
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "surface", enabled: true, order: 0 }],
      documentFor: () => createDefaultMaterialDocument("Rock", "surface"),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    disposers.push(() => attached.dispose());
    expect(attached.passes).toHaveLength(0);
    expect(diagnostics[0]?.message).toContain("surface material");
  });

  it("reports a missing material instead of failing the frame", () => {
    const { preview, library } = host();
    const diagnostics: PostProcessStackDiagnostic[] = [];
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "gone", enabled: true, order: 0 }],
      documentFor: () => null,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    disposers.push(() => attached.dispose());
    expect(diagnostics[0]?.message).toContain("not in this project");
  });

  it("skips a pass whose material fails to compile", () => {
    const { preview, library } = host();
    const broken: MaterialDocument = createDefaultMaterialDocument(
      "Broken",
      "postProcess",
    );
    broken.nodes.push({
      id: "bogus",
      type: "math.doesNotExist",
      position: { x: 0, y: 0 },
      properties: {},
    });
    const diagnostics: PostProcessStackDiagnostic[] = [];
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => broken,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    disposers.push(() => attached.dispose());
    expect(attached.passes).toHaveLength(0);
    expect(diagnostics[0]?.message).toContain("failed to compile");
  });

  it("releases its material references when detached", () => {
    const { preview, library } = host();
    const document = createDefaultMaterialDocument("Blur", "postProcess");
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => document,
    });
    expect(library.materialFor(preview.scene, "pp")).not.toBeNull();
    attached.dispose();
    expect(library.materialFor(preview.scene, "pp")).toBeNull();
  });

  it("skips a pass that needs a buffer the device cannot provide", () => {
    const { preview, library } = host();
    const document = depthSamplingDocument();
    const diagnostics: PostProcessStackDiagnostic[] = [];
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => document,
      deviceBuffers: { sceneDepth: false, sceneNormal: false },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    disposers.push(() => attached.dispose());
    expect(attached.passes).toHaveLength(0);
    expect(diagnostics[0]?.message).toContain("Scene Depth");
    expect(diagnostics[0]?.nodeId).toBe("depth");
    expect(diagnostics[0]?.code).toBe("material.capability");
  });

  it("enables a linear depth renderer for Scene Depth and releases it on detach", () => {
    const { preview, library } = host();
    const enable = vi.spyOn(preview.scene, "enableDepthRenderer");
    const disable = vi.spyOn(preview.scene, "disableDepthRenderer");
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => depthSamplingDocument(),
      deviceBuffers: { sceneDepth: true, sceneNormal: false },
    });
    expect(enable).toHaveBeenCalled();
    expect(enable.mock.calls[0]?.[0]).toBe(preview.camera);
    expect(enable.mock.calls[0]?.[1]).toBe(false);
    expect(enable.mock.calls[0]?.[4]).toBe(false);
    attached.dispose();
    expect(disable).toHaveBeenCalledWith(preview.camera);
  });

  it("does not allocate a depth renderer for a color-only pass", () => {
    const { preview, library } = host();
    const enable = vi.spyOn(preview.scene, "enableDepthRenderer");
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => createDefaultMaterialDocument("Blur", "postProcess"),
    });
    disposers.push(() => attached.dispose());
    expect(enable).not.toHaveBeenCalled();
  });

  it("probes the scene when deviceBuffers are omitted", () => {
    const { preview } = host();
    preview.scene.enablePrePassRenderer = () => null;
    expect(probePostProcessDeviceBuffers(preview.scene, preview.camera)).toEqual({
      sceneDepth: true,
      sceneNormal: false,
    });
  });

  it("anchors a Scene Normal skip to the sampling node", () => {
    const { preview, library } = host();
    const diagnostics: PostProcessStackDiagnostic[] = [];
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => normalSamplingDocument(),
      deviceBuffers: { sceneDepth: true, sceneNormal: false },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    disposers.push(() => attached.dispose());
    expect(attached.passes).toHaveLength(0);
    expect(diagnostics[0]?.nodeId).toBe("n");
    expect(diagnostics[0]?.message).toContain("Scene Normal");
  });
});
