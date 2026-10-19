import { areaEmissionChunkId, AREA_EMISSION_CHUNK_KIND, type IndexedAsset } from "@babylonslate/assets";
import { describe, expect, it, vi } from "vitest";
import { areaEmissionStatusDescription, prepareReferencedAreaEmissions } from "./area-emission-preparation";

const sha = (fill: string) => fill.repeat(64);
function texture(guid: string, source: string, prepared = false): IndexedAsset {
  const chunks = [{ id: "pixels", kind: "pixels", sha256: sha(source) }];
  if (prepared) chunks.push({ id: areaEmissionChunkId(sha(source)), kind: AREA_EMISSION_CHUNK_KIND, sha256: sha("f") });
  return { rootId: "project", path: `assets/${guid}.babasset`, header: { guid, type: "Texture", name: guid, chunks } } as unknown as IndexedAsset;
}

describe("automatic area emission preparation", () => {
  it("prepares each unprepared source once and reports it in the Inspector until it finishes", async () => {
    let finish!: () => void;
    const prepare = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const assets = new Map([["pending", texture("pending", "a")], ["ready", texture("ready", "b", true)]]);
    prepareReferencedAreaEmissions(["pending", "ready", "missing"], (guid) => assets.get(guid), prepare);
    prepareReferencedAreaEmissions(["pending"], (guid) => assets.get(guid), prepare);
    expect(prepare.mock.calls).toEqual([["pending"]]);
    expect(areaEmissionStatusDescription(assets.get("pending"))).toMatch(/^Preparing/);
    expect(areaEmissionStatusDescription(assets.get("ready"))).toBeUndefined();
    finish();
    await vi.waitFor(() => expect(areaEmissionStatusDescription(assets.get("pending"))).toMatch(/Prepare Emission/));
    // A replaced image is a new source and prepares again.
    assets.set("pending", texture("pending", "c"));
    prepareReferencedAreaEmissions(["pending"], (guid) => assets.get(guid), prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure visible instead of retrying it on every render", async () => {
    const prepare = vi.fn(async () => { throw new Error("Project is read-only."); });
    const asset = texture("readonly", "d");
    prepareReferencedAreaEmissions(["readonly"], () => asset, prepare);
    await vi.waitFor(() => expect(areaEmissionStatusDescription(asset)).toContain("could not be prepared: Project is read-only."));
    prepareReferencedAreaEmissions(["readonly"], () => asset, prepare);
    expect(prepare).toHaveBeenCalledOnce();
  });
});
