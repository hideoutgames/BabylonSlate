/** Reliable ordered channel message types (never through the snapshot buffer). */

export type ControlMessage =
  | { type: "load"; sceneAssetGuid: string; seed?: number }
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
  | { channel: "rpc"; payload: unknown };

export type BridgeWorkerMessage =
  | { channel: "command"; payload: CommandMessage }
  | { channel: "snapshot"; payload: ArrayBuffer; transferable?: true }
  | { channel: "rpc"; payload: unknown };
