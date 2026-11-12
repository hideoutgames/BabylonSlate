import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, expect, it } from "vitest";
import { isEditorHelperMesh, markEditorHelperMesh } from "./helper-mesh";
import { markPlayDebugOverlay } from "./play-debug-overlay";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function mesh(name: string): Mesh {
  const engine = new NullEngine();
  engines.push(engine);
  return new Mesh(name, new Scene(engine));
}

it("sees a helper tag its writers add or remove after the mesh was already asked about", () => {
  const crate = mesh("Crate");
  crate.metadata = { gltf: { extras: {} } };
  expect(isEditorHelperMesh(crate)).toBe(false);
  markEditorHelperMesh(crate);
  expect(isEditorHelperMesh(crate)).toBe(true);
  // Untagging replaces the metadata, keeping what else it holds.
  crate.metadata = { ...crate.metadata, editorHelper: false };
  expect(isEditorHelperMesh(crate)).toBe(false);
  markPlayDebugOverlay(crate);
  expect(isEditorHelperMesh(crate)).toBe(true);
  crate.metadata = null;
  expect(isEditorHelperMesh(crate)).toBe(false);
});

it("judges a renamed mesh by its new name", () => {
  const lamp = mesh("Lamp");
  expect(isEditorHelperMesh(lamp)).toBe(false);
  lamp.name = "debugLight:Lamp";
  expect(isEditorHelperMesh(lamp)).toBe(true);
  lamp.name = "__editor-grid__";
  expect(isEditorHelperMesh(lamp)).toBe(true);
  lamp.name = "Lamp";
  expect(isEditorHelperMesh(lamp)).toBe(false);
});
