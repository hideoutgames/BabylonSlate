import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BoxIcon,
  BoxesIcon,
  BugIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CylinderIcon,
  FileBoxIcon,
  FolderIcon,
  HammerIcon,
  LayersIcon,
  LayoutGridIcon,
  Maximize2Icon,
  MaximizeIcon,
  MinusIcon,
  PanelsTopLeftIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SaveIcon,
  SearchIcon,
  SettingsIcon,
  Undo2Icon,
  WorkflowIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { PinShapeGlyph } from "@babylonslate/editor-kit";
import { themeCssVariables, type ThemeColors } from "../lib/editor-themes";

/**
 * The preview is laid out at editor scale and shrunk to fit, so corner radii,
 * type sizes and node proportions match the real chrome.
 */
const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 600;

/** Non-interactive miniature of a Class document in the editor, drawn with a theme's colors. */
export function ThemePreview({ colors }: { colors: ThemeColors }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
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
        style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, transform: `scale(${scale})` }}
      >
        <ChromeBar />
        <GlobalToolbar />
        <div className="flex min-h-0 flex-1 gap-1 p-1">
          <div className="flex w-[250px] shrink-0 flex-col gap-1">
            <Panel tabs={["Components"]} className="flex-1">
              <ComponentsPanel />
            </Panel>
            <Panel tabs={["Class"]} className="flex-1">
              <ClassPanel />
            </Panel>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Panel tabs={["Event Graph", "Prefab"]} className="flex-1">
              <GraphCanvas />
            </Panel>
            <Panel tabs={["Compiler Results"]} className="h-[118px] shrink-0">
              <div className="flex h-full flex-col items-center justify-center gap-1.5">
                <span className="text-sm font-medium">No Issues</span>
                <span className="text-sm text-muted-foreground">Compiler diagnostics appear here.</span>
              </div>
            </Panel>
          </div>
          <Panel tabs={["Inspector"]} className="w-[270px] shrink-0">
            <InspectorPanel />
          </Panel>
        </div>
        <div className="flex h-6 shrink-0 items-center justify-between px-2 text-[11px] text-muted-foreground">
          <span>
            All Changes Saved · <span className="text-foreground">Mannequin Class</span>
          </span>
          <span>Development build</span>
        </div>
      </div>
    </div>
  );
}

function ChromeTab({
  icon: Icon,
  iconColor,
  label,
  active,
  closable,
}: {
  icon: LucideIcon;
  iconColor?: string;
  label: string;
  active?: boolean;
  closable?: boolean;
}) {
  return (
    <div
      className={`relative flex shrink-0 items-center gap-1 rounded-t-sm border-r border-border/60 pl-2 text-xs ${active ? "bg-card font-medium text-foreground" : "text-muted-foreground"}`}
    >
      <Icon className="size-4" style={iconColor ? { color: iconColor } : undefined} />
      {label}
      {closable ? (
        <span className="flex size-7 items-center justify-center">
          <XIcon className="size-3.5" />
        </span>
      ) : (
        <span className="w-2" />
      )}
      {active ? (
        <span
          className="absolute inset-x-2.5 bottom-0 h-0.5 rounded-t-sm bg-foreground"
          style={{ boxShadow: "var(--brand-fringe)" }}
        />
      ) : null}
    </div>
  );
}

function ChromeBar() {
  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-border bg-background">
      <div className="flex shrink-0 items-center gap-1.5 border-r border-border pl-2 pr-3 text-xs font-semibold">
        <span
          className="grid size-[18px] place-items-center rounded-[5px] border-[1.5px]"
          style={{ borderColor: "var(--foreground)" }}
        >
          <BoxesIcon className="size-[11px]" />
        </span>
        ShotProject
      </div>
      <ChromeTab icon={LayoutGridIcon} label="Content Browser" />
      <ChromeTab icon={LayersIcon} iconColor="var(--asset-scene)" label="Main Scene" closable />
      <ChromeTab icon={FileBoxIcon} iconColor="var(--asset-class)" label="Mannequin Class" active closable />
      <div className="ml-auto flex w-7 items-center justify-center text-muted-foreground">
        <PanelsTopLeftIcon className="size-4" />
      </div>
    </div>
  );
}

function OutlineButton({ children, icon }: { children?: ReactNode; icon?: boolean }) {
  return (
    <span
      className={`flex h-7 items-center justify-center gap-1 rounded-sm border border-input bg-control text-[0.8rem] font-medium ${icon ? "w-7" : "px-2.5"}`}
    >
      {children}
    </span>
  );
}

function GlobalToolbar() {
  return (
    <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1 border-b border-border bg-panel-header px-1.5 py-0.5">
      <div className="flex items-center gap-0.5">
        <OutlineButton icon>
          <SaveIcon className="size-3.5" />
        </OutlineButton>
        <OutlineButton icon>
          <Undo2Icon className="size-3.5" />
        </OutlineButton>
        <OutlineButton icon>
          <Redo2Icon className="size-3.5" />
        </OutlineButton>
        <OutlineButton>
          <HammerIcon className="size-3.5" />
          Compile
        </OutlineButton>
      </div>
      <div className="flex items-stretch rounded-sm bg-accent shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="flex h-7 items-center gap-1 rounded-sm bg-(--play) px-2.5 text-[0.8rem] font-medium text-(--play-foreground)">
          <PlayIcon className="size-3.5 fill-current" />
          Play
        </span>
        <span className="flex h-7 items-center gap-1 px-2 text-[0.8rem] font-medium">
          <BugIcon className="size-3.5" />
          Debug
          <ChevronDownIcon className="size-3.5" />
        </span>
      </div>
      <div className="flex items-center justify-end gap-0.5">
        <OutlineButton>
          <PanelsTopLeftIcon className="size-3.5" />
          Windows
          <ChevronDownIcon className="size-3.5" />
        </OutlineButton>
        <OutlineButton icon>
          <Maximize2Icon className="size-3.5" />
        </OutlineButton>
        <OutlineButton icon>
          <SearchIcon className="size-3.5" />
        </OutlineButton>
        <OutlineButton>
          <SettingsIcon className="size-3.5" />
          Settings
          <ChevronDownIcon className="size-3.5" />
        </OutlineButton>
      </div>
    </div>
  );
}

/** A docked group: tab strip over the panel surface, as the editor's Dockview theme draws it. */
function Panel({ tabs, className, children }: { tabs: string[]; className?: string; children: ReactNode }) {
  return (
    <div className={`flex min-h-0 flex-col overflow-hidden rounded-md bg-sidebar ${className ?? ""}`}>
      <div className="flex h-[26px] shrink-0 items-center bg-panel-header px-0.5">
        {tabs.map((tab, index) => (
          <span
            key={tab}
            className={`mx-0.5 flex h-5 min-w-24 items-center gap-1 rounded-sm border pl-2 pr-1 text-[11px] ${index === 0 ? "border-border bg-card font-medium text-foreground shadow-[0_1px_1px_color-mix(in_oklch,var(--foreground)_8%,transparent)]" : "border-transparent text-muted-foreground"}`}
          >
            <span className="flex-1">{tab}</span>
            {index === 0 ? <XIcon className="size-2.5" /> : null}
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function SearchRow({ placeholder }: { placeholder: string }) {
  return (
    <div className="flex items-center gap-1.5 px-1.5 pt-1.5">
      <span className="flex h-7 flex-1 items-center rounded-lg border border-input bg-control px-2.5 text-[13px] text-muted-foreground">
        {placeholder}
      </span>
      <OutlineButton icon>
        <PlusIcon className="size-4" />
      </OutlineButton>
    </div>
  );
}

function TreeRow({
  depth = 0,
  label,
  icon: Icon,
  color,
  dot,
  open,
  selected,
  muted,
  action,
}: {
  depth?: number;
  label: string;
  icon?: LucideIcon;
  color?: string;
  dot?: string;
  open?: boolean;
  selected?: boolean;
  muted?: boolean;
  action?: boolean;
}) {
  return (
    <div
      className={`mx-1.5 flex h-7 items-center gap-1.5 rounded-md text-[13px] ${selected ? "bg-accent" : ""} ${muted ? "text-muted-foreground" : ""}`}
      style={{ paddingLeft: 8 + depth * 16 }}
    >
      {open !== undefined ? (
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      ) : (
        <span className="w-3.5" />
      )}
      {Icon ? <Icon className="size-4" style={color ? { color } : undefined} /> : null}
      {dot ? <span className="size-2.5 rounded-full" style={{ background: dot }} /> : null}
      <span className="flex-1 truncate">{label}</span>
      {action ? (
        <span className="mr-1 flex size-6 items-center justify-center rounded-sm border border-input bg-control">
          <PlusIcon className="size-3.5" />
        </span>
      ) : null}
    </div>
  );
}

function ComponentsPanel() {
  const component = "var(--asset-component)";
  return (
    <div className="flex flex-col gap-1">
      <SearchRow placeholder="Search components" />
      <div>
        <TreeRow label="Prefab Root" open selected />
        <TreeRow depth={1} label="Mesh (mannequin)" icon={BoxIcon} color={component} />
        <TreeRow depth={1} label="Animation Graph" icon={WorkflowIcon} color={component} />
        <TreeRow depth={1} label="Rigid Body" icon={CylinderIcon} color={component} />
        <TreeRow depth={1} label="Collider" icon={CircleDashedIcon} color={component} />
      </div>
    </div>
  );
}

function ClassPanel() {
  return (
    <div className="flex flex-col pt-1">
      <span className="px-3 pb-1 text-xs text-muted-foreground">Mannequin</span>
      <TreeRow label="Functions" open action />
      <TreeRow label="Variables" open action />
      <TreeRow depth={1} label="Components" open icon={FolderIcon} />
      <TreeRow depth={2} label="Mesh" dot="var(--pin-object)" />
      <TreeRow label="Events" open action />
      <TreeRow depth={1} label="Event Begin Play" dot="var(--node-event)" />
    </div>
  );
}

type PreviewPin = { label: string; shape: "diamond" | "circle"; color: string; connected?: boolean };

interface PreviewNodeSpec {
  title: string;
  titleColor: string;
  x: number;
  y: number;
  width: number;
  rows: { in?: PreviewPin; out?: PreviewPin }[];
  selected?: boolean;
}

/** Graph nodes render at editor size inside a layer scaled like a 50% graph zoom. */
const NODE_ZOOM = 0.5;
const NODE_TITLE_HEIGHT = 44;
const NODE_ROW_HEIGHT = 44;
const NODE_BODY_PADDING = 4;

const EXEC = "var(--pin-exec)";
const STRING = "var(--pin-string)";
const FLOAT = "var(--pin-float)";

const NODES: PreviewNodeSpec[] = [
  {
    title: "Event Begin Play",
    titleColor: "var(--node-event)",
    x: 80,
    y: 90,
    width: 320,
    rows: [{ out: { label: "Then", shape: "diamond", color: EXEC, connected: true } }],
  },
  {
    title: "Print String",
    titleColor: "var(--node-function)",
    x: 560,
    y: 90,
    width: 360,
    selected: true,
    rows: [
      {
        in: { label: "Exec", shape: "diamond", color: EXEC, connected: true },
        out: { label: "Then", shape: "diamond", color: EXEC },
      },
      { in: { label: "In String", shape: "circle", color: STRING, connected: true } },
    ],
  },
  {
    title: "Get Greeting",
    titleColor: "var(--node-variable)",
    x: 120,
    y: 330,
    width: 320,
    rows: [{ out: { label: "Greeting", shape: "circle", color: STRING, connected: true } }],
  },
  {
    title: "Event Tick",
    titleColor: "var(--node-event)",
    x: 1040,
    y: 330,
    width: 320,
    rows: [
      { out: { label: "Then", shape: "diamond", color: EXEC } },
      { out: { label: "Delta Seconds", shape: "circle", color: FLOAT } },
    ],
  },
];

function pinCenter(node: PreviewNodeSpec, row: number, side: "in" | "out") {
  return {
    x: side === "in" ? node.x + 1 + 22 : node.x + node.width - 1 - 22,
    y: node.y + 1 + NODE_TITLE_HEIGHT + NODE_BODY_PADDING + NODE_ROW_HEIGHT * row + NODE_ROW_HEIGHT / 2,
  };
}

const EDGES = [
  { from: [0, 0], to: [1, 0], color: EXEC, width: "var(--graph-edge-exec, 5px)" },
  { from: [2, 0], to: [1, 1], color: STRING, width: "var(--graph-edge-data, 4px)" },
] as const;

function PreviewPinHandle({ pin }: { pin: PreviewPin }) {
  return (
    <span className="flex size-11 shrink-0 items-center justify-center">
      <PinShapeGlyph shape={pin.shape} connected={pin.connected} color={pin.color} size="var(--graph-pin-size, 22px)" />
    </span>
  );
}

function PreviewNode({ node }: { node: PreviewNodeSpec }) {
  return (
    <div
      className={`absolute overflow-hidden rounded-lg border border-border bg-graph-node text-card-foreground shadow-sm ${node.selected ? "ring-2 ring-primary" : ""}`}
      style={{ left: node.x, top: node.y, width: node.width }}
    >
      <div
        className="flex items-center rounded-t-lg px-4 text-base font-semibold whitespace-nowrap text-node-title"
        style={{ height: NODE_TITLE_HEIGHT, background: node.titleColor }}
      >
        {node.title}
      </div>
      <div className="flex flex-col" style={{ paddingBlock: NODE_BODY_PADDING }}>
        {node.rows.map((row, index) => (
          <div key={index} className="flex items-center justify-between gap-12" style={{ height: NODE_ROW_HEIGHT }}>
            <div className="flex items-center gap-1">
              {row.in ? (
                <>
                  <PreviewPinHandle pin={row.in} />
                  <span className="text-base">{row.in.label}</span>
                </>
              ) : (
                <span className="size-11" />
              )}
            </div>
            {row.out ? (
              <div className="flex items-center gap-1">
                <span className="text-base">{row.out.label}</span>
                <PreviewPinHandle pin={row.out} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function GraphCanvas() {
  return (
    <div
      className="relative h-full overflow-hidden bg-(--graph-canvas)"
      style={{
        backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1.2px)",
        backgroundSize: "16px 16px",
      }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${NODE_ZOOM})`, width: 1600, height: 900 }}>
        <svg className="absolute inset-0 overflow-visible" width={1600} height={900}>
          {EDGES.map(({ from, to, color, width }) => {
            const start = pinCenter(NODES[from[0]]!, from[1], "out");
            const end = pinCenter(NODES[to[0]]!, to[1], "in");
            const bend = Math.max(80, Math.abs(end.x - start.x) / 2);
            return (
              <path
                key={`${from.join()}-${to.join()}`}
                d={`M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`}
                fill="none"
                stroke={color}
                style={{ strokeWidth: width }}
              />
            );
          })}
        </svg>
        {NODES.map((node) => (
          <PreviewNode key={node.title} node={node} />
        ))}
      </div>
      <div className="absolute left-1/2 top-2.5 flex h-9 -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-card px-1.5 text-[13px]">
        <span className="flex items-center gap-1 px-1.5">
          <PlusIcon className="size-3.5" />
          Add Node
        </span>
        <span className="h-4 w-px bg-border" />
        <MaximizeIcon className="mx-1 size-3.5 text-muted-foreground" />
      </div>
      <div className="absolute bottom-2.5 left-2.5 flex w-9 flex-col items-center gap-1.5 rounded-lg border border-border bg-card py-1.5 text-[10px]">
        <PlusIcon className="size-3.5" />
        50%
        <MinusIcon className="size-3.5" />
      </div>
    </div>
  );
}

function InspectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
    </div>
  );
}

function CheckboxControl() {
  return (
    <span className="flex h-7 w-32 items-center gap-2 rounded-md border border-input bg-control px-2 text-xs">
      <span className="grid size-4 place-items-center rounded-[4px] bg-primary text-primary-foreground">
        <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={3}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      On
    </span>
  );
}

function InspectorPanel() {
  return (
    <div className="flex flex-col gap-1 p-3">
      <span className="text-[13px] font-medium">Parent Class</span>
      <span className="flex h-10 items-center rounded-lg border border-input bg-control px-3 text-[13px]">Actor</span>
      <span className="pt-3 text-xs font-semibold">Actor Defaults</span>
      <InspectorRow label="Generate Hit Events">
        <CheckboxControl />
      </InspectorRow>
      <InspectorRow label="Speed">
        <span className="flex h-7 w-32 items-center rounded-md border border-ring bg-control px-2 text-xs ring-3 ring-ring/50">
          4.00
        </span>
      </InspectorRow>
      <InspectorRow label="Event Tick">
        <span className="flex h-7 w-32 items-center justify-between rounded-md border border-input bg-control px-2 text-xs">
          Inherit
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </span>
      </InspectorRow>
      <span className="pt-3 text-xs leading-relaxed text-muted-foreground">
        Prefab Origin is the actor transform in the Scene.
      </span>
      <div className="flex gap-1.5 pt-2">
        <span className="flex h-7 items-center rounded-sm bg-secondary px-2.5 text-xs font-medium">Reset</span>
        <span className="flex h-7 items-center rounded-sm bg-destructive px-2.5 text-xs font-medium text-destructive-foreground">
          Delete
        </span>
        <span className="flex h-7 items-center rounded-sm bg-primary px-2.5 text-xs font-medium text-primary-foreground">
          Apply
        </span>
      </div>
    </div>
  );
}
