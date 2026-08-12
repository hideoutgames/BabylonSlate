/** Reliable ordered channel message types (never through the snapshot buffer). */

import type { SerializedScene } from "@babylonslate/core";

/** Source anchor mapping a generated line back to a graph node. */
export type ScriptAnchorPayload = {
  line: number;
  column: number;
  assetGuid: string;
  graphId: string;
  nodeId: string;
  bodyLine?: number;
};

/** One compiled graph asset shipped to the runtime for a class. */
export type ScriptBundleEntry = {
  assetGuid: string;
  classId: string;
  source: string;
  anchors: ScriptAnchorPayload[];
  entryPoints: Array<{
    name: string;
    event?: "onBeginPlay" | "onTick";
    isAsync: boolean;
  }>;
};

export type ControlMessage =
  | {
      type: "load";
      sceneAssetGuid: string;
      /** Authored scene document. When present, Play instantiates these actors. */
      scene?: SerializedScene;
      seed?: number;
      /** Scene physics world; defaults to 3d when omitted. */
      physicsWorld?: "3d" | "2d";
      gravity?: [number, number, number];
      /** Worker-resolvable URL for HavokPhysics.wasm (3d Play). */
      havokWasmUrl?: string;
    }
  | {
      type: "loadScripts";
      scripts: ScriptBundleEntry[];
      /** Actors to spawn once the scripts are loaded. */
      spawn?: Array<{ classId: string; variables?: Record<string, unknown> }>;
    }
  | { type: "play" }
  | { type: "pause" }
  | { type: "step" }
  | { type: "stop" }
  | { type: "setPaused"; paused: boolean };

export type CommandMessage =
  | {
      type: "spawn";
      slotId: number;
      actorGuid: string;
      classId: string;
    }
  | { type: "despawn"; slotId: number; actorGuid: string }
  | {
      type: "assignMesh";
      slotId: number;
      meshAssetGuid: string | null;
      /** Primitive mesh kind from MeshComponent (`box`, `sphere`, …). */
      meshKind?: string | null;
    }
  | {
      type: "assignMaterial";
      slotId: number;
      materialAssetGuid: string | null;
    }
  | {
      type: "log";
      severity: "verbose" | "log" | "warning" | "error";
      category: string;
      message: string;
      frameId: number;
    }
  | {
      type: "diagnostic";
      code: string;
      message: string;
      assetGuid?: string;
      graphId?: string;
      nodeId?: string;
      stack?: string;
      frameId: number;
      severity: "error" | "warning";
    }
  | {
      type: "stats";
      frameId: number;
      tickIndex: number;
      scriptMs: number;
      physicsMs: number;
      fps?: number;
    }
  | {
      type: "print";
      message: string;
      key: string;
      duration: number;
      color: { x: number; y: number; z: number; w: number };
      frameId: number;
    };

export type BridgeHostMessage =
  | { channel: "control"; payload: ControlMessage }
  | { channel: "input"; payload: ArrayBuffer | SharedArrayBuffer }
  | { channel: "rpc"; payload: unknown }
  /** Hands a consumed transferable snapshot buffer back for reuse (no per-frame alloc). */
  | { channel: "recycleSnapshot"; payload: ArrayBuffer };

export type BridgeWorkerMessage =
  | { channel: "command"; payload: CommandMessage }
  | { channel: "snapshot"; payload: ArrayBuffer; transferable?: true }
  | { channel: "rpc"; payload: unknown };
