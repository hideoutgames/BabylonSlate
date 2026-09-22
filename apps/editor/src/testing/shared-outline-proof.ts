/** Pixel qualification of the production coordinator; no fixture-owned renderer. */
import { Camera, Color3, Color4, Engine, FreeCamera, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { SharedOutlineOwner, beginEngineDrawCallFrame, createAppWebGpuEngine, readEngineDrawCalls, requestRenderPath } from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { managedLightingReservations } from "@babylonslate/render/managed-lighting-resources";

export async function runSharedOutlineProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  const width = canvas.width = 240, height = canvas.height = 120;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true, stencil: true, disableWebGL2Support: false,
  });
  engine.setSize(width, height);
  requestRenderPath(engine, { renderPath: "forward" });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("Shared Outline Camera", new Vector3(0, 0, -5), scene);
  camera.setTarget(Vector3.Zero());
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -3; camera.orthoRight = 3;
  camera.orthoTop = 1.5; camera.orthoBottom = -1.5;
  camera.minZ = 0.1; camera.maxZ = 20;
  scene.activeCamera = camera;
  const material = new StandardMaterial("Unlit Gray Receiver", scene);
  material.disableLighting = true;
  material.emissiveColor = new Color3(0.2, 0.2, 0.2);
  const source = MeshBuilder.CreateBox("Shared Source", { size: 0.8 }, scene);
  source.material = material;
  source.position.x = 100;
  const instances = [-1.5, 0, 1.5].map((x, index) => {
    const mesh = source.createInstance(`Actor ${index}`);
    mesh.position.x = x;
    return mesh;
  });
  const targets = instances.map((mesh, index) => ({ key: `actor-${index}`, meshes: [mesh] }));
  const owner = SharedOutlineOwner.forScene(scene);
  const view = owner.createView("shared-outline-proof");
  const renderer = new SceneRenderCoordinator(scene);
  const detach = renderer.attachSharedOutline(view);
  type Contribution = Parameters<typeof view.setContribution>[1];
  const contributions: Record<string, Contribution> = {
    global: { kind: "global", targets: [targets[0]!], color: [1, 0, 0], width: 2, throughMeshes: false },
    component: { kind: "component", targets: [targets[1]!], color: [0, 0, 1], width: 2, throughMeshes: false },
    selection: { kind: "selection", targets: [targets[2]!], color: [0, 1, 0], width: 2, throughMeshes: true },
  };
  const objectIds = new WeakMap<object, number>();
  let nextObjectId = 1;
  const objectId = (object: object) => {
    let id = objectIds.get(object);
    if (id === undefined) { id = nextObjectId++; objectIds.set(object, id); }
    return id;
  };
  const snapshots = [];
  const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const capture = async (name: string) => {
    const prepared = await renderer.prepare();
    for (let frame = 0; frame < 3; frame++) {
      engine.beginFrame();
      try {
        beginEngineDrawCallFrame(engine);
        const result = renderer.render();
        if (!result.rendered || !result.readyForPresentation || result.path !== "frameGraph" || prepared.path !== result.path)
          throw new Error(`${name}: unprepared production presentation ${JSON.stringify({ prepared, result })}`);
      } finally { engine.endFrame(); }
      if (frame < 2) await waitFrame();
    }
    // Presented canvas copy handles WebGPU swapchain channel/row order.
    const copy = document.createElement("canvas"); copy.width = width; copy.height = height;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    const lanes = Array.from({ length: 3 }, () => ({ red: 0, green: 0, blue: 0 }));
    let coveredPartialRed = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const r = pixels[offset]!, g = pixels[offset + 1]!, b = pixels[offset + 2]!;
      const lane = lanes[Math.min(2, Math.floor(x / 80))]!;
      if (r > 200 && g < 40 && b < 40) {
        lane.red++;
        // Right half of the middle receiver, well inside the nearer occluder.
        if (x >= 127 && x <= 138 && y >= 40 && y <= 80) coveredPartialRed++;
      }
      if (g > 200 && r < 40 && b < 40) lane.green++;
      if (b > 200 && r < 40 && g < 40) lane.blue++;
    }
    const snapshot = {
      name, image: copy.toDataURL("image/png"), lanes, coveredPartialRed,
      draws: readEngineDrawCalls(engine), tasks: renderer.taskNames(),
      outline: renderer.sharedOutlineDiagnostics(),
      graphs: scene.frameGraphs.map(objectId),
      textures: engine.getLoadedTexturesCache().map(objectId).sort((a, b) => a - b),
      objectRenderers: scene.objectRenderers.length,
      reservations: managedLightingReservations(engine),
      owner: owner.diagnostics(), view: view.diagnostics(),
    };
    snapshots.push(snapshot);
    return snapshot;
  };
  const mount = (key: string, contribution = contributions[key]!) => {
    view.setContribution(key, contribution);
    // This is the same cleanup a component/view host owns on disposal.
    return () => view.removeContribution(key);
  };
  try {
    await capture("disabled-baseline");
    for (const key of ["global", "component", "selection"]) mount(key);
    await capture("three-disjoint-instances");
    for (let repeat = 0; repeat < 8; repeat++)
      for (const key of ["global", "component", "selection"]) mount(key);
    await capture("identical-requests");
    mount("component", { ...contributions.component!, color: [1, 0, 0], width: 4 });
    await capture("live-component-color-and-width");
    mount("component");
    await capture("live-component-style-restored");
    mount("component", { ...contributions.component!, throughMeshes: true });
    await capture("all-visibility-groups");
    mount("component");
    const siblingView = owner.createView("unpresented-sibling-view");
    siblingView.setContribution("selection", { ...contributions.selection!, targets: [targets[0]!] });
    await capture("sibling-view-selection-isolated");
    siblingView.dispose();
    await capture("sibling-view-disposed");

    for (const removed of ["component", "global", "selection"]) {
      view.removeContribution(removed);
      await capture(`remove-${removed}`);
      const dispose = mount(removed);
      await capture(`restore-${removed}`);
      dispose();
      await capture(`dispose-${removed}`);
      mount(removed);
    }

    // Registration order and membership order must not repurpose mesh-owned IDs.
    for (const key of ["global", "component", "selection"]) view.removeContribution(key);
    for (const key of ["selection", "component", "global"]) mount(key);
    await capture("consumer-order-reversed");
    const allGlobal: Contribution = { ...contributions.global!, targets: [...targets] };
    mount("global", allGlobal);
    await capture("overlap-with-global");
    mount("global", { ...allGlobal, targets: [...targets].reverse() });
    await capture("membership-order-reversed");
    mount("selection", { ...contributions.selection!, targets: [targets[1]!] });
    await capture("same-instance-selection-wins");
    view.removeContribution("selection");
    await capture("same-instance-component-survives");
    view.removeContribution("component");
    await capture("same-instance-global-revealed");

    // Geometry stays fixed when comparing strict and intentional through visibility.
    const occluders = [-1.5, 0.4, 1.5].map((x, index) => {
      const mesh = MeshBuilder.CreateBox(`Occluder ${index}`, { width: index === 1 ? 0.65 : 1.2, height: 1.2, depth: 0.2 }, scene);
      mesh.material = material;
      mesh.position.set(x, 0, -1);
      return mesh;
    });
    renderer.invalidate();
    await capture("strict-full-and-partial-occlusion");
    mount("component", { ...contributions.component!, targets: [targets[2]!], throughMeshes: true });
    await capture("through-component-keeps-global-strict");
    view.removeContribution("component");
    await capture("through-component-removed");
    for (const mesh of occluders) mesh.dispose();
    renderer.invalidate();
    await capture("occluders-removed");

    // Forty-eight independent colors use the same visibility-group pass budget.
    mount("component", { ...contributions.component!, throughMeshes: true });
    mount("selection");
    await capture("style-count-baseline");
    const many = Array.from({ length: 48 }, (_, index) => {
      const mesh = source.createInstance(`Style Actor ${index}`);
      mesh.scaling.setAll(0.18);
      mesh.position.set((index % 12 - 5.5) * 0.44, Math.floor(index / 12) * 0.28 - 0.42, -0.7);
      mount(`style-${index}`, {
        kind: "component", targets: [{ key: `style-actor-${index}`, meshes: [mesh] }],
        color: [(index % 5) / 4, (index % 7) / 6, (index % 11) / 10],
        width: 1 + (index % 3), throughMeshes: false,
      });
      return mesh;
    });
    renderer.invalidate();
    await capture("forty-eight-independent-styles");
    for (let index = 0; index < many.length; index++) view.removeContribution(`style-${index}`);
    for (const mesh of many) mesh.dispose();
    for (const key of ["global", "component", "selection"]) view.removeContribution(key);

    // Populate CPU identities with empty geometry, then draw three exact IDs.
    // Different colors distinguish 2048/2049 aliasing in a half-float mask;
    // 65535 checks the high byte and the reserved zero/background distinction.
    const desiredIds = [2048, 2049, 65_535];
    const firstId = owner.diagnostics().identityCount + 1;
    const highTargets = Array.from({ length: 65_536 - firstId }, (_, index) => {
      const id = firstId + index;
      const lane = desiredIds.indexOf(id);
      return { key: `precision-${String(index).padStart(5, "0")}`, meshes: lane < 0 ? [] : [instances[lane]!] };
    });
    const highTargetFor = (id: number) => highTargets[id - firstId]!;
    mount("high-id-global", { ...contributions.global!, targets: highTargets });
    mount("component", { ...contributions.component!, targets: [highTargetFor(2049)] });
    mount("selection", { ...contributions.selection!, targets: [highTargetFor(65_535)] });
    renderer.invalidate();
    await capture("high-identity-colors");
    const highIdentities = desiredIds.map((id) => owner.identityForKey(highTargetFor(id).key));
    view.removeContribution("component");
    await capture("high-identity-component-removed");
    for (const key of ["high-id-global", "component", "selection"]) view.removeContribution(key);
    renderer.invalidate();
    await capture("all-disabled-retired");
    await capture("all-disabled-steady");
    return {
      backend, effectiveBackend: engine.isWebGPU ? "webgpu" : "webgl2",
      babylonVersion: Engine.Version, adapter: engine.getInfo(),
      width: canvas.width, height: canvas.height, viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio, renderScale: 1 / engine.getHardwareScalingLevel(),
      userAgent: navigator.userAgent,
      warmup: "Three production coordinator draws after ready preparation per state",
      highIdentities,
      snapshots,
    };
  } finally {
    detach();
    await renderer.retire();
    view.dispose();
    scene.dispose(); engine.dispose(); canvas.remove();
  }
}
