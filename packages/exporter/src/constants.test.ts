import { describe, expect, it } from "vitest";
import {
  NAVMESH_EXPORT_TYPE,
  AUDIO_REVERB_EXPORT_TYPE,
  navmeshExportGuid,
  audioReverbExportGuid,
  sceneGuidFromNavmeshExport,
  sceneGuidFromAudioReverbExport,
  FONT_FACETYPE_EXPORT_TYPE,
  fontFacetypeExportGuid,
  fontGuidFromFontFacetypeExport,
} from "./constants";

describe("navmesh export ids", () => {
  it("round-trips a scene guid through the sidecar prefix", () => {
    expect(NAVMESH_EXPORT_TYPE).toBe("NavMesh");
    const guid = navmeshExportGuid("scene-1");
    expect(guid).toBe("navmesh:scene-1");
    expect(sceneGuidFromNavmeshExport(guid)).toBe("scene-1");
    expect(sceneGuidFromNavmeshExport("scene-1")).toBeNull();
  });
});

describe("audio reverb export ids", () => {
  it("round-trips a scene guid through the sidecar prefix", () => {
    expect(AUDIO_REVERB_EXPORT_TYPE).toBe("AudioReverb");
    const guid = audioReverbExportGuid("scene-1");
    expect(guid).toBe("audioReverb:scene-1");
    expect(sceneGuidFromAudioReverbExport(guid)).toBe("scene-1");
    expect(sceneGuidFromAudioReverbExport("scene-1")).toBeNull();
  });
});

describe("font facetype export ids", () => {
  it("round-trips a Font guid through the sidecar prefix", () => {
    expect(FONT_FACETYPE_EXPORT_TYPE).toBe("FontFacetype");
    const guid = fontFacetypeExportGuid("font-1");
    expect(guid).toBe("font-facetype:font-1");
    expect(fontGuidFromFontFacetypeExport(guid)).toBe("font-1");
    expect(fontGuidFromFontFacetypeExport("font-1")).toBeNull();
  });
});
