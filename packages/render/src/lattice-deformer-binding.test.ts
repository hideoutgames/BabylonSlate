import { afterEach, describe, expect, it, vi } from "vitest";
import { Mesh, NullEngine, Scene } from "@babylonjs/core";
import { markLatticeComponentRoot, meshLatticeBinding, setLatticeBinding, type LatticeBinding } from "./lattice-deformer-binding";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function cage(): LatticeBinding { return { active: true, bindEffect: vi.fn(), bindBuffer: vi.fn() }; }
function component(scene: Scene, name: string) {
  const root = new Mesh(name, scene), part = new Mesh(`${name}-part`, scene);
  part.parent = root;
  return { root, part };
}
function fixture() {
  const engine = new NullEngine(), scene = new Scene(engine);
  cleanups.push(() => { scene.dispose(); engine.dispose(); });
  return scene;
}

describe("lattice binding resolution", () => {
  it("keeps resolving the remaining cages as others are bound, repeated, and unbound", () => {
    const scene = fixture();
    const a = component(scene, "a"), b = component(scene, "b");
    const first = cage(), second = cage();
    setLatticeBinding(a.root, first); setLatticeBinding(b.root, second);
    expect(meshLatticeBinding(a.part)).toBe(first);
    expect(meshLatticeBinding(b.part)).toBe(second);
    // Unbinding a root twice must not release another cage's share of the fast path.
    setLatticeBinding(a.root); setLatticeBinding(a.root);
    expect(meshLatticeBinding(a.part)).toBeUndefined();
    expect(meshLatticeBinding(b.part)).toBe(second);
    // Replacing a binding in place keeps one owner per root.
    const replacement = cage();
    setLatticeBinding(b.root, replacement);
    expect(meshLatticeBinding(b.part)).toBe(replacement);
    setLatticeBinding(b.root);
    expect(meshLatticeBinding(b.part)).toBeUndefined();
    setLatticeBinding(a.root, first);
    expect(meshLatticeBinding(a.part)).toBe(first);
    setLatticeBinding(a.root);
  });

  it("stops at a nested component root and resolves a binding set on a root marked earlier", () => {
    const scene = fixture();
    const outer = component(scene, "outer"), inner = component(scene, "inner");
    inner.root.parent = outer.root;
    markLatticeComponentRoot(outer.root); markLatticeComponentRoot(inner.root);
    const outerCage = cage();
    setLatticeBinding(outer.root, outerCage);
    expect(meshLatticeBinding(outer.part)).toBe(outerCage);
    expect(meshLatticeBinding(inner.part)).toBeUndefined();
    const innerCage = cage();
    setLatticeBinding(inner.root, innerCage);
    expect(meshLatticeBinding(inner.part)).toBe(innerCage);
    setLatticeBinding(inner.root); setLatticeBinding(outer.root);
    expect(meshLatticeBinding(outer.part)).toBeUndefined();
  });
});
