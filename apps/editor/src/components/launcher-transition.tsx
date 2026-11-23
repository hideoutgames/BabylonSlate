import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "@haptic/editor-kit";
import { getBuildLabel } from "../lib/build-identity";
import type { LaunchPhase } from "../lib/create-project";
import { bootIntroStart, useBootIntro } from "./boot-intro";
import loadingStyles from "./launcher-transition.css?inline";

type Target = "home" | "editor";
type Transition = {
  target: Target;
  label: string;
  /** The boot intro's and the Homepage's loading step (`reportHomeLoading`). */
  status: string;
  /** A project open's broad step (`begin`, `setPhase`). */
  phase: LaunchPhase;
  /** The creation's whole percent while `phase` is `creating`, else null. */
  progress: number | null;
  since: number;
  mounted: boolean;
  readyAt: number | null;
  settled: boolean;
  leaving: boolean;
  /** The first transition continues the boot intro from index.html. */
  boot: boolean;
};
const TransitionContext = createContext<{
  /** Shows the project card for `label`, starting at `phase` (Opening project unless creating). */
  begin: (label: string, phase?: LaunchPhase) => void;
  /** The project open moved on to `phase`; nothing while no open is under way. */
  setPhase: (phase: LaunchPhase) => void;
  /** The creation's percent so far; it only rises, and counts only while the card names Creating Project. */
  setProgress: (percent: number) => void;
  ready: (target: Target) => void;
  settle: () => void;
  reportHomeLoading: (status: string) => void;
  active: boolean;
}>({
  begin: () => {},
  setPhase: () => {},
  setProgress: () => {},
  ready: () => {},
  settle: () => {},
  reportHomeLoading: () => {},
  active: false,
});
export const useLauncherTransition = () => useContext(TransitionContext);

const PHASE_STATUS: Record<LaunchPhase, string> = {
  creating: "Creating Project…",
  "source-control": "Initializing Source Control…",
  opening: "Opening Project…",
};

/**
 * The card's status: the boot intro's and the Homepage's loading step, or a
 * project open's phase, which becomes Preparing Editor… once the editor has
 * mounted beneath the card. A later step (a Remote New Project's
 * Publish) keeps its own name, whichever of the two comes first.
 */
function statusOf(transition: Transition): string {
  if (transition.mounted && transition.settled) return "Ready";
  if (transition.boot || transition.target === "home") return transition.status;
  return transition.mounted && transition.phase === "opening" ? "Preparing Editor…" : PHASE_STATUS[transition.phase];
}

/** The boot intro (index.html) settles its letters at about 2.2 s and then
 * ends at once; the project-open card is quicker and fades out. */
const MINIMUM_MS = { boot: 2600, open: 2000 };
const OPEN_FADE_FALLBACK_MS = 650;

export function LauncherTransitionProvider({
  route,
  children,
}: {
  route: string;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [transition, setTransition] = useState<Transition | null>(() => ({
    target: route === "home" ? "home" : "editor",
    label: "Haptic",
    status: "Loading application",
    phase: "opening",
    progress: null,
    since: performance.now(),
    mounted: false,
    readyAt: null,
    settled: true,
    leaving: false,
    boot: true,
  }));
  const begin = useCallback(
    (label: string, phase: LaunchPhase = "opening") =>
      setTransition({
        target: "editor",
        label,
        status: "",
        phase,
        progress: phase === "creating" ? 0 : null,
        since: performance.now(),
        mounted: false,
        readyAt: null,
        settled: false,
        leaving: false,
        boot: false,
      }),
    [],
  );
  const setProgress = useCallback(
    (percent: number) =>
      setTransition((current) =>
        current?.target === "editor" &&
        !current.boot &&
        !current.settled &&
        current.phase === "creating" &&
        percent > (current.progress ?? -1)
          ? { ...current, progress: percent }
          : current,
      ),
    [],
  );
  const setPhase = useCallback(
    (phase: LaunchPhase) =>
      setTransition((current) =>
        current?.target === "editor" && !current.boot && !current.settled && current.phase !== phase
          ? { ...current, phase }
          : current,
      ),
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
        OPEN_FADE_FALLBACK_MS
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
            ? // The boot intro ends at once; only the project-open card fades.
              current.leaving || reducedMotion || current.boot
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
  const status = transition ? statusOf(transition) : "";
  const showProgress =
    transition?.progress != null && status === PHASE_STATUS.creating;
  useBootIntro(transition?.boot ? { label, status } : null);
  const value = useMemo(
    () => ({
      begin,
      setPhase,
      setProgress,
      ready,
      settle,
      reportHomeLoading,
      active,
    }),
    [begin, setPhase, setProgress, ready, settle, reportHomeLoading, active],
  );
  return (
    <TransitionContext.Provider value={value}>
      <div
        className="haptic-route-surface"
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
              className="haptic-loading"
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
              <section className="haptic-splash">
                <span className="haptic-splash-wordmark" aria-hidden="true">
                  <span className="haptic-splash-wordmark-ca haptic-splash-wordmark-red">
                    HAPTIC
                  </span>
                  <span className="haptic-splash-wordmark-ca haptic-splash-wordmark-amber">
                    HAPTIC
                  </span>
                  <span className="haptic-splash-wordmark-ink">HAPTIC</span>
                </span>
                <div className="haptic-splash-bottom">
                  <span
                    className="haptic-loading-track"
                    aria-hidden="true"
                    data-ready={transition.mounted && transition.settled}
                  >
                    <span />
                  </span>
                  <div className="haptic-splash-footer">
                    <div className="haptic-splash-text">
                      {transition.target !== "home" && (
                        <span className="haptic-loading-label">
                          {transition.label}
                        </span>
                      )}
                      <span className="haptic-splash-status">
                        {status}
                        {/* Outside the announced text, so a screen reader does not read out every percent. */}
                        {showProgress && (
                          <span aria-hidden="true"> {transition.progress}%</span>
                        )}
                      </span>
                    </div>
                    <span className="haptic-splash-version">{version}</span>
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
