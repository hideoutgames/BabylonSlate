import { describe, expect, it } from "vitest";
import { InstancedMesh, Mesh, VertexBuffer } from "@babylonjs/core";
import { encodeGlbJsonBin, splitGlbJsonBin } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { loadModelContainer } from "./model-container";
import {
  encodeParentedAnimatedTriangleGlb,
  encodeTriangleGlb,
} from "./glb-test-fixtures";
import {
  createModelPreviewScene,
  loadModelPreviewSource,
} from "./model-preview";

describe("model pose and clip ranges", () => {
  it("retains repeated-node batching inside independent model owners with shared geometry and local animation targets", async () => {
    const handle = createTestEngine();
    const split = splitGlbJsonBin(encodeParentedAnimatedTriangleGlb("Move Second"))!;
    const json = split.json as {
      nodes: { name?: string; children?: number[]; mesh?: number; translation?: number[] }[];
      meshes: { primitives: { indices?: number }[] }[];
      animations: { channels: { target: { node: number } }[] }[];
      accessors: Record<string, unknown>[]; bufferViews: Record<string, unknown>[]; buffers: { byteLength: number }[];
    };
    json.nodes[0]!.children = [1, 2];
    json.nodes[1] = { name: "first", mesh: 0, translation: [-2, 0, 0] };
    json.nodes.push({ name: "second", mesh: 0, translation: [2, 7, 0] });
    json.animations[0]!.channels[0]!.target.node = 2;
    const bin = new Uint8Array(split.bin.byteLength + 6);
    bin.set(split.bin); bin.set(new Uint8Array(new Uint16Array([0, 1, 2]).buffer), split.bin.byteLength);
    json.meshes[0]!.primitives[0]!.indices = json.accessors.length;
    json.accessors.push({ bufferView: json.bufferViews.length, componentType: 5123, count: 3, type: "SCALAR" });
    json.bufferViews.push({ buffer: 0, byteOffset: split.bin.byteLength, byteLength: 6 });
    json.buffers[0]!.byteLength = bin.byteLength;
    try {
      const container = await loadModelContainer(handle.scene, encodeGlbJsonBin(split.json, bin), "repeated.glb");
      try {
        const first = container.meshes.find((mesh) => mesh.name === "first");
        const second = container.meshes.find((mesh) => mesh.name === "second");
        expect(first).toBeInstanceOf(Mesh); expect(second).toBeInstanceOf(InstancedMesh);
        if (!(first instanceof Mesh) || !(second instanceof InstancedMesh)) throw new Error("Stock repeated nodes must share an instancing source");
        expect(second.sourceMesh).toBe(first);
        expect(second.geometry).toBe(first.geometry);
        expect(first.getVertexBuffer(VertexBuffer.PositionKind)).toBe(second.getVertexBuffer(VertexBuffer.PositionKind));
        expect(first.getIndices()).toBe(second.getIndices());
        expect(first.position.asArray()).toEqual([-2, 0, 0]);
        expect(second.position.asArray()).toEqual([2, 7, 0]);
        expect(first.parent).toBe(second.parent);
        const group = container.animationGroups[0]!;
        expect(group.targetedAnimations[0]!.target).toBe(second);
        expect(handle.scene.animatables).toHaveLength(0);
        const a = container.instantiateModelsToScene((name) => `a-${name}`, false, { doNotInstantiate: true });
        const b = container.instantiateModelsToScene((name) => `b-${name}`, false, { doNotInstantiate: true });
        let disposedA = false;
        try {
          const partsA = a.rootNodes.flatMap((root) => root.getChildMeshes());
          const partsB = b.rootNodes.flatMap((root) => root.getChildMeshes());
          const sourceA = partsA.find((mesh) => mesh.name === "a-first");
          const sourceB = partsB.find((mesh) => mesh.name === "b-first");
          const repeatA = partsA.find((mesh) => mesh.name === "a-second");
          const repeatB = partsB.find((mesh) => mesh.name === "b-second");
          if (!(sourceA instanceof Mesh) || !(sourceB instanceof Mesh) || !(repeatA instanceof InstancedMesh) || !(repeatB instanceof InstancedMesh))
            throw new Error("Each model must retain its own source and regular-instance batch");
          expect(sourceA).not.toBe(sourceB); expect(sourceA).not.toBe(first);
          expect(repeatA.sourceMesh).toBe(sourceA); expect(repeatB.sourceMesh).toBe(sourceB);
          expect(sourceA.geometry).toBe(first.geometry); expect(sourceB.geometry).toBe(first.geometry);
          expect(repeatA.geometry).toBe(first.geometry); expect(repeatB.geometry).toBe(first.geometry);
          expect(a.animationGroups[0]!.targetedAnimations[0]!.target).toBe(repeatA);
          expect(b.animationGroups[0]!.targetedAnimations[0]!.target).toBe(repeatB);
          expect(sourceA.parent).toBe(repeatA.parent); expect(sourceA.parent).not.toBe(sourceB.parent);
          expect(repeatA.position.asArray()).toEqual([2, 7, 0]);
          const animationA = a.animationGroups[0]!;
          animationA.start(false); animationA.pause(); animationA.goToFrame(30);
          expect(repeatA.position.y).toBeCloseTo(0.5);
          expect(repeatB.position.asArray()).toEqual([2, 7, 0]);
          expect(second.position.asArray()).toEqual([2, 7, 0]);
          expect(sourceA.position.asArray()).toEqual([-2, 0, 0]);
          a.dispose(); disposedA = true;
          expect(sourceB.geometry!.isDisposed()).toBe(false);
          const animationB = b.animationGroups[0]!;
          animationB.start(false); animationB.pause(); animationB.goToFrame(45);
          expect(repeatB.position.y).toBeCloseTo(0.75);
          expect(second.position.asArray()).toEqual([2, 7, 0]);
        } finally { if (!disposedA) a.dispose(); b.dispose(); }
        expect(second.getVertexBuffer(VertexBuffer.PositionKind)!.getData()).not.toBeNull();
      } finally { container.dispose(); }
    } finally { handle.scene.dispose(); handle.engine.dispose(); }
  });

  it("matches unnamed and duplicate clips to their own ranges", async () => {
    const handle = createTestEngine();
    const host = createModelPreviewScene(handle.engine);
    try {
      const split = splitGlbJsonBin(
        encodeParentedAnimatedTriangleGlb("Duplicate"),
      )!;
      const animations = split.json.animations as Record<string, unknown>[];
      animations.push(
        { ...animations[0], name: "Duplicate" },
        { ...animations[0], name: " " },
      );
      const loaded = await loadModelPreviewSource(
        host,
        encodeGlbJsonBin(split.json, split.bin),
      );
      expect(loaded!.animationGroups.map((group) => group.name)).toEqual([
        "Duplicate",
        "Duplicate_1",
        "Animation_2",
      ]);
      expect(
        loaded!.animationGroups.map((group) => group.to - group.from),
      ).toEqual([60, 60, 60]);
    } finally {
      host.dispose();
      handle.engine.dispose();
    }
  });

  it("retains the authored pose, with no playback, until a specific animation is requested", async () => {
    const handle = createTestEngine();
    const host = createModelPreviewScene(handle.engine);
    try {
      const split = splitGlbJsonBin(encodeParentedAnimatedTriangleGlb("Walk"))!;
      const json = split.json as {
        nodes: { translation?: number[] }[];
        accessors: { min: number[]; max: number[] }[];
      };
      json.nodes[1]!.translation = [0, 7, 0];
      json.accessors[1]!.min = [47];
      json.accessors[1]!.max = [48];
      new DataView(split.bin.buffer, split.bin.byteOffset).setFloat32(
        36,
        47,
        true,
      );
      new DataView(split.bin.buffer, split.bin.byteOffset).setFloat32(
        40,
        48,
        true,
      );
      const loaded = await loadModelPreviewSource(
        host,
        encodeGlbJsonBin(split.json, split.bin),
      );
      const group = loaded!.animationGroups[0]!;
      const target = group.targetedAnimations[0]!.target;
      expect(target.position.y).toBe(7);
      for (let i = 0; i < 3; i++) host.scene.render();
      expect(target.position.y).toBe(7);
      expect(host.scene.animatables).toHaveLength(0);
      expect(group.from).toBeCloseTo(47 * 60);
      expect(group.to - group.from).toBeCloseTo(60);
      group.start(true);
      group.pause();
      group.goToFrame(group.from + 30);
      expect(target.position.y).toBeCloseTo(0.5);
      expect(group.loopAnimation).toBe(true);
      group.stop();
      host.scene.useConstantAnimationDeltaTime = true;
      group.start(true);
      for (let i = 0; i < 32; i++) host.scene.render();
      expect(target.position.y).toBeGreaterThan(0.3);
      expect(target.position.y).toBeLessThan(0.7);
      for (let i = 0; i < 33; i++) host.scene.render();
      expect(target.position.y).toBeLessThan(0.1);
      expect(group.isPlaying).toBe(true);
    } finally {
      host.dispose();
      handle.engine.dispose();
    }
  });

  it("still loads ordinary models without skeletons or animations", async () => {
    const handle = createTestEngine();
    const host = createModelPreviewScene(handle.engine);
    try {
      const loaded = await loadModelPreviewSource(host, encodeTriangleGlb());
      expect(loaded!.animationGroups).toEqual([]);
      expect(
        host.mesh.getChildMeshes().some((mesh) => mesh.getTotalVertices() > 0),
      ).toBe(true);
      host.scene.render();
    } finally {
      host.dispose();
      handle.engine.dispose();
    }
  });
});
