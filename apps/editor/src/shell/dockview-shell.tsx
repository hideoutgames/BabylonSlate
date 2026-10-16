import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelProps,
} from "dockview-react";
import type { DockviewDocumentKind } from "./default-layout";
import "dockview-react/dist/styles/dockview.css";
import "./dockview-theme.css";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FunctionComponent,
} from "react";
import { cn } from "@babylonslate/ui/lib/utils";
import { createDefaultLayoutForKind } from "./default-layout";
import { panelComponents } from "./panel-registry";
import { usePlatformLayoutOptions } from "./use-platform-layout";
import type { AnimEditorMode } from "./anim-document-layout";
import type { SceneMode } from "./scene-document-layout";
import {
  enterPhoneDockLayout,
  inlineDetachedDockviewLayout,
} from "./phone-dock-layout";
import { PhoneWindowSwitcher } from "./phone-window-switcher";
import {
  listDockWindows,
  LOCKS_WINDOW_ID,
  type DockWindowDefinition,
} from "./window-catalog";
import {
  FUNCTION_GRAPH_PANEL_COMPONENT,
  isFunctionGraphPanelId,
} from "./function-graph-panels";
import { profileComponents } from "../lib/render-profile";

type DockviewLayout = ReturnType<DockviewApi["toJSON"]>;

const SPACED_THEME: DockviewTheme = { ...themeAbyss, gap: 4 };
let dockPanelComponents:
  | Record<string, FunctionComponent<IDockviewPanelProps>>
  | undefined;
/**
 * Each dock panel kind is one `panel:<component>` profiling region in test
 * builds. Wrapped on first render, not at import: a bundle chunk cycle can
 * evaluate this module before `render-profile` has initialized, which would
 * silently keep the unwrapped registry. One map serves every shell, so a kind
 * keeps one wrapper type across documents.
 */
function profiledDockPanelComponents() {
  return (dockPanelComponents ??= profileComponents<IDockviewPanelProps>(
    "panel:",
    panelComponents,
  ));
}

/**
 * Catalog windows a document hides: Prefab and Components outside the Actor
 * lineage, Locks without source control.
 */
function closeHiddenWindows(
  api: DockviewApi,
  { actorPrefab, sourceControl }: { actorPrefab: boolean; sourceControl: boolean },
): void {
  if (!actorPrefab) {
    api.getPanel("prefab-viewport")?.api.close();
    api.getPanel("actor-prefab")?.api.close();
  }
  if (!sourceControl) api.getPanel(LOCKS_WINDOW_ID)?.api.close();
}

/**
 * A saved layout keeps each tab's title from when it was saved. Catalog
 * windows show their current title instead, so a renamed window reads the
 * same in older projects; other tabs, such as function graphs, keep theirs.
 */
function withCatalogTitles(
  layout: DockviewLayout,
  windows: readonly DockWindowDefinition[],
): DockviewLayout {
  if (!layout?.panels) return layout;
  const panels = { ...layout.panels };
  for (const window of windows) {
    const saved = panels[window.id];
    if (saved && saved.title !== window.title) {
      panels[window.id] = { ...saved, title: window.title };
    }
  }
  return { ...layout, panels };
}

function sameWindows(
  current: readonly DockWindowDefinition[],
  next: readonly DockWindowDefinition[],
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (entry, index) =>
        entry.id === next[index]!.id && entry.title === next[index]!.title,
    )
  );
}

export interface DockviewShellProps {
  documentKind: DockviewDocumentKind;
  onReady?: (api: DockviewApi) => void;
  initialLayout?: Record<string, unknown> | null;
  actorPrefab?: boolean;
  sourceControl?: boolean;
  animEditorMode?: AnimEditorMode;
  sceneMode?: SceneMode;
}

export function DockviewShell({
  documentKind,
  onReady,
  initialLayout,
  actorPrefab = true,
  sourceControl = false,
  animEditorMode,
  sceneMode,
}: DockviewShellProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [functionWindows, setFunctionWindows] = useState<
    DockWindowDefinition[]
  >([]);
  const phoneLayoutRef = useRef<ReturnType<typeof enterPhoneDockLayout> | null>(
    null,
  );
  const initialDesktopLayoutRef = useRef<
    ReturnType<DockviewApi["toJSON"]> | undefined
  >(undefined);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const initialLayoutRef = useRef(initialLayout);
  initialLayoutRef.current = initialLayout;
  const hiddenWindowsRef = useRef({ actorPrefab, sourceControl });
  hiddenWindowsRef.current = { actorPrefab, sourceControl };
  const platformOptions = usePlatformLayoutOptions();

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Retitled before the phone keeps it as the layout to return to.
      const savedLayout = initialLayoutRef.current;
      const originalLayout = savedLayout
        ? withCatalogTitles(
            savedLayout as unknown as DockviewLayout,
            listDockWindows(documentKind, {
              actorPrefab,
              sourceControl,
              animEditorMode,
              sceneMode,
            }),
          )
        : undefined;
      const hostLayout =
        originalLayout && platformOptions.disableFloatingGroups
          ? inlineDetachedDockviewLayout(originalLayout)
          : originalLayout;
      if (hostLayout) {
        event.api.fromJSON(hostLayout);
      } else {
        createDefaultLayoutForKind(
          event.api,
          documentKind,
          { actorPrefab, sourceControl, animEditorMode, sceneMode },
          hostRef.current?.clientWidth ?? 0,
        );
      }
      closeHiddenWindows(event.api, { actorPrefab, sourceControl });
      // A phone returns to the saved floating and popout groups, not the
      // inlined grid; hidden windows close again after that restore.
      if (platformOptions.singleWindow && hostLayout !== originalLayout) {
        initialDesktopLayoutRef.current = originalLayout;
      }

      setApi(event.api);
      onReadyRef.current?.(event.api);
    },
    [
      documentKind,
      actorPrefab,
      sourceControl,
      animEditorMode,
      sceneMode,
      platformOptions.disableFloatingGroups,
      platformOptions.singleWindow,
    ],
  );

  useLayoutEffect(() => {
    if (!api) return;
    const updateSelection = () => setActivePanelId(api.activePanel?.id ?? null);
    // Open function graph tabs join the phone Window picker; a rename only
    // reaches it through the layout change Dockview fires for a new title.
    const updateFunctionWindows = () => {
      const next = api.panels
        .filter((panel) => isFunctionGraphPanelId(panel.id))
        .map((panel) => ({
          id: panel.id,
          component: FUNCTION_GRAPH_PANEL_COMPONENT,
          title: panel.api.title ?? panel.id,
        }));
      setFunctionWindows((current) =>
        sameWindows(current, next) ? current : next,
      );
    };
    updateSelection();
    updateFunctionWindows();
    const subscriptions = [
      api.onDidActivePanelChange(() => {
        updateSelection();
        updateFunctionWindows();
      }),
      api.onDidAddPanel(updateFunctionWindows),
      api.onDidRemovePanel(updateFunctionWindows),
      api.onDidLayoutChange(updateFunctionWindows),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [api]);

  useLayoutEffect(() => {
    if (api) closeHiddenWindows(api, { actorPrefab, sourceControl });
  }, [api, actorPrefab, sourceControl]);

  useLayoutEffect(() => {
    if (!api) return;
    if (platformOptions.singleWindow && !phoneLayoutRef.current) {
      phoneLayoutRef.current = enterPhoneDockLayout(
        api,
        initialDesktopLayoutRef.current,
      );
      initialDesktopLayoutRef.current = undefined;
    } else if (!platformOptions.singleWindow && phoneLayoutRef.current) {
      phoneLayoutRef.current.restore({
        allowDetached: !platformOptions.disableFloatingGroups,
      });
      phoneLayoutRef.current = null;
      closeHiddenWindows(api, hiddenWindowsRef.current);
    }
  }, [
    api,
    platformOptions.singleWindow,
    platformOptions.disableFloatingGroups,
  ]);

  useLayoutEffect(() => () => phoneLayoutRef.current?.dispose(), []);

  const windows = [
    ...listDockWindows(documentKind, {
      actorPrefab,
      sourceControl,
      animEditorMode,
      sceneMode,
    }),
    ...functionWindows,
  ];
  const selectWindow = (id: string) => {
    const dock = apiRef.current;
    if (!dock) return;
    const existing = dock.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const window = windows.find((entry) => entry.id === id);
    if (window) {
      dock.addPanel({
        id: window.id,
        component: window.component,
        title: window.title,
      });
    }
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      data-layout={platformOptions.singleWindow ? "phone" : "docked"}
    >
      <div
        ref={hostRef}
        className={cn(
          "min-h-0 min-w-0 flex-1",
          !platformOptions.singleWindow && "dockview-frame",
        )}
      >
        <DockviewReact
          className={cn(
            "dockview-theme-babylonslate h-full w-full",
            platformOptions.singleWindow && "phone-dockview",
          )}
          theme={platformOptions.singleWindow ? themeAbyss : SPACED_THEME}
          dndStrategy={platformOptions.dndStrategy}
          disableDnd={platformOptions.singleWindow}
          disableFloatingGroups={platformOptions.disableFloatingGroups}
          onReady={handleReady}
          components={profiledDockPanelComponents()}
        />
      </div>
      {platformOptions.singleWindow && (
        <PhoneWindowSwitcher
          windows={windows}
          activeId={activePanelId}
          onSelect={selectWindow}
        />
      )}
    </div>
  );
}
