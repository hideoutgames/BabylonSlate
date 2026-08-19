import { uiHostStats } from "@babylonslate/render";
import type { WidgetLayout } from "@babylonslate/ui-runtime";
import { uiDesignStrokeMergeKey } from "../components/ui-design-gestures";

export interface UiDesignerLiveHost {
  setGestureLocked?(locked: boolean): void;
  patchLiveLayout?(id: string, layout: WidgetLayout): void;
  markAsDirty?(): void;
}

export interface UiDesignerSessionOptions {
  getHost: () => UiDesignerLiveHost | null | undefined;
  present: () => void;
  schedule: (work: () => void) => void;
  commitLayout: (id: string, layout: WidgetLayout, mergeKey?: string) => void;
  onOverlay?: (id: string, layout: WidgetLayout) => void;
}

export interface UiDesignerSession {
  readonly locked: boolean;
  readonly widgetId: string | null;
  readonly layout: WidgetLayout | null;
  preview(widgetId: string, layout: WidgetLayout): void;
  commit(layout?: WidgetLayout): void;
  cancel(): void;
}

function newStrokeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** One layout stroke: live ADT patch + overlay, document commit on pointer-up. */
export function createUiDesignerSession(
  options: UiDesignerSessionOptions,
): UiDesignerSession {
  let widgetId: string | null = null;
  let layout: WidgetLayout | null = null;
  let origin: WidgetLayout | null = null;
  let strokeId: string | null = null;
  let scheduled = false;

  const host = () => options.getHost();

  const lock = (locked: boolean) => {
    host()?.setGestureLocked?.(locked);
  };

  const flushPresent = () => {
    scheduled = false;
    options.present();
  };

  const begin = (id: string) => {
    widgetId = id;
    strokeId = newStrokeId();
    lock(true);
  };

  const end = () => {
    widgetId = null;
    layout = null;
    origin = null;
    strokeId = null;
    scheduled = false;
    lock(false);
  };

  const session: UiDesignerSession = {
    get locked() {
      return widgetId !== null;
    },
    get widgetId() {
      return widgetId;
    },
    get layout() {
      return layout;
    },
    preview(id, next) {
      if (widgetId && widgetId !== id) {
        session.commit();
      }
      if (!widgetId) {
        begin(id);
        origin = next;
      }
      layout = next;
      const live = host();
      live?.patchLiveLayout?.(id, next);
      live?.markAsDirty?.();
      options.onOverlay?.(id, next);
      if (scheduled) return;
      scheduled = true;
      options.schedule(flushPresent);
    },
    commit(next) {
      if (!widgetId || !strokeId) {
        if (next && widgetId) {
          options.commitLayout(widgetId, next);
        }
        end();
        return;
      }
      const id = widgetId;
      const committed = next ?? layout;
      const mergeKey = uiDesignStrokeMergeKey(strokeId);
      end();
      if (committed) {
        options.commitLayout(id, committed, mergeKey);
        uiHostStats.commit += 1;
      }
    },
    cancel() {
      const id = widgetId;
      const restored = origin;
      if (id && restored) {
        const live = host();
        live?.patchLiveLayout?.(id, restored);
        live?.markAsDirty?.();
        options.onOverlay?.(id, restored);
        try {
          options.present();
        } finally {
          end();
        }
        return;
      }
      end();
    },
  };
  return session;
}
