/** Pixel qualification of the production coordinator; no fixture-owned renderer. */
import { Camera, Color3, Color4, Engine, FreeCamera, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { SharedOutlineOwner, beginEngineDrawCallFrame, createAppWebGpuEngine, readEngineDrawCalls, requestRenderPath } from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";

export interface SharedOutlineProofProgress {
  stage: string;
  state: "metadata" | "preparing" | "captured" | "retiring";
  data?: Record<string, unknown>;
  image?: string;
}

export async function runSharedOutlineProof(backend: "webgl2" | "webgpu",
  onProgress?: (progress: SharedOutlineProofProgress) => void | Promise<void>) {
  const canvas = document.createElement("canvas");
  const width = canvas.width = 240, height = canvas.height = 120;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true, stencil: true, disableWebGL2Support: false,
  });
  engine.setSize(width, height);
  const webGLVersion = engine instanceof Engine ? engine.webGLVersion : null;
  const effectiveBackend = engine.isWebGPU ? "webgpu" : webGLVersion === 2 ? "webgl2" : "webgl1";
  await onProgress?.({ stage: "engine-created", state: "metadata", data: {
    backend, effectiveBackend, webGLVersion, babylonVersion: Engine.Version,
    adapter: engine.getInfo(), width: canvas.width, height: canvas.height,
    viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio,
    renderScale: 1 / engine.getHardwareScalingLevel(), userAgent: navigator.userAgent,
  } });
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
    await onProgress?.({ stage: name, state: "preparing" });
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
    const captureWidth = canvas.width, captureHeight = canvas.height;
    const copy = document.createElement("canvas"); copy.width = captureWidth; copy.height = captureHeight;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, captureWidth, captureHeight).data;
    const lanes = Array.from({ length: 3 }, () => ({ red: 0, green: 0, blue: 0 }));
    const redCoverage = [0, 0, 0];
    let coveredPartialRed = 0;
    let coveredBoundaryRed = 0;
    for (let y = 0; y < captureHeight; y++) for (let x = 0; x < captureWidth; x++) {
      const offset = (y * captureWidth + x) * 4;
      const r = pixels[offset]!, g = pixels[offset + 1]!, b = pixels[offset + 2]!;
      const lane = lanes[Math.min(2, Math.floor(x / (captureWidth / 3)))]!;
      redCoverage[Math.min(2, Math.floor(x / (captureWidth / 3)))]! += Math.max(0, r - Math.max(g, b)) / 255;
      if (r > 200 && g < 40 && b < 40) {
        lane.red++;
        // Right half of the middle receiver, well inside the nearer occluder.
        if (x >= 127 / width * captureWidth && x <= 138 / width * captureWidth &&
          y >= 40 / height * captureHeight && y <= 80 / height * captureHeight) coveredPartialRed++;
        if (x >= 124 / width * captureWidth && x <= 126 / width * captureWidth &&
          y >= 48 / height * captureHeight && y <= 72 / height * captureHeight) coveredBoundaryRed++;
      }
      if (g > 200 && r < 40 && b < 40) lane.green++;
      if (b > 200 && r < 40 && g < 40) lane.blue++;
    }
    const snapshot = {
      name, image: copy.toDataURL("image/png"), lanes, redCoverage, coveredPartialRed, coveredBoundaryRed,
      drawingBuffer: { width: captureWidth, height: captureHeight },
      draws: readEngineDrawCalls(engine), tasks: renderer.taskNames(),
      outline: renderer.sharedOutlineDiagnostics(),
      // The coordinator deliberately removes its graph from scene.frameGraphs.
      // Its real ObjectRenderers are recreated on a graph rebuild, unlike that empty list.
      renderers: scene.objectRenderers.map(objectId),
      textures: engine.getLoadedTexturesCache().map(objectId).sort((a, b) => a - b),
      objectRenderers: scene.objectRenderers.length,
      reservations: managedRenderReservations(engine),
      owner: owner.diagnostics(), view: view.diagnostics(),
    };
    snapshots.push(snapshot);
    const { image, ...data } = snapshot;
    await onProgress?.({ stage: name, state: "captured", data, image });
    return snapshot;
  };
  const mount = (key: string, contribution = contributions[key]!) => {
    view.setContribution(key, contribution);
    // This is the same cleanup a component/view host owns on disposal.
    return () => view.removeContribution(key);
  };
  const retireWithoutDrawing = async () => {
    await onProgress?.({ stage: "unpresented-retirement", state: "preparing" });
    const before = managedRenderReservations(engine);
    const unpresentedScene = new Scene(engine);
    const unpresentedCamera = new FreeCamera("Unpresented Camera", new Vector3(0, 0, -4), unpresentedScene);
    unpresentedCamera.setTarget(Vector3.Zero());
    unpresentedScene.activeCamera = unpresentedCamera;
    const mesh = MeshBuilder.CreateBox("Unpresented Receiver", { size: 1 }, unpresentedScene);
    const unpresentedOwner = SharedOutlineOwner.forScene(unpresentedScene);
    const unpresentedView = unpresentedOwner.createView("unpresented-outline-view");
    const unpresentedRenderer = new SceneRenderCoordinator(unpresentedScene);
    const unpresentedDetach = unpresentedRenderer.attachSharedOutline(unpresentedView);
    let deadline: number | undefined;
    try {
      unpresentedView.setContribution("selection", {
        kind: "selection", targets: [{ key: "unpresented-actor", meshes: [mesh] }],
        color: [0, 1, 0], width: 2, throughMeshes: true,
      });
      const prepared = await unpresentedRenderer.prepare();
      const allocated = managedRenderReservations(engine);
      await onProgress?.({ stage: "unpresented-retirement", state: "retiring", data: { before, allocated, preparedPath: prepared.path } });
      unpresentedDetach();
      unpresentedView.dispose();
      await unpresentedRenderer.retire();
      const released = Promise.all([unpresentedRenderer.whenReleased(), unpresentedOwner.whenReleased()]);
      // No unpresentedRenderer.render() occurs. Existing Engine boundaries drain
      // deferred native frees without treating an unpresented scene as accepted.
      for (let frame = 0; frame < 3; frame++) {
        await waitFrame();
        engine.beginFrame(); engine.endFrame();
      }
      await Promise.race([released, new Promise<never>((_, reject) => {
        deadline = window.setTimeout(() => reject(new Error("Prepared but unpresented outline resources did not retire.")), 5_000);
      })]);
      return { preparedPath: prepared.path, before, allocated,
        after: managedRenderReservations(engine), retainedRenderers: unpresentedScene.objectRenderers.length };
    } finally {
      window.clearTimeout(deadline);
      unpresentedDetach(); unpresentedView.dispose(); unpresentedRenderer.dispose(); unpresentedScene.dispose();
    }
  };
  try {
    await capture("disabled-baseline");
    for (const key of ["global", "component", "selection"]) mount(key);
    await capture("three-disjoint-instances");
    for (let repeat = 0; repeat < 8; repeat++)
      for (const key of ["global", "component", "selection"]) mount(key);
    await capture("identical-requests");
    mount("global", { ...contributions.global!, targets, distanceFade: { start: 6, end: 10 } });
    await capture("fade-near");
    camera.position.z = -8;
    await capture("fade-middle");
    camera.position.z = -9.5;
    await capture("fade-subpixel");
    camera.position.z = -11;
    await capture("fade-far");
    camera.position.z = -5;
    await capture("fade-return");
    mount("global", { ...contributions.global!, targets, width: 0.25, distanceFade: { start: 6, end: 10 } });
    await capture("fade-quarter-pixel-near");
    camera.position.z = -9.5;
    await capture("fade-quarter-pixel-shrinking");
    camera.position.z = -11;
    mount("global");
    await capture("fade-disabled-far");
    mount("global", { ...contributions.global!, distanceFade: { start: 6, end: 10 } });
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    camera.position.z = -5;
    await capture("fade-perspective-near");
    camera.position.z = -11;
    await capture("fade-perspective-far");
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.position.z = -5;
    mount("global");
    mount("component", { ...contributions.component!, color: [1, 0, 0], width: 4 });
    await capture("live-component-color-and-width");
    mount("component");
    await capture("live-component-style-restored");
    mount("component", { ...contributions.component!, throughMeshes: true });
    await capture("all-visibility-groups");
    for (let cycle = 0; cycle < 3; cycle++) {
      engine.setSize(320, 160);
      await capture(`resize-${cycle}-larger`);
      engine.setSize(width, height);
      await capture(`resize-${cycle}-restored`);
    }
    mount("component");
    const siblingView = owner.createView("unpresented-sibling-view");
    siblingView.setContribution("selection", { ...contributions.selection!, targets: [targets[0]!] });
    await capture("sibling-view-selection-isolated");
    siblingView.dispose();
    await capture("sibling-view-disposed");

    const defaultMaterialMesh = MeshBuilder.CreateBox("No Assigned Material", { size: 0.35 }, scene);
    defaultMaterialMesh.position.set(0, 1.05, 0);
    // Null is a real ordinary-mesh authoring state; Babylon draws scene.defaultMaterial.
    defaultMaterialMesh.material = null;
    mount("default-material-selection", { ...contributions.selection!, targets: [{ key: "default-material-actor", meshes: [defaultMaterialMesh] }] });
    renderer.invalidate();
    await capture("no-assigned-material-selected");
    view.removeContribution("default-material-selection");
    defaultMaterialMesh.dispose();
    renderer.invalidate();
    await capture("no-assigned-material-removed");

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
    // The box front is z=-0.4. This nearer plane is distinguishable in depth32,
    // but a broad normalized-depth epsilon can incorrectly paint onto its face.
    const closeOccluder = MeshBuilder.CreatePlane("Close Partial Occluder", { width: 0.65, height: 1.2 }, scene);
    closeOccluder.material = material;
    closeOccluder.position.set(0.4, 0, -0.4001);
    renderer.invalidate();
    await capture("close-partial-occluder");
    closeOccluder.dispose();
    renderer.invalidate();
    await capture("close-partial-occluder-removed");

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
    const unpresentedRetirement = await retireWithoutDrawing();
    return {
      backend, effectiveBackend, webGLVersion,
      babylonVersion: Engine.Version, adapter: engine.getInfo(),
      width: canvas.width, height: canvas.height, viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio, renderScale: 1 / engine.getHardwareScalingLevel(),
      userAgent: navigator.userAgent,
      warmup: "Three production coordinator draws after ready preparation per state",
      highIdentities,
      unpresentedRetirement,
      snapshots,
    };
  } finally {
    detach();
    await renderer.retire();
    view.dispose();
    scene.dispose(); engine.dispose(); canvas.remove();
  }
}
