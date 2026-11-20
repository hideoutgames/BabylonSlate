import { describe, expect, it } from "vitest";
import {
  filterInspectorPinPickerAssets,
  materialDomainsFromAssets,
  materialSlotPickerAssets,
  materialSlotTakes,
} from "./material-asset-filters";

function material(guid: string, domain?: string) {
  return { path: `assets/${guid}.material.hasset`, header: { guid, type: "Material", name: guid, payload: domain ? { domain } : {} } };
}

function instance(guid: string, parentGuid: string | null, cached: string) {
  return { path: `assets/${guid}.matinst.hasset`, header: { guid, type: "MaterialInstance", name: guid, payload: { parentGuid, domain: cached } } };
}

describe("materialDomainsFromAssets", () => {
  it("gives an Instance its root's domain through its parents, not the domain it cached", () => {
    const assets = [
      material("stain", "decal"),
      instance("child", "stain", "surface"),
      instance("grandchild", "child", "surface"),
      { path: "assets/t.texture.hasset", header: { guid: "t", type: "Texture", name: "t" } },
    ];
    expect(materialDomainsFromAssets(assets)).toEqual({ stain: "decal", child: "decal", grandchild: "decal" });
  });

  it("follows a root's unsaved domain in its open tab", () => {
    const assets = [material("rock", "surface"), instance("rock-red", "rock", "surface")];
    const open = [{ ref: { kind: "material", path: "assets/rock.material.hasset" }, content: { domain: "decal" } }];
    expect(materialDomainsFromAssets(assets, open)).toEqual({ rock: "decal", "rock-red": "decal" });
  });

  it("follows an Instance's unsaved parent in its open tab", () => {
    const assets = [material("rock", "surface"), material("stain", "decal"), instance("pick", "rock", "surface")];
    const open = [{ ref: { kind: "material-instance", path: "assets/pick.matinst.hasset" }, content: { parentGuid: "stain", domain: "surface" } }];
    expect(materialDomainsFromAssets(assets, open).pick).toBe("decal");
  });

  it("keeps the cached domain when the chain reaches no Material, and reads a Material without one as Surface", () => {
    const assets = [material("plain"), instance("orphan", "gone", "particle"), instance("a", "b", "text"), instance("b", "a", "text")];
    expect(materialDomainsFromAssets(assets)).toEqual({ plain: "surface", orphan: "particle", a: "text", b: "text" });
  });
});

describe("Material slot pickers", () => {
  const domains: Record<string, string> = { rock: "surface", stain: "decal" };
  const domainOf = (guid: string) => domains[guid];
  const entries = [{ guid: "rock" }, { guid: "stain" }, { guid: "missing" }];
  const modelMaterials = { guid: "__model_materials__" };

  it("lists only the slot's domain, after the Model Materials entry a Mesh offers", () => {
    expect(materialSlotPickerAssets("surface", entries, domainOf, modelMaterials).map((entry) => entry.guid)).toEqual(["__model_materials__", "rock"]);
    expect(materialSlotPickerAssets("decal", entries, domainOf).map((entry) => entry.guid)).toEqual(["stain"]);
    expect(materialSlotPickerAssets(undefined, entries, domainOf)).toEqual(entries);
  });

  it("refuses a pick of another domain or an unknown asset, but takes None and the slot's own entries", () => {
    expect(materialSlotTakes("surface", "stain", domainOf)).toBe(false);
    expect(materialSlotTakes("surface", "missing", domainOf)).toBe(false);
    expect(materialSlotTakes("surface", "rock", domainOf)).toBe(true);
    expect(materialSlotTakes("surface", null, domainOf)).toBe(true);
    expect(materialSlotTakes("surface", "__model_materials__", domainOf, ["__model_materials__"])).toBe(true);
    expect(materialSlotTakes(undefined, "stain", domainOf)).toBe(true);
  });
});

describe("filterInspectorPinPickerAssets", () => {
  const assets = [material("bloom", "postProcess"), material("rock", "surface"), material("stain", "decal"), instance("stain-red", "stain", "surface")];
  const picker = assets.map((asset) => ({ guid: asset.header.guid, type: asset.header.type }));
  it.each([
    ["scene.registerPostProcess", ["bloom"]],
    ["scene-layer.unregisterPostProcess", ["bloom"]],
    ["decals.spawn", ["stain", "stain-red"]],
    ["material.setMaterialInstance", ["rock"]],
    ["audio.play", ["bloom", "rock", "stain", "stain-red"]],
  ])("offers %s's Material pin %j", (nodeType, guids) => {
    expect(filterInspectorPinPickerAssets(picker, assets, [], { nodeType }).map((entry) => entry.guid)).toEqual(guids);
  });
});
