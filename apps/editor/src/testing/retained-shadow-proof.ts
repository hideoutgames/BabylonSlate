/**
 * Test-build-only oracle for retained shadow casters (`RetainedShadowCasters`): one scene of rigid casters under a
 * shadowed sun, spot light and point light, drawn through the Forward FrameGraph twice, once with its maps drawing the
 * casters from the shared buffer and once with Babylon drawing each. The two images must be the same pixel for pixel
 * at every stage (the settled scene; a caster moved; casters added, removed, hidden, mirrored and stretched; a caster
 * faded, which Babylon then draws; that caster back in the shared buffer), and the retained run must spend far fewer
 * draw calls on its maps.
 *
 * The scene sits kilometres from the origin, so the floating origin's offset is in every matrix a map reads.
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createPrimitiveMesh, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { sceneShadowController } from "../../../../packages/render/src/shadow-controller";
import { setRetainedShadowCasters, type RetainedShadowDiagnostics } from "../../../../packages/render/src/shadow-retained-casters";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 200;
const HEIGHT = 150;
/** Where the scene stands: far enough that a 32-bit position there is centimetres coarse. */
const PLACE = new Vector3(40_000, 0, -25_000);

type Run = {
  /** The image at each stage. */
  images: number[][];
  retained: RetainedShadowDiagnostics | null;
  /** Draw calls the maps made over the frames after the first stage settled. */
  mapDraws: number;
};

async function drawRun(engine: AbstractEngine, retain: boolean): Promise<Run> {
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    setRetainedShadowCasters(scene, retain);
    const camera = new FreeCamera("camera", PLACE.add(new Vector3(0, 5, -9)), scene);
    camera.setTarget(PLACE.add(new Vector3(0, 0.6, 0.5)));
    camera.minZ = 0.1;
    camera.maxZ = 200;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    // The sun's cascades and both local lights shadowed.
    setSceneRenderSettings(scene, {
      quality: normalizeRenderingQuality({ lighting: { localLightMode: "manual", maxLocalLights: 16 } }),
      shadows: normalizeShadowSettings({ screenShadows: "off", maxLocalLights: 2 }),
    });
    const doc = createDefaultMaterialDocument("matte");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("matte did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "matte" });
    if (!compiled.ok) throw new Error("matte did not compile");
    await compiled.ready;
    const material = compiled.material;
    // Meshes of their own (stretched, mirrored, turned and round) and instances of one of them.
    const own = (name: string, kind: string, x: number, y: number, z: number) => {
      const mesh: Mesh = createPrimitiveMesh(scene, name, kind);
      mesh.material = material;
      mesh.position.copyFrom(PLACE).addInPlaceFromFloats(x, y, z);
      return mesh;
    };
    const mover = own("mover", "box", -3, 0.5, 0);
    const copied = own("copied", "box", -1.5, 0.5, 1.5);
    const mirroredCopy = copied.createInstance("copy a");
    mirroredCopy.position.copyFrom(PLACE).addInPlaceFromFloats(3.2, 0.5, -1);
    const turnedCopy = copied.createInstance("copy b");
    turnedCopy.position.copyFrom(PLACE).addInPlaceFromFloats(0.4, 0.5, -2.6);
    turnedCopy.rotation.y = 0.6;
    const stretched = own("stretched", "box", 0, 1, 0.5);
    stretched.scaling.set(0.4, 2, 1.3);
    const mirrored = own("mirrored", "box", 1.8, 0.6, 2);
    mirrored.scaling.set(-1, 1.2, 0.7);
    const turned = own("turned", "box", -2.4, 0.8, 2.6);
    turned.rotation.set(0.5, 0.9, 0.2);
    const round = own("round", "sphere", 2.2, 0.7, -2.2);
    const ground = own("ground", "box", 0, -0.1, 0);
    ground.scaling.set(16, 0.2, 16);
    const sun = new DirectionalLight("sun", new Vector3(0.4, -0.7, 0.58).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 1, 1], intensity: 2, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });
    const spot = new SpotLight("spot", PLACE.add(new Vector3(-4, 5, -2)), new Vector3(0.5, -1, 0.4).normalize(), 1.2, 1, scene);
    applyAuthoredLightProperties(spot, { color: [1, 0.8, 0.6], intensity: 60, castShadows: true, range: 14, outerAngle: 70, innerAngle: 40 });
    const point = new PointLight("point", PLACE.add(new Vector3(3, 2.2, 1)), scene);
    applyAuthoredLightProperties(point, { color: [0.6, 0.8, 1], intensity: 40, castShadows: true, range: 9, outerAngle: 70, innerAngle: 40 });
    const controller = sceneShadowController(scene);

    const graph = new ForwardSceneFrameGraph(scene);
    let mapDraws = 0;
    const draw = async () => {
      const deadline = performance.now() + 20_000;
      for (;;) {
        await graph.prepare(camera);
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        // The controller counts a frame's map draws from zero.
        mapDraws += controller.shadowDrawCalls();
        if (rendered) return read();
        if (performance.now() > deadline) throw new Error("The view did not present");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    const settle = async () => {
      let last = await draw();
      for (let frame = 0; frame < 12; frame++) last = await draw();
      return last;
    };
    const images = [await settle()];
    mapDraws = 0;
    // A caster moves and turns.
    mover.position.addInPlaceFromFloats(1.4, 0.3, 1.1);
    mover.rotation.y = 0.7;
    images.push(await settle());
    // Casters arrive with geometry of their own (the shared buffers grow), one leaves, one hides, an instance is
    // mirrored and another stretched.
    own("late", "sphere", -3.4, 0.7, -2.4);
    const pillar = own("pillar", "cylinder", 3.4, 1, 2.6);
    pillar.scaling.set(0.6, 2, 0.6);
    round.dispose();
    stretched.isVisible = false;
    mirroredCopy.scaling.x = -1;
    turnedCopy.scaling.set(1, 2.2, 0.6);
    images.push(await settle());
    // The hidden caster shows again, and one is faded: the scheduler no longer vouches for it, so Babylon draws it.
    stretched.isVisible = true;
    turned.visibility = 0.5;
    images.push(await settle());
    // It returns to the shared buffer, and another caster moves.
    turned.visibility = 1;
    pillar.position.x -= 0.9;
    images.push(await settle());
    const retained = controller.retainedCasters();
    graph.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.beginFrame();
    engine.endFrame();
    await graph.whenReleased();
    return { images, retained, mapDraws };
  } finally {
    scene.dispose();
  }
}

export async function runRetainedShadowProof() {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(WIDTH, HEIGHT);
  try {
    const retained = await drawRun(engine, true);
    const drawnByBabylon = await drawRun(engine, false);
    // Per image: the pixels that differ and the largest channel difference; and how much of each image the shadows darken.
    const compared = retained.images.map((image, index) => {
      const other = drawnByBabylon.images[index]!;
      let differing = 0, largest = 0, dark = 0;
      for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
        let delta = 0;
        for (let channel = 0; channel < 3; channel++) delta = Math.max(delta, Math.abs(image[pixel * 4 + channel]! - other[pixel * 4 + channel]!));
        if (delta) differing += 1;
        largest = Math.max(largest, delta);
        if (image[pixel * 4]! + image[pixel * 4 + 1]! + image[pixel * 4 + 2]! < 90) dark += 1;
      }
      return { differing, largest, dark };
    });
    // Each stage changes the image: a run whose stages drew alike would compare equal too.
    const changed = retained.images.slice(1).map((image, index) => image.some((value, at) => value !== retained.images[index]![at]));
    return {
      width: WIDTH, height: HEIGHT, compared, changed,
      retained: { casters: retained.retained, mapDraws: retained.mapDraws },
      drawnByBabylon: { casters: drawnByBabylon.retained, mapDraws: drawnByBabylon.mapDraws },
    };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
