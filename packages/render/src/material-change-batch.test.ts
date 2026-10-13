import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshBuilder, NullEngine, Scene, StandardMaterial } from "@babylonjs/core";
import { withNetMaterialChanges } from "./material-change-batch";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const first = new StandardMaterial("first", scene);
  const second = new StandardMaterial("second", scene);
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  mesh.material = first;
  const changed = vi.fn();
  mesh.onMaterialChangedObservable.add(changed);
  return { mesh, first, second, changed };
}

describe("withNetMaterialChanges", () => {
  it("announces nothing for a mesh that ends on the Material it started with, and the net change once otherwise", () => {
    const { mesh, first, second, changed } = fixture();
    withNetMaterialChanges([mesh], () => { mesh.material = second; mesh.material = first; });
    expect(changed).not.toHaveBeenCalled();
    expect(mesh.material).toBe(first);

    withNetMaterialChanges([mesh], () => { mesh.material = null; mesh.material = second; });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(mesh, expect.anything());
    expect(mesh.material).toBe(second);
    // Outside a scope every assignment is announced as before.
    mesh.material = first;
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("lets each assignment read the state its predecessor left", () => {
    const { mesh, first, second } = fixture();
    const seen: Array<unknown> = [];
    withNetMaterialChanges([mesh], () => {
      mesh.material = second;
      seen.push(mesh.material);
      mesh.material = first;
      seen.push(mesh.material);
    });
    expect(seen).toEqual([second, first]);
  });

  it("still reports the net change, and releases the mesh, when the binding throws", () => {
    const { mesh, second, changed } = fixture();
    expect(() => withNetMaterialChanges([mesh], () => { mesh.material = second; throw new Error("bind failed"); })).toThrow("bind failed");
    expect(changed).toHaveBeenCalledTimes(1);
    mesh.material = null;
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("reports once, from the outermost scope, when scopes nest", () => {
    const { mesh, first, second, changed } = fixture();
    withNetMaterialChanges([mesh], () => {
      withNetMaterialChanges([mesh], () => { mesh.material = second; });
      // The inner scope did not release the mesh early.
      expect(changed).not.toHaveBeenCalled();
      mesh.material = first;
    });
    expect(changed).not.toHaveBeenCalled();

    withNetMaterialChanges([mesh], () => {
      withNetMaterialChanges([mesh], () => { mesh.material = second; });
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
