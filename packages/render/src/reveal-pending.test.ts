import { afterEach, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { hasRevealPending, hideUntilReady, isRevealPending, noteRevealProbe } from "./reveal-pending";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

it("tells a Scene that hides nothing from one with a hidden mesh, through reveals and disposals", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const other = new Scene(engine);
  const spawned = MeshBuilder.CreateBox("spawned", {}, scene);
  const second = MeshBuilder.CreateBox("second", {}, scene);
  expect(hasRevealPending(scene)).toBe(false);
  hideUntilReady(spawned);
  hideUntilReady(second);
  // Another Scene's passes still leave nothing out.
  expect([hasRevealPending(scene), hasRevealPending(other)]).toEqual([true, false]);
  // Revealed once its variants are ready: the Scene still hides the other one.
  noteRevealProbe(spawned, true);
  expect([isRevealPending(spawned), hasRevealPending(scene)]).toEqual([false, true]);
  // A hidden mesh that despawns before it is ready leaves the Scene's list, so nothing is left to leave out.
  second.dispose();
  expect(hasRevealPending(scene)).toBe(false);
  // Hidden again (its Material changed before it drew), then revealed.
  hideUntilReady(spawned);
  expect(hasRevealPending(scene)).toBe(true);
  noteRevealProbe(spawned, true);
  expect(hasRevealPending(scene)).toBe(false);
});
