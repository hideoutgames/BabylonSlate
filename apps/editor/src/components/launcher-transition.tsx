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
import { bootIntroStart, useBootIntro } from "./boot-intro";
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
  /** The first transition continues the boot intro from index.html. */
  boot: boolean;
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

/** The boot intro (index.html) settles its letters at about 2.2 s and fades
 * out over about 1.2 s; the project-open card is quicker. */
const MINIMUM_MS = { boot: 2600, open: 2000 };
const FADE_FALLBACK_MS = { boot: 1800, open: 650 };

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
    boot: true,
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
        boot: false,
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
    // The boot intro started before the bundle ran; read its start late, as
    // its letters may have started after the provider mounted.
    const since =
      (transition.boot && bootIntroStart()) || transition.since;
    const kind = transition.boot ? "boot" : "open";
    const delay = transition.leaving
      ? // transitionend normally releases the route; this also covers browsers
        // that omit the event, such as a backgrounded webview.
        FADE_FALLBACK_MS[kind]
      : Math.max(
          0,
          MINIMUM_MS[kind] - (performance.now() - since),
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
  const label =
    transition?.target === "home"
      ? "Loading Haptic"
      : `Opening ${transition?.label ?? "Haptic"}`;
  const releaseBoot = useCallback(
    () =>
      setTransition((current) =>
        current?.boot && current.leaving ? null : current,
      ),
    [],
  );
  useBootIntro(
    transition?.boot
      ? { leaving: transition.leaving, label, status: transition.status }
      : null,
    releaseBoot,
  );
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
        !transition.boot &&
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
              aria-label={label}
            >
              <section className="slate-splash">
                <span className="slate-splash-wordmark" aria-hidden="true">
                  <span className="slate-splash-wordmark-ca slate-splash-wordmark-red">
                    HAPTIC
                  </span>
                  <span className="slate-splash-wordmark-ca slate-splash-wordmark-amber">
                    HAPTIC
                  </span>
                  <span className="slate-splash-wordmark-ink">HAPTIC</span>
                </span>
                <div className="slate-splash-bottom">
                  <span
                    className="slate-loading-track"
                    aria-hidden="true"
                    data-ready={transition.mounted && transition.settled}
                  >
                    <span />
                  </span>
                  <div className="slate-splash-footer">
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
                    <span className="slate-splash-version">{version}</span>
                  </div>
                </div>
              </section>
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
