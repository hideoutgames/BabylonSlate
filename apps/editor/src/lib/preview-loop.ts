import { useSyncExternalStore } from "react";
import type { DockviewPanelApi } from "dockview-react";
import { editorQuiet, subscribeEditorQuiet } from "./editor-quiet";
import { useDockPanelShown } from "./use-dock-panel-shown";

/**
 * Whether an asset preview's frame loop should run: its dock panel is on screen
 * (`useDockPanelShown`, so the panel's document is the active tab too) and no
 * game view covers the editor (`editorQuiet`: Play or Preview Build; a
 * Simulation or a Play stopped at a breakpoint shows the editor and keeps the
 * previews running). Without a Dockview API only the document and Play count.
 */
export function usePreviewLoopActive(api?: DockviewPanelApi): boolean {
  const shown = useDockPanelShown(api);
  const quiet = useSyncExternalStore(subscribeEditorQuiet, editorQuiet, editorQuiet);
  return shown && !quiet;
}

export type PreviewFrameLoop = {
  /** Starts or stops the loop; a start calls `resume` before the first frame is requested. */
  setActive: (active: boolean) => void;
  dispose: () => void;
};

/**
 * A `requestAnimationFrame` loop that requests no frame while inactive. A
 * preview presenter idles once its frame settled, so `resume` forces a fresh
 * frame, and a time-driven preview drops the time it was paused for there.
 * It starts inactive.
 */
export function createPreviewFrameLoop(frame: () => void, resume: () => void): PreviewFrameLoop {
  let id = 0;
  let active = false;
  let disposed = false;
  const request = () => {
    if (active && !disposed && id === 0) id = window.requestAnimationFrame(tick);
  };
  // `frame` and `resume` may stop or restart the loop themselves, so each request checks the state again.
  function tick() {
    id = 0;
    frame();
    request();
  }
  return {
    setActive: (next) => {
      if (disposed || next === active) return;
      active = next;
      if (!next) {
        window.cancelAnimationFrame(id);
        id = 0;
        return;
      }
      resume();
      request();
    },
    dispose: () => {
      disposed = true;
      active = false;
      window.cancelAnimationFrame(id);
      id = 0;
    },
  };
}
