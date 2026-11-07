import { lazy, Suspense, useState, type FunctionComponent } from "react";
import type { IDockviewPanelProps } from "dockview-react";

export type DockPanel = FunctionComponent<IDockviewPanelProps>;

/**
 * A panel from a family module (`asset-panels/`) the Editor route loads the first time a document shows one of the
 * family's panels. Until it has loaded, the panel's body is empty under its tab.
 *
 * A family whose chunk does not download throws to the document's `WorkspaceErrorBoundary`. Vite's preload helper
 * rejects then, or resolves `undefined` when `installPreloadErrorReload` took the error to reload the page and the
 * user stayed on it; both are a failed attempt. React keeps a rejected `lazy()` for good, so a panel that mounts after
 * a failure (the boundary's Retry, or the document opened again) starts a new one, while the panels that failed keep
 * theirs and show the error rather than downloading again in a loop.
 */
export function lazyPanel<M>(load: () => Promise<M>, pick: (module: M) => DockPanel): DockPanel {
  const attempt = () => {
    const next = {
      failed: false,
      Panel: lazy(() =>
        load()
          .then((module: M | undefined) => {
            if (module === undefined) throw new Error("This editor's files didn't download. Retry, or reload the page.");
            return { default: pick(module) };
          })
          .catch((error: unknown) => {
            next.failed = true;
            throw error;
          }),
      ),
    };
    return next;
  };
  let current = attempt();
  const panelForMount = () => {
    if (current.failed) current = attempt();
    return current.Panel;
  };
  return function LazyDockPanel(props: IDockviewPanelProps) {
    const [Panel] = useState(panelForMount);
    return (
      <Suspense fallback={null}>
        <Panel {...props} />
      </Suspense>
    );
  };
}
