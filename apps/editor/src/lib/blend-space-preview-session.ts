import {
  ANIM_POSE_BLEND_SPACE_PLAYER_TYPE,
  ANIM_POSE_OUTPUT_NODE_ID,
  createDefaultAnimGraph,
  evaluateAnimGraph,
  type AnimEvalState,
  type AnimGraphDocument,
  type BlendSpaceNodeData,
} from "@haptic/anim-graph";

/** A long frame (a hidden tab) advances the Preview at most this much. */
const MAX_FRAME_SECONDS = 0.1;
const PLAYER_ID = "blend-space";

export type BlendSpacePreviewSnapshot = {
  state: AnimEvalState | null;
  playing: boolean;
  speed: number;
};

/** A one-state graph whose state is the Blend Space Player, as the evaluator plays it in a game. */
function previewGraph(blendSpace: BlendSpaceNodeData): AnimGraphDocument {
  const base = createDefaultAnimGraph("Blend Space Preview", { dimension: "3d" });
  return {
    ...base,
    stateMachine: {
      entryStateId: "preview",
      transitions: [],
      states: [{
        id: "preview",
        name: "Preview",
        position: { x: 0, y: 0 },
        stateGraph: {
          nodes: [
            { id: PLAYER_ID, type: ANIM_POSE_BLEND_SPACE_PLAYER_TYPE, position: { x: 0, y: 0 }, data: { assetGuid: "preview", blendSpace } },
            { id: ANIM_POSE_OUTPUT_NODE_ID, type: "anim.pose.output", position: { x: 300, y: 0 }, data: { __protected: true } },
          ],
          edges: [{ id: "preview-output", source: PLAYER_ID, sourceHandle: "pose", target: ANIM_POSE_OUTPUT_NODE_ID, targetHandle: "pose" }],
        },
      }],
    },
  };
}

/**
 * The Blend Space editor's Preview: the Blend Space played by the game's evaluator at the Grid's preview point, so
 * weights, time sync and smoothing look as they will in a game.
 */
export class BlendSpacePreviewSession {
  private doc = previewGraph({ axes: [], samples: [] });
  private point = { x: 0, y: 0 };
  private snapshot: BlendSpacePreviewSnapshot = { state: null, playing: true, speed: 1 };
  private readonly listeners = new Set<() => void>();

  /** A new Blend Space keeps the playing phase. */
  setBlendSpace(blendSpace: BlendSpaceNodeData): void {
    this.doc = previewGraph(blendSpace);
    this.tick(0);
  }

  setPoint(point: { x: number; y: number }): void {
    if (point.x === this.point.x && point.y === this.point.y) return;
    this.point = point;
    this.tick(0);
  }

  /** Real time × Speed while playing, at most a tenth of a second at once. */
  advanceRealTime(seconds: number): void {
    if (!this.snapshot.playing) return;
    this.tick(Math.min(MAX_FRAME_SECONDS, Math.max(0, seconds)) * this.snapshot.speed);
  }

  tick(dtSeconds: number): void {
    const point = this.point;
    const state = evaluateAnimGraph(this.doc, this.snapshot.state, dtSeconds, {
      poseData: () => ({ [PLAYER_ID]: { x: point.x, y: point.y } }),
    });
    this.emit({ ...this.snapshot, state });
  }

  setPlaying(playing: boolean): void {
    this.emit({ ...this.snapshot, playing });
  }

  setSpeed(speed: number): void {
    this.emit({ ...this.snapshot, speed });
  }

  getSnapshot = (): BlendSpacePreviewSnapshot => this.snapshot;

  getState = (): AnimEvalState | null => this.snapshot.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(snapshot: BlendSpacePreviewSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
