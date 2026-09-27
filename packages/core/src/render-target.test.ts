import { describe, expect, it } from "vitest";
import {
  normalizeRenderTargetCaptureProperties, normalizeRenderTargetPayload,
  normalizeRenderTargetTexturePayload, renderTargetAssetGuidsFromGraph,
} from "./render-target";
import type { SerializedGraph } from "./project";

describe("render target asset contracts", () => {
  it("bounds allocation dimensions and preserves the selected specialized pass", () => {
    expect(normalizeRenderTargetPayload({ mode: "DepthPass", width: 9000, height: 0 })).toEqual({
      mode: "DepthPass", width: 4096, height: 1,
    });
    expect(normalizeRenderTargetPayload({ mode: "Unknown", width: NaN, height: Infinity })).toEqual({
      mode: "SceneColor", width: 512, height: 512,
    });
    expect(normalizeRenderTargetTexturePayload({ renderTargetGuid: " capture " })).toEqual({ renderTargetGuid: "capture" });
  });

  it("keeps actor filtering opt-in and sanitizes ids and the camera clipping range", () => {
    const props = normalizeRenderTargetCaptureProperties({
      captureOnlyActors: "true", actorIds: [" hero ", "hero", null, "", 3, "wall"],
      nearClip: 20, farClip: 2, fieldOfView: 200,
    });
    expect(props.captureOnlyActors).toBe(false);
    expect(props.actorIds).toEqual(["hero", "wall"]);
    expect(props.fieldOfView).toBe(179);
    expect(props.farClip).toBeGreaterThan(props.nearClip);
    expect(normalizeRenderTargetCaptureProperties({ captureOnlyActors: true, actorIds: [] })).toMatchObject({
      captureOnlyActors: true, actorIds: [],
    });
  });

  it("keeps assets referenced by graph nodes and typed containers reachable without collecting text", () => {
    const node = (type: string, props: Record<string, unknown>): SerializedGraph["nodes"][number] => ({
      id: type, type, position: { x: 0, y: 0 }, data: { properties: props },
    });
    expect(renderTargetAssetGuidsFromGraph({
      nodes: [node("render-target.getMode", { "default:target": "depth-target" }),
        node("render-target.setRenderTarget", { "default:value": null, value: "cleared-target" }),
        node("debug.log", { "default:target": "text-ignore" })],
      edges: [],
      members: [
        { id: "a", name: "Targets", kind: "variable", typeId: "asset", typeClassId: "RenderTarget", container: "array", defaultValue: ["array-target"] },
        { id: "m", name: "Map", kind: "variable", typeId: "asset", typeClassId: "RenderTargetTexture", container: "map", keyTypeId: "asset", keyTypeClassId: "RenderTarget", defaultValue: [{ key: "map-target", value: "map-texture" }] },
        { id: "s", name: "Text", kind: "variable", typeId: "string", defaultValue: "text-ignore" },
      ],
      functionGraphs: { read: { nodes: [node("render-target.getTextureTarget", { "default:texture": "function-texture" })], edges: [] } },
    })).toEqual(["array-target", "map-target", "map-texture", "depth-target", "function-texture"]);
  });
  it("collects reflected setter literals and typed containers while preserving cleared defaults", () => {
    const setter = (id: string, properties: Record<string, unknown>): SerializedGraph["nodes"][number] => ({
      id, type: "variables.set", position: { x: 0, y: 0 }, data: { properties },
    });
    expect(renderTargetAssetGuidsFromGraph({ nodes: [
      setter("target", { typeId: "asset", typeClassId: "RenderTarget", propertyKey: "renderTargetGuid", "default:value": "reflected-target" }),
      setter("cleared", { typeId: "asset", typeClassId: "RenderTarget", "default:value": null, value: "ignore-cleared" }),
      setter("array", { typeId: "asset", typeClassId: "RenderTargetTexture", container: "array", "default:value": ["array-image"] }),
      setter("map", { typeId: "string", container: "map", keyTypeId: "asset", keyTypeClassId: "RenderTarget", "default:value": [{ key: "map-target", value: "ignore-text" }] }),
      setter("text", { typeId: "string", "default:value": "ignore-text" }),
    ], edges: [], functionGraphs: { sample: { nodes: [
      setter("sampler", { typeId: "asset", typeClassId: "Texture", variableName: "Monitor", "default:Monitor": "function-image" }),
    ], edges: [] } } })).toEqual(["reflected-target", "array-image", "map-target", "function-image"]);
  });

});
