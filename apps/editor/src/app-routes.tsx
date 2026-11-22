import { Suspense, lazy } from "react";
import {
  usePreventDocumentOverscroll,
  useSuppressIosEditingGestures,
  useSuppressNativeContextMenu,
} from "@haptic/editor-kit";
import { isTestModeEnabled } from "@haptic/vfs";
import { useAppRoute } from "./context/document-context";
import { useOrientationScrollReset } from "./shell/use-orientation-scroll-reset";

import {
  LauncherTransitionProvider,
  EditorRouteReady,
} from "./components/launcher-transition";
import { RouteErrorBoundary } from "./components/route-error-boundary";

const HomeRoute = lazy(() => import("./routes/home-route"));
// The editor reads Model geometry synchronously (collision, regenerated colliders, root motion) and decodes meshopt
// geometry, so opening a project also waits for the decoder; the Homepage never loads it.
const EditorRoute = lazy(() => Promise.all([
  import("./routes/editor-route"),
  import("@haptic/assets/gltf-geometry-decoders").then(({ gltfGeometryDecodersReady }) => gltfGeometryDecodersReady()),
]).then(([route]) => route));

export function AppRoutes() {
  const route = useAppRoute();
  const gallery =
    isTestModeEnabled() &&
    new URLSearchParams(window.location.search).has("gallery");
  useSuppressNativeContextMenu();
  useSuppressIosEditingGestures(gallery || route !== "home");
  usePreventDocumentOverscroll();
  useOrientationScrollReset();
  return (
    <RouteErrorBoundary>
      <LauncherTransitionProvider route={gallery ? "editor" : route}>
        <Suspense fallback={null}>
          {gallery ? (
            <>
              <EditorRoute gallery />
              <EditorRouteReady />
            </>
          ) : route === "home" ? (
            <HomeRoute />
          ) : (
            <>
              <EditorRoute />
              <EditorRouteReady />
            </>
          )}
        </Suspense>
      </LauncherTransitionProvider>
    </RouteErrorBoundary>
  );
}
