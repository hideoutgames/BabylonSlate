import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph } from "@haptic/anim-graph";
import { ASSET_TYPES, findExecuteJavaScriptNodes, normalizeEmbeddedScript, type SerializedGraph } from "@haptic/core";
import { compileAnimGraphScripts, compileGraphDocuments } from "./script-compiler";
import { EMBEDDED_SCRIPT_OWNER_TYPES, SCRIPT_ASSET_TYPES } from "./play-asset-sources";

/**
 * The import scan (`findExecuteJavaScriptNodes`) and the Play and export gate (the compiler's
 * `executeJavaScriptNodes`) must see the same Execute JavaScript in every asset type that holds a
 * script graph. Every asset type is listed here, either with a document carrying the node where its
 * editor stores it and the compile path Play and export use, or as holding no script graph; a new
 * type fails until it is placed.
 */
const ENTRY = { id: "begin", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} };
const executeJavaScript = (id: string) =>
  ({ id, type: "debug.executeJavaScript", position: { x: 200, y: 0 }, data: { body: `ctx.log(${JSON.stringify(id)});`, inputs: [], outputs: [] } });
const wire = (source: string, target: string, sourceHandle = "execOut") =>
  ({ id: `${source}-${target}`, source, target, sourceHandle, targetHandle: "execIn" });
const scriptGraph = (nodeId: string): SerializedGraph => ({ nodes: [ENTRY, executeJavaScript(nodeId)], edges: [wire("begin", nodeId)] });

type Fixture = { document: Record<string, unknown>; compile: (document: Record<string, unknown>) => string[] };

const compiledClass = (content: SerializedGraph, classId = "Hero") =>
  compileGraphDocuments([{ path: `assets/${classId}.class.hasset`, content, parentClassId: "Actor" }], { throwOnError: true })
    .flatMap((script) => script.executeJavaScriptNodes ?? []);
const embeddedScript = (document: Record<string, unknown>, classId: string) =>
  compiledClass(normalizeEmbeddedScript(document.script)!, classId);
const animationGraph = (dimension: "3d" | "2d"): Fixture => {
  const graph = createDefaultAnimGraph("Loco", { dimension });
  graph.animationObject = {
    ...graph.animationObject,
    nodes: [...graph.animationObject.nodes, executeJavaScript("animation")],
    edges: [wire("event-initialize", "animation")],
  };
  return {
    document: graph as unknown as Record<string, unknown>,
    compile: (document) => compileAnimGraphScripts([{ guid: "loco", path: "assets/Loco.hasset", document }], { throwOnError: true })
      .flatMap((script) => script.executeJavaScriptNodes ?? []),
  };
};

const SCRIPT_GRAPH_FIXTURES: Record<string, Fixture> = {
  Class: {
    document: {
      ...scriptGraph("event"),
      members: [{ id: "fn", kind: "function", name: "Fire", pins: [] }],
      functionGraphs: {
        fn: {
          nodes: [{ id: "entry", type: "flow.function.input", position: { x: 0, y: 0 }, data: {} }, executeJavaScript("inFunction")],
          edges: [wire("entry", "inFunction", "exec")],
        },
      },
    },
    compile: (document) => compiledClass(document as unknown as SerializedGraph),
  },
  Scene: { document: { actors: [], script: scriptGraph("scene") }, compile: (document) => embeddedScript(document, "Scene_level") },
  SceneLayer: { document: { actors: [], script: scriptGraph("layer") }, compile: (document) => embeddedScript(document, "SceneLayer_hud") },
  AnimationGraph3D: animationGraph("3d"),
  AnimationGraph2D: animationGraph("2d"),
};

/** Types whose documents hold no script graph: data, media, and Material, Particle and other non-script graphs. */
const NO_SCRIPT_GRAPH = [
  "Animation", "Audio", "AudioChannel", "AudioMixer", "BehaviourTree", "Blackboard", "BlendSpace", "CameraShake",
  "ColorCurve", "DataDefinition", "DataTree", "Enum", "FloatCurve", "Font", "GlobalParameterCollection", "InputAction",
  "InputAxis", "Material", "MaterialFunction", "MaterialInstance", "Model", "ParticleEmitter", "ParticleGraph",
  "ParticleSystem", "PluginSettings", "Prefab", "RenderTarget", "RenderTargetTexture", "SaveGame", "ScriptInterface",
  "Skeleton", "SkyboxCreator", "SoundAttenuation", "Sprite", "SpriteAnimation", "SpriteBlendSpace", "Structure",
  "Texture", "Tilemap", "Tileset", "Timeline", "TimelineClip2D", "TimelineClip3D", "Trace", "VectorCurve", "Water",
];

describe("Execute JavaScript coverage of script graph assets", () => {
  it("places every asset type, and gives every type the Play compile reads a script fixture", () => {
    expect([...Object.keys(SCRIPT_GRAPH_FIXTURES), ...NO_SCRIPT_GRAPH].sort()).toEqual([...ASSET_TYPES].sort());
    for (const type of [...SCRIPT_ASSET_TYPES, ...EMBEDDED_SCRIPT_OWNER_TYPES]) expect(Object.keys(SCRIPT_GRAPH_FIXTURES)).toContain(type);
  });

  it.each(Object.entries(SCRIPT_GRAPH_FIXTURES))("%s: the import scan finds each node the compiler ships", (_type, fixture) => {
    const compiled = fixture.compile(fixture.document);
    expect(compiled.length).toBeGreaterThan(0);
    expect(findExecuteJavaScriptNodes(fixture.document).map((node) => node.nodeId).sort()).toEqual([...compiled].sort());
  });
});
