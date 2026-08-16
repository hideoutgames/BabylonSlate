export type EditorLoopHandle = {
  setAlwaysRender: (value: boolean) => void;
  setPaused: (value: boolean) => void;
};

/** Fan-out pause to every live editor canvas; Always Render stays on. */
export class EditorSchedulerRegistry {
  private readonly handles = new Set<EditorLoopHandle>();

  register(handle: EditorLoopHandle): () => void {
    this.handles.add(handle);
    handle.setAlwaysRender(true);
    return () => {
      this.handles.delete(handle);
    };
  }

  setPaused(value: boolean): void {
    for (const handle of this.handles) {
      handle.setPaused(value);
    }
  }
}
