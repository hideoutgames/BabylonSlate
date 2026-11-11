import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import type { Nullable } from "@babylonjs/core/types";
import { createEngineDrawingState, restoreEngineDrawingState, saveEngineDrawingState } from "./engine-drawing-state";
import { beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease } from "./managed-render-resources";
import { renderTargetAllocationBytes } from "./render-target-resource-cost";

/**
 * A Scene's small layer images on one shared page, so a batch can draw visuals that differ in image alone
 * (`overlay-draw-batcher.ts`): a draw binds one texture, and images of their own textures never shared a draw.
 *
 * Only the batcher reads the page, and only for a batch: a visual drawn on its own samples its own texture as before.
 * Both read the same texel: the unlit graph finds the texel a UV falls in and samples its centre (`unlitTexelGrid`),
 * so a lookup never reads a cell's neighbour and cells need no gutter. An image is copied when the page can hold what
 * such a lookup reads:
 *
 * - **Texels.** A cell holds the image's texels as its texture stores them, copied on the GPU texel by texel
 *   (`texelFetch`), so the page needs 8-bit colour that is neither compressed nor stored as sRGB.
 * - **Sampling.** Nearest, which reads the base level alone: only such a texture has a texel grid. The batcher asks
 *   for a texture's cell while it has one, at every draw, as Nearest Texture Filtering changes the mode in place
 *   (`nearest-textures.ts`).
 * - **Size.** Each side at most `CELL_EDGE`, so one image cannot take the page, and a single level of storage, whose
 *   recorded size a cell can be copied by.
 *
 * A cell is drawn before the Scene's next frame (the first of its `onBeforeRenderObservable` work) and is given out
 * only once drawn; until then, and for an image the page has no room for, the visual keeps its own texture. A cell
 * goes when its texture is disposed or reloaded.
 */

/** The page's edge in texels, where the device allows it. */
const PAGE_EDGE = 1024;
/** The longest side of an image the page takes. */
const CELL_EDGE = 256;
const SHADER = "hapticLayerImageAtlas";
for (const wgsl of [false, true]) {
  const store = ShaderStore.GetShadersStore(wgsl ? 1 : 0);
  store[`${SHADER}VertexShader`] = wgsl
    ? "attribute position: vec2f;\n@vertex\nfn main(input: VertexInputs) -> FragmentInputs {\nvertexOutputs.position = vec4f(vertexInputs.position, 0.0, 1.0);\n}"
    : "attribute vec2 position;\nvoid main(void) {\ngl_Position = vec4(position, 0.0, 1.0);\n}";
  // atlasCell: the cell's first texel on the page.
  store[`${SHADER}PixelShader`] = wgsl
    ? `var atlasSource: texture_2d<f32>;
uniform atlasCell: vec4f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
fragmentOutputs.color = textureLoad(atlasSource, vec2i(floor(fragmentInputs.position.xy - uniforms.atlasCell.xy)), 0);
}`
    : `uniform sampler2D atlasSource;
uniform vec4 atlasCell;
void main(void) {
gl_FragColor = texelFetch(atlasSource, ivec2(floor(gl_FragCoord.xy - atlasCell.xy)), 0);
}`;
}

/** Where an image is on its page: the page as a batch binds it, and the image's rectangle there in texels. */
export interface LayerImageCell {
  /** The page; one of two wrappers of it, by whether the image's texture has alpha (a draw binds that with the texture). */
  readonly page: BaseTexture;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Slot = { x: number; y: number; width: number; height: number };

interface Image {
  texture: BaseTexture;
  /** The storage the cell was copied from; a reload gives the texture another. */
  internal: InternalTexture;
  slot: Slot;
  /** The cell as given out for a texture with alpha and for one without. */
  cells: [LayerImageCell, LayerImageCell];
  drawn: boolean;
  disposal: Nullable<Observer<BaseTexture>>;
}

/** The page's room, on shelves. */
class Shelves {
  private readonly free: Slot[] = [];
  private x = 0;
  private y = 0;
  private rowHeight = 0;
  private readonly width: number;
  private readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** Room for `width` × `height`: a freed slot that holds it, else the next place on the shelves; null when there is none. */
  place(width: number, height: number): Slot | null {
    for (let index = 0; index < this.free.length; index += 1) {
      const slot = this.free[index]!;
      if (slot.width < width || slot.height < height) continue;
      this.free.splice(index, 1);
      return slot;
    }
    let { x, y, rowHeight } = this;
    if (x + width > this.width) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    if (x + width > this.width || y + height > this.height) return null;
    this.x = x + width;
    this.y = y;
    this.rowHeight = Math.max(rowHeight, height);
    return { x, y, width, height };
  }

  release(slot: Slot): void {
    this.free.push(slot);
  }

  get hasFreed(): boolean {
    return this.free.length > 0;
  }

  reset(): void {
    this.free.length = 0;
    this.x = this.y = this.rowHeight = 0;
  }
}

/** Whether the page can hold `internal`'s texels as they are, and has a cell size for them (see the module comment). */
function copies(internal: InternalTexture): boolean {
  if (internal.isCube || internal.is3D || internal.is2DArray || internal.isMultiview || internal.samples > 1) return false;
  if (internal.type !== Constants.TEXTURETYPE_UNSIGNED_BYTE || internal._compression || internal._useSRGBBuffer || internal._isRGBD) return false;
  if (internal.format !== Constants.TEXTUREFORMAT_RGBA && internal.format !== Constants.TEXTUREFORMAT_RGB) return false;
  // A cell is copied by the size the texture records, which is its storage's for a single level only: Babylon leaves
  // a mip-mapped KTX2 it decoded to plain colour at its last level's.
  if (internal.useMipMaps) return false;
  return internal.width >= 1 && internal.height >= 1 && internal.width <= CELL_EDGE && internal.height <= CELL_EDGE;
}

const drawingState = createEngineDrawingState();
const viewport = new Viewport(0, 0, 1, 1);

/** A Scene's page of small layer images; made by the Scene's draw batcher and disposed with it. */
export class LayerImageAtlas {
  private readonly scene: Scene;
  private readonly engine: AbstractEngine;
  private readonly images = new Map<BaseTexture, Image>();
  /** Textures the page does not take, with the storage that was judged: a reload is judged again. */
  private readonly refused = new WeakMap<BaseTexture, InternalTexture>();
  private readonly pending: Image[] = [];
  private target: RenderTargetWrapper | null = null;
  private lease: ManagedRenderLease | null = null;
  /** The page as a texture with alpha and as one without. */
  private pages: [BaseTexture, BaseTexture] | null = null;
  private shelves: Shelves | null = null;
  private width = 0;
  private height = 0;
  /** No page on this device, or the ledger has no room for one. */
  private unavailable = false;
  private renderer: EffectRenderer | null = null;
  private effect: EffectWrapper | null = null;
  private readonly beforeRender: Nullable<Observer<Scene>>;
  private readonly restored: Nullable<Observer<AbstractEngine>>;
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.engine = scene.getEngine();
    // First of the Scene's before-render work, as the glyph atlas's upload: a capture draws the Scene from there.
    this.beforeRender = scene.onBeforeRenderObservable.add(() => this.flush(), undefined, true);
    // A restored context rebuilds the page empty, and reloads the textures it was copied from.
    this.restored = this.engine.onContextRestoredObservable.add(() => this.redrawAll());
  }

  /**
   * Where `texture`'s image is on the page, once it is drawn there; null for a texture the page does not take, has no
   * room for, or has not drawn yet (it is asked for then, and drawn before the Scene's next frame).
   */
  cell(texture: BaseTexture): LayerImageCell | null {
    const image = this.images.get(texture);
    const internal = texture.getInternalTexture();
    if (image) {
      if (image.internal === internal) return image.drawn ? image.cells[texture.hasAlpha ? 0 : 1] : null;
      // Reloaded: its texels may differ, and so may whether the page takes them.
      this.remove(image);
    }
    if (this.unavailable || this.disposed || !internal?.isReady) return null;
    if (this.refused.get(texture) === internal) return null;
    if (!copies(internal)) {
      this.refused.set(texture, internal);
      return null;
    }
    const slot = this.place(internal.width, internal.height);
    if (!slot) return null;
    const added: Image = {
      texture, internal, slot, cells: this.cells(slot, internal), drawn: false,
      disposal: texture.onDisposeObservable.add(() => { const held = this.images.get(texture); if (held) this.remove(held); }),
    };
    this.images.set(texture, added);
    this.pending.push(added);
    return null;
  }

  /** Images on the page and those of them drawn there, for tests and diagnostics. */
  get counts(): { images: number; drawn: number } {
    let drawn = 0;
    for (const image of this.images.values()) if (image.drawn) drawn += 1;
    return { images: this.images.size, drawn };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.onBeforeRenderObservable.remove(this.beforeRender);
    this.engine.onContextRestoredObservable.remove(this.restored);
    for (const image of this.images.values()) image.texture.onDisposeObservable.remove(image.disposal);
    this.images.clear();
    this.pending.length = 0;
    this.renderer?.dispose();
    this.effect?.dispose();
    this.renderer = null;
    this.effect = null;
    for (const page of this.pages ?? []) page.dispose();
    this.pages = null;
    this.target?.dispose();
    this.target = null;
    if (this.lease) void releaseManagedRenderLeaseAfterDisposal(this.engine, this.lease);
    this.lease = null;
  }

  private cells(slot: Slot, internal: InternalTexture): [LayerImageCell, LayerImageCell] {
    const rectangle = { x: slot.x, y: slot.y, width: internal.width, height: internal.height };
    return [{ page: this.pages![0], ...rectangle }, { page: this.pages![1], ...rectangle }];
  }

  /** A slot on the page, which is made with the first; null when the page has no room, or there is no page. */
  private place(width: number, height: number): Slot | null {
    if (!this.shelves && !this.create()) return null;
    const shelves = this.shelves!;
    const slot = shelves.place(width, height);
    if (slot || !shelves.hasFreed) return slot;
    // Freed slots too small for this image: lay the page out again, tallest first, and draw every cell where it is now.
    const images = [...this.images.values()].sort((a, b) => b.cells[0].height - a.cells[0].height);
    shelves.reset();
    this.pending.length = 0;
    for (const image of images) {
      const moved = shelves.place(image.cells[0].width, image.cells[0].height);
      // Another order may leave one out: it is asked for again by its next draw.
      if (!moved) {
        this.remove(image, false);
        continue;
      }
      image.slot = moved;
      image.cells = this.cells(moved, image.internal);
      image.drawn = false;
      this.pending.push(image);
    }
    return shelves.place(width, height);
  }

  /** Makes the page, its two wrappers and the copy's program; false (and no page from then on) when it cannot. */
  private create(): boolean {
    const engine = this.engine;
    const caps = engine.getCaps();
    this.unavailable = true;
    // The copy reads texels by index, which WebGL1 cannot.
    if (!engine.isWebGPU && (engine as { webGLVersion?: number }).webGLVersion! < 2) return false;
    const edge = Math.min(PAGE_EDGE, caps.maxTextureSize);
    const options = { width: edge, height: edge, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE };
    const bytes = renderTargetAllocationBytes(options);
    const lease = beginManagedRenderAllocation(engine, bytes);
    if (!lease) return false;
    let target: RenderTargetWrapper | undefined;
    try {
      target = engine.createRenderTargetTexture({ width: edge, height: edge }, {
        type: options.type, format: options.format, samplingMode: Constants.TEXTURE_NEAREST_NEAREST,
        generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: "Layer image atlas",
      });
      lease.commit([{ handle: target.texture!, bytes, category: "sceneColor" }]);
    } catch {
      target?.dispose();
      void releaseManagedRenderLeaseAfterDisposal(engine, lease);
      return false;
    }
    this.unavailable = false;
    const wrap = (hasAlpha: boolean) => {
      // Each wrapper holds a reference of its own, so the wrappers and the target release independently.
      target.texture!.incrementReferences();
      const page = new BaseTexture(engine, target.texture!);
      page.name = `layer-image-atlas:${hasAlpha ? "alpha" : "opaque"}`;
      page.hasAlpha = hasAlpha;
      return page;
    };
    this.target = target;
    this.lease = lease;
    this.pages = [wrap(true), wrap(false)];
    this.width = this.height = edge;
    this.shelves = new Shelves(edge, edge);
    this.renderer = new EffectRenderer(engine);
    this.effect = new EffectWrapper({
      engine, name: SHADER, vertexShader: SHADER, fragmentShader: SHADER, useShaderStore: true, shaderLanguage: engine.isWebGPU ? 1 : 0,
      uniformNames: ["atlasCell"], samplerNames: ["atlasSource"],
    });
    return true;
  }

  /** Takes `image` off the page; its texels stay until the slot is drawn again. */
  private remove(image: Image, release = true): void {
    image.texture.onDisposeObservable.remove(image.disposal);
    this.images.delete(image.texture);
    const queued = this.pending.indexOf(image);
    if (queued >= 0) this.pending.splice(queued, 1);
    if (release) this.shelves?.release(image.slot);
  }

  private redrawAll(): void {
    this.pending.length = 0;
    for (const image of this.images.values()) {
      image.drawn = false;
      this.pending.push(image);
    }
  }

  /** Copies the images asked for since the last frame into their cells; those whose texture is not ready wait. */
  private flush(): void {
    const pending = this.pending;
    if (!pending.length) return;
    const effect = this.effect!, renderer = this.renderer!, target = this.target!, engine = this.engine;
    if (!effect.isReady() || !target.texture?.isReady) return;
    let ready = false;
    for (const image of pending) {
      // A texture that reloaded since is asked for again by its next draw.
      if (image.texture.getInternalTexture() === image.internal && image.internal.isReady) { ready = true; break; }
    }
    if (!ready) return;
    saveEngineDrawingState(engine, drawingState);
    try {
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setColorWrite(true);
      engine.bindFramebuffer(target, 0, undefined, undefined, true);
      let kept = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const image = pending[index]!;
        if (image.texture.getInternalTexture() !== image.internal || !image.internal.isReady) {
          pending[kept++] = image;
          continue;
        }
        const cell = image.cells[0];
        viewport.x = cell.x / this.width;
        viewport.y = cell.y / this.height;
        viewport.width = cell.width / this.width;
        viewport.height = cell.height / this.height;
        renderer.setViewport(viewport);
        renderer.applyEffectWrapper(effect);
        effect.effect.setTexture("atlasSource", image.texture);
        effect.effect.setFloat4("atlasCell", cell.x, cell.y, 0, 0);
        renderer.draw();
        image.drawn = true;
      }
      pending.length = kept;
      engine.unBindFramebuffer(target, true);
    } finally {
      restoreEngineDrawingState(engine, drawingState);
    }
  }
}
