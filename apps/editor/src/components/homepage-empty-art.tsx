import { lazy, Suspense, useSyncExternalStore } from "react";
import { brandIconSrc } from "../lib/branding";
const Sculpture = lazy(() => import("./homepage-sculpture"));
const query = "(min-width: 700px) and (min-height: 520px)";
function subscribe(update: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
export function HomepageEmptyArt({ scheme }: { scheme: "light" | "dark" }) {
  const desktop = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
  return (
    <div className="homepage-empty-art" aria-hidden="true">
      <div className="homepage-empty-object">
        <span />
        <span />
        <img src={brandIconSrc(scheme)} alt="" />
      </div>
      {desktop && (
        <Suspense fallback={null}>
          <Sculpture />
        </Suspense>
      )}
    </div>
  );
}
