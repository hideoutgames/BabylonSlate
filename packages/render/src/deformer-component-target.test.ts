import { afterEach, expect, it } from "vitest";
import { Mesh, NullEngine, Scene } from "@babylonjs/core";
import { createSnapshotSceneBinding, meshForPlayComponent, retirePlaySlot } from "./snapshot-apply";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

it("resolves the exact component root through single and attached multi-component actor layouts", () => {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine), binding = createSnapshotSceneBinding();
  const single = new Mesh("actor-1", scene);
  binding.meshes.set(1, single); binding.primaryComponentIds.set(1, "body");
  expect(meshForPlayComponent(binding, 1, "body")).toBe(single);
  expect(meshForPlayComponent(binding, 1, "unknown")).toBeNull();

  const origin = new Mesh("actor-2", scene); origin.metadata = { playActorOrigin: true };
  const first = new Mesh("actor-2|body", scene); first.parent = origin;
  const attached = new Mesh("actor-2|accessory", scene); attached.parent = first;
  const imported = new Mesh("Model Imported Child", scene); imported.parent = attached;
  binding.meshes.set(2, origin); binding.primaryComponentIds.set(2, "body");
  expect(meshForPlayComponent(binding, 2, "accessory")).toBe(attached);
  expect(meshForPlayComponent(binding, 2, "body")).toBe(first);
  expect(meshForPlayComponent(binding, 2, "unknown")).toBeNull();
  binding.deformers.set(2, { actorId: "actor", revision: 3, bindings: [] });
  retirePlaySlot(binding, 2);
  expect(meshForPlayComponent(binding, 2, "body")).toBeNull();
  expect(binding.deformers.has(2)).toBe(false);
});
