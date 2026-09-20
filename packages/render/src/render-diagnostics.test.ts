import {
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { readEngineDrawCalls } from "./draw-calls";
import { MANAGED_RENDER_BYTE_LIMIT } from "./managed-render-resources";
import { createRenderDiagnostics } from "./render-diagnostics";
import { setupDefaultViewport } from "./viewport";

const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("render diagnostics qualification fields", () => {
  it("reports adapter, draw calls, resource counts, GPU reservations and scaling level", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    setupDefaultViewport(scene);
    MeshBuilder.CreateBox("receiver", { size: 1 }, scene);
    new StandardMaterial("material", scene);
    scene.activeCamera = new UniversalCamera("camera", Vector3.Zero(), scene);
    engine.setHardwareScalingLevel(1.25);

    const diagnostics = createRenderDiagnostics(scene, () => 1.5)();

    // NullEngine exposes neither getInfo nor getGlInfo: the API is still named
    // and the strings stay null rather than fabricated.
    expect(diagnostics.adapter.api).toBe("webgl2");
    expect(diagnostics.adapter.vendor).toBeNull();
    expect(diagnostics.adapter.renderer).toBeNull();
    expect(diagnostics.adapter.version).toBeNull();
    expect(diagnostics.drawCalls).toBe(readEngineDrawCalls(engine));
    expect(diagnostics.resources).toEqual({
      meshes: scene.meshes.length,
      materials: scene.materials.length,
      textures: scene.textures.length,
      cachedTextures: engine.getLoadedTexturesCache().length,
    });
    expect(diagnostics.gpuReservations.limit).toBe(MANAGED_RENDER_BYTE_LIMIT);
    expect(diagnostics.gpuReservations.reservedBytes).toBeGreaterThanOrEqual(0);
    // NullEngine does not apply the level; the field mirrors whatever the
    // live Engine reports, so a qualification run records the real value.
    expect(diagnostics.scalingLevel).toBe(engine.getHardwareScalingLevel());
  });
});
