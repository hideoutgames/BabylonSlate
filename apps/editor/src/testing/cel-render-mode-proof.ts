/**
 * Test-build-only CEL hard-step pixel oracle; no production renderer is
 * selected. A fixed camera renders one sphere under a directional key light
 * plus an overlapping point light; captures return raw rows so the spec can
 * compare against the CPU reference.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  ShadowGenerator,
  Vector3,
} from "@babylonjs/core";
import {
  createAppWebGpuEngine,
  setSceneRenderSettings,
} from "@babylonslate/render";
import { normalizeCelShadingSettings } from "@babylonslate/core";

const WIDTH = 160;
const HEIGHT = 96;
const BANDS = 3;
const MIDPOINT = 0.5;
const SPECULAR_STRENGTH = 0.2;
const SPECULAR_SIZE = 0.2;

export async function runCelRenderModeProof(
  backend: "webgl2" | "webgpu" = "webgl2",
) {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine =
    backend === "webgpu"
      ? await createAppWebGpuEngine(canvas)
      : new Engine(canvas, false, {
          preserveDrawingBuffer: true,
          stencil: true,
          disableWebGL2Support: false,
        });
  const draw = (render: () => void) => {
    engine.beginFrame();
    try {
      render();
    } finally {
      engine.endFrame();
    }
  };
  const readRow = async (y: number) => {
    const pixels = await engine.readPixels(0, y, WIDTH, 1);
    if (!pixels) throw new Error("Missing rendered pixels");
    return Array.from(
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );
  };
  try {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    scene.useConstantAnimationDeltaTime = true;
    const camera = new FreeCamera("camera", new Vector3(0, 0, -5), scene);
    camera.setTarget(Vector3.Zero());
    // The key travels with the view axis so the facing hemisphere spans the
    // full ramp and the highlight lands on the sphere's centre.
    const key = new DirectionalLight("key", new Vector3(0, 0, 1), scene);
    key.intensity = 1;
    const point = new PointLight("overlap", new Vector3(0, 0, -4), scene);
    point.intensity = 0.8;
    point.range = 100;
    const surface = new PBRMaterial("surface", scene);
    surface.albedoColor = new Color3(0.2, 0.6, 0.3);
    surface.metallic = 0;
    surface.roughness = 1;
    const sphere = MeshBuilder.CreateSphere(
      "sphere",
      { diameter: 3, segments: 32 },
      scene,
    );
    sphere.material = surface;
    const receiver = MeshBuilder.CreateGround(
      "receiver",
      { width: 14, height: 14 },
      scene,
    );
    receiver.position.y = -2.5;
    receiver.receiveShadows = true;
    receiver.setEnabled(false);
    const shadows = new ShadowGenerator(1024, key);
    shadows.addShadowCaster(sphere);
    const cel = (overrides: Record<string, unknown>) =>
      setSceneRenderSettings(scene, {
        mode: "cel",
        cel: normalizeCelShadingSettings({
          shadowBands: BANDS,
          shadowThreshold: MIDPOINT,
          shadowStrength: 1,
          specularStrength: SPECULAR_STRENGTH,
          specularSize: SPECULAR_SIZE,
          specularEnabled: true,
          ...overrides,
        }),
      });
    const mixing: Record<string, { row: number[] }> = {};
    const centerRow = Math.floor(HEIGHT / 2);
    for (const lightMixing of ["strongest", "additive", "blend"] as const) {
      cel({ lightMixing });
      await scene.whenReadyAsync();
      draw(() => scene.render(false));
      mixing[lightMixing] = { row: await readRow(centerRow) };
    }
    // Cast-shadow capture: the sphere's shadow on a lit ground must step
    // between exactly two luminance levels with no filtered ramp.
    receiver.setEnabled(true);
    key.direction = new Vector3(0, -0.9, 0.8).normalize();
    key.shadowEnabled = true;
    camera.position = new Vector3(0, 1.3, -6);
    camera.setTarget(new Vector3(0, -0.8, 0));
    cel({ lightMixing: "strongest", specularEnabled: false });
    await scene.whenReadyAsync();
    draw(() => scene.render(false));
    // Find the row crossing the shadow blob: exactly two dominant luminance
    // levels (lit field, shadowed blob) covering nearly every pixel.
    let shadow: {
      row: number[];
      y: number;
      lit: number;
      dark: number;
      litLevel: number;
      darkLevel: number;
      other: number;
    } | null = null;
    for (let y = 0; y < HEIGHT; y++) {
      const row = await readRow(y);
      const counts = new Map<number, number>();
      for (let i = 1; i < row.length; i += 4)
        counts.set(row[i]!, (counts.get(row[i]!) ?? 0) + 1);
      const dominant = [...counts.entries()]
        .filter(([, count]) => count > 10)
        .map(([value]) => value)
        .sort((a, b) => a - b);
      if (dominant.length !== 2 || dominant[1]! - dominant[0]! < 30) continue;
      const [darkLevel, litLevel] = dominant as [number, number];
      let lit = 0;
      let dark = 0;
      let other = 0;
      for (let i = 1; i < row.length; i += 4) {
        const g = row[i]!;
        if (Math.abs(g - litLevel) <= 2) lit++;
        else if (Math.abs(g - darkLevel) <= 2) dark++;
        else other++;
      }
      // Prefer the row where the shadowed blob is largest while remaining a
      // minority inside the lit field.
      if (lit > dark && dark > 5 && (!shadow || dark > shadow.dark))
        shadow = { row, y, lit, dark, litLevel, darkLevel, other };
    }
    return {
      backend,
      webGLVersion: engine instanceof Engine ? engine.webGLVersion : null,
      config: {
        bands: BANDS,
        midpoint: MIDPOINT,
        specularStrength: SPECULAR_STRENGTH,
        specularSize: SPECULAR_SIZE,
        baseGreen: 153,
      },
      width: WIDTH,
      centerRow,
      mixing,
      shadow,
    };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
