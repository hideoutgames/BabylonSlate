/** Qualification geometry and numeric textures, presented by the production coordinator. */
import {
  Bone, Camera, Color3, Color4, Engine, Material, Matrix, Mesh, MeshBuilder,
  MorphTarget, MorphTargetManager, PBRMaterial, Plane, RawTexture, Scene,
  Skeleton, StandardMaterial, Texture, Vector3, VertexBuffer, FreeCamera,
} from "@babylonjs/core";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { compileMaterialPlan, createAppWebGpuEngine, requestRenderPath, SharedOutlineOwner } from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import type { SharedOutlineProofProgress } from "./shared-outline-proof";

const WIDTH = 240, HEIGHT = 120;
type Pixels = Uint8ClampedArray;
const foreground = (pixels: Pixels, index: number) => Math.max(pixels[index * 4]!, pixels[index * 4 + 1]!, pixels[index * 4 + 2]!) > 12;
const outline = (pixels: Pixels, index: number) => {
  const r = pixels[index * 4]!, g = pixels[index * 4 + 1]!, b = pixels[index * 4 + 2]!;
  return r > 200 && g < 40 && b < 40 ? "red" : b > 200 && r < 40 && g < 40 ? "blue" : null;
};
function pixelSummary(pixels: Pixels) {
  let count = 0, red = 0, blue = 0, sumX = 0, sumY = 0;
  let left = WIDTH, right = -1, top = HEIGHT, bottom = -1;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const index = y * WIDTH + x;
    if (foreground(pixels, index)) {
      count++; sumX += x; sumY += y;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    const color = outline(pixels, index);
    if (color === "red") red++; else if (color === "blue") blue++;
  }
  return { count, red, blue, centroid: count ? [sumX / count, sumY / count] : null,
    bounds: count ? { left, right, top, bottom } : null };
}
/** Independent native silhouette is the oracle; no outline mask or IDs are read. */
function compareEdges(native: Pixels, outlined: Pixels, expected: (x: number) => boolean) {
  let detachedOutlinePixels = 0, boundaryPixels = 0, coveredBoundaryPixels = 0;
  const near = (x: number, y: number, predicate: (index: number) => boolean) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const sx = x + dx, sy = y + dy;
      if (sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT && predicate(sy * WIDTH + sx)) return true;
    }
    return false;
  };
  for (let y = 1; y < HEIGHT - 1; y++) for (let x = 1; x < WIDTH - 1; x++) {
    const index = y * WIDTH + x;
    if (outline(outlined, index) && !near(x, y, (other) => foreground(native, other))) detachedOutlinePixels++;
    if (expected(x) && foreground(native, index) &&
      [index - 1, index + 1, index - WIDTH, index + WIDTH].some((other) => !foreground(native, other))) {
      boundaryPixels++;
      if (near(x, y, (other) => outline(outlined, other) !== null)) coveredBoundaryPixels++;
    }
  }
  return { detachedOutlinePixels, boundaryPixels, coveredBoundaryPixels };
}

export async function runSharedOutlineGeometryProof(backend: "webgl2" | "webgpu",
  onProgress?: (progress: SharedOutlineProofProgress) => void | Promise<void>) {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  const webGLVersion = engine instanceof Engine ? engine.webGLVersion : null;
  const effectiveBackend = engine.isWebGPU ? "webgpu" : webGLVersion === 2 ? "webgl2" : "webgl1";
  const metadata = { backend, effectiveBackend, webGLVersion, babylonVersion: Engine.Version, adapter: engine.getInfo(),
    drawingBuffer: { width: canvas.width, height: canvas.height }, viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio, renderScale: 1 / engine.getHardwareScalingLevel(), userAgent: navigator.userAgent };
  await onProgress?.({ stage: "engine-created", state: "metadata", data: metadata });
  requestRenderPath(engine, { renderPath: "forward" });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("Geometry Camera", new Vector3(0, 0, -5), scene);
  camera.setTarget(Vector3.Zero()); camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -3; camera.orthoRight = 3; camera.orthoTop = 1.5; camera.orthoBottom = -1.5;
  camera.minZ = 0.1; camera.maxZ = 20; scene.activeCamera = camera;
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("geometry-proof");
  const renderer = new SceneRenderCoordinator(scene), detach = renderer.attachSharedOutline(view);
  // A second production view supplies the native reference without retiring the
  // outlined view's mask programs between live material/deformation edits.
  const referenceRenderer = new SceneRenderCoordinator(scene);
  const material = new StandardMaterial("Gray Control", scene);
  material.disableLighting = true; material.emissiveColor = new Color3(0.4, 0.4, 0.4);
  const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const captures = [];
  const cases = [];
  const capture = async (name: string, coordinator = renderer) => {
    await onProgress?.({ stage: name, state: "preparing" });
    const prepared = await coordinator.prepare();
    for (let frame = 0; frame < 3; frame++) {
      engine.beginFrame();
      try {
        const result = coordinator.render();
        if (!result.rendered || !result.readyForPresentation || result.path !== "frameGraph" || prepared.path !== result.path)
          throw new Error(`${name}: production frame not ready ${JSON.stringify({ prepared, result })}`);
      } finally { engine.endFrame(); }
      if (frame < 2) await waitFrame();
    }
    const copy = document.createElement("canvas"); copy.width = WIDTH; copy.height = HEIGHT;
    const context = copy.getContext("2d")!; context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    const data = { name, ...pixelSummary(pixels), tasks: coordinator.taskNames(), outline: coordinator.sharedOutlineDiagnostics(),
      owner: owner.diagnostics(), reservations: managedRenderReservations(engine) };
    captures.push(data);
    await onProgress?.({ stage: name, state: "captured", data, image: copy.toDataURL("image/png") });
    return { data, pixels };
  };
  type Contribution = Parameters<typeof view.setContribution>[1];
  const contribution = (meshes: Mesh[], color: [number, number, number] = [1, 0, 0]): Contribution => ({
    kind: "component", targets: [{ key: "geometry", meshes }], color, width: 2, throughMeshes: false,
  });
  const pair = async (name: string, contributions: Contribution[], expected: (x: number) => boolean = () => true) => {
    for (let index = contributions.length; index < 2; index++) view.removeContribution(`proof-${index}`);
    contributions.forEach((value, index) => view.setContribution(`proof-${index}`, value));
    const native = await capture(`${name}-native`, referenceRenderer);
    const rendered = await capture(`${name}-outlined`);
    const result = { name, native: native.data, rendered: rendered.data, ...compareEdges(native.pixels, rendered.pixels, expected) };
    cases.push(result);
    await onProgress?.({ stage: `${name}-comparison`, state: "metadata", data: result });
    return result;
  };
  const clear = () => {
    for (let index = 0; index < 2; index++) view.removeContribution(`proof-${index}`);
    for (const mesh of [...scene.meshes]) mesh.dispose();
  };
  let disposeAuthored: (() => void) | undefined;
  try {
    // Two independently dispatched submaterials in one grouped actor.
    const opaque = MeshBuilder.CreatePlane("Opaque Submesh", { size: 1 }, scene); opaque.position.x = -0.7; opaque.material = material;
    const cutout = MeshBuilder.CreatePlane("Cutout Submesh", { size: 1 }, scene); cutout.position.x = 0.7;
    const tested = new PBRMaterial("Tested Surface", scene); tested.unlit = true; tested.albedoColor = new Color3(0.4, 0.4, 0.4);
    const alpha = RawTexture.CreateRGBATexture(new Uint8Array([255,255,255,0, 255,255,255,85, 255,255,255,170, 255,255,255,255]), 4, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    alpha.hasAlpha = true; tested.albedoTexture = alpha; tested.useAlphaFromAlbedoTexture = true;
    tested.transparencyMode = Material.MATERIAL_ALPHATEST; tested.alphaCutOff = 0.5; cutout.material = tested;
    const grouped = Mesh.MergeMeshes([opaque, cutout], true, true, undefined, false, true)!;
    await pair("multi-material-cutout", [contribution([grouped])]);
    tested.alphaCutOff = 0.8;
    await pair("live-alpha-cutoff", [contribution([grouped])]);
    alpha.uOffset = 0.5;
    await pair("live-uv-transform", [contribution([grouped])]);
    alpha.uOffset = 0; tested.alphaCutOff = 0.5;
    const uv = grouped.getVerticesData(VertexBuffer.UVKind)!;
    grouped.setVerticesData(VertexBuffer.UV2Kind, uv); grouped.removeVerticesData(VertexBuffer.UVKind);
    alpha.coordinatesIndex = 0;
    await pair("uv2-only-index-zero", [contribution([grouped])]);
    alpha.coordinatesIndex = 1;
    await pair("uv2-only-index-one", [contribution([grouped])]);
    clear();

    // Strict gameplay and intentional through-mesh consumers share the world,
    // but only the latter may survive positive occluder coverage.
    const strictTarget = MeshBuilder.CreatePlane("Strict Target", { size: 0.8 }, scene);
    strictTarget.position.x = -0.9; strictTarget.material = material;
    const throughTarget = MeshBuilder.CreatePlane("Through Target", { size: 0.8 }, scene);
    throughTarget.position.x = 0.9; throughTarget.material = material;
    const wall = MeshBuilder.CreatePlane("Coverage Occluder", { width: 3.2, height: 1.4 }, scene);
    wall.position.z = -0.5;
    const wallMaterial = material.clone("Occluder Coverage"); wall.material = wallMaterial;
    const wallAlpha = RawTexture.CreateRGBATexture(new Uint8Array([255,255,255,0]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    wallAlpha.hasAlpha = true;
    wallMaterial.diffuseTexture = wallAlpha; wallMaterial.useAlphaFromDiffuseTexture = true;
    wallMaterial.transparencyMode = Material.MATERIAL_ALPHATEST;
    view.setContribution("proof-0", { ...contribution([strictTarget]), kind: "global",
      targets: [{ key: "strict-behind-wall", meshes: [strictTarget] }] });
    view.setContribution("proof-1", { ...contribution([throughTarget], [0,0,1]), throughMeshes: true,
      targets: [{ key: "through-behind-wall", meshes: [throughTarget] }] });
    await capture("cutout-occluder-open");
    wallAlpha.update(new Uint8Array([255,255,255,255]));
    await capture("cutout-occluder-closed");
    wallMaterial.diffuseTexture = null;
    wallMaterial.transparencyMode = Material.MATERIAL_ALPHABLEND;
    wallMaterial.alpha = 0;
    await capture("transparent-occluder-zero");
    wallMaterial.alpha = 0.5;
    await capture("transparent-occluder-positive");
    wallMaterial.opacityTexture = wallAlpha;
    wallAlpha.update(new Uint8Array([255,255,255,0]));
    await capture("opacity-occluder-open");
    wallAlpha.update(new Uint8Array([255,255,255,255]));
    await capture("opacity-occluder-closed");
    wallMaterial.opacityTexture = null;
    const colors = new Float32Array(wall.getTotalVertices() * 4).fill(1);
    for (let index = 3; index < colors.length; index += 4) colors[index] = 0;
    wall.setVerticesData(VertexBuffer.ColorKind, colors, true); wall.hasVertexAlpha = true;
    await capture("vertex-alpha-occluder-open");
    colors.fill(1); wall.updateVerticesData(VertexBuffer.ColorKind, colors);
    await capture("vertex-alpha-occluder-closed");
    clear();

    const clipped = MeshBuilder.CreatePlane("Clipped Surface", { size: 1.2 }, scene);
    const clipMaterial = material.clone("Clip Material"); clipped.material = clipMaterial;
    await pair("clip-unrestricted", [contribution([clipped])]);
    clipMaterial.clipPlane = new Plane(1, 0, 0, 0);
    await pair("live-material-clip-plane", [contribution([clipped])]);
    clipMaterial.clipPlane = null; clipped.scaling.set(-1.4, 0.7, 1);
    await pair("negative-nonuniform-scale", [contribution([clipped])]);
    clear();

    const thinGroups = [-1.4, 1.4].map((x, index) => {
      const mesh = MeshBuilder.CreateBox(`Thin Actor ${index}`, { size: 0.5 }, scene); mesh.material = material;
      const matrices = new Float32Array(32);
      Matrix.Translation(x, -0.45, 0).copyToArray(matrices, 0); Matrix.Translation(x, 0.45, 0).copyToArray(matrices, 16);
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, true); return mesh;
    });
    const thin = thinGroups.map((mesh, index) => ({ ...contribution([mesh], index ? [0, 0, 1] : [1, 0, 0]), targets: [{ key: `thin-${index}`, meshes: [mesh] }] }));
    await pair("two-thin-actor-groups", thin);
    // Remove one consumer while the second remains; no redraw setup can mask cross-owner cleanup.
    view.removeContribution("proof-0");
    await capture("thin-first-consumer-removed");
    thinGroups[0]!.dispose();
    await capture("thin-first-actor-disposed");
    clear();

    const source = MeshBuilder.CreateBox("LOD Source", { width: 1.2, height: 1.2, depth: 0.2 }, scene);
    source.material = material;
    await pair("before-late-lod", [contribution([source])]);
    const lod = MeshBuilder.CreateBox("Late LOD", { width: 0.4, height: 1.2, depth: 0.2 }, scene); lod.material = material;
    source.addLODLevel(1, lod);
    await pair("late-lod-selected", [contribution([source])]);
    clear();

    const morphed = MeshBuilder.CreatePlane("Morph Receiver", { size: 0.8 }, scene); morphed.material = material;
    morphed.setVerticesData(VertexBuffer.ColorKind, new Float32Array(morphed.getTotalVertices() * 4).fill(1));
    const manager = new MorphTargetManager(scene); morphed.morphTargetManager = manager;
    const target = MorphTarget.FromMesh(morphed, "Position And Color", 0);
    const positions = [...morphed.getVerticesData(VertexBuffer.PositionKind)!];
    for (let index = 0; index < positions.length; index += 3) positions[index] = positions[index]! + 0.9;
    target.setPositions(positions); target.setColors(new Float32Array(morphed.getTotalVertices() * 4).fill(0.6));
    manager.addTarget(target);
    await pair("morph-rest", [contribution([morphed])]);
    target.influence = 1;
    await pair("position-and-color-morph", [contribution([morphed])]);
    clear();

    const skinned = MeshBuilder.CreatePlane("Skinned Receiver", { size: 0.8 }, scene); skinned.material = material;
    const skeleton = new Skeleton("Geometry Rig", "geometry-rig", scene);
    const bone = new Bone("Root", skeleton, null, Matrix.Identity());
    skinned.skeleton = skeleton; skinned.numBoneInfluencers = 4;
    skinned.setVerticesData(VertexBuffer.MatricesIndicesKind, new Float32Array(skinned.getTotalVertices() * 4));
    const weights = new Float32Array(skinned.getTotalVertices() * 4);
    for (let index = 0; index < weights.length; index += 4) weights[index] = 1;
    skinned.setVerticesData(VertexBuffer.MatricesWeightsKind, weights);
    await pair("skeleton-rest", [contribution([skinned])]);
    bone.setPosition(new Vector3(-0.9, 0, 0));
    await pair("skeleton-pose", [contribution([skinned])]);
    clear();

    const doc = createDefaultMaterialDocument(); doc.shadingModel = "unlit"; doc.blendMode = "masked"; doc.alphaCutoff = 0.5;
    doc.nodes.push(
      { id: "cutout", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Cutout", value: [1] } },
      { id: "shift", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Shift", value: [0.9] } },
      { id: "offset", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push(
      { id: "cutout-output", sourceNodeId: "cutout", sourcePinId: "out", targetNodeId: "output", targetPinId: "alphaClip" },
      { id: "shift-offset", sourceNodeId: "shift", sourcePinId: "out", targetNodeId: "offset", targetPinId: "x" },
      { id: "offset-output", sourceNodeId: "offset", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "worldPositionOffset" },
    );
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "Authored Coverage" });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    disposeAuthored = () => compiled.dispose();
    const diagnostics = await compiled.ready;
    if (diagnostics.length) throw new Error(JSON.stringify(diagnostics));
    const authored = MeshBuilder.CreatePlane("Authored Material Receiver", { size: 0.8 }, scene); authored.material = compiled.material;
    await pair("authored-wpo", [contribution([authored])]);
    compiled.setParameter("Shift", { kind: "float", value: -0.8 });
    await pair("authored-wpo-parameter-edit", [contribution([authored])]);
    compiled.setParameter("Cutout", { kind: "float", value: 0 });
    await pair("authored-discard-parameter-edit", [contribution([authored])]);
    compiled.resetParameter("Cutout"); compiled.resetParameter("Shift");
    await pair("authored-parameters-reset", [contribution([authored])]);
    clear();
    await capture("all-geometry-removed");
    return { ...metadata, cases, captures, warmup: "Three production coordinator draws after prepare per captured state" };
  } finally {
    detach(); await renderer.retire(); await referenceRenderer.retire(); view.dispose(); disposeAuthored?.(); scene.dispose(); engine.dispose(); canvas.remove();
  }
}
