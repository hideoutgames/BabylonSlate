import { Constants, RawTexture, type AbstractEngine, type Scene } from "@babylonjs/core";
import { AREA_LIGHT_LTC_BASE64 } from "./resources/area-lights-ltc";

type Lookup = { LTC1: RawTexture; LTC2: RawTexture; references: number };
const engines = new WeakMap<AbstractEngine, Lookup>();
const scenes = new WeakMap<Scene, { lookup: Lookup; references: number }>();

/** Native 9.20 encoding: interleaved RGBA half floats for two 64 by 64 tables. */
function decodeLookup(): [Uint16Array, Uint16Array] {
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
  return tables;
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
      const data = decodeLookup();
      const texture = (index: 0 | 1) => {
        const result = RawTexture.CreateRGBATexture(data[index], 64, 64, engine, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
        result.name = `slate:areaLTC${index + 1}`;
        result.wrapU = result.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        result.gammaSpace = false;
        return result;
      };
      const LTC1 = texture(0);
      try { lookup = { LTC1, LTC2: texture(1), references: 0 }; }
      catch (error) { LTC1.dispose(); throw error; }
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
  };
}

export const AREA_LIGHT_LOOKUP_BYTES = 2 * 64 * 64 * 4 * 2;
