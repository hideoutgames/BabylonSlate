import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBlock, NodeMaterial, NullEngine } from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  lowerMaterialDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
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

function host(functions: Record<string, MaterialFunctionDocument> = {}) {
  const engine = new NullEngine();
  const preview = createMaterialPreviewScene(engine as never);
  const library = new MaterialLibrary({ functions: () => functions });
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

function nestedSamplingDocument(buffer: "sceneDepth" | "sceneNormal") {
  const source =
    buffer === "sceneDepth"
      ? depthSamplingDocument()
      : normalSamplingDocument();
  const inner = createDefaultMaterialFunctionDocument("Sample Buffer");
  inner.inputs = [];
  inner.outputs = [{ id: "out_value", name: "Color", type: "vec4" }];
  inner.nodes.push(...source.nodes.filter((node) => node.id !== "output"));
  inner.edges = source.edges.map((edge) =>
    edge.targetNodeId === "output"
      ? { ...edge, targetNodeId: "outputs", targetPinId: "out_value" }
      : edge,
  );
  const outer = createDefaultMaterialFunctionDocument("Nested Buffer");
  outer.inputs = [];
  outer.outputs = inner.outputs;
  outer.nodes.push({
    id: "nested",
    type: "function.call",
    position: { x: 0, y: 0 },
    properties: { functionGuid: "inner" },
  });
  outer.edges = [
    {
      id: "e-nested-output",
      sourceNodeId: "nested",
      sourcePinId: "out_value",
      targetNodeId: "outputs",
      targetPinId: "out_value",
    },
  ];
  const document = createDefaultMaterialDocument(
    "Function Buffer",
    "postProcess",
  );
  document.nodes.push({
    id: "call",
    type: "function.call",
    position: { x: 0, y: 0 },
    properties: { functionGuid: "outer" },
  });
  document.edges = document.edges.map((edge) =>
    edge.id === "e-scene-output"
      ? { ...edge, sourceNodeId: "call", sourcePinId: "out_value" }
      : edge,
  );
  return { document, functions: { inner, outer } };
}

describe("post-process stack", () => {
  it("sorts entries by their authored order", () => {
    const stack = normalizePostProcessStack([
      { id: "second", materialGuid: "b", order: 2, scalable: true },
      { id: "first", materialGuid: "a", order: 1 },
    ]);
    expect(stack.map((entry) => entry.materialGuid)).toEqual(["a", "b"]);
    expect(stack.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(stack[1]!.scalable).toBe(true);
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
    expect(preview.scene.materials.filter((material) => material.name === "material:pp")).toHaveLength(1);
    attached.dispose();
    expect(preview.scene.materials.filter((material) => material.name === "material:pp")).toHaveLength(0);
  });

  it("isolates duplicate pass parameters by entry ID and releases only its own instances", () => {
    const { preview, library } = host();
    const document = createDefaultMaterialDocument("Gain", "postProcess");
    document.nodes.push(
      { id: "gain", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Gain", value: [0.5] } },
      { id: "multiply", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} },
    );
    document.edges = [
      ...document.edges.filter((edge) => edge.id !== "e-scene-output"),
      { id: "color", sourceNodeId: "sceneColor", sourcePinId: "color", targetNodeId: "multiply", targetPinId: "a" },
      { id: "gain", sourceNodeId: "gain", sourcePinId: "out", targetNodeId: "multiply", targetPinId: "b" },
      { id: "output", sourceNodeId: "multiply", sourcePinId: "out", targetNodeId: "output", targetPinId: "color" },
    ];
    const shared = library.acquire(preview.scene, "gain", document);
    if (!shared.ok) throw new Error("Invalid gain fixture");
    const attached = attachPostProcessStack({ scene: preview.scene, camera: preview.camera, library,
      stack: [{ id: "later", materialGuid: "gain", enabled: true, order: 1 },
        { id: "earlier", materialGuid: "gain", enabled: true, order: 0 }],
      documentFor: () => document, deviceBuffers: { sceneDepth: false, sceneNormal: false } });
    disposers.push(attached.dispose);
    const instances = preview.scene.materials.filter((material): material is NodeMaterial =>
      material instanceof NodeMaterial && material.name === "material:gain" && material !== shared.material);
    expect(instances).toHaveLength(2);
    const first = instances[0]!.getBlockByName("gain") as InputBlock;
    const second = instances[1]!.getBlockByName("gain") as InputBlock;
    expect(attached.setParameter("earlier", "Gain", { kind: "float", value: 0.25 })).toBe(true);
    expect(attached.setParameter("later", "Gain", { kind: "float", value: 0.75 })).toBe(true);
    expect([first.value, second.value]).toEqual([0.25, 0.75]);
    expect((shared.material.getBlockByName("gain") as InputBlock).value).toBe(0.5);
    expect(attached.setParameter("missing", "Gain", { kind: "float", value: 1 })).toBe(false);
    expect(attached.setParameter("earlier", "Gain", { kind: "float", value: NaN })).toBe(false);
    expect(first.value).toBe(0.25);
    attached.dispose();
    expect(attached.setParameter("later", "Gain", { kind: "float", value: 1 })).toBe(false);
    expect(library.materialFor(preview.scene, "gain")).toBe(shared.material);
    expect(preview.scene.materials).not.toContain(instances[0]);
    expect(preview.scene.materials).not.toContain(instances[1]);
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

  it.each([
    ["sceneDepth", "depth", "Scene Depth"],
    ["sceneNormal", "n", "Scene Normal"],
  ] as const)(
    "denies nested %s before acquisition while retaining neighboring passes",
    (buffer, node, title) => {
      const { document, functions } = nestedSamplingDocument(buffer);
      const { preview, library } = host(functions);
      const diagnostics: PostProcessStackDiagnostic[] = [];
      const enableDepth = vi.spyOn(preview.scene, "enableDepthRenderer");
      const enableNormal = vi.spyOn(preview.scene, "enablePrePassRenderer");
      const attached = attachPostProcessStack({
        scene: preview.scene,
        camera: preview.camera,
        library,
        stack: ["before", "nested", "after"].map((materialGuid, order) => ({
          materialGuid,
          order,
          enabled: true,
        })),
        documentFor: (guid) =>
          guid === "nested"
            ? document
            : createDefaultMaterialDocument(guid, "postProcess"),
        deviceBuffers: { sceneDepth: false, sceneNormal: false },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      disposers.push(() => attached.dispose());
      expect(attached.passes).toHaveLength(2);
      expect(library.materialFor(preview.scene, "nested")).toBeNull();
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "material.capability",
          materialGuid: "nested",
          nodeId: `call/nested/${node}`,
          message: expect.stringContaining(title),
        }),
      ]);
      expect(enableDepth).not.toHaveBeenCalled();
      expect(enableNormal).not.toHaveBeenCalled();
    },
  );

  it.each(["sceneDepth", "sceneNormal"] as const)(
    "leases and releases nested %s from the compiled plan",
    (buffer) => {
      const { document, functions } = nestedSamplingDocument(buffer);
      const { preview, library } = host(functions);
      // NullEngine reports no MRT support by default. Its pre-pass remains a real
      // Babylon renderer; this test exercises attachment rather than GPU drawing.
      preview.scene.getEngine().getCaps().drawBuffersExtension = true;
      const enableDepth = vi.spyOn(preview.scene, "enableDepthRenderer");
      const enableNormal = vi.spyOn(preview.scene, "enablePrePassRenderer");
      const disableDepth = vi.spyOn(preview.scene, "disableDepthRenderer");
      const disableNormal = vi.spyOn(preview.scene, "disablePrePassRenderer");
      const diagnostics: PostProcessStackDiagnostic[] = [];
      const attached = attachPostProcessStack({
        scene: preview.scene,
        camera: preview.camera,
        library,
        stack: [{ materialGuid: "nested", order: 0, enabled: true }],
        documentFor: () => document,
        deviceBuffers: { sceneDepth: true, sceneNormal: true },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      disposers.push(() => attached.dispose());
      expect(diagnostics).toEqual([]);
      expect(attached.passes).toHaveLength(1);
      expect(
        buffer === "sceneDepth" ? enableDepth : enableNormal,
      ).toHaveBeenCalled();
      expect(
        buffer === "sceneDepth" ? enableNormal : enableDepth,
      ).not.toHaveBeenCalled();
      attached.dispose();
      expect(
        buffer === "sceneDepth" ? disableDepth : disableNormal,
      ).toHaveBeenCalledTimes(1);
      expect(library.materialFor(preview.scene, "nested")).toBeNull();
    },
  );

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
      diagnostics: [
        {
          code: "material.compile",
          severity: "error",
          message: "failed to compile: boom",
        },
      ],
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
      plan: (() => {
        const lowered = lowerMaterialDocument(normalSamplingDocument());
        if (!lowered.ok)
          throw new Error("Expected a valid normal sampling plan");
        return lowered.plan;
      })(),
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
