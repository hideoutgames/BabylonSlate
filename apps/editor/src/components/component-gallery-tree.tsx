import {
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  LockIcon,
  UnlockIcon,
} from "lucide-react";
import { useState } from "react";
import {
  PanelFrame,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  type TreeViewNode,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Toggle } from "@haptic/ui/components/toggle";

// Resolve icons after the gallery mounts, once shared route modules are initialized.
const createGalleryTreeNodes = (): TreeViewNode[] => [
  {
    id: "root",
    label: "Scene Root",
    depth: 0,
    hasChildren: true,
    expanded: true,
    icon: <TypeVisualIcon visual={resolveTypeVisual({ assetType: "Scene" })} />,
  },
  {
    id: "player",
    preview: <span className="text-xs text-muted-foreground">Health 100</span>,
    label: "Player",
    depth: 1,
    hasChildren: true,
    expanded: true,
    icon: <TypeVisualIcon visual={resolveTypeVisual({ classId: "Actor" })} />,
  },
  {
    id: "player-mesh",
    label: "Character Mesh",
    depth: 2,
    hasChildren: false,
    expanded: false,
    icon: (
      <TypeVisualIcon
        visual={resolveTypeVisual({ classId: "MeshComponent" })}
      />
    ),
  },
  {
    id: "player-camera",
    label: "Follow Camera",
    depth: 2,
    hasChildren: false,
    expanded: false,
    icon: (
      <TypeVisualIcon
        visual={resolveTypeVisual({ classId: "CameraComponent" })}
      />
    ),
  },
  {
    id: "environment",
    label: "Environment",
    depth: 1,
    hasChildren: true,
    expanded: true,
    icon: <FolderIcon />,
  },
  {
    id: "ground",
    label: "Ground",
    depth: 2,
    hasChildren: false,
    expanded: false,
    icon: (
      <TypeVisualIcon
        visual={resolveTypeVisual({ classId: "MeshComponent" })}
      />
    ),
  },
  {
    id: "stone-arch",
    label: "Stone Arch",
    depth: 2,
    hasChildren: false,
    expanded: false,
    icon: (
      <TypeVisualIcon
        visual={resolveTypeVisual({ classId: "MeshComponent" })}
      />
    ),
  },
  {
    id: "props",
    label: "Props",
    depth: 2,
    hasChildren: true,
    expanded: true,
    icon: <FolderIcon />,
  },
  {
    id: "crate",
    label: "Wooden Crate",
    depth: 3,
    hasChildren: false,
    expanded: false,
    icon: (
      <TypeVisualIcon
        visual={resolveTypeVisual({ classId: "MeshComponent" })}
      />
    ),
  },
  {
    id: "barrel",
    label: "Barrel",
    depth: 3,
    hasChildren: false,
    expanded: false,
    icon: (
      <TypeVisualIcon
        visual={resolveTypeVisual({ classId: "MeshComponent" })}
      />
    ),
  },
  {
    id: "lighting",
    label: "Lighting",
    depth: 1,
    hasChildren: true,
    expanded: true,
    icon: <FolderIcon />,
  },
  {
    id: "sun",
    label: "Directional Light",
    depth: 2,
    hasChildren: false,
    expanded: false,
    icon: (
      <TypeVisualIcon
        visual={resolveTypeVisual({ classId: "LightComponent" })}
      />
    ),
  },
  {
    id: "ambient",
    label: "Ambient Audio",
    depth: 2,
    hasChildren: false,
    expanded: false,
    icon: (
      <TypeVisualIcon
        visual={resolveTypeVisual({ classId: "AudioComponent" })}
      />
    ),
  },
];

export function GalleryTreeExample({ touch = false }: { touch?: boolean }) {
  const [treeNodes, setTreeNodes] = useState(createGalleryTreeNodes);
  const [selectedId, setSelectedId] = useState("player");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set(["barrel"]));
  const [groundLocked, setGroundLocked] = useState(true);
  const prefix = touch ? "touch-" : "";
  const nodes: TreeViewNode[] = [];
  let collapsedDepth: number | null = null;

  for (const node of treeNodes) {
    if (collapsedDepth !== null && node.depth > collapsedDepth) continue;
    collapsedDepth = null;
    const expanded = node.hasChildren && !collapsed.has(node.id);
    if (node.hasChildren && !expanded) collapsedDepth = node.depth;
    const muted = hidden.has(node.id);
    nodes.push({
      ...node,
      id: `${prefix}${node.id}`,
      expanded,
      muted,
      trailing:
        node.id === "player" || node.id === "barrel" ? (
          <Button
            variant="ghost"
            size={touch ? "touch-icon" : "icon-sm"}
            aria-label={`${muted ? "Show" : "Hide"} ${node.label}`}
            onClick={() =>
              setHidden((current) => {
                const next = new Set(current);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                return next;
              })
            }
          >
            {muted ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        ) : node.id === "ground" ? (
          <Toggle
            variant={groundLocked ? "outline" : "default"}
            size={touch ? "touch" : "sm"}
            className="px-0"
            aria-label={`${groundLocked ? "Unlock" : "Lock"} Ground`}
            pressed={groundLocked}
            onPressedChange={setGroundLocked}
          >
            {groundLocked ? <LockIcon /> : <UnlockIcon />}
          </Toggle>
        ) : undefined,
    });
  }

  return (
    <div className="h-[25rem] min-w-0 overflow-hidden rounded-lg border border-border">
      <PanelFrame
        title={touch ? "Tree View · Touch" : "Tree View · Compact"}
        data-testid={touch ? "gallery-tree-view-touch" : "gallery-tree-view"}
      >
        <TreeView
          aria-label={touch ? "Touch Component Gallery Tree" : "Component Gallery Tree"}
          nodes={nodes}
          rowHeight={touch ? 44 : undefined}
          selectedId={`${prefix}${selectedId}`}
          onSelect={(id) => setSelectedId(id.slice(prefix.length))}
          onReparent={(dragId, targetId, placement = "into") => {
            const sourceId = dragId.slice(prefix.length);
            const destinationId = targetId?.slice(prefix.length) ?? null;
            setTreeNodes((current) => {
              const sourceIndex = current.findIndex((node) => node.id === sourceId);
              if (sourceIndex < 0) return current;
              const source = current[sourceIndex]!;
              const subtreeEnd = (rows: TreeViewNode[], index: number) => {
                let end = index + 1;
                while (end < rows.length && rows[end]!.depth > rows[index]!.depth) end++;
                return end;
              };
              const end = subtreeEnd(current, sourceIndex);
              const moving = current.slice(sourceIndex, end);
              if (moving.some((node) => node.id === destinationId)) return current;
              const remaining = [...current.slice(0, sourceIndex), ...current.slice(end)];
              const targetIndex = remaining.findIndex((node) => node.id === destinationId);
              const target = remaining[targetIndex];
              const depth = target ? target.depth + (placement === "into" ? 1 : 0) : 0;
              const insertAt = target
                ? placement === "before" ? targetIndex : subtreeEnd(remaining, targetIndex)
                : remaining.length;
              remaining.splice(insertAt, 0, ...moving.map((node) => ({
                ...node,
                depth: node.depth + depth - source.depth,
              })));
              return remaining.map((node, index) => ({
                ...node,
                hasChildren: (remaining[index + 1]?.depth ?? 0) > node.depth,
              }));
            });
            if (destinationId && placement === "into") {
              setCollapsed((current) => {
                const next = new Set(current);
                next.delete(destinationId);
                return next;
              });
            }
          }}
          onToggleExpanded={(id) =>
            setCollapsed((current) => {
              const next = new Set(current);
              const nodeId = id.slice(prefix.length);
              if (next.has(nodeId)) next.delete(nodeId);
              else next.add(nodeId);
              return next;
            })
          }
          data-testid={touch ? "gallery-tree-touch" : "gallery-tree"}
        />
      </PanelFrame>
    </div>
  );
}
