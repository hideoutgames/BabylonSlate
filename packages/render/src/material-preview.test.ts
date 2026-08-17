import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArcRotateCamera,
  MeshBuilder,
  NullEngine,
  RenderTargetTexture,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { MATERIAL_PREVIEW_MESHES } from "@babylonslate/shader-graph";
import {
  MATERIAL_PREVIEW_MESH_NAME,
  aimPreviewCameraAtMesh,
  attachMaterialPreviewGestures,
  createMaterialPreviewMesh,
  createMaterialPreviewPresenter,
  createMaterialPreviewScene,
} from "./material-preview";

type Listener = (event: Event) => void;

/** Node has no DOM canvas; gestures only need the listener surface. */
class FakeCanvas {
  clientWidth = 320;
  clientHeight = 180;
  #width = 320;
  #height = 180;
  widthAssigns = 0;
  heightAssigns = 0;
  readonly listeners = new Map<string, Set<Listener>>();
  capturedPointers: number[] = [];
  readonly dataset: Record<string, string> = {};

  get width(): number {
    return this.#width;
  }

  set width(value: number) {
    this.widthAssigns += 1;
    this.#width = value;
  }

  get height(): number {
    return this.#height;
  }

  set height(value: number) {
    this.heightAssigns += 1;
    this.#height = value;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointers.push(pointerId);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  getContext(): {
    clearRect: () => void;
    putImageData: () => void;
    createImageData: (width: number, height: number) => ImageData;
  } {
    return {
      clearRect: () => {},
      putImageData: () => {},
      createImageData: (width, height) =>
        ({ data: new Uint8ClampedArray(width * height * 4), width, height }) as ImageData,
    };
  }

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

function pointer(pointerId: number, x: number, y: number) {
  return { pointerId, clientX: x, clientY: y };
}

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

describe("material preview orbit gestures", () => {
  it("orbits around a fixed target so the camera position moves", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    const handle = attachMaterialPreviewGestures(
      canvas as unknown as HTMLCanvasElement,
      host.camera,
    );
    disposers.push(() => handle.dispose());
    host.camera.getViewMatrix();
    const targetBefore = host.camera.target.clone();
    const positionBefore = host.camera.position.clone();
    const alphaBefore = host.camera.alpha;

    canvas.emit("pointerdown", pointer(1, 160, 90));
    canvas.emit("pointermove", pointer(1, 220, 110));
    canvas.emit("pointerup", pointer(1, 220, 110));
    host.camera.getViewMatrix();

    expect(host.camera.alpha).not.toBeCloseTo(alphaBefore, 5);
    expect(host.camera.target.x).toBeCloseTo(targetBefore.x, 5);
    expect(host.camera.target.y).toBeCloseTo(targetBefore.y, 5);
    expect(host.camera.target.z).toBeCloseTo(targetBefore.z, 5);
    expect(host.camera.position.subtract(positionBefore).length()).toBeGreaterThan(
      0.01,
    );
  });

  it("zooms radius on wheel and pinch without panning the target", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    const handle = attachMaterialPreviewGestures(
      canvas as unknown as HTMLCanvasElement,
      host.camera,
    );
    disposers.push(() => handle.dispose());
    const targetBefore = host.camera.target.clone();
    const radiusBefore = host.camera.radius;

    canvas.emit("wheel", { deltaY: 240 });
    expect(host.camera.radius).toBeGreaterThan(radiusBefore);
    expect(host.camera.target.equals(targetBefore)).toBe(true);

    const afterWheel = host.camera.radius;
    canvas.emit("pointerdown", pointer(1, 100, 90));
    canvas.emit("pointerdown", pointer(2, 220, 90));
    canvas.emit("pointermove", pointer(1, 40, 90));
    canvas.emit("pointermove", pointer(2, 280, 90));
    expect(host.camera.radius).toBeLessThan(afterWheel);
    expect(host.camera.target.equals(targetBefore)).toBe(true);
  });

  it("attaches listeners only to the preview canvas and drops them on dispose", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    const other = new FakeCanvas();
    const handle = attachMaterialPreviewGestures(
      canvas as unknown as HTMLCanvasElement,
      host.camera,
    );
    expect(canvas.listenerCount()).toBeGreaterThan(0);
    expect(other.listenerCount()).toBe(0);
    handle.dispose();
    expect(canvas.listenerCount()).toBe(0);
  });
});

describe("material preview presenter", () => {
  it("renders through an output RenderTargetTexture instead of the default framebuffer", () => {
    const created = engine();
    const host = createMaterialPreviewScene(created as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    const registerView = vi.spyOn(created, "registerView");
    const resize = vi.spyOn(created, "resize");
    const presenter = createMaterialPreviewPresenter(
      host,
      canvas as unknown as HTMLCanvasElement,
    );
    disposers.push(() => presenter.dispose());

    presenter.present();

    expect(host.camera.outputRenderTarget).not.toBeNull();
    expect(registerView).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    expect(host.camera.inputs.attachedToElement).toBeFalsy();
  });

  it("does not clear the shared default framebuffer", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    expect(host.scene.autoClear).toBe(false);
  });

  it("does not reset the 2D canvas size when the buffer is unchanged", async () => {
    const pixels = new Uint8Array(320 * 180 * 4);
    const readPixels = vi
      .spyOn(RenderTargetTexture.prototype, "readPixels")
      .mockResolvedValue(pixels);
    disposers.push(() => readPixels.mockRestore());
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    canvas.width = 1;
    canvas.height = 1;
    canvas.widthAssigns = 0;
    canvas.heightAssigns = 0;
    const presenter = createMaterialPreviewPresenter(
      host,
      canvas as unknown as HTMLCanvasElement,
      { maxFps: 1000 },
    );
    disposers.push(() => presenter.dispose());
    presenter.present();
    await vi.waitFor(() => expect(canvas.widthAssigns).toBeGreaterThan(0));
    const assigns = canvas.widthAssigns + canvas.heightAssigns;
    presenter.present();
    await Promise.resolve();
    await Promise.resolve();
    expect(canvas.widthAssigns + canvas.heightAssigns).toBe(assigns);
  });

  it("skips scene.render while a blit is in flight", () => {
    const hang = vi
      .spyOn(RenderTargetTexture.prototype, "readPixels")
      .mockReturnValue(new Promise(() => {}));
    disposers.push(() => hang.mockRestore());
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    let now = 0;
    const presenter = createMaterialPreviewPresenter(
      host,
      canvas as unknown as HTMLCanvasElement,
      { maxFps: 1000, now: () => (now += 50) },
    );
    disposers.push(() => presenter.dispose());
    presenter.present();
    const render = vi.spyOn(host.scene, "render");
    presenter.present();
    expect(render).not.toHaveBeenCalled();
  });

  it("caps present to the editor viewport frame cap", async () => {
    const readPixels = vi
      .spyOn(RenderTargetTexture.prototype, "readPixels")
      .mockResolvedValue(new Uint8Array(4));
    disposers.push(() => readPixels.mockRestore());
    let now = 0;
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    const presenter = createMaterialPreviewPresenter(
      host,
      canvas as unknown as HTMLCanvasElement,
      { maxFps: 30, now: () => now },
    );
    disposers.push(() => presenter.dispose());
    presenter.present();
    await Promise.resolve();
    await Promise.resolve();
    const render = vi.spyOn(host.scene, "render");
    presenter.present();
    expect(render).not.toHaveBeenCalled();
    now = 34;
    presenter.present();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("skips scene.render when frozen or the preview canvas has no size", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    const presenter = createMaterialPreviewPresenter(
      host,
      canvas as unknown as HTMLCanvasElement,
    );
    disposers.push(() => presenter.dispose());
    const render = vi.spyOn(host.scene, "render");

    presenter.setFrozen(true);
    presenter.present();
    expect(render).not.toHaveBeenCalled();

    presenter.setFrozen(false);
    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    presenter.present();
    expect(render).not.toHaveBeenCalled();
  });

  it("clears the camera output target on dispose", () => {
    const host = createMaterialPreviewScene(engine() as never);
    disposers.push(() => host.dispose());
    const canvas = new FakeCanvas();
    const presenter = createMaterialPreviewPresenter(
      host,
      canvas as unknown as HTMLCanvasElement,
    );
    presenter.present();
    expect(host.camera.outputRenderTarget).not.toBeNull();
    presenter.dispose();
    expect(host.camera.outputRenderTarget).toBeNull();
  });
});
