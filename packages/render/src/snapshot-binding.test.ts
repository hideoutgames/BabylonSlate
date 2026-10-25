import { Mesh, NullEngine, Scene } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { SlotRootMap } from "./snapshot-binding";

describe("SlotRootMap", () => {
  it("reports a mesh as a root only while some slot holds it", () => {
    const engine = new NullEngine();
    try {
      const scene = new Scene(engine);
      const [replaced, current, shared] = ["replaced", "current", "shared"].map((name) => new Mesh(name, scene));
      const roots = new SlotRootMap();
      roots.set(1, replaced!);
      roots.set(1, current!);
      expect([roots.hasRoot(replaced!), roots.hasRoot(current!)]).toEqual([false, true]);
      roots.set(2, shared!);
      roots.set(3, shared!);
      roots.delete(2);
      expect(roots.hasRoot(shared!)).toBe(true);
      roots.delete(3);
      expect(roots.hasRoot(shared!)).toBe(false);
      roots.clear();
      expect(roots.hasRoot(current!)).toBe(false);
    } finally {
      engine.dispose();
    }
  });
});
