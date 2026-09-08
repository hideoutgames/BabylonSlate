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
import { brandIconSrc } from "../lib/branding";
import { useHomepageScheme } from "./homepage-scheme";
import loadingStyles from "./launcher-transition.css?inline";

type Target = "home" | "editor";
type Transition = {
  target: Target;
  label: string;
  since: number;
  mounted: boolean;
  settled: boolean;
  leaving: boolean;
};
const TransitionContext = createContext({
  begin: (_label: string) => {},
  ready: (_target: Target) => {},
  settle: () => {},
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
    since: performance.now(),
    mounted: false,
    settled: true,
    leaving: false,
  }));
  const begin = useCallback(
    (label: string) =>
      setTransition({
        target: "editor",
        label,
        since: performance.now(),
        mounted: false,
        settled: false,
        leaving: false,
      }),
    [],
  );
  const ready = useCallback(
    (target: Target) =>
      setTransition((current) =>
        current?.target === target && !current.mounted
          ? { ...current, mounted: true }
          : current,
      ),
    [],
  );
  const settle = useCallback(
    () =>
      setTransition((current) =>
        current ? { ...current, settled: true } : current,
      ),
    [],
  );
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
      ? 420
      : Math.max(0, 2000 - (performance.now() - transition.since));
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
  const value = useMemo(
    () => ({ begin, ready, settle }),
    [begin, ready, settle],
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
              <div className="slate-loading-mark">
                <img src={brandIconSrc(scheme)} alt="" />
              </div>
              <span className="slate-loading-label">{transition.label}</span>
              <span className="slate-loading-track" aria-hidden="true">
                <span />
              </span>
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
