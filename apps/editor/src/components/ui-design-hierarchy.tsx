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
  resolveNested,
  onExtract,
  onOpenAsset,
}: {
  ui: UserInterfaceDocument;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (next: UserInterfaceDocument) => void;
  resolveNested?: (guid: string) => UserInterfaceDocument | null;
  onExtract?: (widgetId: string, name: string) => void;
  onOpenAsset?: (guid: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [extractTarget, setExtractTarget] = useState<string | null>(null);

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
          id: "open-asset",
          label: "Open Asset",
          testId: "ui-widget-open-asset",
          disabled: widget.kind !== "UserInterface" || !widget.nestedUiGuid,
          onSelect: () => {
            if (widget.nestedUiGuid) onOpenAsset?.(widget.nestedUiGuid);
          },
        },
        {
          id: "extract",
          label: "Extract",
          testId: "ui-widget-extract",
          disabled: isRoot || widget.kind === "UserInterface",
          onSelect: () => setExtractTarget(id),
        },
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
    [onChange, onOpenAsset, onSelect, selectedId, ui],
  );

  const nodes = useMemo(() => {
    const rows: TreeViewNode[] = [];
    const walkNested = (
      nested: UserInterfaceDocument,
      prefix: string,
      depth: number,
    ) => {
      const visit = (id: string, nestedDepth: number) => {
        const widget = nested.widgets[id];
        if (!widget || id === nested.rootId) {
          if (widget) {
            for (const child of widget.children) visit(child, nestedDepth);
          }
          return;
        }
        const rowId = `${prefix}/${widget.id}`;
        const expanded = !collapsed.has(rowId);
        rows.push({
          id: rowId,
          label: widget.name,
          depth: nestedDepth,
          hasChildren: widget.children.length > 0,
          expanded,
          muted: true,
        });
        if (!expanded) return;
        for (const child of widget.children) visit(child, nestedDepth + 1);
      };
      visit(nested.rootId, depth);
    };
    const walk = (id: string, depth: number) => {
      const widget = ui.widgets[id];
      if (!widget) return;
      const nested =
        widget.kind === "UserInterface" && widget.nestedUiGuid
          ? resolveNested?.(widget.nestedUiGuid)
          : null;
      const expanded = !collapsed.has(id);
      rows.push({
        id,
        label: widget.name,
        depth,
        hasChildren: widget.children.length > 0 || !!nested,
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
      if (nested) walkNested(nested, id, depth + 1);
    };
    walk(ui.rootId, 0);
    return rows;
  }, [collapsed, resolveNested, ui, widgetMenuItems]);

  const renameWidget = renameTarget ? ui.widgets[renameTarget] : undefined;
  const extractWidget = extractTarget ? ui.widgets[extractTarget] : undefined;

  return (
    <>
      <TreeView
        nodes={nodes}
        selectedId={selectedId}
        onSelect={(id) => onSelect(id.includes("/") ? (id.split("/")[0] ?? id) : id)}
        onActivate={(id) => {
          const widget = ui.widgets[id];
          if (widget?.kind === "UserInterface" && widget.nestedUiGuid) {
            onOpenAsset?.(widget.nestedUiGuid);
          }
        }}
        onToggleExpanded={(id) => {
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }}
        onReparent={(dragId, targetId, placement) => {
          if (!targetId || dragId.includes("/") || targetId.includes("/")) return;
          onChange(reparentWidget(ui, dragId, targetId, placement));
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
      {extractWidget && extractTarget ? (
        <NamePromptDialog
          open
          onOpenChange={(open) => {
            if (!open) setExtractTarget(null);
          }}
          title="Extract User Interface"
          label="Name"
          description={`Create a prefab from ${extractWidget.name}.`}
          confirmLabel="Extract"
          data-testid="ui-extract-widget"
          onSubmit={(name) => {
            onExtract?.(extractTarget, name);
            setExtractTarget(null);
          }}
        />
      ) : null}
    </>
  );
}
