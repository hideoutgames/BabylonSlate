import { describe, expect, it } from "vitest";
import {
  NAVMESH_EXPORT_TYPE,
  AUDIO_REVERB_EXPORT_TYPE,
  navmeshExportGuid,
  audioReverbExportGuid,
  sceneGuidFromNavmeshExport,
  UI_IMAGE_EXPORT_TYPE,
  uiImageExportGuid,
  textureGuidFromUiImageExport,
  sceneGuidFromAudioReverbExport,
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

describe("UI image export ids", () => {
  it("round-trips a texture guid through the sidecar prefix", () => {
    expect(UI_IMAGE_EXPORT_TYPE).toBe("UiImage");
    const guid = uiImageExportGuid("tex-1");
    expect(guid).toBe("uiimage:tex-1");
    expect(textureGuidFromUiImageExport(guid)).toBe("tex-1");
    expect(textureGuidFromUiImageExport("tex-1")).toBeNull();
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
