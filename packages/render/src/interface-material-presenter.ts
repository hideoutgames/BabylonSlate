import {
  Color4,
} from "@babylonjs/core/Maths/math.color";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { MaterialDocument, MaterialFunctionDocument } from "@babylonslate/shader-graph";
import { Image } from "@babylonjs/gui/2D/controls/image";
import { flipReadPixelsRgba } from "./flip-read-pixels";
import { MaterialLibrary, materialUnavailable } from "./material-library";

export interface InterfaceMaterialPresenter {
  canvas: HTMLCanvasElement;
  resize(width: number, height: number): void;
  present(): void;
  dispose(): void;
}

export interface InterfaceMaterialPresenterOptions {
  /** Host scene; the presenter uses its Engine and ticks after it renders. */
  scene: Scene;
  document: MaterialDocument;
  assetGuid: string;
  width: number;
  height: number;
  library?: MaterialLibrary;
  functions?: Record<string, MaterialFunctionDocument>;
  resolveTexture?: (guid: string) => Texture | null;
}

function pixelSize(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

function createBlitCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return {
    width,
    height,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
}

function blitTextureToCanvas(
  texture: RenderTargetTexture,
  canvas: HTMLCanvasElement,
): void {
  void (async () => {
    try {
      const buffer = await texture.readPixels();
      if (!buffer || !canvas.getContext) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height } = texture.getSize();
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const bytes =
        buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer);
      ctx.putImageData(
        new ImageData(flipReadPixelsRgba(bytes, width, height), width, height),
        0,
        0,
      );
    } catch {
      /* NullEngine / missing GPU readback still leaves a sized canvas. */
    }
  })();
}

/**
 * Compile an Interface material onto a widget-sized RTT and blit into a 2D
 * canvas for a GUI Image (`domImage`). Shared by designer, Play HUD,
 * and the packaged player.
 */
export function createInterfaceMaterialPresenter(
  options: InterfaceMaterialPresenterOptions,
): InterfaceMaterialPresenter {
  const width = pixelSize(options.width);
  const height = pixelSize(options.height);
  const canvas = createBlitCanvas(width, height);
  const engine = options.scene.getEngine();
  const preview = new Scene(engine);
  preview.skipPointerMovePicking = true;
  preview.autoClear = true;
  preview.clearColor = new Color4(0, 0, 0, 0);
  const camera = new FreeCamera(
    `${options.assetGuid}:ifaceCam`,
    new Vector3(0, 0, -1),
    preview,
  );
  const library =
    options.library ??
    new MaterialLibrary({
      resolveTexture: options.resolveTexture,
      functions: () => options.functions ?? {},
    });
  const ownedLibrary = options.library ? null : library;
  const acquired = library.acquire(preview, options.assetGuid, options.document);
  if (!materialUnavailable(acquired)) {
    try {
      acquired.material.createPostProcess(camera);
    } catch {
      /* NullEngine / missing post-process pipeline still leaves a sized canvas. */
    }
  }

  let rtt: RenderTargetTexture | null = null;
  let blitInFlight = false;
  let disposed = false;

  const releaseRtt = () => {
    camera.outputRenderTarget = null;
    rtt?.dispose();
    rtt = null;
  };

  const ensureRtt = (nextWidth: number, nextHeight: number): RenderTargetTexture => {
    const current = rtt?.getSize();
    if (
      rtt &&
      current &&
      current.width === nextWidth &&
      current.height === nextHeight
    ) {
      return rtt;
    }
    releaseRtt();
    rtt = new RenderTargetTexture(
      `${options.assetGuid}:iface`,
      { width: nextWidth, height: nextHeight },
      preview,
      false,
    );
    camera.outputRenderTarget = rtt;
    return rtt;
  };

  const present = () => {
    if (disposed) return;
    const size = { width: canvas.width, height: canvas.height };
    if (!(size.width > 0) || !(size.height > 0)) return;
    const texture = ensureRtt(size.width, size.height);
    preview.render();
    if (blitInFlight) return;
    blitInFlight = true;
    void (async () => {
      try {
        blitTextureToCanvas(texture, canvas);
      } finally {
        blitInFlight = false;
      }
    })();
  };

  ensureRtt(width, height);
  present();

  const observer: Observer<Scene> | null = options.scene.onAfterRenderObservable.add(
    () => present(),
  );

  return {
    canvas,
    resize: (nextWidth, nextHeight) => {
      if (disposed) return;
      canvas.width = pixelSize(nextWidth);
      canvas.height = pixelSize(nextHeight);
      present();
    },
    present,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (observer) options.scene.onAfterRenderObservable.remove(observer);
      releaseRtt();
      library.release(preview, options.assetGuid);
      ownedLibrary?.dispose();
      preview.dispose();
    },
  };
}

/** Drive a GUI Image from the presenter canvas (Babylon `domImage`). */
export function bindInterfaceMaterialImage(
  image: Image,
  canvas: HTMLCanvasElement,
): void {
  image.domImage = canvas as never;
}
