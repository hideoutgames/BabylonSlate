import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DockviewReact,
  themeAbyss,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelProps,
} from "dockview-react";
import {
  AppWindowIcon,
  BugIcon,
  ChevronDownIcon,
  FolderIcon,
  HammerIcon,
  LayoutGridIcon,
  Maximize2Icon,
  PanelsTopLeftIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SaveAllIcon,
  SearchIcon,
  SettingsIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  PanelFrame,
  PropertyGrid,
  SearchInput,
  TreeView,
  TypeColorMark,
  TypeVisualIcon,
  pinPickerColorVar,
  resolveTypeVisual,
  type TreeViewNode,
} from "@haptic/editor-kit";
import { GraphEditor, type GraphDocument } from "@haptic/graph-ui";
import { Button } from "@haptic/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@haptic/ui/components/empty";
import { Field, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import { Toggle } from "@haptic/ui/components/toggle";
import { cn } from "@haptic/ui/lib/utils";
import { themeCssVariables, type ThemeColors } from "../lib/editor-themes";
import { IconActionButton } from "./icon-action-button";
import { ProjectIdentityMark } from "./project-identity-mark";
import "dockview-react/dist/styles/dockview.css";
import "../shell/dockview-theme.css";
import "../shell/editor-chrome.css";

/**
 * A static Class document built from the editor's own chrome classes, Dockview
 * theme, trees, graph and Inspector controls. It is laid out at desktop size
 * and scaled down to fit, so it reads as the editor in miniature.
 */
const PREVIEW_WIDTH = 1440;
const PREVIEW_HEIGHT = 900;

const NOOP = () => undefined;

/** Non-interactive miniature of the editor, drawn with a theme's colors. */
export function ThemePreview({ colors }: { colors: ThemeColors }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const width = frame.clientWidth;
      if (width > 0) setScale(width / PREVIEW_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // React Flow measures pin positions with getBoundingClientRect, which includes
  // our scale and any ancestor transform such as the dialog's open animation.
  // Lay the graph out at full size until fonts load and nothing above is
  // transformed, then shrink it; pin positions stay correct since nodes don't resize.
  const [measured, setMeasured] = useState(false);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let cancelled = false;
    let frameId = 0;
    let settledFrames = 0;
    const deadline = performance.now() + 2000;
    const settle = () => {
      if (cancelled) return;
      const untransformed = Math.abs(frame.getBoundingClientRect().width - frame.offsetWidth) < 0.5;
      settledFrames = untransformed ? settledFrames + 1 : 0;
      if (settledFrames >= 3 || performance.now() > deadline) setMeasured(true);
      else frameId = requestAnimationFrame(settle);
    };
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (!cancelled) frameId = requestAnimationFrame(settle);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, []);

  return (
    <div
      ref={frameRef}
      aria-hidden="true"
      inert
      data-testid="application-theme-preview"
      className="pointer-events-none relative w-full max-w-[640px] select-none overflow-hidden rounded-lg border border-border"
      style={{
        ...(themeCssVariables(colors) as CSSProperties),
        aspectRatio: `${PREVIEW_WIDTH} / ${PREVIEW_HEIGHT}`,
      }}
    >
      <div
        className="absolute left-0 top-0 flex origin-top-left flex-col bg-background text-foreground"
        style={{
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
          transform: measured ? `scale(${scale})` : undefined,
          visibility: measured ? undefined : "hidden",
        }}
      >
        <PreviewChrome />
        <div className="dockview-frame min-h-0 flex-1">
          <DockviewReact
            className="dockview-theme-haptic h-full w-full"
            theme={PREVIEW_DOCK_THEME}
            disableDnd
            disableFloatingGroups
            onReady={buildPreviewLayout}
            components={PREVIEW_PANELS}
          />
        </div>
        <footer className="editor-statusbar">
          <p className="editor-status-summary">
            <span>All Changes Saved</span>
            <span aria-hidden="true">·</span>
            <span className="editor-status-document">Mannequin Class</span>
          </p>
          <span className="editor-status-version">Development build</span>
        </footer>
      </div>
    </div>
  );
}

const PREVIEW_DOCK_THEME: DockviewTheme = { ...themeAbyss, gap: 4 };

function buildPreviewLayout({ api }: DockviewReadyEvent) {
  api.addPanel({ id: "event-graph", component: "graph", title: "Event Graph" });
  api.addPanel({
    id: "prefab",
    component: "blank",
    title: "Prefab",
    position: { referencePanel: "event-graph", direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: "compiler-results",
    component: "compilerResults",
    title: "Compiler Results",
    position: { referencePanel: "event-graph", direction: "below" },
    initialHeight: 160,
  });
  api.addPanel({
    id: "components",
    component: "components",
    title: "Components",
    position: { direction: "left" },
    initialWidth: 256,
  });
  api.addPanel({
    id: "class",
    component: "classMembers",
    title: "Class",
    position: { referencePanel: "components", direction: "below" },
  });
  api.addPanel({
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    position: { direction: "right" },
    initialWidth: 280,
  });
  // Root-edge panels ignore their initial size; match the editor's default columns.
  api.getPanel("components")?.group.api.setSize({ width: 256 });
  api.getPanel("inspector")?.group.api.setSize({ width: 280 });
  api.getPanel("compiler-results")?.group.api.setSize({ height: 160 });
  api.getPanel("class")?.group.api.setSize({ height: 410 });
}

function ChromeTab({
  icon,
  label,
  active,
  closable,
  sortable,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  closable?: boolean;
  sortable?: boolean;
}) {
  return (
    <div
      className={cn(
        "chrome-tab",
        sortable ? "chrome-tab-closable" : "chrome-tab-pinned",
        active && "chrome-tab-active",
      )}
    >
      <Button variant="ghost" size="sm" tabIndex={-1} className="chrome-tab-label">
        {icon}
        <span>{label}</span>
      </Button>
      {closable ? (
        <Button variant="ghost" size="icon-sm" tabIndex={-1} className="chrome-tab-close" aria-label={`Close ${label}`}>
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}

function PreviewChrome() {
  const sceneVisual = resolveTypeVisual({ assetType: "Scene" });
  const classVisual = resolveTypeVisual({ assetType: "Class", ancestry: ["Actor"] });
  return (
    <div className="editor-chrome-shell" data-phone="false">
      <header className="editor-chrome-bar">
        <div className="editor-chrome-title">
          <ProjectIdentityMark className="editor-chrome-brand" />
          <span className="editor-chrome-project">ShotProject</span>
        </div>
        <div className="editor-chrome-tabs">
          <div className="editor-chrome-tabs-pinned">
            <ChromeTab icon={<LayoutGridIcon className="size-4 shrink-0" />} label="Content Browser" />
            <ChromeTab
              icon={<TypeVisualIcon visual={sceneVisual} className="size-4 shrink-0" />}
              label="Main Scene"
              closable
            />
          </div>
          <div className="editor-chrome-tabs-scroll">
            <ChromeTab
              icon={<TypeVisualIcon visual={classVisual} className="size-4 shrink-0" />}
              label="Mannequin Class"
              active
              closable
              sortable
            />
          </div>
          <Button variant="ghost" size="icon-sm" tabIndex={-1} className="document-switcher" aria-label="Open Documents">
            <PanelsTopLeftIcon data-icon="inline-start" />
          </Button>
        </div>
      </header>
      <div className="editor-global-toolbar">
        <div className="editor-global-toolbar-start">
          <Button variant="outline" size="icon-sm" tabIndex={-1} disabled className="chrome-action-feedback chrome-icon-button" aria-label="Save All">
            <SaveAllIcon />
          </Button>
          <Button variant="outline" size="icon-sm" tabIndex={-1} disabled className="chrome-action-feedback chrome-icon-button" aria-label="Undo">
            <Undo2Icon />
          </Button>
          <Button variant="outline" size="icon-sm" tabIndex={-1} disabled className="chrome-action-feedback chrome-icon-button" aria-label="Redo">
            <Redo2Icon />
          </Button>
          <Button variant="outline" size="sm" tabIndex={-1} className="chrome-action-feedback chrome-action-button">
            <HammerIcon data-icon="inline-start" />
            <span className="chrome-optional-label">Compile</span>
          </Button>
        </div>
        <div className="editor-global-toolbar-center">
          <div className="editor-play-island">
            <Button size="sm" variant="ghost" tabIndex={-1} className="chrome-action-button chrome-play-button relative">
              <PlayIcon data-icon="inline-start" fill="currentColor" />
              Play
            </Button>
            <Button size="sm" variant="ghost" tabIndex={-1} className="chrome-action-button">
              <BugIcon data-icon="inline-start" />
              Debug
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </div>
        </div>
        <div className="editor-global-toolbar-end">
          <Button size="sm" variant="outline" tabIndex={-1} className="chrome-action-button">
            <AppWindowIcon data-icon="inline-start" />
            Windows
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
          <Toggle variant="outline" size="sm" tabIndex={-1} pressed={false} className="chrome-icon-button" aria-label="Focus">
            <Maximize2Icon />
          </Toggle>
          <IconActionButton label="Search Project" tabIndex={-1} className="chrome-icon-button">
            <SearchIcon />
          </IconActionButton>
          <Button size="sm" variant="outline" tabIndex={-1} className="chrome-action-button">
            <SettingsIcon data-icon="inline-start" />
            Settings
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}

const COMPONENT_ROWS: TreeViewNode[] = [
  { id: "prefab-root", label: "Prefab Root", depth: 0, hasChildren: true, expanded: true },
  ...[
    ["prefab-mesh", "Mesh (mannequin)", "MeshComponent"],
    ["prefab-anim-graph", "Animation Graph (Mannequin)", "AnimationGraphComponent"],
    ["prefab-rigid-body", "Rigid Body", "RigidBodyComponent"],
    ["prefab-collider", "Collider", "ColliderComponent"],
  ].map(([id, label, classId]) => ({
    id: id!,
    label: label!,
    depth: 1,
    hasChildren: false,
    expanded: false,
    icon: <TypeVisualIcon visual={resolveTypeVisual({ classId })} />,
  })),
];

function ComponentsPanel(_props: IDockviewPanelProps) {
  void _props;
  return (
    <PanelFrame>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-panel-header px-1 py-1">
          <SearchInput className="h-7" placeholder="Search components" value="" onChange={NOOP} tabIndex={-1} />
          <IconActionButton label="Add Component" tabIndex={-1}>
            <PlusIcon />
          </IconActionButton>
        </div>
        <div className="min-h-0 flex-1">
          <TreeView nodes={COMPONENT_ROWS} selectedId="prefab-root" aria-label="Components" />
        </div>
      </div>
    </PanelFrame>
  );
}

function addButton(label: string) {
  return (
    <IconActionButton label={label} tabIndex={-1}>
      <PlusIcon />
    </IconActionButton>
  );
}

const componentVariable = (id: string, label: string): TreeViewNode => ({
  id,
  label,
  depth: 2,
  hasChildren: false,
  expanded: false,
  icon: <TypeColorMark colorVar={pinPickerColorVar("object")} />,
});

const eventMember = (id: string, label: string): TreeViewNode => ({
  id,
  label,
  depth: 1,
  hasChildren: false,
  expanded: false,
  icon: <TypeColorMark colorVar="var(--node-event)" />,
});

const CLASS_ROWS: TreeViewNode[] = [
  { id: "section-functions", label: "Functions", depth: 0, hasChildren: true, expanded: true, trailing: addButton("Add Function") },
  { id: "section-variables", label: "Variables", depth: 0, hasChildren: true, expanded: true, trailing: addButton("Add Variable") },
  { id: "section-components", label: "Components", depth: 1, hasChildren: true, expanded: true, icon: <FolderIcon /> },
  componentVariable("var-mesh", "Mesh"),
  componentVariable("var-anim-graph", "Animation Graph"),
  componentVariable("var-rigid-body", "Rigid Body"),
  componentVariable("var-collider", "Collider"),
  { id: "section-events", label: "Events", depth: 0, hasChildren: true, expanded: true, trailing: addButton("Add Event") },
  eventMember("event-begin-play", "Event Begin Play"),
  eventMember("event-tick", "Event Tick"),
  { id: "section-interfaces", label: "Interfaces", depth: 0, hasChildren: true, expanded: true, trailing: addButton("Add Interface") },
];

function ClassMembersPanel(_props: IDockviewPanelProps) {
  void _props;
  return (
    <PanelFrame>
      <div className="flex h-full min-h-0 flex-col">
        <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground">Mannequin</p>
        <div className="relative min-h-0 flex-1">
          <TreeView nodes={CLASS_ROWS} aria-label="Class" />
        </div>
      </div>
    </PanelFrame>
  );
}

const execPin = (id: string, name: string, direction: "in" | "out") => ({
  id,
  name,
  direction,
  type: { kind: "exec" },
  kind: "exec",
  optional: false,
});

const floatPin = (id: string, direction: "in" | "out") => ({
  id,
  name: "deltaSeconds",
  direction,
  type: { kind: "float" },
  kind: "data",
  optional: false,
});

/** The Class template's Event Graph: Begin Play and Tick calling their parents. */
const PREVIEW_GRAPH = {
  nodes: [
    {
      id: "event-begin-play",
      type: "flow.event.beginPlay",
      position: { x: 0, y: 0 },
      data: { title: "Event Begin Play", __pins: [execPin("execOut", "then", "out")], __category: "flow", __pure: true },
    },
    {
      id: "call-begin-play-parent",
      type: "flow.event.callParent",
      position: { x: 440, y: 0 },
      data: {
        title: "Call Begin Play Parent",
        __pins: [execPin("execIn", "exec", "in"), execPin("execOut", "then", "out")],
        __category: "flow",
      },
    },
    {
      id: "event-tick",
      type: "flow.event.tick",
      position: { x: 0, y: 200 },
      data: {
        title: "Event Tick",
        __pins: [execPin("execOut", "then", "out"), floatPin("deltaSeconds", "out")],
        __category: "flow",
        __pure: true,
      },
    },
    {
      id: "call-tick-parent",
      type: "flow.event.callParent",
      position: { x: 440, y: 200 },
      data: {
        title: "Call Tick Parent",
        __pins: [
          execPin("execIn", "exec", "in"),
          execPin("execOut", "then", "out"),
          floatPin("deltaSeconds", "in"),
          floatPin("deltaSeconds__out", "out"),
        ],
        __category: "flow",
      },
    },
  ],
  edges: [
    { id: "begin-play", source: "event-begin-play", target: "call-begin-play-parent", sourceHandle: "execOut", targetHandle: "execIn" },
    { id: "tick", source: "event-tick", target: "call-tick-parent", sourceHandle: "execOut", targetHandle: "execIn" },
    { id: "delta", source: "event-tick", target: "call-tick-parent", sourceHandle: "deltaSeconds", targetHandle: "deltaSeconds" },
  ],
} as unknown as GraphDocument;

const PREVIEW_VIEWPORT = { x: 150, y: 190, zoom: 0.8 };

/** Shows the toolbar's Add Node; the palette never opens in the preview. */
const PREVIEW_PALETTE = [{ id: "flow.event.beginPlay", title: "Event Begin Play", category: "flow" }];

function GraphPanel(_props: IDockviewPanelProps) {
  void _props;
  return (
    <PanelFrame>
      <GraphEditor initialGraph={PREVIEW_GRAPH} sessionViewport={PREVIEW_VIEWPORT} paletteNodes={PREVIEW_PALETTE} />
    </PanelFrame>
  );
}

function CompilerResultsPanel(_props: IDockviewPanelProps) {
  void _props;
  return (
    <PanelFrame>
      <Empty>
        <EmptyTitle>No Issues</EmptyTitle>
        <EmptyDescription>Compiler diagnostics appear here.</EmptyDescription>
      </Empty>
    </PanelFrame>
  );
}

function InspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  return (
    <PanelFrame>
      <FieldGroup className="p-4">
        <Field>
          <FieldLabel>Parent Class</FieldLabel>
          <Button type="button" variant="outline" tabIndex={-1} className="min-h-[var(--touch-target,44px)] w-full justify-start">
            Actor
          </Button>
        </Field>
      </FieldGroup>
      <PropertyGrid
        title="Actor Defaults"
        rows={[
          { id: "generateHitEvents", kind: "boolean", label: "Generate Hit Events", value: true, defaultValue: true, onChange: NOOP },
          { id: "generateOverlapEvents", kind: "boolean", label: "Generate Overlap Events", value: true, defaultValue: true, onChange: NOOP },
          {
            id: "eventTick",
            kind: "enum",
            label: "Event Tick",
            value: "inherit",
            defaultValue: "inherit",
            options: [{ value: "inherit", label: "Inherit (Enabled)" }],
            onChange: NOOP,
          },
        ]}
      />
      <p className="p-4 text-sm text-muted-foreground">
        Prefab Origin is the actor transform in the Scene. Drag the viewport gizmo on Prefab Root to move that origin
        relative to the components.
      </p>
    </PanelFrame>
  );
}

function BlankPanel(_props: IDockviewPanelProps) {
  void _props;
  return <PanelFrame>{null}</PanelFrame>;
}

const PREVIEW_PANELS = {
  graph: GraphPanel,
  blank: BlankPanel,
  compilerResults: CompilerResultsPanel,
  components: ComponentsPanel,
  classMembers: ClassMembersPanel,
  inspector: InspectorPanel,
};
