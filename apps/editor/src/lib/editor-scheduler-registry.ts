export type EditorLoopHandle = {
  setAlwaysRender: (value: boolean) => void;
  setPaused: (value: boolean) => void;
};

/** Fan-out pause to every live editor canvas; Always Render stays on. */
export class EditorSchedulerRegistry {
  private readonly handles = new Set<EditorLoopHandle>();
  private paused = false;

  register(handle: EditorLoopHandle): () => void {
    this.handles.add(handle);
    handle.setAlwaysRender(true);
    // A canvas mounted while the editor is paused starts paused too.
    if (this.paused) handle.setPaused(true);
    return () => {
      this.handles.delete(handle);
    };
  }

  setPaused(value: boolean): void {
    this.paused = value;
    for (const handle of this.handles) {
      handle.setPaused(value);
    }
  }
}
