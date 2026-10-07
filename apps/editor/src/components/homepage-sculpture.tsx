import { useEffect, useRef, useState } from "react";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Engine } from "@babylonjs/core/Engines/engine";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Light } from "@babylonjs/core/Lights/light";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { HDRFiltering } from "@babylonjs/core/Materials/Textures/Filtering/hdrFiltering";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { CubeMapToSphericalPolynomialTools } from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF/2.0/glTFLoader";

/** Room geometry renders only into the environment probe, never the camera. */
const ROOM_LAYER = 0x10000000;
const VIEW_LAYER = 0x0fffffff;

/*
 * The sculpture is authored in right-handed glTF space. Babylon stays
 * left-handed (engineplan), and its glTF loader mirrors X, so every authored
 * position below goes through `authored` and every rotation through `applyPose`.
 */
const authored = (x: number, y: number, z: number) => new Vector3(-x, y, z);

type Euler = { x: number; y: number; z: number };

/** Applies an authored XYZ-order Euler pose, mirrored like the loaded model. */
function applyPose(node: TransformNode, pose: Euler) {
  const [x, y, z] = [pose.x, -pose.y, -pose.z];
  const [c1, c2, c3] = [Math.cos(x / 2), Math.cos(y / 2), Math.cos(z / 2)];
  const [s1, s2, s3] = [Math.sin(x / 2), Math.sin(y / 2), Math.sin(z / 2)];
  (node.rotationQuaternion ??= new Quaternion()).set(
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  );
}

const linear = (hex: string) => Color3.FromHexString(hex).toLinearSpace();

/*
 * Neutral studio lighting: a white room with a few boxes and emissive panels
 * (the layout of model-viewer's room environment), captured once into an HDR
 * cube probe. Built from engine primitives, so no image asset is shipped.
 */
function createRoomProbe(scene: Scene) {
  const probe = new ReflectionProbe("launcher-room", 128, scene, true, true, true);
  probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  /* Blocks Babylon's lazy readback of the not-yet-rendered probe; `bakeEnvironment` fills it. */
  probe.cubeTexture.sphericalPolynomial = new SphericalPolynomial();
  const at = (x: number, y: number, z: number) => authored(x, y - 3.5, z);
  const surface = new PBRMaterial("launcher-room-surface", scene);
  surface.albedoColor = Color3.White();
  surface.metallic = 0;
  surface.roughness = 1;
  const box = (
    name: string,
    position: Vector3,
    scaling: Vector3,
    material: PBRMaterial,
    rotationY = 0,
  ) => {
    const mesh = CreateBox(name, { size: 1 }, scene);
    mesh.position = position;
    mesh.scaling = scaling;
    mesh.rotation.y = -rotationY;
    mesh.material = material;
    mesh.layerMask = ROOM_LAYER;
    mesh.isPickable = false;
    probe.renderList!.push(mesh);
    return mesh;
  };
  const room = box(
    "launcher-room",
    at(-0.757, 13.219, 0.717),
    new Vector3(31.713, 28.305, 28.591),
    surface,
  );
  room.flipFaces(true);
  surface.backFaceCulling = false;
  const boxes: [number, number, number, number, number, number, number][] = [
    [-10.906, 2.009, 1.846, -0.195, 2.328, 7.905, 4.651],
    [-5.607, -0.754, -0.758, 0.994, 1.97, 1.534, 3.955],
    [6.167, 0.857, 7.803, 0.561, 3.927, 6.285, 3.687],
    [-2.017, 0.018, 6.124, 0.333, 2.002, 4.566, 2.064],
    [2.291, -0.756, -2.621, -0.286, 1.546, 1.552, 1.496],
    [-2.193, -0.369, -5.547, 0.516, 3.875, 3.487, 2.986],
  ];
  for (const [index, [x, y, z, rotationY, sx, sy, sz]] of boxes.entries())
    box(`launcher-room-box-${index}`, at(x, y, z), new Vector3(sx, sy, sz), surface, rotationY);
  const panels: [number, number, number, number, number, number, number][] = [
    [-16.116, 14.37, 8.208, 0.1, 2.428, 2.739, 50],
    [-16.109, 18.021, -8.207, 0.1, 2.425, 2.751, 50],
    [14.904, 12.198, -1.832, 0.15, 4.265, 6.331, 17],
    [-0.462, 8.89, 14.52, 4.38, 5.441, 0.088, 43],
    [3.235, 11.486, -12.541, 2.5, 2.0, 0.1, 20],
    [0, 20, 0, 1, 0.1, 1, 100],
  ];
  for (const [index, [x, y, z, sx, sy, sz, intensity]] of panels.entries()) {
    const emitter = new PBRMaterial(`launcher-room-light-${index}`, scene);
    emitter.albedoColor = Color3.Black();
    emitter.metallic = 0;
    emitter.roughness = 1;
    emitter.disableLighting = true;
    emitter.emissiveColor = Color3.White();
    emitter.emissiveIntensity = intensity;
    box(`launcher-room-light-${index}`, at(x, y, z), new Vector3(sx, sy, sz), emitter);
  }
  const lamp = new PointLight("launcher-room-lamp", at(0.418, 16.199, 0.3), scene);
  lamp.intensity = 900;
  lamp.range = 28;
  lamp.falloffType = Light.FALLOFF_GLTF;
  lamp.includeOnlyWithLayerMask = ROOM_LAYER;
  return probe;
}

/*
 * Screen-space anti-aliased lines that fade out before cells shrink below a
 * pixel, so the receding grid neither shimmers nor forms moiré while drifting.
 */
function createFloor(scene: Scene, eye: Vector3) {
  const material = new ShaderMaterial(
    "launcher-floor",
    scene,
    {
      vertexSource: /* glsl */ `
        precision highp float;
        attribute vec3 position;
        uniform mat4 world;
        uniform mat4 viewProjection;
        varying vec3 vWorld;
        void main() {
          vec4 worldPosition = world * vec4(position, 1.0);
          vWorld = worldPosition.xyz;
          gl_Position = viewProjection * worldPosition;
        }
      `,
      fragmentSource: /* glsl */ `
        #extension GL_OES_standard_derivatives : enable
        precision highp float;
        uniform float drift;
        uniform vec3 lineColor;
        uniform vec3 eye;
        varying vec3 vWorld;
        void main() {
          vec2 coord = vWorld.xz / 0.6 - vec2(0.0, drift);
          vec2 width = fwidth(coord);
          vec2 grid = abs(fract(coord - 0.5) - 0.5) / width;
          float line = 1.0 - min(min(grid.x, grid.y), 1.0);
          float detail = 1.0 - smoothstep(0.25, 0.6, max(width.x, width.y));
          float fade = 1.0 - smoothstep(8.0, 24.0, length(vWorld - eye));
          float edge = 1.0 - smoothstep(6.0, 11.0, abs(vWorld.x));
          gl_FragColor = vec4(lineColor, line * detail * fade * edge * 0.85);
        }
      `,
    },
    {
      attributes: ["position"],
      uniforms: ["world", "viewProjection", "drift", "lineColor", "eye"],
      needAlphaBlending: true,
    },
  );
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.setFloat("drift", 0);
  /* Written to the canvas unconverted, like the authored linear line colour. */
  material.setColor3("lineColor", linear("#6b6965"));
  material.setVector3("eye", eye);
  const floor = CreateGround("launcher-floor", { width: 24, height: 30 }, scene);
  floor.position.set(0, -2, -6);
  floor.material = material;
  floor.isPickable = false;
  return material;
}

/*
 * Bakes the captured room once into roughness mips and diffuse harmonics, like
 * a PMREM, so each frame samples one mip instead of filtering per pixel. Until
 * then (and on WebGL 1, which cannot prefilter) materials filter in real time.
 */
async function bakeEnvironment(
  engine: AbstractEngine,
  environment: RenderTargetTexture,
  materials: PBRMaterial[],
) {
  try {
    await new HDRFiltering(engine, {
      quality: Constants.TEXTURE_FILTERING_QUALITY_HIGH,
    }).prefilter(environment);
  } catch {
    return;
  }
  const polynomial =
    await CubeMapToSphericalPolynomialTools.ConvertCubeMapTextureToSphericalPolynomial(
      environment,
    );
  if (!polynomial) return;
  environment.sphericalPolynomial = polynomial;
  for (const material of materials) material.realTimeFiltering = false;
}

/** Resolves with `work`, or rejects once `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
}

/** Decorative launcher canvas. No engine state or editor imports. */
export default function HomepageSculpture({
  onReady,
  paused = false,
}: {
  onReady?: () => void;
  paused?: boolean;
}) {
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const motionRef = useRef<() => void>(() => {});
  useEffect(() => {
    motionRef.current();
  }, [paused]);
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const canvas = document.createElement("canvas");
    let engine: Engine;
    try {
      /* The launcher shows before any project Engine exists, so it owns a small one. */
      engine = new Engine(
        canvas,
        true,
        {
          alpha: true,
          powerPreference: "low-power",
          stencil: false,
          loseContextOnDispose: true,
        },
        false,
      );
    } catch {
      readyCallback.current?.();
      return;
    }
    /* Keep the decorative canvas inert: page scrolling and context menus pass through. */
    engine.disableContextMenu = false;
    canvas.style.touchAction = "";
    canvas.removeAttribute("touch-action");
    engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
    let disposed = false;
    let frame = 0;
    let lastFrame = 0;
    let elapsed = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scene = new Scene(engine);
    scene.detachControl();
    scene.clearColor = new Color4(0, 0, 0, 0);
    const camera = new TargetCamera("launcher-camera", authored(0, 0, 9.2), scene);
    camera.setTarget(Vector3.Zero());
    camera.fov = (32 * Math.PI) / 180;
    camera.minZ = 0.1;
    camera.maxZ = 40;
    camera.layerMask = VIEW_LAYER;
    const pivot = new TransformNode("launcher-pivot", scene);
    const pose: Euler = { x: 0, y: 0, z: 0 };
    const floorMaterial = createFloor(scene, camera.position);
    const ambient = new HemisphericLight("launcher-ambient", Vector3.Up(), scene);
    ambient.groundColor = Color3.White();
    ambient.specular = Color3.Black();
    /* Hemispheric diffuse omits the Lambert 1/π that ambient light carries. */
    ambient.intensity = 1.2 / Math.PI;
    /* Directional lights shine from their authored position towards the origin. */
    const key = new DirectionalLight("launcher-key", authored(-3, 5, 6).negate(), scene);
    key.diffuse = key.specular = linear("#fff4e8");
    key.intensity = 4;
    const rim = new DirectionalLight("launcher-rim", authored(4, -1, 2).negate(), scene);
    rim.diffuse = rim.specular = linear("#b3aca3");
    rim.intensity = 3;
    for (const light of [ambient, key, rim]) light.includeOnlyWithLayerMask = VIEW_LAYER;
    const environment = createRoomProbe(scene);
    element.appendChild(canvas);
    const renderFrame = () => {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
    };
    const target = { x: 0, y: 0 };
    const resize = () => {
      engine.resize();
      renderFrame();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || reduced.matches) return;
      const rect = element.getBoundingClientRect();
      target.x = (event.clientX - rect.left) / rect.width - 0.5;
      target.y = (event.clientY - rect.top) / rect.height - 0.5;
    };
    const leave = () => {
      target.x = 0;
      target.y = 0;
    };
    element.addEventListener("pointermove", pointer);
    element.addEventListener("pointerleave", leave);
    const draw = (time: number) => {
      if (disposed || document.hidden || pausedRef.current) return;
      frame = requestAnimationFrame(draw);
      if (time - lastFrame < 1000 / 30 - 1) return;
      elapsed += Math.min((time - lastFrame) / 1000, 0.05);
      lastFrame = time;
      pose.x += (0.13 + target.y * 0.2 - pose.x) * 0.06;
      pose.y += (-0.28 + target.x * 0.3 - pose.y) * 0.06;
      pose.z = -0.1 + Math.sin(elapsed * 0.35) * 0.035;
      applyPose(pivot, pose);
      pivot.position.y = Math.sin(elapsed * 0.7) * 0.09;
      floorMaterial.setFloat("drift", (elapsed * 0.16) % 1);
      renderFrame();
    };
    const motion = () => {
      cancelAnimationFrame(frame);
      if (!reduced.matches && !document.hidden && !pausedRef.current)
        frame = requestAnimationFrame(draw);
      else renderFrame();
    };
    motionRef.current = motion;
    document.addEventListener("visibilitychange", motion);
    reduced.addEventListener("change", motion);
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 12000);
    /* Waits for shaders in both the probe and camera passes, so a static frame is complete. */
    const whenRenderable = async () => {
      await scene.whenReadyAsync();
      while (
        !controller.signal.aborted &&
        !environment.cubeTexture.isReadyForRendering()
      )
        await new Promise((resolve) => setTimeout(resolve, 16));
    };
    void fetch(`${import.meta.env.BASE_URL}launcher/slate-object.glb`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Model unavailable");
        return response.arrayBuffer();
      })
      .then((data) =>
        LoadAssetContainerAsync(new Uint8Array(data), scene, {
          pluginExtension: ".glb",
        }),
      )
      .then(async (model) => {
        if (disposed) {
          model.dispose();
          return;
        }
        model.addAllToScene();
        for (const node of model.rootNodes) node.parent = pivot;
        const materials = model.materials.filter(
          (material) => material instanceof PBRMaterial,
        );
        for (const material of materials) {
          material.reflectionTexture = environment.cubeTexture;
          material.realTimeFiltering = true;
          material.realTimeFilteringQuality =
            Constants.TEXTURE_FILTERING_QUALITY_MEDIUM;
        }
        Object.assign(pose, { x: 0.13, y: -0.28, z: -0.1 });
        applyPose(pivot, pose);
        await untilAborted(whenRenderable(), controller.signal);
        if (disposed) return;
        renderFrame(); /* Captures the room into the probe, once. */
        await untilAborted(
          bakeEnvironment(engine, environment.cubeTexture, materials),
          controller.signal,
        );
        await untilAborted(scene.whenReadyAsync(), controller.signal);
        if (disposed) return;
        clearTimeout(deadline);
        resize();
        setReady(true);
        readyCallback.current?.();
        motion();
      })
      .catch(() => {
        clearTimeout(deadline);
        if (!disposed) readyCallback.current?.();
        /* Release the loading cover even when the model is unavailable. */
      });
    return () => {
      disposed = true;
      motionRef.current = () => {};
      controller.abort();
      clearTimeout(deadline);
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", motion);
      reduced.removeEventListener("change", motion);
      element.removeEventListener("pointermove", pointer);
      element.removeEventListener("pointerleave", leave);
      engine.dispose();
      canvas.remove();
    };
  }, []);
  return (
    <div
      ref={host}
      className="homepage-sculpture"
      data-ready={ready}
      aria-hidden="true"
    />
  );
}
