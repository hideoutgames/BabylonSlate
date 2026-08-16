import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CONTEXT_MENU_MOVE_TOLERANCE_PX } from "@babylonslate/editor-kit";
import {
  paintSelectTiles,
  resolveContentBrowserPaintHit,
  type ContentBrowserPaintHit,
  type ContentBrowserSelection,
} from "./content-browser-helpers";

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

type PaintSession = {
  pointerId: number;
  startX: number;
  startY: number;
  hits: ContentBrowserPaintHit[];
  armed: boolean;
  menuOpened: boolean;
};

function hitKey(hit: ContentBrowserPaintHit): string {
  return hit.kind === "asset" ? `asset:${hit.guid}` : `folder:${hit.path}`;
}

function addHit(hits: ContentBrowserPaintHit[], hit: ContentBrowserPaintHit | null): boolean {
  if (!hit) return false;
  const key = hitKey(hit);
  if (hits.some((existing) => hitKey(existing) === key)) return false;
  hits.push(hit);
  return true;
}

export function useContentBrowserPaintSelect(options: {
  onPaint: (selection: ContentBrowserSelection) => void;
}): {
  gridBind: {
    onPointerDownCapture: (event: ReactPointerEvent) => void;
    onPointerMoveCapture: (event: ReactPointerEvent) => void;
    onPointerUpCapture: (event: ReactPointerEvent) => void;
    onPointerCancelCapture: (event: ReactPointerEvent) => void;
    style: CSSProperties;
  };
  consumeSelectClick: () => boolean;
  markMenuOpened: () => void;
  painting: boolean;
} {
  const { onPaint } = options;
  const onPaintRef = useRef(onPaint);
  onPaintRef.current = onPaint;
  const sessionRef = useRef<PaintSession | null>(null);
  const suppressClickRef = useRef(false);
  const [painting, setPainting] = useState(false);

  const emitPaint = useCallback((hits: ContentBrowserPaintHit[]) => {
    onPaintRef.current(paintSelectTiles(hits));
  }, []);

  const endSession = useCallback((event: ReactPointerEvent) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.armed) {
      suppressClickRef.current = true;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* capture may already be released */
      }
    }
    sessionRef.current = null;
    setPainting(false);
  }, []);

  const onPointerDownCapture = useCallback((event: ReactPointerEvent) => {
    if (sessionRef.current) return;
    suppressClickRef.current = false;
    const hit = resolveContentBrowserPaintHit(event.target as Element | null);
    if (!hit) return;
    sessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      hits: [hit],
      armed: false,
      menuOpened: false,
    };
  }, []);

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== event.pointerId || session.menuOpened) {
        return;
      }
      if (!session.armed) {
        if (
          distance(session.startX, session.startY, event.clientX, event.clientY) <=
          CONTEXT_MENU_MOVE_TOLERANCE_PX
        ) {
          return;
        }
        session.armed = true;
        setPainting(true);
        event.preventDefault();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* jsdom / already captured */
        }
        addHit(
          session.hits,
          resolveContentBrowserPaintHit(
            document.elementFromPoint(event.clientX, event.clientY),
          ),
        );
        emitPaint(session.hits);
        return;
      }
      event.preventDefault();
      const added = addHit(
        session.hits,
        resolveContentBrowserPaintHit(
          document.elementFromPoint(event.clientX, event.clientY),
        ),
      );
      if (added) emitPaint(session.hits);
    },
    [emitPaint],
  );

  const consumeSelectClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  const markMenuOpened = useCallback(() => {
    suppressClickRef.current = true;
    const session = sessionRef.current;
    if (session) session.menuOpened = true;
  }, []);

  return {
    gridBind: {
      onPointerDownCapture,
      onPointerMoveCapture,
      onPointerUpCapture: endSession,
      onPointerCancelCapture: endSession,
      style: { touchAction: painting ? "none" : undefined },
    },
    consumeSelectClick,
    markMenuOpened,
    painting,
  };
}
