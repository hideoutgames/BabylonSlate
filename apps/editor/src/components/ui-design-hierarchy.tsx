import { useCallback, useMemo, useState } from "react";
import {
  NamePromptDialog,
  NestedMenu,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  type NestedMenuItem,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { MoreHorizontalIcon } from "lucide-react";
import {
  duplicateWidget,
  removeWidget,
  reparentWidget,
  widgetParentId,
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
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  const widgetMenuItems = useCallback(
    (id: string): NestedMenuItem[] => {
      const widget = ui.widgets[id];
      if (!widget) return [];
      const isRoot = id === ui.rootId;
      const parentId = widgetParentId(ui, id);
      const parent = parentId ? ui.widgets[parentId] : undefined;
      const items: NestedMenuItem[] = [
        {
          type: "checkbox",
          id: "visible",
          label: "Visible",
          checked: widget.visible,
          testId: `ui-widget-visible-${id}`,
          closeOnClick: false,
          onCheckedChange: (visible) => {
            const current = ui.widgets[id];
            if (!current) return;
            onChange({
              ...ui,
              widgets: {
                ...ui.widgets,
                [id]: { ...current, visible },
              },
            });
          },
        },
      ];
      if (parent?.kind === "Canvas") {
        items.push({
          type: "checkbox",
          id: "ignore-safe-area",
          label: "Ignore Safe Area",
          checked: widget.ignoreSafeArea === true,
          testId: `ui-widget-ignore-safe-area-${id}`,
          onCheckedChange: (ignoreSafeArea) => {
            const current = ui.widgets[id];
            if (!current) return;
            onChange({
              ...ui,
              widgets: {
                ...ui.widgets,
                [id]: { ...current, ignoreSafeArea },
              },
            });
          },
        });
      }
      items.push(
        { type: "separator", id: "actions" },
        {
          id: "duplicate",
          label: "Duplicate",
          testId: "ui-widget-duplicate",
          disabled: isRoot,
          onSelect: () => {
            if (isRoot) return;
            const nextId = `${id}-copy-${Math.random().toString(36).slice(2, 6)}`;
            const next = duplicateWidget(ui, id, nextId);
            onChange(next);
            if (next.widgets[nextId]) onSelect(nextId);
          },
        },
        {
          id: "rename",
          label: "Rename",
          testId: "ui-widget-rename",
          onSelect: () => setRenameTarget(id),
        },
        {
          id: "delete",
          label: "Delete",
          testId: "ui-widget-delete",
          variant: "destructive",
          disabled: isRoot,
          onSelect: () => {
            if (isRoot) return;
            const next = removeWidget(ui, id);
            onChange(next);
            if (selectedId === id || !next.widgets[selectedId]) {
              onSelect(next.rootId);
            }
          },
        },
      );
      return items;
    },
    [onChange, onSelect, selectedId, ui],
  );

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
          <NestedMenu
            items={widgetMenuItems(id)}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Widget Menu for ${widget.name}`}
                data-testid={`ui-widget-menu-${id}`}
              >
                <MoreHorizontalIcon />
              </Button>
            }
          />
        ),
      });
      if (!expanded) return;
      for (const child of widget.children) walk(child, depth + 1);
    };
    walk(ui.rootId, 0);
    return rows;
  }, [collapsed, ui, widgetMenuItems]);

  const renameWidget = renameTarget ? ui.widgets[renameTarget] : undefined;

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
        reparentArm="immediate"
        emptyLabel="No widgets"
        data-testid="ui-widget-tree"
      />
      {renameWidget && renameTarget ? (
        <NamePromptDialog
          open
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          title="Rename Widget"
          label="Name"
          confirmLabel="Rename"
          data-testid="ui-rename-widget"
          onSubmit={(name) => {
            onChange({
              ...ui,
              widgets: {
                ...ui.widgets,
                [renameTarget]: { ...renameWidget, name },
              },
            });
          }}
        />
      ) : null}
    </>
  );
}
