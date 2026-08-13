import { useMemo, useState } from "react";
import {
  CatalogDialog,
  CatalogItemButton,
  TypeVisualIcon,
  humanizePropertyLabel,
  resolveTypeVisual,
  useCatalogFilter,
} from "@babylonslate/editor-kit";
import { WIDGET_KINDS, type WidgetKind } from "@babylonslate/ui-runtime";

const CONTAINER_KINDS: ReadonlySet<WidgetKind> = new Set([
  "HorizontalBox",
  "VerticalBox",
  "Grid",
  "ScrollBox",
  "Overlay",
  "SizeBox",
  "Border",
  "UserInterface",
]);

const TOUCH_KINDS: ReadonlySet<WidgetKind> = new Set([
  "TouchJoystick",
  "TouchButton",
  "TouchDPad",
]);

type CatalogCategoryId = "all" | "Containers" | "Controls" | "Touch";

type WidgetCatalogItem = {
  kind: WidgetKind;
  category: Exclude<CatalogCategoryId, "all">;
  label: string;
};

const ITEMS: WidgetCatalogItem[] = WIDGET_KINDS.filter((kind) => kind !== "Canvas").map(
  (kind) => ({
    kind,
    category: CONTAINER_KINDS.has(kind)
      ? "Containers"
      : TOUCH_KINDS.has(kind)
        ? "Touch"
        : "Controls",
    label: humanizePropertyLabel(kind),
  }),
);

export function UiWidgetCatalog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (kind: WidgetKind) => void;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<CatalogCategoryId>("all");
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of ITEMS) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    return [
      { id: "all", label: "All", count: ITEMS.length },
      { id: "Containers", label: "Containers", count: counts.get("Containers") ?? 0 },
      { id: "Controls", label: "Controls", count: counts.get("Controls") ?? 0 },
      { id: "Touch", label: "Touch", count: counts.get("Touch") ?? 0 },
    ];
  }, []);
  const bySearch = useCatalogFilter(
    ITEMS,
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
              key={item.kind}
              data-testid={`ui-add-widget-${item.kind}`}
              onClick={() => {
                onSelect(item.kind);
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
