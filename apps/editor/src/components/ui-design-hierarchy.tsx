import { useMemo, useRef, useState } from "react";
import {
  ContextMenuOverlay,
  NamePromptDialog,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  useContextMenu,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import { Toggle } from "@babylonslate/ui/components/toggle";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import {
  duplicateWidget,
  removeWidget,
  reparentWidget,
  type UserInterfaceDocument,
} from "@babylonslate/ui-runtime";

export function UiDesignHierarchy({
  ui,
  selectedId,
  onSelect,
  onChange,
}: {
  ui: UserInterfaceDocument;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (next: UserInterfaceDocument) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const menuTargetRef = useRef<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const nodes = useMemo(() => {
    const rows: TreeViewNode[] = [];
    const walk = (id: string, depth: number) => {
      const widget = ui.widgets[id];
      if (!widget) return;
      const expanded = !collapsed.has(id);
      rows.push({
        id,
        label: widget.name,
        depth,
        hasChildren: widget.children.length > 0,
        expanded,
        muted: !widget.visible,
        icon: (
          <TypeVisualIcon visual={resolveTypeVisual({ assetType: "UserInterface" })} />
        ),
        trailing: (
          <Toggle
            variant="default"
            size="sm"
            aria-label={`Toggle visibility of ${widget.name}`}
            pressed={widget.visible}
            data-testid={`ui-widget-visible-${id}`}
            onPressedChange={(visible) => {
              onChange({
                ...ui,
                widgets: {
                  ...ui.widgets,
                  [id]: { ...widget, visible },
                },
              });
            }}
          >
            {widget.visible ? <EyeIcon /> : <EyeOffIcon />}
          </Toggle>
        ),
      });
      if (!expanded) return;
      for (const child of widget.children) walk(child, depth + 1);
    };
    walk(ui.rootId, 0);
    return rows;
  }, [collapsed, onChange, ui]);

  const { menu, closeMenu, openMenuAt } = useContextMenu({
    items: [
      {
        id: "duplicate",
        label: "Duplicate",
        testId: "ui-widget-duplicate",
        disabled: menuTargetRef.current === ui.rootId,
        onSelect: () => {
          const target = menuTargetRef.current;
          if (!target || target === ui.rootId) return;
          const nextId = `${target}-copy-${Math.random().toString(36).slice(2, 6)}`;
          const next = duplicateWidget(ui, target, nextId);
          onChange(next);
          if (next.widgets[nextId]) onSelect(nextId);
        },
      },
      {
        id: "rename",
        label: "Rename",
        testId: "ui-widget-rename",
        onSelect: () => setRenameOpen(true),
      },
      {
        id: "delete",
        label: "Delete",
        testId: "ui-widget-delete",
        disabled: menuTargetRef.current === ui.rootId,
        onSelect: () => {
          const target = menuTargetRef.current;
          if (!target || target === ui.rootId) return;
          const next = removeWidget(ui, target);
          onChange(next);
          if (selectedId === target || !next.widgets[selectedId]) {
            onSelect(next.rootId);
          }
        },
      },
    ],
  });

  return (
    <>
      <TreeView
        nodes={nodes}
        selectedId={selectedId}
        onSelect={onSelect}
        onToggleExpanded={(id) => {
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }}
        onReparent={(dragId, targetId) => {
          if (!targetId) return;
          onChange(reparentWidget(ui, dragId, targetId));
        }}
        onContextMenu={(id, x, y) => {
          menuTargetRef.current = id;
          onSelect(id);
          openMenuAt(x, y);
        }}
        emptyLabel="No widgets"
        data-testid="ui-widget-tree"
      />
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      {renameOpen ? (
        <NamePromptDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          title="Rename Widget"
          label="Name"
          confirmLabel="Rename"
          data-testid="ui-rename-widget"
          onSubmit={(name) => {
            const target = menuTargetRef.current;
            if (!target || !ui.widgets[target]) return;
            onChange({
              ...ui,
              widgets: {
                ...ui.widgets,
                [target]: { ...ui.widgets[target]!, name },
              },
            });
          }}
        />
      ) : null}
    </>
  );
}
