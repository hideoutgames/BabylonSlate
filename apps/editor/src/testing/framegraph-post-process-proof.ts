/** Test-build-only real backend proof. No editor renderer selection is changed. */
import {
  Engine,
  FreeCamera,
  RawTexture,
  Scene,
  Texture,
  Vector3,
  ShaderLanguage,
  ShaderStore,
} from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { MaterialLibrary, attachPostProcessStack, createAppWebGpuEngine } from "@babylonslate/render";
import { addAuthoredPostProcessTasks } from "@babylonslate/render/framegraph-post-process";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialGraphNode,
  type MaterialNumericType,
} from "@babylonslate/shader-graph";

function node(id: string, type: string, properties = {}): MaterialGraphNode {
  return { id, type, properties, position: { x: 0, y: 0 } };
}

function connect(
  doc: Pick<MaterialDocument, "edges">,
  source: string,
  pin: string,
  target: string,
  input: string,
) {
  doc.edges.push({
    id: `${source}-${pin}-${target}-${input}`,
    sourceNodeId: source,
    sourcePinId: pin,
    targetNodeId: target,
    targetPinId: input,
  });
}

function multiplyDocument(kind: "gain" | "texture" | "time" | "function") {
  const doc = createDefaultMaterialDocument(kind, "postProcess");
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-scene-output");
  doc.nodes.push(node("multiply", "math.multiply"));
  connect(doc, "sceneColor", "color", "multiply", "a");
  connect(doc, "multiply", "out", "output", "color");
  const repeatGain = (source: string, pin: string) => {
    doc.nodes.push(node("gainChannels", "vector.combine"));
    for (const channel of ["x", "y", "z", "w"]) connect(doc, source, pin, "gainChannels", channel);
    connect(doc, "gainChannels", "xyzw", "multiply", "b");
  };
  if (kind === "gain") {
    doc.nodes.push(node("gain", "param.float", { name: "Gain", value: [0.5] }));
    repeatGain("gain", "out");
  } else if (kind === "texture") {
    doc.nodes.push(node("texture", "texture.sample", { textureGuid: "mask" }));
    connect(doc, "screenUv", "uv", "texture", "uv");
    connect(doc, "texture", "rgba", "multiply", "b");
  } else if (kind === "time") {
    doc.nodes.push(
      node("time", "input.time"),
      node("offset", "const.float", { value: [0.5] }),
      node("add", "math.add"),
    );
    connect(doc, "time", "time", "add", "a");
    connect(doc, "offset", "out", "add", "b");
    repeatGain("add", "out");
  } else {
    doc.nodes.push(node("call", "function.call", { functionGuid: "outer" }));
    repeatGain("call", "out_value");
  }
  return doc;
}

function functions(): Record<string, MaterialFunctionDocument> {
  const inner = createDefaultMaterialFunctionDocument("Inner Gain");
  inner.inputs = [];
  inner.outputs = [{ id: "out_value", name: "Value", type: "float" }];
  inner.nodes.push(node("value", "const.float", { value: [0.25] }));
  inner.edges = [];
  connect(inner, "value", "out", "outputs", "out_value");
  const outer = createDefaultMaterialFunctionDocument("Outer Gain");
  outer.inputs = [];
  outer.outputs = inner.outputs;
  outer.nodes.push(node("inner", "function.call", { functionGuid: "inner" }));
  outer.edges = [];
  connect(outer, "inner", "out_value", "outputs", "out_value");
  return { inner, outer };
}

async function ready(predicate: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error("Proof effect did not become ready");
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
}

export async function runFrameGraphPostProcessProof(
  backend: "webgl2" | "webgpu" = "webgl2",
  scenario: "bindings" | "numeric" = "bindings",
) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true,
    stencil: false,
    disableWebGL2Support: false,
  });
  const shaderStore = ShaderStore.GetShadersStore(backend === "webgpu" ? ShaderLanguage.WGSL : ShaderLanguage.GLSL);
  const pixelFormat = backend === "webgpu" ? (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() : "rgba8unorm";
  const draw = (render: () => void) => {
    engine.beginFrame();
    try { render(); } finally { engine.endFrame(); }
  };
  engine.setSize(16, 16);
  const scene = new Scene(engine);
  scene.useConstantAnimationDeltaTime = true;
  scene.activeCamera = new FreeCamera(
    "Proof Camera",
    new Vector3(0, 0, -2),
    scene,
  );
  // Numeric fixture pixels only. Asymmetric quadrants also catch UV flips.
  const makeSource = (width: number, height: number) => {
    const colors = [
      [160, 80, 40, 255],
      [40, 160, 80, 255],
      [80, 40, 160, 255],
      [120, 100, 60, 255],
    ];
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        pixels.set(
          colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]!,
          (y * width + x) * 4,
        );
      }
    return RawTexture.CreateRGBATexture(
      pixels,
      width,
      height,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
  };
  let source = makeSource(16, 16);
  const mask = RawTexture.CreateRGBATexture(
    new Uint8Array([128, 255, 64, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  mask.gammaSpace = false;
  const functionDocuments = functions();
  const library = new MaterialLibrary({
    functions: () => functionDocuments,
    resolveTexture: () => mask,
  });
  const captures: Array<{
    name: string;
    legacy: number[];
    graph: number[];
    width: number;
    height: number;
    passWidth: number;
    passHeight: number;
  }> = [];
  const diagnostics: Array<{
    materialGuid?: string;
    code?: string;
    message: string;
  }> = [];
  let stack: ReturnType<typeof addAuthoredPostProcessTasks> | undefined;
  let graph: FrameGraph | undefined;
  let legacy: ReturnType<typeof attachPostProcessStack> | undefined;
  let sourceHandle = 0;
  let updateLegacy!: (disabled: number[]) => Promise<void>;
  const disabledResources: Array<{
    phase: string;
    materials: number;
    passes: number;
    shaderSources: number;
  }> = [];
  const disabledResourceSnapshot = (phase: string) =>
    disabledResources.push({
      phase,
      materials: scene.materials.filter(
        (material) => material.name === "material:proof-1",
      ).length,
      passes: engine.postProcesses.filter(
        (pass) => pass.name === "Authored Post Process 1",
      ).length,
      shaderSources: [...graphShaderKeys].filter(
        (key) =>
          key.startsWith("material:proof-1") &&
          shaderStore[key] !== undefined,
      ).length,
    });
  const graphShaderKeys = new Set<string>();
  const rememberGraphShaders = (before: Set<string>) => {
    for (const key of Object.keys(shaderStore)) {
      if (!before.has(key) && key.startsWith("material:proof-"))
        graphShaderKeys.add(key);
    }
  };
  const rebuild = async (
    documents: Array<MaterialDocument | null>,
    disabled: number[] = [],
    resolutionScale = 1,
    sharedMaterial = false,
  ) => {
    legacy?.dispose();
    legacy = undefined;
    stack?.dispose();
    graph?.dispose();
    graph = new FrameGraph(scene);
    sourceHandle = graph.textureManager.importTexture(
      "Scene Color",
      source.getInternalTexture()!,
    );
    const entries = documents.map((_, order) => ({
      id: `entry-${order}`,
      materialGuid: `proof-${sharedMaterial ? 0 : order}`,
      order,
      enabled: !disabled.includes(order),
      scalable: resolutionScale < 1,
      ...(sharedMaterial ? { parameters: { Gain: { kind: "float" as const, value: order === 0 ? 0.2 : 0.8 } } } : {}),
    }));
    const documentFor = (guid: string) =>
      documents[Number(guid.slice(6))] ?? null;
    const beforeGraphShaders = new Set(Object.keys(shaderStore));
    stack = addAuthoredPostProcessTasks({
      frameGraph: graph,
      sourceTexture: sourceHandle,
      library,
      stack: entries,
      resolutionScale,
      documentFor,
      onDiagnostic: (item) => diagnostics.push(item),
    });
    const present = new FrameGraphCopyToBackbufferColorTask("Present", graph);
    present.sourceTexture = stack.outputTexture;
    graph.addTask(present);
    await graph.buildAsync();
    rememberGraphShaders(beforeGraphShaders);
    updateLegacy = async (disabledEntries) => {
      legacy?.dispose();
      legacy = attachPostProcessStack({
        scene,
        camera: scene.activeCamera!,
        library,
        stack: entries.map((entry, index) => ({
          ...entry,
          enabled: !disabledEntries.includes(index),
        })),
        resolutionScale,
        documentFor,
        deviceBuffers: { sceneDepth: false, sceneNormal: false },
      });
      // Keep the legacy manager path available for directRender without also
      // executing it during the blank scene tick that advances Time inputs.
      for (const pass of legacy.passes)
        scene.activeCamera!.detachPostProcess(pass);
      const first = legacy.passes[0]!;
      first.externalTextureSamplerBinding = true;
      first.onApplyObservable.add((effect) =>
        effect.setTexture("textureSampler", source),
      );
      await ready(() => legacy!.passes.every((pass) => pass.isReady()));
    };
    await updateLegacy(disabled);
  };
  const readPixels = async () => {
    const view = await engine.readPixels(0, 0, canvas.width, canvas.height);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const rgba = Array.from(bytes);
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const src = (y * canvas.width + x) * 4;
        const dst = ((backend === "webgpu" ? canvas.height - 1 - y : y) * canvas.width + x) * 4;
        rgba[dst] = bytes[src + (pixelFormat.startsWith("bgra") ? 2 : 0)]!;
        rgba[dst + 1] = bytes[src + 1]!;
        rgba[dst + 2] = bytes[src + (pixelFormat.startsWith("bgra") ? 0 : 2)]!;
        rgba[dst + 3] = bytes[src + 3]!;
      }
    return rgba;
  };
  const capture = async (name: string) => {
    draw(() => {
      scene.render();
      scene.postProcessManager.directRender(legacy!.passes, null, true);
    });
    const legacyPixels = await readPixels();
    draw(() => graph!.execute());
    const graphPixels = await readPixels();
    const passSize = graph!.textureManager.getTextureDescription(
      stack!.outputTexture,
    ).size;
    captures.push({
      name,
      legacy: legacyPixels,
      graph: graphPixels,
      width: canvas.width,
      height: canvas.height,
      passWidth: passSize.width,
      passHeight: passSize.height,
    });
  };
  try {
    if (scenario === "numeric") {
      const types: MaterialNumericType[] = ["float", "vec2", "vec3", "vec4"];
      const values = { float: [32 / 255], vec2: [32 / 255, 96 / 255], vec3: [32 / 255, 96 / 255, 160 / 255], vec4: [32 / 255, 96 / 255, 160 / 255, 0] };
      for (const target of types) {
        const fn = createDefaultMaterialFunctionDocument(target);
        fn.inputs[0] = { ...fn.inputs[0]!, type: target, defaultValue: values[target] };
        fn.outputs[0]!.type = target;
        functionDocuments[`numeric-${target}`] = fn;
      }
      for (const from of types) for (const to of types) {
        const doc = createDefaultMaterialDocument("Numeric Conversion", "postProcess");
        doc.nodes.push(node("numeric", `const.${from}`, { value: values[from] }), node("boundary", "function.call", { functionGuid: `numeric-${to}` }));
        doc.edges = [];
        connect(doc, "numeric", "out", "boundary", "in_value");
        connect(doc, "boundary", "out_value", "output", "color");
        await rebuild([doc]);
        await capture(`${from}-${to}`);
      }
      for (const from of types) {
        const doc = createDefaultMaterialDocument("Padded Mask", "postProcess");
        doc.nodes.push(node("numeric", `const.${from}`, { value: values[from] }), node("mask", "vector.mask", { r: false, b: true, a: true }));
        doc.edges = [];
        connect(doc, "numeric", "out", "mask", "value");
        connect(doc, "mask", "out", "output", "color");
        await rebuild([doc]);
        await capture(`mask-${from}`);
      }
      for (const order of ["a", "b"]) {
        const doc = createDefaultMaterialDocument("Mixed Add", "postProcess");
        doc.nodes.push(node("pair", "const.vec2", { value: values.vec2 }), node("triple", "const.vec3", { value: [16 / 255, 8 / 255, 64 / 255] }), node("add", "math.add"));
        doc.edges = [];
        connect(doc, "pair", "out", "add", order);
        connect(doc, "triple", "out", "add", order === "a" ? "b" : "a");
        connect(doc, "add", "out", "output", "color");
        await rebuild([doc]);
        await capture(`mixed-${order}`);
      }
      const mathCases: Array<{ name: string; type: string; inputs: Record<string, number[]> }> = [
        { name: "step", type: "math.step", inputs: { edge: [0.5, 0.5], value: [0.75] } },
        { name: "atan2", type: "math.atan2", inputs: { y: [0.5], x: [0.5, 0.5] } },
        { name: "smoothstep", type: "math.smoothstep", inputs: { edgeA: [0.25], edgeB: [1, 1, 1], value: [0.625, 0.5, 1] } },
        { name: "remap", type: "math.remap", inputs: { value: [0.5, 0.25, 0.75], fromMin: [0.25], fromMax: [1, 1, 1], toMin: [0], toMax: [1, 1, 1] } },
        { name: "reflect-vec4", type: "vector.reflect", inputs: { incident: [0.2, 0.3, 0.4, -0.5], normal: [0, 0, 0, 1] } },
        { name: "reflect-vec2", type: "vector.reflect", inputs: { incident: [0.25, -0.5], normal: [0, 1] } },
        { name: "reflect-float", type: "vector.reflect", inputs: { incident: [-0.25], normal: [1] } },
        { name: "dot-float", type: "vector.dot", inputs: { a: [0.5], b: [0.5] } },
        { name: "distance-float", type: "vector.distance", inputs: { a: [0.25], b: [0.75] } },
        { name: "length-float", type: "vector.length", inputs: { value: [-0.5] } },
        { name: "normalize-float", type: "vector.normalize", inputs: { value: [0.5] } },
      ];
      for (const example of mathCases) {
        const doc = createDefaultMaterialDocument(example.name, "postProcess");
        doc.nodes.push(node("operation", example.type));
        doc.edges = [];
        for (const [pin, value] of Object.entries(example.inputs)) {
          doc.nodes.push(node(pin, `const.${types[value.length - 1]}`, { value }));
          connect(doc, pin, "out", "operation", pin);
        }
        connect(doc, "operation", "out", "output", "color");
        await rebuild([doc]);
        await capture(example.name);
      }
      const live = createDefaultMaterialDocument("Live Numeric", "postProcess");
      live.nodes.push(node("value", "param.float", { name: "Value", value: [0.25] }), node("split", "vector.split"));
      live.edges = [];
      connect(live, "value", "out", "output", "color");
      await rebuild([live]);
      await capture("live-before");
      if (!stack!.tasks[0]!.setParameter("Value", { kind: "float", value: 0.75 }) ||
        !legacy!.setParameter("entry-0", "Value", { kind: "float", value: 0.75 })) throw new Error("Converted parameter was not live");
      await capture("live-after");
      live.edges = [];
      connect(live, "value", "out", "split", "value");
      connect(live, "split", "w", "output", "color");
      await rebuild([live]);
      await capture("split-missing-w");
    } else {
    const gain = multiplyDocument("gain");
    await rebuild([gain]);
    await capture("color");
    if (
      !stack!.tasks[0]!.setParameter("Gain", { kind: "float", value: 0.75 }) ||
      !legacy!.setParameter("entry-0", "Gain", {
        kind: "float",
        value: 0.75,
      })
    )
      throw new Error("Gain parameter was not bound");
    await capture("parameter");
    const revised = structuredClone(gain);
    revised.name = "Hot Gain";
    const beforeReplacement = new Set(Object.keys(shaderStore));
    await stack!.tasks[0]!.replaceDocument(revised);
    await graph!.whenReadyAsync();
    rememberGraphShaders(beforeReplacement);
    await capture("hot-rebuild");
    await rebuild([multiplyDocument("texture")]);
    await capture("texture");
    mask.update(new Uint8Array([255, 128, 64, 255]));
    await capture("texture-updated");
    await rebuild([multiplyDocument("time")]);
    await capture("time-first");
    await capture("time-next");
    await rebuild([multiplyDocument("function")]);
    await capture("nested-function");
    await rebuild([
      gain,
      multiplyDocument("texture"),
      multiplyDocument("function"),
    ]);
    await capture("ordered-stack");
    engine.postProcesses
      .find((pass) => pass.name === "Authored Post Process 1")!
      .onApplyObservable.add(() => {
        throw new Error("Proof binding failure");
      });
    legacy!.passes.splice(1, 1)[0]!.dispose();
    await capture("binding-failed-middle");
    await rebuild(
      [gain, multiplyDocument("texture"), multiplyDocument("function")],
      [1],
    );
    await capture("disabled-middle");
    const sourceDocument = createDefaultMaterialDocument(
      "Source",
      "postProcess",
    );
    await rebuild([sourceDocument, gain, multiplyDocument("function")], [1]);
    disabledResourceSnapshot("initial");
    await capture("initial-disabled-gain");
    if (!stack!.tasks[1]!.setParameter("Gain", { kind: "float", value: 0.75 }))
      throw new Error("Disabled gain override was not retained");
    const enableMiddle = async () => {
      const before = new Set(Object.keys(shaderStore));
      stack!.tasks[1]!.disabled = false;
      if (stack!.tasks[1]!.isReady())
        throw new Error(
          "Enabled pass reported readiness before acquisition completed",
        );
      await stack!.tasks[1]!.initAsync();
      await graph!.whenReadyAsync();
      rememberGraphShaders(before);
      await updateLegacy([]);
      if (
        !legacy!.setParameter("entry-1", "Gain", {
          kind: "float",
          value: 0.75,
        })
      )
        throw new Error("Legacy gain override was not bound");
    };
    await enableMiddle();
    await capture("enabled-gain");
    stack!.tasks[1]!.disabled = true;
    await updateLegacy([1]);
    disabledResourceSnapshot("disabled-again");
    await capture("disabled-gain-again");
    await enableMiddle();
    await capture("re-enabled-gain");
    await rebuild([sourceDocument, null], [1]);
    disabledResourceSnapshot("missing");
    await capture("disabled-missing");
    await rebuild([gain, null, multiplyDocument("function")]);
    await capture("failed-middle");
    engine.setSize(24, 12);
    const oldSource = source;
    source = makeSource(24, 12);
    graph!.textureManager.importTexture(
      "Scene Color",
      source.getInternalTexture()!,
      sourceHandle,
    );
    await graph!.buildAsync();
    oldSource.dispose();
    await capture("resized");
    await rebuild([gain], [], 0.5);
    await capture("half-resolution");
    await rebuild([gain, gain], [], 1, true);
    await capture("duplicate-entry-authored");
    for (const [index, value] of [0.25, 0.75].entries()) {
      const parameter = { kind: "float" as const, value };
      if (!stack!.tasks[index]!.setParameter("Gain", parameter) ||
        !legacy!.setParameter(`entry-${index}`, "Gain", parameter))
        throw new Error("Duplicate pass parameter was not independently bound");
    }
    await capture("duplicate-entry-parameters");
    if (!stack!.tasks[0]!.resetParameter("Gain") || !legacy!.resetParameter("entry-0", "Gain"))
      throw new Error("First entry reset failed");
    await capture("duplicate-entry-reset-first");
    if (!stack!.tasks[1]!.resetParameter("Gain") || !legacy!.resetParameter("entry-1", "Gain"))
      throw new Error("Second entry reset failed");
    await capture("duplicate-entry-reset-both");
    await rebuild([gain]);
    if (!stack!.tasks[0]!.setParameter("Gain", { kind: "float", value: 0.1 }) ||
      !legacy!.setParameter("entry-0", "Gain", { kind: "float", value: 0.1 }) ||
      !stack!.tasks[0]!.resetParameter("Gain") || !legacy!.resetParameter("entry-0", "Gain"))
      throw new Error("Compiled default reset failed");
    await capture("compiled-default-reset");
    }
    stack!.dispose();
    legacy!.dispose();
    graph!.dispose();
    const retainedPasses = engine.postProcesses.length;
    const retainedMaterials = scene.materials.filter(
      (material) => material.getClassName() === "NodeMaterial",
    ).length;
    return {
      captures,
      disabledResources,
      diagnostics,
      retainedPasses,
      retainedMaterials,
      ownedShaderSources: graphShaderKeys.size,
      retainedShaderSources: [...graphShaderKeys].filter(
        (key) => shaderStore[key] !== undefined,
      ).length,
      backend,
      pixelFormat,
      webGLVersion: engine instanceof Engine ? engine.webGLVersion : null,
      info: engine instanceof Engine ? engine.getGlInfo() : engine.getInfo(),
    };
  } finally {
    stack?.dispose();
    legacy?.dispose();
    graph?.dispose();
    library.dispose();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
