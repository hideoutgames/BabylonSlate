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
      deviceBuffers: { sceneDepth: true, sceneNormal: false },
    });
    disposers.push(() => attached.dispose());
    expect(enable).not.toHaveBeenCalled();
  });

  it("does not leave a probe depth renderer after a color-only attach", () => {
    const { preview, library } = host();
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => createDefaultMaterialDocument("Blur", "postProcess"),
    });
    disposers.push(() => attached.dispose());
    const depthMap = (
      preview.scene as { _depthRenderer?: Record<number, unknown> }
    )._depthRenderer;
    expect(depthMap?.[preview.camera.uniqueId]).toBeUndefined();
  });

  it("probes the scene when deviceBuffers are omitted", () => {
    const { preview } = host();
    preview.scene.enablePrePassRenderer = () => null;
    const probed = probePostProcessDeviceBuffers(preview.scene, preview.camera);
    expect(probed.sceneNormal).toBe(false);
    expect(typeof probed.sceneDepth).toBe("boolean");
  });

  it("does not dispose a pre-existing pre-pass while probing", () => {
    const { preview } = host();
    const existing = { isSupported: true, dispose: vi.fn() };
    preview.scene.prePassRenderer = existing as never;
    const disable = vi.spyOn(preview.scene, "disablePrePassRenderer");
    const probed = probePostProcessDeviceBuffers(preview.scene, preview.camera);
    expect(probed.sceneNormal).toBe(true);
    expect(disable).not.toHaveBeenCalled();
    expect(preview.scene.prePassRenderer).toBe(existing);
    expect(existing.dispose).not.toHaveBeenCalled();
  });

  it("reports Scene Depth unavailable when the depth renderer cannot be created", () => {
    const { preview } = host();
    vi.spyOn(preview.scene, "enableDepthRenderer").mockImplementation(() => {
      throw new Error("No camera available to enable depth renderer");
    });
    expect(
      probePostProcessDeviceBuffers(preview.scene, preview.camera).sceneDepth,
    ).toBe(false);
  });

  it("does not allocate a depth renderer when the depth pass fails to compile", () => {
    const { preview, library } = host();
    vi.spyOn(library, "acquire").mockReturnValue({
      ok: false,
      diagnostics: [{ message: "failed to compile: boom" }],
    });
    const enable = vi.spyOn(preview.scene, "enableDepthRenderer");
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [
        { materialGuid: "color", enabled: true, order: 0 },
        { materialGuid: "depth", enabled: true, order: 1 },
      ],
      documentFor: (guid) =>
        guid === "depth"
          ? depthSamplingDocument()
          : createDefaultMaterialDocument("Blur", "postProcess"),
      deviceBuffers: { sceneDepth: true, sceneNormal: false },
    });
    disposers.push(() => attached.dispose());
    expect(attached.passes).toHaveLength(0);
    expect(enable).not.toHaveBeenCalled();
  });

  it("acquires Scene Depth only after a pass compiles", () => {
    const { preview, library } = host();
    const order: string[] = [];
    const acquire = library.acquire.bind(library);
    vi.spyOn(library, "acquire").mockImplementation((...args) => {
      order.push("acquire");
      return acquire(...args);
    });
    const enableDepth = preview.scene.enableDepthRenderer.bind(preview.scene);
    vi.spyOn(preview.scene, "enableDepthRenderer").mockImplementation(
      (...args) => {
        order.push("depth");
        return enableDepth(...args);
      },
    );
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => depthSamplingDocument(),
      deviceBuffers: { sceneDepth: true, sceneNormal: false },
    });
    disposers.push(() => attached.dispose());
    expect(attached.passes.length).toBeGreaterThan(0);
    expect(order).toEqual(["acquire", "depth"]);
  });

  it("does not disable a pre-existing pre-pass when the stack detaches", () => {
    const { preview, library } = host();
    const existing = {
      isSupported: true,
      dispose: vi.fn(),
      markAsDirty: vi.fn(),
    };
    preview.scene.prePassRenderer = existing as never;
    const disable = vi.spyOn(preview.scene, "disablePrePassRenderer");
    vi.spyOn(library, "acquire").mockReturnValue({
      ok: true,
      hash: "stub",
      material: {
        createPostProcess: () => ({ dispose: vi.fn() }),
      },
    } as never);
    const attached = attachPostProcessStack({
      scene: preview.scene,
      camera: preview.camera,
      library,
      stack: [{ materialGuid: "pp", enabled: true, order: 0 }],
      documentFor: () => normalSamplingDocument(),
      deviceBuffers: { sceneDepth: false, sceneNormal: true },
    });
    attached.dispose();
    expect(disable).not.toHaveBeenCalled();
    expect(preview.scene.prePassRenderer).toBe(existing);
    expect(existing.dispose).not.toHaveBeenCalled();
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
