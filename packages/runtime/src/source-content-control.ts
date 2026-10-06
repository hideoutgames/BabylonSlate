import { normalizeWaterDefinition } from "@babylonslate/core";
import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import { parseBehaviourTreeDocument, parseBlackboardDocument } from "@babylonslate/behaviour-tree";
import { normalizeModelPayload, normalizeTilemapPayload, normalizeTilesetPayload, parseSpriteAnimationPayload, type SpritePayload } from "@babylonslate/assets";
import type { ControlMessage } from "@babylonslate/bridge";
import type { RuntimeDriver } from "./driver";

/** Apply the same prepared source controls in worker and in-process hosts. */
export async function applyRuntimeSourceControl(runtime: RuntimeDriver, control: ControlMessage): Promise<boolean> {
  switch (control.type) {
    case "loadSceneContent": runtime.registerSceneContent(control); return true;
    case "loadScripts":
      if (control.replace) await runtime.replaceScriptSources(control.scripts);
      else await runtime.loadScripts(control.scripts);
      for (const entry of control.spawn ?? []) runtime.spawnScriptedActor(entry);
      return true;
    case "loadAnimGraphs":
      for (const entry of control.graphs) { const document = parseAnimGraphDocument(entry.document); if (document) runtime.registerAnimGraph(entry.guid, document); }
      return true;
    case "loadBehaviourTrees":
      for (const entry of control.trees) { const document = parseBehaviourTreeDocument(entry.document); if (document) runtime.registerBehaviourTree(entry.guid, document); }
      for (const entry of control.blackboards ?? []) { const document = parseBlackboardDocument(entry.document); if (document) runtime.registerBlackboard(entry.guid, document); }
      return true;
    case "loadWater": runtime.registerWaterContent(new Map(control.waters.map(entry => [entry.guid, normalizeWaterDefinition(entry.document)]))); return true;
    case "loadTilemaps":
      runtime.registerTileContent({ tilemaps: new Map(control.tilemaps.map(entry => [entry.guid, normalizeTilemapPayload(entry.document)])), tilesets: new Map(control.tilesets.map(entry => [entry.guid, normalizeTilesetPayload(entry.document)])), pixelsPerUnit: control.pixelsPerUnit });
      return true;
    case "loadSprites":
      runtime.registerSpriteContent({ sprites: new Map(control.sprites.flatMap(entry => {
        const document = entry.document as Partial<SpritePayload> | null;
        return document && Array.isArray(document.frames) && Array.isArray(document.clips) ? [[entry.guid, document as SpritePayload] as const] : [];
      })), spriteAnimations: new Map(control.spriteAnimations.map(entry => [entry.guid, parseSpriteAnimationPayload(entry.document)])), pixelsPerUnit: control.pixelsPerUnit });
      return true;
    case "loadModels":
      runtime.registerModelContent({ models: new Map(control.models.map(entry => [entry.guid, normalizeModelPayload(entry.document)])), complexMeshes: new Map((control.complexMeshes ?? []).map(entry => [entry.guid, { vertices: entry.vertices, indices: entry.indices }])) });
      return true;
    case "loadNavMesh": await runtime.loadNavMesh(new Uint8Array(control.bytes)); return true;
    default: return false;
  }
}
