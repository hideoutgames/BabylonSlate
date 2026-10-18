import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getBuildLabel } from "../lib/build-identity";
import { brandWordmarkSrc } from "../lib/branding";
import loadingStyles from "./launcher-transition.css?inline";

type Target = "home" | "editor";
type Transition = {
  target: Target;
  label: string;
  status: string;
  since: number;
  mounted: boolean;
  readyAt: number | null;
  settled: boolean;
  leaving: boolean;
};
const TransitionContext = createContext<{
  begin: (label: string) => void;
  ready: (target: Target) => void;
  settle: () => void;
  reportHomeLoading: (status: string) => void;
  active: boolean;
}>({
  begin: () => {},
  ready: () => {},
  settle: () => {},
  reportHomeLoading: () => {},
  active: false,
});
export const useLauncherTransition = () => useContext(TransitionContext);

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(update: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}
function prefersReducedMotion() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function LauncherTransitionProvider({
  route,
  children,
}: {
  route: string;
  children: ReactNode;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => false,
  );
  const [transition, setTransition] = useState<Transition | null>(() => ({
    target: route === "home" ? "home" : "editor",
    label: "Haptic",
    status: "Loading application",
    since: performance.now(),
    mounted: false,
    readyAt: null,
    settled: true,
    leaving: false,
  }));
  const begin = useCallback(
    (label: string) =>
      setTransition({
        target: "editor",
        label,
        status: "Opening project",
        since: performance.now(),
        mounted: false,
        readyAt: null,
        settled: false,
        leaving: false,
      }),
    [],
  );
  const ready = useCallback(
    (target: Target) =>
      setTransition((current) =>
        current?.target === target && !current.mounted
          ? {
              ...current,
              mounted: true,
              readyAt: current.settled ? performance.now() : null,
              status: current.settled ? "Ready" : "Preparing editor",
            }
          : current,
      ),
    [],
  );
  const settle = useCallback(
    () =>
      setTransition((current) =>
        current
          ? {
              ...current,
              settled: true,
              readyAt: current.mounted ? performance.now() : null,
              status: current.mounted ? "Ready" : current.status,
            }
          : current,
      ),
    [],
  );
  const reportHomeLoading = useCallback((status: string) => {
    setTransition((current) =>
      current?.target === "home" &&
      !current.mounted &&
      current.status !== status
        ? { ...current, status }
        : current,
    );
  }, []);
  const version = getBuildLabel();
  useEffect(() => {
    if (!transition) return;
    if (
      transition.target === "editor" &&
      transition.settled &&
      route === "home"
    ) {
      setTransition(null);
      return;
    }
    if (!transition.mounted || !transition.settled) return;
    // CSS removes the fade immediately when the preference changes. Release
    // the matching interaction cover in the same update, including mid-fade.
    if (transition.leaving && reducedMotion) {
      setTransition(null);
      return;
    }
    const delay = transition.leaving
      ? // transitionend normally releases the route; this also covers browsers
        // that omit the event, such as a backgrounded webview.
        650
      : Math.max(
          0,
          2000 - (performance.now() - transition.since),
          transition.target === "editor"
            ? 600 -
                (performance.now() - (transition.readyAt ?? performance.now()))
            : 0,
        );
    const timer = window.setTimeout(
      () =>
        setTransition((current) =>
          current === transition
            ? current.leaving || reducedMotion
              ? null
              : { ...current, leaving: true }
            : current,
        ),
      delay,
    );
    return () => clearTimeout(timer);
  }, [transition, route, reducedMotion]);
  const active = Boolean(transition);
  const value = useMemo(
    () => ({
      begin,
      ready,
      settle,
      reportHomeLoading,
      active,
    }),
    [begin, ready, settle, reportHomeLoading, active],
  );
  return (
    <TransitionContext.Provider value={value}>
      <div
        className="slate-route-surface"
        style={{ height: "100%" }}
        inert={Boolean(transition)}
      >
        {children}
      </div>
      {transition &&
        createPortal(
          <>
            <style>{loadingStyles}</style>
            <div
              className="slate-loading"
              data-leaving={transition.leaving}
              onTransitionEnd={(event) => {
                if (
                  event.target !== event.currentTarget ||
                  event.propertyName !== "opacity"
                )
                  return;
                setTransition((current) =>
                  current === transition && current.leaving ? null : current,
                );
              }}
              role="status"
              aria-live="polite"
              aria-label={
                transition.target === "home"
                  ? "Loading Haptic"
                  : `Opening ${transition.label}`
              }
            >
              <section className="slate-splash">
                <img
                  className="slate-splash-wordmark"
                  src={brandWordmarkSrc("dark")}
                  alt=""
                />
                <div className="slate-splash-text">
                  {transition.target !== "home" && (
                    <span className="slate-loading-label">
                      {transition.label}
                    </span>
                  )}
                  <span className="slate-splash-status">
                    {transition.status}
                  </span>
                </div>
                <span
                  className="slate-loading-track"
                  aria-hidden="true"
                  data-ready={transition.mounted && transition.settled}
                >
                  <span />
                </span>
              </section>
              <span className="slate-splash-version">{version}</span>
            </div>
          </>,
          document.body,
        )}
    </TransitionContext.Provider>
  );
}
export function EditorRouteReady() {
  const { ready } = useLauncherTransition();
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => ready("editor"));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready]);
  return null;
}
