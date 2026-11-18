import { useCallback, useEffect, useRef } from "react";
import { prefersReducedMotion, zoomViewAbout, type PanZoomSurface, type PanZoomView } from "@haptic/editor-kit";
import { createViewportZoomDrive, type ViewportZoomDrive } from "@haptic/render";

/**
 * The **Viewport Zoom Buttons** drive for a flat pan-zoom surface (a texture, sprite or artboard preview): zooms the
 * view about the surface centre within the surface's own pinch limits, and ends a held press at either limit. The view
 * it sets counts as adjusted, as a pinch does, so the host's Fit / Actual Size toggles release.
 */
export function usePanZoomDrive(surface: Pick<PanZoomSurface, "view" | "surfaceSize" | "limits" | "setView">): () => ViewportZoomDrive | null {
  // Read at each frame, so the drive never zooms from a stale view or size.
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const driveRef = useRef<ViewportZoomDrive | null>(null);
  // The last view the drive set, and the view it came from: until the host re-renders, the next frame builds on it.
  const pendingRef = useRef<{ from: PanZoomView; to: PanZoomView } | null>(null);

  useEffect(() => {
    const drive = createViewportZoomDrive(
      {
        zoom: (factor: number) => {
          const { view: rendered, surfaceSize, limits, setView } = surfaceRef.current;
          const pending = pendingRef.current;
          const view = pending && pending.from === rendered ? pending.to : rendered;
          if (!view) return;
          const centre = { x: surfaceSize.width / 2, y: surfaceSize.height / 2 };
          const next = zoomViewAbout(view, factor, centre, limits);
          pendingRef.current = { from: rendered!, to: next };
          setView(next);
        },
      },
      {
        instantStep: prefersReducedMotion,
        atLimit: (direction) => {
          const { view: rendered, limits } = surfaceRef.current;
          const pending = pendingRef.current;
          const view = pending && pending.from === rendered ? pending.to : rendered;
          if (!view) return true;
          return direction === 1 ? view.scale >= limits.maxScale : view.scale <= limits.minScale;
        },
      },
    );
    driveRef.current = drive;
    return () => {
      drive.dispose();
      driveRef.current = null;
    };
  }, []);

  return useCallback(() => driveRef.current, []);
}
