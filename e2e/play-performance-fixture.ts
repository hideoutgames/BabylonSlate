import type { Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  PROJECT_FILE,
  RENDER_QUALITY_PROFILES,
  type QualityLevel,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";

/** Runtime primitives only: a lit room with static casters and settling dynamic spheres. */
export function playPerformanceRoom(): SerializedScene {
  const scene = { ...createDefaultScene(), name: "Play Performance Route" };
  const box = (
    id: string,
    position: [number, number, number],
    scale: [number, number, number],
  ) =>
    createActor(id, id, {
      transform: { ...identitySerializedTransform(), position, scale },
      components: [createMeshComponent(`${id}-mesh`, "box")],
    });
  scene.actors.push(box("Floor", [0, -1.25, 0], [44, 0.5, 44]));
  scene.actors.push(box("Back Wall", [0, 3, 22], [44, 8, 0.5]));
  scene.actors.push(box("Left Wall", [-22, 3, 0], [0.5, 8, 44]));
  scene.actors.push(box("Right Wall", [22, 3, 0], [0.5, 8, 44]));
  // 12 x 8 caster grid with deterministic height variation.
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 12; column += 1) {
      const index = row * 12 + column;
      const height = 1 + ((index * 7) % 5) * 0.5;
      scene.actors.push(
        box(
          `Caster ${index}`,
          [column * 3.2 - 17.6, height / 2 - 1, row * 3.2 - 11.2],
          [0.8, height, 0.8],
        ),
      );
    }
  }
  // Dynamic spheres exercise the worker tick and snapshot application.
  for (let index = 0; index < 16; index += 1) {
    scene.actors.push(
      createActor(`Sphere ${index}`, `Sphere ${index}`, {
        transform: {
          ...identitySerializedTransform(),
          position: [(index % 4) * 4 - 6, 6 + (index % 3) * 2, Math.floor(index / 4) * 4 - 6],
        },
        components: [
          createMeshComponent(`sphere-${index}-mesh`, "sphere"),
          {
            id: `sphere-${index}-body`,
            classId: "RigidBodyComponent",
            properties: { motionType: "dynamic", mass: 1, gravityScale: 1 },
          },
        ],
      }),
    );
  }
  const light = (
    id: string,
    kind: "point" | "spot",
    position: [number, number, number],
  ) =>
    createActor(id, id, {
      transform: {
        ...identitySerializedTransform(),
        position,
        rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      },
      components: [
        {
          id: `${id}-light`,
          classId: "LightComponent",
          properties: {
            lightKind: kind,
            color: [1, 0.95, 0.85],
            intensity: 2,
            range: 16,
            innerAngle: 35,
            outerAngle: 70,
            enabled: true,
            castShadows: true,
          },
        },
      ],
    });
  scene.actors.push(light("Spot 0", "spot", [-8, 7, 0]), light("Spot 1", "spot", [8, 7, 0]));
  for (let index = 0; index < 6; index += 1)
    scene.actors.push(light(`Point ${index}`, "point", [(index % 3) * 12 - 12, 4, Math.floor(index / 3) * 12 - 6]));
  const camera = scene.actors.find((actor) => actor.id === scene.settings.mainCameraActorId);
  if (camera) {
    // Behind the room, pitched ~20 degrees down so walls, casters and spheres are all in frame.
    camera.transform = {
      ...identitySerializedTransform(),
      position: [0, 9, -30],
      rotation: [Math.sin(Math.PI / 18), 0, 0, Math.cos(Math.PI / 18)],
    };
  }
  return scene;
}

/**
 * Minimal project files at the requested quality level. `BL_PERF_RENDER_MODE`
 * (`cel`) flips the render mode and `BL_PERF_BACKEND` (`webgl2`/`webgpu`)
 * selects the project GPU backend for routes that exercise both.
 */
export async function projectFilesWithQuality(level: QualityLevel) {
  const files = new Map(await minimalProjectFiles());
  const projectBytes = files.get(PROJECT_FILE);
  if (!projectBytes) throw new Error(`Minimal project has no ${PROJECT_FILE}`);
  const project = JSON.parse(new TextDecoder().decode(projectBytes)) as {
    settings: Record<string, unknown>;
  };
  const backend = process.env.BL_PERF_BACKEND;
  // Quality lives on settings.render; a top-level settings.quality is ignored
  // by normalization, so the profile must merge into the render block or the
  // route silently runs the default profile.
  project.settings.render = {
    ...(project.settings.render as Record<string, unknown> | undefined),
    quality: RENDER_QUALITY_PROFILES[level],
    ...(process.env.BL_PERF_RENDER_MODE === "cel" ? { mode: "cel" } : {}),
    ...(backend === "webgl2" || backend === "webgpu" ? { gpuBackend: backend } : {}),
  };
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  return files;
}

/** Unmasked adapter strings from a probe canvas on this page. */
export async function graphicsAdapter(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return { api: null, renderer: null, vendor: null };
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const result = {
      api: gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl",
      renderer: info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      vendor: info ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  });
}

export function distribution(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  return {
    samples: sorted.length,
    meanMs: mean,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    longestMs: sorted.at(-1) ?? null,
  };
}
