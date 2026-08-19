import { useMemo, useState } from "react";
import {
  CatalogDialog,
  CatalogItemButton,
  TypeVisualIcon,
  resolveTypeVisual,
  useCatalogFilter,
} from "@babylonslate/editor-kit";
import type { WidgetKind } from "@babylonslate/ui-runtime";

type CatalogCategoryId = "all" | "Containers" | "Controls" | "Touch";

export type WidgetCatalogSelection = {
  kind: WidgetKind;
  isVertical?: boolean;
  nestedUiGuid?: string;
  label?: string;
};

type WidgetCatalogItem = {
  id: string;
  kind: WidgetKind;
  category: Exclude<CatalogCategoryId, "all">;
  label: string;
  isVertical?: boolean;
  nestedUiGuid?: string;
};

const ITEMS: WidgetCatalogItem[] = [
  { id: "Rectangle", kind: "Rectangle", category: "Containers", label: "Rectangle" },
  {
    id: "StackPanel-vertical",
    kind: "StackPanel",
    category: "Containers",
    label: "Vertical Stack",
    isVertical: true,
  },
  {
    id: "StackPanel-horizontal",
    kind: "StackPanel",
    category: "Containers",
    label: "Horizontal Stack",
    isVertical: false,
  },
  { id: "Grid", kind: "Grid", category: "Containers", label: "Grid" },
  { id: "ScrollViewer", kind: "ScrollViewer", category: "Containers", label: "Scroll Viewer" },
  { id: "Ellipse", kind: "Ellipse", category: "Containers", label: "Ellipse" },
  { id: "Container", kind: "Container", category: "Containers", label: "Container" },
  { id: "Button", kind: "Button", category: "Controls", label: "Button" },
  { id: "TextBlock", kind: "TextBlock", category: "Controls", label: "Text Block" },
  { id: "InputText", kind: "InputText", category: "Controls", label: "Input Text" },
  { id: "Slider", kind: "Slider", category: "Controls", label: "Slider" },
  { id: "Checkbox", kind: "Checkbox", category: "Controls", label: "Checkbox" },
  { id: "Image", kind: "Image", category: "Controls", label: "Image" },
  { id: "ProgressBar", kind: "ProgressBar", category: "Controls", label: "Progress Bar" },
  { id: "Material", kind: "Material", category: "Controls", label: "Material" },
  { id: "TouchJoystick", kind: "TouchJoystick", category: "Touch", label: "Touch Joystick" },
  { id: "TouchButton", kind: "TouchButton", category: "Touch", label: "Touch Button" },
  { id: "TouchDPad", kind: "TouchDPad", category: "Touch", label: "Touch D-Pad" },
];

export function UiWidgetCatalog({
  open,
  onOpenChange,
  onSelect,
  nestedUiAssets = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: WidgetCatalogSelection) => void;
  nestedUiAssets?: ReadonlyArray<{ guid: string; name: string }>;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<CatalogCategoryId>("all");
  const items = useMemo<WidgetCatalogItem[]>(() => {
    const nested = nestedUiAssets.map((asset) => ({
      id: `UserInterface-${asset.guid}`,
      kind: "UserInterface" as const,
      category: "Containers" as const,
      label: asset.name,
      nestedUiGuid: asset.guid,
    }));
    return [...ITEMS, ...nested];
  }, [nestedUiAssets]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    return [
      { id: "all", label: "All", count: items.length },
      { id: "Containers", label: "Containers", count: counts.get("Containers") ?? 0 },
      { id: "Controls", label: "Controls", count: counts.get("Controls") ?? 0 },
      { id: "Touch", label: "Touch", count: counts.get("Touch") ?? 0 },
    ];
  }, [items]);
  const bySearch = useCatalogFilter(
    items,
    search,
    (item) => `${item.label} ${item.kind} ${item.category}`,
  );
  const visible =
    activeCategory === "all"
      ? bySearch
      : bySearch.filter((item) => item.category === activeCategory);

  return (
    <CatalogDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setSearch("");
          setActiveCategory("all");
        }
      }}
      title="Add Widget"
      description="Containers, controls, and touch widgets."
      categories={categories}
      activeCategoryId={activeCategory}
      onCategoryChange={(id) => setActiveCategory(id as CatalogCategoryId)}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search widgets"
      data-testid="ui-widget-catalog"
    >
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((item) => (
            <CatalogItemButton
              key={item.id}
              data-testid={`ui-add-widget-${item.id}`}
              onClick={() => {
                onSelect({
                  kind: item.kind,
                  isVertical: item.isVertical,
                  nestedUiGuid: item.nestedUiGuid,
                  label: item.label,
                });
                onOpenChange(false);
              }}
            >
              <TypeVisualIcon visual={resolveTypeVisual({ assetType: "UserInterface" })} />
              <span className="truncate">{item.label}</span>
            </CatalogItemButton>
          ))}
        </div>
      )}
    </CatalogDialog>
  );
}
