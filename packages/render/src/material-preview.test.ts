import { afterEach, describe, expect, it } from "vitest";
import {
  ArcRotateCamera,
  MeshBuilder,
  NullEngine,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { MATERIAL_PREVIEW_MESHES } from "@babylonslate/shader-graph";
import {
  MATERIAL_PREVIEW_MESH_NAME,
  aimPreviewCameraAtMesh,
  attachMaterialPreviewGestures,
  createMaterialPreviewMesh,
  createMaterialPreviewScene,
} from "./material-preview";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function engine(): NullEngine {
  const created = new NullEngine();
  disposers.push(() => created.dispose());
  return created;
}

describe("material preview scene", () => {
  it("builds a mesh for every preview primitive", () => {
    const scene = new Scene(engine());
    disposers.push(() => scene.dispose());
    for (const kind of MATERIAL_PREVIEW_MESHES) {
      const mesh = createMaterialPreviewMesh(scene, kind);
      expect(mesh.getTotalVertices()).toBeGreaterThan(0);
      mesh.dispose();
    }
  });

  it("collapses the cone apex onto the axis", () => {
    const scene = new Scene(engine());
    disposers.push(() => scene.dispose());
    const cone = createMaterialPreviewMesh(scene, "cone");
    const positions = cone.getVerticesData("position")!;
    let maxY = -Infinity;
    for (let index = 1; index < positions.length; index += 3) {
      maxY = Math.max(maxY, positions[index]!);
    }
    let widestAtTop = 0;
    for (let index = 0; index < positions.length; index += 3) {
      if (Math.abs(positions[index + 1]! - maxY) > 1e-5) continue;
      widestAtTop = Math.max(
        widestAtTop,
        Math.hypot(positions[index]!, positions[index + 2]!),
      );
    }
    expect(widestAtTop).toBeLessThan(1e-5);
  });

  it("falls back to a sphere when a custom mesh has no bytes", () => {
    const scene = new Scene(engine());
    disposers.push(() => scene.dispose());
    const mesh = createMaterialPreviewMesh(scene, "custom", null);
    expect(mesh.getTotalVertices()).toBeGreaterThan(0);
    expect(mesh.name).toBe(MATERIAL_PREVIEW_MESH_NAME);
  });

  it("creates a scene with a camera, lights and a mesh", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    expect(host.scene.cameras.length).toBe(1);
    expect(host.scene.lights.length).toBeGreaterThan(0);
    expect(host.mesh.name).toBe(MATERIAL_PREVIEW_MESH_NAME);
  });

  it("swaps the primitive while keeping the applied material", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const before = host.mesh.getTotalVertices();
    const next = host.setMesh("cube");
    expect(next.getTotalVertices()).not.toBe(before);
    expect(host.scene.meshes.length).toBe(1);
  });

  it("disposes the old mesh when the primitive changes", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const original = host.mesh;
    host.setMesh("plane");
    expect(original.isDisposed()).toBe(true);
  });

  it("disables panning so orbit stays on the mesh", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    expect(host.camera.panningSensibility).toBe(0);
  });

  it("configures pinch zoom on the preview orbit camera", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    expect(host.camera.useNaturalPinchZoom).toBe(true);
    expect(host.camera.pinchPrecision).toBeGreaterThan(0);
    expect(host.camera.pinchDeltaPercentage).toBeGreaterThan(0);
  });

  it("aims the camera at a mesh that is not at the origin", () => {
    const scene = new Scene(engine());
    disposers.push(() => scene.dispose());
    const camera = new ArcRotateCamera(
      "aim",
      0,
      Math.PI / 2,
      4,
      Vector3.Zero(),
      scene,
    );
    const mesh = MeshBuilder.CreateBox("offset", { size: 1 }, scene);
    mesh.position.set(2, 3, 4);
    mesh.computeWorldMatrix(true);
    aimPreviewCameraAtMesh(camera, mesh);
    expect(camera.target.x).toBeCloseTo(2);
    expect(camera.target.y).toBeCloseTo(3);
    expect(camera.target.z).toBeCloseTo(4);
  });

  it("reframes the camera when the preview primitive changes", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    host.mesh.position.set(1.5, 0, 0);
    host.mesh.computeWorldMatrix(true);
    const next = host.setMesh("cube");
    next.computeWorldMatrix(true);
    const center = next.getBoundingInfo().boundingBox.centerWorld;
    expect(host.camera.target.x).toBeCloseTo(center.x);
    expect(host.camera.target.y).toBeCloseTo(center.y);
    expect(host.camera.target.z).toBeCloseTo(center.z);
  });

  it("disposes its scene on close", () => {
    const created = engine();
    const host = createMaterialPreviewScene(created as never);
    const scene = host.scene;
    host.dispose();
    expect(scene.isDisposed).toBe(true);
  });
});

type Listener = (event: Event) => void;

class FakePreviewCanvas {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  setPointerCapture(): void {}

  emit(type: string, event: Record<string, unknown>): void {
    const payload = { preventDefault: () => {}, ...event } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

describe("attachMaterialPreviewGestures", () => {
  it("zooms the orbit camera on wheel", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakePreviewCanvas();
    const gestures = attachMaterialPreviewGestures(
      canvas as unknown as HTMLCanvasElement,
      host.camera,
    );
    const before = host.camera.radius;
    canvas.emit("wheel", { deltaY: 400 });
    expect(host.camera.radius).toBeGreaterThan(before);
    gestures.dispose();
    expect(canvas.listenerCount()).toBe(0);
  });

  it("zooms the orbit camera when pinch spread changes", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakePreviewCanvas();
    const gestures = attachMaterialPreviewGestures(
      canvas as unknown as HTMLCanvasElement,
      host.camera,
    );
    const before = host.camera.radius;
    canvas.emit("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
    canvas.emit("pointerdown", { pointerId: 2, clientX: 172, clientY: 100 });
    canvas.emit("pointermove", { pointerId: 1, clientX: 64, clientY: 100 });
    canvas.emit("pointermove", { pointerId: 2, clientX: 208, clientY: 100 });
    expect(host.camera.radius).toBeLessThan(before);
    gestures.dispose();
  });
});
