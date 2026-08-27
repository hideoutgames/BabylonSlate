import { describe, expect, it } from "vitest";
import {
  engineEventTypeClassIds,
  engineScriptApiFor,
  engineScriptEventsFor,
  engineScriptFunctionsFor,
  ENGINE_CLASS_SCRIPT_APIS,
} from "./engine-script-api";

function names(
  entries: readonly { name: string }[] | undefined,
): string[] {
  return (entries ?? []).map((entry) => entry.name);
}

describe("engine script API catalog", () => {
  it("lists Collider overlap and hit events", () => {
    const events = engineScriptEventsFor("ColliderComponent");
    expect(events.map((event) => event.eventType)).toEqual([
      "flow.event.hit",
      "flow.event.beginOverlap",
      "flow.event.endOverlap",
    ]);
    expect(events.map((event) => event.exportName)).toEqual([
      "onHit",
      "onBeginOverlap",
      "onEndOverlap",
    ]);
  });

  it("exposes 2DPanel source, guids, margins, and Hit Test", () => {
    const panel = engineScriptApiFor("2DPanelComponent");
    expect(names(panel?.variables)).toEqual([
      "Source",
      "Texture",
      "Material",
      "Margin Left",
      "Margin Right",
      "Margin Top",
      "Margin Bottom",
      "Hit Test",
    ]);
  });

  it("exposes 2DButton mouse events and Hit Test, not SceneLayerActor natives", () => {
    expect(engineScriptApiFor("SceneLayerActor")).toBeUndefined();
    const button = engineScriptApiFor("2DButtonComponent");
    expect(names(button?.variables)).toEqual(["Hit Test"]);
    expect(button?.variables?.[0]?.propertyKey).toBe("hitTest");
    expect(engineScriptEventsFor("2DButtonComponent").map((event) => event.eventType)).toEqual(
      [
        "flow.event.onMouseEnter",
        "flow.event.onMouseLeave",
        "flow.event.onClick",
        "flow.event.onPressStart",
        "flow.event.onPressEnd",
      ],
    );
  });

  it("exposes Text3D Set Text, text properties, and On Text Changed", () => {
    const api = engineScriptApiFor("Text3DComponent");
    expect(names(api?.variables)).toEqual(["Text", "Size", "Color", "Font", "Alignment"]);
    expect(api?.variables?.map((entry) => entry.propertyKey)).toEqual([
      "text",
      "size",
      "color",
      "fontAssetGuid",
      "alignment",
    ]);
    const setText = engineScriptFunctionsFor("Text3DComponent").find(
      (entry) => entry.name === "Set Text",
    );
    expect(setText?.runtime).toBe("setText");
    expect(setText?.pins).toEqual(
      expect.arrayContaining([
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "then", typeId: "exec", direction: "out" },
        { name: "text", typeId: "string", direction: "in" },
      ]),
    );
    expect(engineScriptEventsFor("Text3DComponent")).toEqual([
      expect.objectContaining({
        name: "On Text Changed",
        eventType: "flow.event.textChanged",
        exportName: "onTextChanged",
      }),
    ]);
  });

  it("exposes Scene Name, Asset Guid, and Gravity on Scene and Game Instance scene getters", () => {
    const scene = engineScriptApiFor("Scene");
    expect(scene?.variables).toEqual([
      expect.objectContaining({
        name: "Scene Name",
        typeId: "string",
        propertyKey: "sceneName",
        getOnly: true,
      }),
      expect.objectContaining({
        name: "Asset Guid",
        typeId: "string",
        propertyKey: "assetGuid",
        getOnly: true,
      }),
      expect.objectContaining({
        name: "Gravity",
        typeId: "vec3",
        propertyKey: "gravity",
      }),
    ]);
    const gi = engineScriptApiFor("GameInstance");
    expect(names(gi?.functions)).toEqual([
      "Get Scene Loading Progress",
      "Get Scene Reference",
    ]);
  });

  it("does not invent APIs for bake-only and graph-document hosts", () => {
    expect(engineScriptApiFor("BlockingVolumeComponent")).toBeUndefined();
    expect(engineScriptApiFor("NavMeshComponent")).toBeUndefined();
    expect(engineScriptApiFor("NavMeshBlockerComponent")).toBeUndefined();
    expect(engineScriptApiFor("AnimationGraphComponent")).toBeUndefined();
    expect(engineScriptApiFor("BehaviourTreeComponent")).toBeUndefined();
    expect(engineScriptEventsFor("CameraComponent")).toEqual([]);
    expect(ENGINE_CLASS_SCRIPT_APIS.every((api) => api.classId !== "Actor")).toBe(
      true,
    );
  });

  it("exposes Mesh Kind, Mesh (Mesh+Model), and Material on MeshComponent", () => {
    const api = engineScriptApiFor("MeshComponent");
    expect(
      api?.variables?.map((entry) => [entry.name, entry.propertyKey]),
    ).toEqual([
      ["Mesh Kind", "meshKind"],
      ["Mesh", "assetGuid"],
      ["Material", "materialGuid"],
    ]);
    const mesh = api?.variables?.find((entry) => entry.propertyKey === "assetGuid");
    expect(mesh?.typeId).toBe("asset");
    expect(mesh?.typeClassId).toBe("Model");
    expect(mesh?.typeClassIds).toEqual(["Mesh", "Model"]);
    expect(
      api?.variables?.find((entry) => entry.propertyKey === "materialGuid"),
    ).toMatchObject({ typeId: "asset", typeClassId: "Material" });
  });

  it("exposes Sprite and Tilemap assets plus sorting", () => {
    expect(
      engineScriptApiFor("SpriteComponent")?.variables?.map((entry) => [
        entry.name,
        entry.propertyKey,
      ]),
    ).toEqual([
      ["Sprite", "assetGuid"],
      ["Sorting Layer", "sortingLayer"],
      ["Order In Layer", "orderInLayer"],
    ]);
    expect(
      engineScriptApiFor("TilemapComponent")?.variables?.map((entry) => [
        entry.name,
        entry.propertyKey,
      ]),
    ).toEqual([
      ["Tilemap", "assetGuid"],
      ["Sorting Layer", "sortingLayer"],
      ["Order In Layer", "orderInLayer"],
    ]);
    expect(engineScriptApiFor("SkyboxComponent")?.variables).toEqual([
      { name: "Size", typeId: "float", propertyKey: "size" },
    ]);
  });

  it("exposes Camera lens knobs and Possess, Light extras, and Nav Agent Move To", () => {
    expect(
      engineScriptApiFor("CameraComponent")?.variables?.map(
        (entry) => entry.propertyKey,
      ),
    ).toEqual([
      "fieldOfView",
      "orthographicSize",
      "projectionMode",
      "nearClip",
      "farClip",
    ]);
    expect(engineScriptFunctionsFor("CameraComponent")).toEqual([
      expect.objectContaining({ name: "Possess", runtime: "possessCamera" }),
    ]);
    expect(
      engineScriptApiFor("LightComponent")?.variables?.map(
        (entry) => entry.propertyKey,
      ),
    ).toEqual([
      "enabled",
      "color",
      "intensity",
      "lightKind",
      "range",
      "innerAngle",
      "outerAngle",
      "castShadows",
    ]);
    expect(
      engineScriptApiFor("NavAgentComponent")?.variables?.map(
        (entry) => entry.propertyKey,
      ),
    ).toEqual(["radius", "height", "maxSpeed", "maxAcceleration"]);
    expect(
      engineScriptFunctionsFor("NavAgentComponent").map((entry) => [
        entry.name,
        entry.runtime,
      ]),
    ).toEqual([
      ["Move To", "moveTo"],
      ["Stop Movement", "stopMovement"],
    ]);
  });

  it("exposes 2D text overlay knobs, Audio clip and On Audio Finished, particle and physics extras", () => {
    expect(
      engineScriptApiFor("2DTextComponent")?.variables?.map(
        (entry) => entry.propertyKey,
      ),
    ).toEqual([
      "text",
      "size",
      "color",
      "fontAssetGuid",
      "hitTest",
      "renderer",
      "outline",
      "outlineColor",
      "alignment",
      "verticalAlignment",
      "bold",
      "italic",
      "underline",
      "wrapWidth",
      "wrapHeight",
    ]);
    expect(
      engineScriptApiFor("AudioComponent")?.variables?.map(
        (entry) => entry.propertyKey,
      ),
    ).toEqual(["volume", "loop", "audioAssetGuid"]);
    expect(engineScriptEventsFor("AudioComponent")).toEqual([
      expect.objectContaining({
        name: "On Audio Finished",
        eventType: "flow.event.audioFinished",
        exportName: "onAudioFinished",
      }),
    ]);
    expect(
      engineScriptApiFor("ParticleComponent")?.variables?.map(
        (entry) => entry.propertyKey,
      ),
    ).toEqual(["particleSystemGuid", "sortingLayer", "orderInLayer"]);
    expect(
      engineScriptApiFor("RigidBodyComponent")?.variables?.map(
        (entry) => entry.propertyKey,
      ),
    ).toEqual([
      "mass",
      "gravityScale",
      "motionType",
      "linearDamping",
      "angularDamping",
    ]);
    expect(engineScriptFunctionsFor("RigidBodyComponent")).toEqual([
      expect.objectContaining({ name: "Add Impulse", runtime: "addImpulse" }),
    ]);
    expect(
      engineScriptApiFor("ColliderComponent")?.variables?.map(
        (entry) => entry.propertyKey,
      ),
    ).toEqual([
      "isTrigger",
      "friction",
      "restitution",
      "layer",
      "mask",
      "renderInGame",
    ]);
  });

  it("maps event types onto the classes that expose them", () => {
    const types = engineEventTypeClassIds();
    expect(types["flow.event.onClick"]).toEqual(["2DButtonComponent"]);
    expect(types["flow.event.beginOverlap"]).toEqual(["ColliderComponent"]);
    expect(types["flow.event.textChanged"]).toEqual([
      "Text3DComponent",
      "2DTextComponent",
      "2DRichTextComponent",
    ]);
    expect(types["flow.event.audioFinished"]).toEqual(["AudioComponent"]);
    expect(types["flow.event.beginPlay"]).toBeUndefined();
  });
});
