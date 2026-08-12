export type EditorLoopHandle = {
  setAlwaysRender: (value: boolean) => void;
  setPaused: (value: boolean) => void;
  stats: () => {
    renderedFps: number;
    invalidationsPerSecond: number;
  };
};

/** Fan-out Always Render / pause / HUD stats to every live editor canvas. */
export class EditorSchedulerRegistry {
  private readonly handles = new Set<EditorLoopHandle>();
  private alwaysRender = true;

  register(handle: EditorLoopHandle): () => void {
    this.handles.add(handle);
    handle.setAlwaysRender(this.alwaysRender);
    return () => {
      this.handles.delete(handle);
    };
  }

  setAlwaysRender(value: boolean): void {
    this.alwaysRender = value;
    for (const handle of this.handles) {
      handle.setAlwaysRender(value);
    }
  }

  setPaused(value: boolean): void {
    for (const handle of this.handles) {
      handle.setPaused(value);
    }
  }

  stats(): {
    renderedFps: number;
    invalidationsPerSecond: number;
  } | null {
    for (const handle of this.handles) {
      return handle.stats();
    }
    return null;
  }
}
