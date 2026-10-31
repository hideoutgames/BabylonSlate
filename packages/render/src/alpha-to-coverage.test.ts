import { afterEach, expect, it } from "vitest";
import { Constants, MeshBuilder, NullEngine, Scene, StandardMaterial, type AbstractMesh } from "@babylonjs/core";
import { drawsAlphaCoverage, endAlphaToCoverage, guardAlphaToCoverageBlending, registerAlphaToCoverage } from "./alpha-to-coverage";

type CoverageEngine = NullEngine & { getAlphaToCoverage(): boolean };

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function fixture() {
  const engine = new NullEngine() as CoverageEngine;
  engines.push(engine);
  const scene = new Scene(engine);
  /** Binds `material` for `mesh`'s draw into a target of `samples`, as a draw does; returns the engine's coverage state. */
  const draw = (material: StandardMaterial, mesh: AbstractMesh, samples: number) => {
    (engine as unknown as { _currentRenderTarget: { samples: number } | null })._currentRenderTarget = samples > 1 ? { samples } : null;
    (material as unknown as { _afterBind(mesh: AbstractMesh): void })._afterBind(mesh);
    return engine.getAlphaToCoverage();
  };
  return { engine, scene, draw };
}

it("turns alpha-to-coverage on only for a registered Material's alpha-tested mesh drawn into a multisampled target", () => {
  const { engine, scene, draw } = fixture();
  const masked = new StandardMaterial("masked", scene);
  const cutout = MeshBuilder.CreatePlane("cutout", {}, scene), solid = MeshBuilder.CreatePlane("solid", {}, scene);
  registerAlphaToCoverage(masked, (mesh) => mesh === cutout);
  const other = new StandardMaterial("other", scene);
  // Each draw sets the state its own Material needs, so an opaque draw after a cutout one never inherits it.
  expect([
    draw(masked, cutout, 4), draw(other, solid, 4), draw(masked, cutout, 2), draw(masked, solid, 4), draw(masked, cutout, 1),
  ]).toEqual([true, false, true, false, false]);
  expect(drawsAlphaCoverage(engine, masked, cutout)).toBe(false);
  // Registered for every mesh.
  const all = new StandardMaterial("all", scene);
  registerAlphaToCoverage(all);
  expect(draw(all, solid, 4)).toBe(true);
});

it("ends alpha-to-coverage when the engine starts blending and when a pass ends", () => {
  const { engine, scene, draw } = fixture();
  guardAlphaToCoverageBlending(engine);
  guardAlphaToCoverageBlending(engine);
  const masked = new StandardMaterial("masked", scene);
  registerAlphaToCoverage(masked);
  const mesh = MeshBuilder.CreatePlane("cutout", {}, scene);
  expect(draw(masked, mesh, 4)).toBe(true);
  engine.setAlphaMode(Constants.ALPHA_DISABLE);
  expect(engine.getAlphaToCoverage()).toBe(true);
  // Sprites and particles blend without binding a Material.
  engine.setAlphaMode(Constants.ALPHA_COMBINE);
  expect(engine.getAlphaToCoverage()).toBe(false);
  expect(draw(masked, mesh, 4)).toBe(true);
  endAlphaToCoverage(engine);
  expect(engine.getAlphaToCoverage()).toBe(false);
});
