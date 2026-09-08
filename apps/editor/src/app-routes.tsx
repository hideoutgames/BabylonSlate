import { Suspense, lazy } from "react";
import {
  usePreventDocumentOverscroll,
  useSuppressIosEditingGestures,
  useSuppressNativeContextMenu,
} from "@babylonslate/editor-kit";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { useDocuments } from "./context/document-context";
import { useOrientationScrollReset } from "./shell/use-orientation-scroll-reset";

import {
  LauncherTransitionProvider,
  EditorRouteReady,
} from "./components/launcher-transition";

const HomeRoute = lazy(() => import("./routes/home-route"));
const EditorRoute = lazy(() => import("./routes/editor-route"));

export function AppRoutes() {
  useSuppressNativeContextMenu();
  useSuppressIosEditingGestures();
  usePreventDocumentOverscroll();
  useOrientationScrollReset();
  const { route } = useDocuments();
  const gallery =
    isTestModeEnabled() &&
    new URLSearchParams(window.location.search).has("gallery");
  return (
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
  );
}
