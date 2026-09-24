import { lazy, Suspense } from "react";

const Sculpture = lazy(() => import("./homepage-sculpture"));

/** Decorative viewport: the Slate model over a scene-style grid floor. */
export function HomepageEmptyArt({
  onReady,
  paused = false,
}: {
  onReady?: () => void;
  paused?: boolean;
}) {
  return (
    <div className="homepage-empty-art" aria-hidden="true">
      <Suspense fallback={null}>
        <Sculpture onReady={onReady} paused={paused} />
      </Suspense>
      <div className="homepage-viewport-chips">
        <span>Perspective</span>
        <span>3D</span>
      </div>
    </div>
  );
}
