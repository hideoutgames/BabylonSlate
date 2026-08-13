import { describe, expect, it } from "vitest";
import { createMeshComponent } from "@babylonslate/core";
import { flattenPrefabComponents } from "./actor-prefab-panel";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";

describe("flattenPrefabComponents", () => {
  it("nests children under a parentId", () => {
    const root = createMeshComponent("root", "box");
    const child = { ...createMeshComponent("child", "sphere"), parentId: "root" };
    const nodes = flattenPrefabComponents([root, child], new Set());
    expect(nodes.map((node) => ({ id: node.id, depth: node.depth }))).toEqual([
      { id: PREFAB_ROOT_ID, depth: 0 },
      { id: "root", depth: 1 },
      { id: "child", depth: 2 },
    ]);
    expect(nodes.find((node) => node.id === "root")?.hasChildren).toBe(true);
  });
});
