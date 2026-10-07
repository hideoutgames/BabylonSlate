/** Numeric geometry oracle for the production post-WPO lattice path. */
import {
  Bone, Camera, Color3, Color4, Engine, FreeCamera, HemisphericLight, Matrix,
  Mesh, MeshBuilder, MorphTarget, MorphTargetManager, RawTexture, Scene, Skeleton,
  StandardMaterial, Texture, Vector3, VertexBuffer, type AbstractMesh,
} from "@babylonjs/core";
import { Lattice } from "@babylonjs/core/Meshes/lattice";
import { LatticePluginMaterial } from "@babylonjs/core/Meshes/lattice.material";
import {
  compileMaterialPlan, createAppWebGpuEngine, disposeMeshLatticeDeformer,
  requestRenderPath, setMeshLatticeDeformer, SharedOutlineOwner, SceneDeformerHost,
} from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";
import { deformerBindings } from "@babylonslate/core";

const WIDTH = 256, HEIGHT = 160;
type Pixels = Uint8ClampedArray;
// Isolate the unadapted stock plugin from the production native adapter's UBO.
class StockLatticeReferenceMaterial extends StandardMaterial {
  override getClassName(): string { return "StockLatticeReferenceMaterial"; }
}
const occupied = (pixels: Pixels, index: number) => Math.max(pixels[index * 4]!, pixels[index * 4 + 1]!, pixels[index * 4 + 2]!) > 12;
const red = (pixels: Pixels, index: number) => pixels[index * 4]! > 180 && pixels[index * 4 + 1]! < 50 && pixels[index * 4 + 2]! < 50;

function compare(actual: Pixels, reference: Pixels, outlined: Pixels) {
  let union = 0, mismatch = 0, referencePixels = 0, colorError = 0, channels = 0;
  let boundary = 0, coveredBoundary = 0, detachedOutline = 0;
  const nearby = (x: number, y: number, predicate: (index: number) => boolean) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const sx = x + dx, sy = y + dy;
      if (sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT && predicate(sy * WIDTH + sx)) return true;
    }
    return false;
  };
  for (let y = 1; y < HEIGHT - 1; y++) for (let x = 1; x < WIDTH - 1; x++) {
    const i = y * WIDTH + x;
    const a = occupied(actual, i), b = occupied(reference, i);
    if (a || b) union++;
    if (a !== b) mismatch++;
    if (b) referencePixels++;
    const neighbors = [i - 1, i + 1, i - WIDTH, i + WIDTH];
    if (a && b && neighbors.every((index) => occupied(actual, index) && occupied(reference, index))) {
      for (let c = 0; c < 3; c++) colorError += Math.abs(actual[i * 4 + c]! - reference[i * 4 + c]!);
      channels += 3;
    }
    if (a && neighbors.some((index) => !occupied(actual, index))) {
      boundary++;
      if (nearby(x, y, (index) => red(outlined, index))) coveredBoundary++;
    }
    if (red(outlined, i) && !nearby(x, y, (index) => occupied(actual, index))) detachedOutline++;
  }
  return { referencePixels, mismatchFraction: mismatch / Math.max(union, 1),
    meanColorError: colorError / Math.max(channels, 1), boundary, coveredBoundary, detachedOutline };
}

function config(strength = 1) {
  const offsets: number[] = [];
  for (const z of [-2, 2]) for (const y of [-2, 2]) for (const x of [-2, 2]) {
    void z;
    offsets.push(0.5 * x + 0.25 * y, 0, 0.2 * x);
  }
  return { enabled: true, resolution: [2, 2, 2] as [number, number, number], strength, offsets,
    fitToMesh: false, boundsMin: [-2, -2, -2] as [number, number, number], boundsMax: [2, 2, 2] as [number, number, number] };
}

/** Independent affine reference: no production lattice, interpolation or shader helper. */
function transformReference(mesh: Mesh, inputShift: number, strength: number) {
  const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!);
  const normals = Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)!);
  const scale = 1 + 0.5 * strength, shearY = 0.25 * strength, shearZ = 0.2 * strength;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]! + inputShift, y = positions[i + 1]!, z = positions[i + 2]!;
    positions[i] = scale * x + shearY * y;
    positions[i + 1] = y;
    positions[i + 2] = z + shearZ * x;
    const nx = normals[i]!, ny = normals[i + 1]!, nz = normals[i + 2]!;
    const normal = new Vector3((nx - shearZ * nz) / scale, ny - shearY * (nx - shearZ * nz) / scale, nz).normalize();
    normal.toArray(normals, i);
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals);
  mesh.refreshBoundingInfo();
}

export async function runLatticeDeformerProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  requestRenderPath(engine, { renderPath: "forward" });
  const scene = new Scene(engine); scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("Lattice Camera", new Vector3(0, 0, -8), scene);
  camera.setTarget(Vector3.Zero()); camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -3.2; camera.orthoRight = 3.2; camera.orthoTop = 2; camera.orthoBottom = -2;
  camera.minZ = 0.1; camera.maxZ = 30; scene.activeCamera = camera;
  const light = new HemisphericLight("Normal Oracle", new Vector3(0.7, 0.3, -1), scene); light.intensity = 0.85;
  const material = new StandardMaterial("Shared Surface", scene);
  material.diffuseColor = new Color3(0.6, 0.6, 0.6); material.specularColor = Color3.Black();
  const renderer = new SceneRenderCoordinator(scene);
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("lattice-proof");
  let detach = () => {};
  const meshes: AbstractMesh[] = [];
  const releases: (() => void)[] = [];
  const cases: (ReturnType<typeof compare> & { name: string; compareLighting: boolean })[] = [];
  const makeBox = (name: string, surface = material) => {
    const mesh = MeshBuilder.CreateBox(name, { width: 0.8, height: 1, depth: 0.4 }, scene);
    mesh.material = surface; meshes.push(mesh); return mesh;
  };
  const activate = (active: AbstractMesh[]) => { for (const mesh of meshes) mesh.setEnabled(active.includes(mesh)); };
  const capture = async () => {
    renderer.invalidate(); await renderer.prepare();
    const deadline = performance.now() + 15_000;
    let coherent = 0;
    while (coherent < 3) {
      engine.beginFrame();
      let ready: boolean;
      try { const frame = renderer.render(); ready = frame.rendered && frame.readyForPresentation; }
      finally { engine.endFrame(); }
      if (ready) coherent++;
      else { coherent = 0; await renderer.prepare(); }
      if (performance.now() > deadline) throw new Error("Lattice scene did not reach coherent presentation");
      if (coherent < 3) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const copy = document.createElement("canvas"); copy.width = WIDTH; copy.height = HEIGHT;
    const context = copy.getContext("2d")!; context.drawImage(canvas, 0, 0);
    return context.getImageData(0, 0, WIDTH, HEIGHT).data;
  };
  const pair = async (name: string, actual: AbstractMesh[], reference: AbstractMesh[], compareLighting = true, withOutline = true) => {
    view.removeContribution("shape"); activate(reference); const expected = await capture();
    activate(actual); const observed = await capture();
    if (withOutline) view.setContribution("shape", { kind: "component", targets: [{ key: name, meshes: actual }],
      color: [1, 0, 0], width: 2, throughMeshes: false });
    const outlined = withOutline ? await capture() : observed;
    const result = { name, compareLighting, ...compare(observed, expected, outlined) };
    // The unadapted stock plugin has neither post-WPO nor outline integration;
    // it supplies only the independently checked baseline silhouette.
    if (!withOutline) { result.boundary = 0; result.coveredBoundary = 0; }
    cases.push(result); return result;
  };
  try {
    const stockMaterial = new StockLatticeReferenceMaterial("Stock Baseline", scene);
    stockMaterial.diffuseColor.copyFrom(material.diffuseColor); stockMaterial.specularColor.copyFrom(material.specularColor);
    const stock = makeBox("Stock", stockMaterial), stockReference = makeBox("Stock Reference");
    const lattice = new Lattice({ resolutionX: 2, resolutionY: 2, resolutionZ: 2, size: new Vector3(4, 4, 4) });
    for (const plane of lattice.data) for (const row of plane) for (const p of row) p.set(1.5 * p.x + 0.25 * p.y, p.y, p.z + 0.2 * p.x);
    const plugin = new LatticePluginMaterial(lattice, stockMaterial);
    transformReference(stockReference, 0, 1);
    await pair("stock-baseline", [stock], [stockReference], false, false);
    // The stock plugin deliberately has no shared-outline adapter. Retire its
    // isolated baseline before enabling the production coverage passes.
    plugin.dispose(); stock.dispose(); stockReference.dispose(); stockMaterial.dispose();
    meshes.splice(0, 2);
    detach = renderer.attachSharedOutline(view);

    const native = makeBox("Native"), nativeReference = makeBox("Native Reference");
    const sourcePositions = Array.from(native.getVerticesData(VertexBuffer.PositionKind)!);
    setMeshLatticeDeformer(native, config()); transformReference(nativeReference, 0, 1);
    await pair("native-affine-normals", [native], [nativeReference]);

    const objectNormalMaterial = new StandardMaterial("Object Space Normal", scene);
    objectNormalMaterial.diffuseColor.copyFrom(material.diffuseColor); objectNormalMaterial.specularColor.copyFrom(material.specularColor);
    objectNormalMaterial.useObjectSpaceNormalMap = true;
    objectNormalMaterial.bumpTexture = RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 0, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    const objectNormalReferenceMaterial = new StandardMaterial("Object Normal Reference", scene);
    objectNormalReferenceMaterial.diffuseColor.copyFrom(material.diffuseColor); objectNormalReferenceMaterial.specularColor.copyFrom(material.specularColor);
    objectNormalReferenceMaterial.useObjectSpaceNormalMap = true;
    // Transform the sampled object normal independently of the shader helper.
    const nx = 1 / 255, ny = 1 / 255, nz = -1;
    const transformed = new Vector3((nx - 0.2 * nz) / 1.5, ny - 0.25 * (nx - 0.2 * nz) / 1.5, nz).normalize();
    objectNormalReferenceMaterial.bumpTexture = RawTexture.CreateRGBATexture(new Uint8Array([
      Math.round((transformed.x + 1) * 127.5), Math.round((transformed.y + 1) * 127.5), Math.round((transformed.z + 1) * 127.5), 255,
    ]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    const objectNormal = makeBox("Object Normal", objectNormalMaterial);
    const objectNormalReference = makeBox("Object Normal Reference", objectNormalReferenceMaterial);
    setMeshLatticeDeformer(objectNormal, config()); transformReference(objectNormalReference, 0, 1);
    await pair("object-space-normal-map", [objectNormal], [objectNormalReference]);

    const tangentMaterial = new StandardMaterial("Tangent Normal", scene);
    tangentMaterial.diffuseColor.copyFrom(material.diffuseColor); tangentMaterial.specularColor.copyFrom(material.specularColor);
    tangentMaterial.bumpTexture = RawTexture.CreateRGBATexture(new Uint8Array([166, 179, 238, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    for (const handedness of [1, -1]) {
      const plane = MeshBuilder.CreatePlane("Tangent Plane", { width: 0.8, height: 1 }, scene);
      const reference = MeshBuilder.CreatePlane("Tangent Reference", { width: 0.8, height: 1 }, scene);
      meshes.push(plane, reference); plane.material = reference.material = tangentMaterial;
      // Independent affine tangent: normalize(J * [1,0,0]) = [15,0,2]/sqrt(229).
      // Stock shading constructs the orthogonal bitangent, including mirrored UVs.
      plane.setVerticesData(VertexBuffer.TangentKind, Array.from({ length: plane.getTotalVertices() }, () => [1, 0, 0, handedness]).flat());
      reference.setVerticesData(VertexBuffer.TangentKind, Array.from({ length: reference.getTotalVertices() }, () => [15 / Math.sqrt(229), 0, 2 / Math.sqrt(229), handedness]).flat());
      transformReference(reference, 0, 1); setMeshLatticeDeformer(plane, config());
      await pair(`tangent-normal-map-${handedness === 1 ? "regular" : "mirrored"}`, [plane], [reference]);
    }
    const halfReference = makeBox("Half Strength Reference"); transformReference(halfReference, 0, 0.5);
    setMeshLatticeDeformer(native, config(0.5));
    await pair("live-strength", [native], [halfReference]);
    setMeshLatticeDeformer(native, null);
    const identity = makeBox("Identity Reference");
    await pair("disabled-restores-geometry", [native], [identity]);

    const sharedA = makeBox("Shared A"), sharedB = makeBox("Shared B");
    const sharedReferenceA = makeBox("Shared Reference A"), sharedReferenceB = makeBox("Shared Reference B");
    sharedA.position.x = sharedReferenceA.position.x = -1.2;
    sharedB.position.x = sharedReferenceB.position.x = 1.2;
    setMeshLatticeDeformer(sharedA, config(1)); setMeshLatticeDeformer(sharedB, config(0.5));
    transformReference(sharedReferenceA, 0, 1); transformReference(sharedReferenceB, 0, 0.5);
    material.freeze();
    await pair("independent-frozen-shared-material", [sharedA, sharedB], [sharedReferenceA, sharedReferenceB]);
    material.unfreeze();

    // Imported repeated glTF nodes retain regular instancing within one model
    // owner. Two model owners have distinct sources sharing the same geometry.
    const groupA = new Mesh("Model A", scene), groupB = new Mesh("Model B", scene);
    groupA.position.x = -1.3; groupB.position.x = 1.3;
    const sourceA = makeBox("Repeated Part A"); sourceA.parent = groupA; sourceA.position.y = -0.7;
    const instanceA = sourceA.createInstance("Instance A"); instanceA.parent = groupA; instanceA.position.y = 0.7;
    const sourceB = sourceA.clone("Repeated Part B", groupB, true)!;
    const instanceB = sourceB.createInstance("Instance B"); instanceB.parent = groupB; instanceB.position.y = 0.7;
    meshes.push(instanceA, sourceB, instanceB);
    setMeshLatticeDeformer(groupA, config(1)); setMeshLatticeDeformer(groupB, config(0.5));
    const instanceReferences: Mesh[] = [];
    for (const [x, strength] of [[-1.3, 1], [1.3, 0.5]] as const) for (const y of [-0.7, 0.7]) {
      const reference = makeBox("Repeated Part Reference");
      reference.bakeTransformIntoVertices(Matrix.Translation(0, y, 0));
      transformReference(reference, 0, strength); reference.position.x = x;
      instanceReferences.push(reference);
    }
    await pair("independent-model-instance-groups", [sourceA, instanceA, sourceB, instanceB], instanceReferences);
    disposeMeshLatticeDeformer(groupA); disposeMeshLatticeDeformer(groupB);

    const host = new SceneDeformerHost(scene); releases.push(() => host.dispose());
    let componentTarget = makeBox("Target Component");
    const siblingComponent = makeBox("Sibling Component");
    componentTarget.position.x = -1.2; siblingComponent.position.x = 1.2;
    const componentReference = makeBox("Target Component Reference"), siblingReference = makeBox("Sibling Component Reference");
    componentReference.position.x = -1.2; siblingReference.position.x = 1.2;
    transformReference(componentReference, 0, 1);
    const bindings = deformerBindings("owner", [
      { id: "target", classId: "MeshComponent", properties: {} },
      { id: "sibling", classId: "MeshComponent", properties: {} },
      { id: "cage", classId: "DeformerComponent", properties: { ...config(), targetMeshComponentId: "target" } },
    ]);
    const resolve = (id: string) => id === "target" ? componentTarget : id === "sibling" ? siblingComponent : null;
    host.setActor("owner", bindings, resolve);
    await pair("authored-component-target", [componentTarget, siblingComponent], [componentReference, siblingReference]);
    componentTarget = makeBox("Late Replacement"); componentTarget.position.x = -1.2;
    host.setActor("owner", bindings, resolve, true);
    await pair("component-late-replacement", [componentTarget, siblingComponent], [componentReference, siblingReference]);
    host.dispose();

    const document = createDefaultMaterialDocument(); document.shadingModel = "unlit"; document.boundsPadding = 1;
    document.nodes.push(
      { id: "shift", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Shift", value: [0.4] } },
      { id: "offset", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
    );
    document.edges.push(
      { id: "shift-offset", sourceNodeId: "shift", sourcePinId: "out", targetNodeId: "offset", targetPinId: "x" },
      { id: "offset-output", sourceNodeId: "offset", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "worldPositionOffset" },
    );
    const lowered = lowerMaterialDocument(document);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "WPO Then Lattice" });
    if (compiled.ok === false) throw new Error(JSON.stringify(compiled.diagnostics));
    releases.push(() => compiled.dispose());
    const errors = await compiled.ready; if (errors.length) throw new Error(JSON.stringify(errors));
    const authored = makeBox("Authored"); authored.material = compiled.material;
    const authoredReference = makeBox("Authored Reference"); transformReference(authoredReference, 0.4, 1);
    setMeshLatticeDeformer(authored, config());
    await pair("wpo-before-lattice", [authored], [authoredReference], false);
    compiled.setParameter("Shift", { kind: "float", value: -0.3 });
    const editedReference = makeBox("Edited WPO Reference"); transformReference(editedReference, -0.3, 1);
    await pair("wpo-parameter-update", [authored], [editedReference], false);
    compiled.resetParameter("Shift");

    const manager = new MorphTargetManager(scene); authored.morphTargetManager = manager;
    const morph = MorphTarget.FromMesh(authored, "Shift Morph", 1);
    const morphed = Array.from(morph.getPositions()!);
    for (let i = 0; i < morphed.length; i += 3) morphed[i] = morphed[i]! + 0.15;
    morph.setPositions(morphed); manager.addTarget(morph);
    const skeleton = new Skeleton("Translated Skeleton", "lattice-skeleton", scene);
    const bone = new Bone("Root", skeleton, null, Matrix.Identity()); authored.skeleton = skeleton;
    authored.setVerticesData(VertexBuffer.MatricesIndicesKind, new Float32Array(authored.getTotalVertices() * 4));
    const weights = new Float32Array(authored.getTotalVertices() * 4);
    for (let i = 0; i < weights.length; i += 4) weights[i] = 1;
    authored.setVerticesData(VertexBuffer.MatricesWeightsKind, weights);
    bone.setPosition(new Vector3(0.2, 0, 0));
    const animatedReference = makeBox("Animated Reference"); transformReference(animatedReference, 0.75, 1);
    await pair("morph-skin-wpo-lattice", [authored], [animatedReference], false);

    const geometryUnchanged = sourcePositions.every((value, i) => native.getVerticesData(VertexBuffer.PositionKind)![i] === value);
    for (const mesh of meshes) disposeMeshLatticeDeformer(mesh);
    return { requestedBackend: backend, effectiveBackend: engine.isWebGPU ? "webgpu" : (engine as Engine).webGLVersion === 2 ? "webgl2" : "webgl1",
      adapter: engine.getInfo(), cases, geometryUnchanged, reservationsAfterRelease: managedRenderReservations(engine) };
  } finally {
    detach(); await renderer.retire(); view.dispose();
    for (const mesh of meshes) disposeMeshLatticeDeformer(mesh);
    for (const release of releases.reverse()) release();
    scene.dispose(); engine.dispose(); canvas.remove();
  }
}
