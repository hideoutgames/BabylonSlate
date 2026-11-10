import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { glyphCellIdentity, type BitmapGlyphCell } from "./text2d-bitmap";

/**
 * The bitmap glyphs of every 2D Text in a Scene, on shared atlas pages. A text of its own atlas texture could never
 * share a draw with another text, and uploaded a texture at every build. Texts that sample one page bind the same
 * values, so a Scene's draw batcher can merge them, and a text whose glyphs are already on a page uploads nothing.
 *
 * A page is a fixed-size RGBA texture that keeps its pixels on the CPU. Cells sit on shelves a pixel apart and a
 * pixel from the edges, so a glyph samples the same texels wherever its cell is, with bilinear filtering too. A cell is kept while a text draws it and, after that, until its room is needed. Pages are never resized: a
 * glyph's UVs stay valid for as long as a text holds it.
 */

/** The edge of a page, unless a cell needs a larger one of its own. */
const PAGE_EDGE = 512;

export type GlyphUvs = { u0: number; v0: number; u1: number; v1: number };

/** One atlas page: texts with glyphs on the same page sample the same texture. */
export interface GlyphAtlasPage {
  readonly id: number;
  readonly texture: RawTexture;
}

/** Where a glyph a text holds is: its page and its rectangle there. */
export type AtlasGlyph = { readonly page: GlyphAtlasPage; readonly uvs: GlyphUvs };

type Slot = { x: number; y: number; width: number; height: number };
type Entry = { identity: string; slot: Slot; page: Page; glyph: AtlasGlyph; references: number };

function nextPowerOfTwo(value: number): number {
  let size = 8;
  while (size < value) size *= 2;
  return size;
}

class Page implements GlyphAtlasPage {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly texture: RawTexture;
  readonly entries = new Set<Entry>();
  /** Pixels written since the last upload. */
  dirty = false;
  private readonly free: Slot[] = [];
  private x = 1;
  private y = 1;
  private rowHeight = 0;

  constructor(id: number, width: number, height: number, scene: Scene, nearest: boolean) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.texture = RawTexture.CreateRGBATexture(
      this.pixels, width, height, scene, false, true,
      // A pixel font's texels stay square on screen.
      nearest ? Texture.NEAREST_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE,
    );
    this.texture.hasAlpha = true;
    this.texture.name = `text2d-glyph-atlas:${nearest ? "nearest" : "bilinear"}:${id}`;
  }

  /** Room for a cell: a freed slot that holds it, else the next place on the shelves; null when the page has none. */
  private place(width: number, height: number): Slot | null {
    for (let index = 0; index < this.free.length; index++) {
      const slot = this.free[index]!;
      if (slot.width < width || slot.height < height) continue;
      this.free.splice(index, 1);
      return slot;
    }
    let { x, y, rowHeight } = this;
    if (x + width + 1 > this.width) {
      x = 1;
      y += rowHeight + 1;
      rowHeight = 0;
    }
    if (x + width + 1 > this.width || y + height + 1 > this.height) return null;
    this.x = x + width + 1;
    this.y = y;
    this.rowHeight = Math.max(rowHeight, height);
    return { x, y, width, height };
  }

  /** Writes `cell` into the page, or returns null when it has no room for it. */
  add(identity: string, cell: BitmapGlyphCell): Entry | null {
    const slot = this.place(cell.width, cell.height);
    if (!slot) return null;
    const { pixels, width } = this;
    // A reused slot may be larger than the cell: what it held before must not show beside it.
    for (let row = 0; row < slot.height; row++) {
      const start = ((slot.y + row) * width + slot.x) * 4;
      pixels.fill(0, start, start + slot.width * 4);
    }
    for (let row = 0; row < cell.height; row++) {
      const source = row * cell.width * 4;
      pixels.set(cell.pixels.subarray(source, source + cell.width * 4), ((slot.y + row) * width + slot.x) * 4);
    }
    this.dirty = true;
    const entry: Entry = {
      identity, slot, page: this, references: 0,
      glyph: {
        page: this,
        uvs: {
          u0: slot.x / width,
          v0: 1 - (slot.y + cell.height) / this.height,
          u1: (slot.x + cell.width) / width,
          v1: 1 - slot.y / this.height,
        },
      },
    };
    this.entries.add(entry);
    return entry;
  }

  /** Gives a cell no text holds back to the page. Its pixels stay until the slot is written again. */
  remove(entry: Entry): void {
    this.entries.delete(entry);
    this.free.push(entry.slot);
  }

  upload(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.texture.update(this.pixels);
  }
}

/** A Scene's glyph pages for one sampling mode. */
export class SceneGlyphAtlas {
  private readonly pages: Page[] = [];
  private readonly entries = new Map<string, Entry>();
  private nextPage = 0;
  private readonly scene: Scene;
  private readonly nearest: boolean;

  constructor(scene: Scene, nearest: boolean) {
    this.scene = scene;
    this.nearest = nearest;
  }

  /**
   * Holds `cell` for a text until `release`, and returns where it is. A cell another text holds, or held until its
   * room was needed, is found again by what it draws (`glyphCellIdentity`).
   */
  acquire(cell: BitmapGlyphCell): AtlasGlyph {
    const identity = glyphCellIdentity(cell);
    let entry = this.entries.get(identity);
    if (!entry) {
      entry = this.add(identity, cell);
      this.entries.set(identity, entry);
    }
    entry.references += 1;
    return entry.glyph;
  }

  /** Lets go of a cell `acquire` returned for `cell`. */
  release(cell: BitmapGlyphCell): void {
    const entry = this.entries.get(glyphCellIdentity(cell));
    if (entry && entry.references > 0) entry.references -= 1;
  }

  private add(identity: string, cell: BitmapGlyphCell): Entry {
    for (const page of this.pages) {
      const entry = page.add(identity, cell);
      if (entry) return entry;
    }
    // No page has room: drop the cells no text holds, and try the pages again.
    if (this.dropUnheld()) {
      for (const page of this.pages) {
        const entry = page.add(identity, cell);
        if (entry) return entry;
      }
    }
    const limit = this.scene.getEngine().getCaps().maxTextureSize;
    const edge = Math.min(PAGE_EDGE, limit);
    // A cell larger than a page gets a page of its own size. The text's allocation preflight has refused any cell
    // the device's largest texture cannot hold.
    const page = new Page(
      this.nextPage++,
      Math.min(limit, Math.max(edge, nextPowerOfTwo(cell.width + 2))),
      Math.min(limit, Math.max(edge, nextPowerOfTwo(cell.height + 2))),
      this.scene,
      this.nearest,
    );
    this.pages.push(page);
    const entry = page.add(identity, cell);
    if (!entry) {
      this.pages.pop();
      page.texture.dispose();
      throw new Error(`2D Text glyph ${cell.width} x ${cell.height} does not fit an atlas page.`);
    }
    return entry;
  }

  /** Drops every cell no text holds, and every page left empty but one; whether any room was made. */
  private dropUnheld(): boolean {
    let dropped = false;
    for (const entry of [...this.entries.values()]) {
      if (entry.references > 0) continue;
      entry.page.remove(entry);
      this.entries.delete(entry.identity);
      dropped = true;
    }
    for (let index = this.pages.length - 1; index >= 0 && this.pages.length > 1; index--) {
      const page = this.pages[index]!;
      if (page.entries.size > 0) continue;
      this.pages.splice(index, 1);
      page.texture.dispose();
    }
    return dropped;
  }

  /** Uploads the pages written since the last upload: once a frame, however many texts were built in it. */
  upload(): void {
    for (const page of this.pages) page.upload();
  }

  dispose(): void {
    for (const page of this.pages) page.texture.dispose();
    this.pages.length = 0;
    this.entries.clear();
  }
}

const atlases = new WeakMap<Scene, { nearest?: SceneGlyphAtlas; bilinear?: SceneGlyphAtlas }>();

/** The Scene's glyph atlas for pixel fonts (`nearest`) or for every other bitmap glyph; disposed with the Scene. */
export function sceneGlyphAtlas(scene: Scene, nearest: boolean): SceneGlyphAtlas {
  let owned = atlases.get(scene);
  if (!owned) {
    const created: { nearest?: SceneGlyphAtlas; bilinear?: SceneGlyphAtlas } = owned = {};
    atlases.set(scene, created);
    // A frame draws what the texts built since the last one hold. First of the Scene's before-render work: a render
    // target capture draws the Scene from there.
    const upload = scene.onBeforeRenderObservable.add(() => {
      created.nearest?.upload();
      created.bilinear?.upload();
    }, undefined, true);
    scene.onDisposeObservable.addOnce(() => {
      scene.onBeforeRenderObservable.remove(upload);
      created.nearest?.dispose();
      created.bilinear?.dispose();
      atlases.delete(scene);
    });
  }
  const key = nearest ? "nearest" : "bilinear";
  return owned[key] ??= new SceneGlyphAtlas(scene, nearest);
}
