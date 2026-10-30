import { Constants, RawTexture, type AbstractEngine, type Scene } from "@babylonjs/core";
import { AREA_LIGHT_LTC_BASE64 } from "./resources/area-lights-ltc";
import { beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease } from "./managed-render-resources";

/**
 * The tables twice: Babylon's native slot (`scene._ltcTextures`, which its RectAreaLight and native materials read) holds
 * them as two 64 by 64 textures, and the light block reads them stacked in one 64 by 128 texture (`combined`: LTC1's rows,
 * then LTC2's), one sampler instead of two.
 */
type Lookup = { LTC1: RawTexture; LTC2: RawTexture; combined: RawTexture; references: number; lease: ManagedRenderLease };
const engines = new WeakMap<AbstractEngine, Lookup>();
const scenes = new WeakMap<Scene, { lookup: Lookup; references: number }>();

/** Native 9.29 encoding: interleaved RGBA half floats for two 64 by 64 tables. Returns both, and both stacked. */
function decodeLookup(): [Uint16Array, Uint16Array, Uint16Array] {
  const bytes = Uint8Array.from(atob(AREA_LIGHT_LTC_BASE64), (char) => char.charCodeAt(0));
  if (bytes.byteLength !== 64 * 64 * 8 * 2) throw new Error("Invalid bundled area-light lookup data.");
  const source = new DataView(bytes.buffer);
  const tables: [Uint16Array, Uint16Array] = [new Uint16Array(64 * 64 * 4), new Uint16Array(64 * 64 * 4)];
  for (let pixel = 0; pixel < 64 * 64; pixel++) {
    for (let channel = 0; channel < 4; channel++) {
      tables[0][pixel * 4 + channel] = source.getUint16((pixel * 8 + channel) * 2, true);
      tables[1][pixel * 4 + channel] = source.getUint16((pixel * 8 + channel + 4) * 2, true);
    }
  }
  const combined = new Uint16Array(64 * 128 * 4);
  combined.set(tables[0]);
  combined.set(tables[1], 64 * 64 * 4);
  return [...tables, combined];
}

/** The light block's stacked tables for `scene` (`retainAreaLightLookup`), or null while no area light holds them. */
export function areaLightLtcTexture(scene: Scene): RawTexture | null {
  return scenes.get(scene)?.lookup.combined ?? null;
}

/** Fill the native scene slot before constructing a light; no CDN or loading frame. */
export function retainAreaLightLookup(scene: Scene): () => void {
  let entry = scenes.get(scene);
  // Do not claim textures installed by another native owner.
  if (!entry && scene._ltcTextures) return () => {};
  if (!entry) {
    const engine = scene.getEngine();
    let lookup = engines.get(engine);
    if (!lookup) {
      const lease = beginManagedRenderAllocation(engine, AREA_LIGHT_LOOKUP_BYTES);
      if (!lease) throw new Error("Rectangular Area Light lookup textures exceed the managed rendering memory budget.");
      let LTC1: RawTexture | undefined;
      let LTC2: RawTexture | undefined;
      let combined: RawTexture | undefined;
      try {
      const data = decodeLookup();
      const texture = (index: 0 | 1 | 2, name: string) => {
        const result = RawTexture.CreateRGBATexture(data[index], 64, index === 2 ? 128 : 64, engine, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
        result.name = name;
        result.wrapU = result.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        result.gammaSpace = false;
        return result;
      };
      LTC1 = texture(0, "slate:areaLTC1"); LTC2 = texture(1, "slate:areaLTC2"); combined = texture(2, "slate:areaLTC");
      const table = AREA_LIGHT_LOOKUP_BYTES / 4;
      lease.commit([
        { handle: LTC1.getInternalTexture()!, bytes: table, category: "areaLight" },
        { handle: LTC2.getInternalTexture()!, bytes: table, category: "areaLight" },
        { handle: combined.getInternalTexture()!, bytes: 2 * table, category: "areaLight" },
      ]);
      lookup = { LTC1, LTC2, combined, references: 0, lease };
      } catch (error) { LTC1?.dispose(); LTC2?.dispose(); combined?.dispose(); void releaseManagedRenderLeaseAfterDisposal(engine, lease); throw error; }
      engines.set(engine, lookup);
    }
    lookup.references++;
    entry = { lookup, references: 0 };
    scenes.set(scene, entry);
    scene._ltcTextures = lookup;
  }
  entry.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry!.references !== 0) return;
    scenes.delete(scene);
    if (scene._ltcTextures === entry!.lookup) scene._ltcTextures = undefined;
    if (--entry!.lookup.references !== 0) return;
    engines.delete(scene.getEngine());
    entry!.lookup.LTC1.dispose();
    entry!.lookup.LTC2.dispose();
    entry!.lookup.combined.dispose();
    void releaseManagedRenderLeaseAfterDisposal(scene.getEngine(), entry!.lookup.lease);
  };
}

/** Both tables twice (the native pair and the stacked texture), as RGBA half floats. */
export const AREA_LIGHT_LOOKUP_BYTES = 4 * 64 * 64 * 4 * 2;
