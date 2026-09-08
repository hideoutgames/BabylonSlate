import { Suspense, lazy } from "react";
import {
  usePreventDocumentOverscroll,
  useSuppressIosEditingGestures,
  useSuppressNativeContextMenu,
} from "@babylonslate/editor-kit";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { useDocuments } from "./context/document-context";
import { useOrientationScrollReset } from "./shell/use-orientation-scroll-reset";

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
    <Suspense
      fallback={
        <div
          className="safe-frame flex h-full items-center justify-center bg-background text-muted-foreground"
          role="status"
        >
          Opening Slate…
        </div>
      }
    >
      {gallery ? (
        <EditorRoute gallery />
      ) : route === "home" ? (
        <HomeRoute />
      ) : (
        <EditorRoute />
      )}
    </Suspense>
  );
}
