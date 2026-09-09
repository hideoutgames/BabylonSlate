import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { brandIconSrc } from "../lib/branding";
const Sculpture = lazy(() => import("./homepage-sculpture"));
const query = "(min-width: 700px) and (min-height: 520px)";
function subscribe(update: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
export function HomepageEmptyArt({
  scheme,
  onReady,
  paused = false,
}: {
  scheme: "light" | "dark";
  onReady?: () => void;
  paused?: boolean;
}) {
  const desktop = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
  useEffect(() => {
    if (!desktop) onReady?.();
  }, [desktop, onReady]);
  return (
    <div className="homepage-empty-art" aria-hidden="true">
      {!desktop && (
        <div className="homepage-empty-object">
          <span />
          <span />
          <img src={brandIconSrc(scheme)} alt="" />
        </div>
      )}
      {desktop && (
        <Suspense fallback={null}>
          <Sculpture onReady={onReady} paused={paused} />
        </Suspense>
      )}
    </div>
  );
}
