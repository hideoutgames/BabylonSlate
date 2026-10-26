export type EditorLoopHandle = {
  setAlwaysRender: (value: boolean) => void;
  setPaused: (value: boolean) => void;
  /**
   * Hold this viewport's frames (a render scheduler obstruction lease); the
   * returned release ends only this hold. Unlike `setPaused`, it leaves audio,
   * particles and the pause that Play, scene loads and the app lifecycle share
   * untouched, and a loading scene still presents its frames.
   */
  holdFrames: () => () => void;
};

/**
 * Fan-out to every live editor canvas: the app lifecycle pause (`setPaused`)
 * and the Save All frame hold (`setFramesHeld`). They are separate gates, so
 * ending one never ends the other. Always Render stays on.
 */
export class EditorSchedulerRegistry {
  /** Each live canvas, with the release of its frame hold while one is held. */
  private readonly handles = new Map<EditorLoopHandle, (() => void) | null>();
  private paused = false;
  private framesHeld = false;

  register(handle: EditorLoopHandle): () => void {
    handle.setAlwaysRender(true);
    // A canvas mounted while the editor is paused starts paused too.
    if (this.paused) handle.setPaused(true);
    // A canvas mounted during a hold is held with the others.
    this.handles.set(handle, this.framesHeld ? handle.holdFrames() : null);
    return () => {
      const release = this.handles.get(handle);
      this.handles.delete(handle);
      release?.();
    };
  }

  setPaused(value: boolean): void {
    this.paused = value;
    for (const handle of this.handles.keys()) {
      handle.setPaused(value);
    }
  }

  setFramesHeld(held: boolean): void {
    if (held === this.framesHeld) return;
    this.framesHeld = held;
    for (const [handle, release] of this.handles) {
      this.handles.set(handle, held ? handle.holdFrames() : null);
      release?.();
    }
  }
}
