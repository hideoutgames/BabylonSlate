import { lazy, Suspense } from "react";

const Sculpture = lazy(() => import("./homepage-sculpture"));

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
    </div>
  );
}
