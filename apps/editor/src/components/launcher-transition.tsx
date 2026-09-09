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
import { getBuildLabel } from "../lib/build-identity";
import { brandIconSrc } from "../lib/branding";
import { useHomepageScheme } from "./homepage-scheme";
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
const TransitionContext = createContext({
  begin: (_label: string) => {},
  ready: (_target: Target) => {},
  settle: () => {},
  reportHomeLoading: (_status: string) => {},
  active: false,
});
export const useLauncherTransition = () => useContext(TransitionContext);
export function LauncherTransitionProvider({
  route,
  children,
}: {
  route: string;
  children: ReactNode;
}) {
  const [scheme] = useHomepageScheme();
  const [transition, setTransition] = useState<Transition | null>(() => ({
    target: route === "home" ? "home" : "editor",
    label: "Slate",
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
    const delay = transition.leaving
      ? 650
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
            ? current.leaving
              ? null
              : { ...current, leaving: true }
            : current,
        ),
      delay,
    );
    return () => clearTimeout(timer);
  }, [transition, route]);
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
              data-scheme={scheme}
              data-leaving={transition.leaving}
              role="status"
              aria-live="polite"
              aria-label={
                transition.target === "home"
                  ? "Loading Slate"
                  : `Opening ${transition.label}`
              }
            >
              <section className="slate-splash-card">
                <div className="slate-splash-art" aria-hidden="true">
                  <div className="slate-splash-brand">
                    <img src={brandIconSrc("dark")} alt="" />
                    <span>Slate</span>
                  </div>
                  <div className="slate-splash-planes">
                    <i />
                    <i />
                    <i />
                  </div>
                  <span className="slate-splash-caption">
                    {transition.target === "home"
                      ? "A blank slate to create with."
                      : "Preparing slate project..."}
                  </span>
                </div>
                <div className="slate-splash-info">
                  <div className="slate-splash-heading">
                    <span className="slate-loading-label">
                      {transition.label}
                    </span>
                    <span className="slate-splash-version">{version}</span>
                  </div>
                  <div className="slate-splash-status">
                    <span>{transition.status}</span>
                  </div>
                  <span
                    className="slate-loading-track"
                    aria-hidden="true"
                    data-ready={transition.mounted && transition.settled}
                  >
                    <span />
                  </span>
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
