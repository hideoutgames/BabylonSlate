import { useMemo } from "react";
import {
  CatalogMenu,
  TypeVisualIcon,
  resolveTypeVisual,
} from "@babylonslate/editor-kit";
import {
  addableComponentsForHost,
  type AddComponentItem,
  type AddComponentSelection,
} from "../panels/add-component-catalog";

const categoryLabel = (category: string) => category;
/** Project assets and classes follow the engine categories. */
const TRAILING_CATEGORIES = ["Project"] as const;

type AddComponentMenuItem = {
  id: string;
  title: string;
  category: string;
  description: string;
  source: AddComponentItem;
};

/** Add Node-style popup of addable components, anchored under its button. */
export function AddComponentMenu({
  open,
  onOpenChange,
  onSelect,
  anchor,
  projectItems = [],
  overlay = false,
  physicsWorld = "3d",
  "data-testid": testId = "add-component-catalog",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: AddComponentSelection) => void;
  anchor?: { x: number; y: number } | null;
  projectItems?: readonly AddComponentItem[];
  overlay?: boolean;
  physicsWorld?: "2d" | "3d";
  "data-testid"?: string;
}) {
  const items = useMemo(
    () =>
      [...addableComponentsForHost({ overlay, physicsWorld }), ...projectItems].map(
        (source): AddComponentMenuItem => ({
          id: source.id,
          title: source.label,
          category: source.category,
          description: source.description,
          source,
        }),
      ),
    [overlay, physicsWorld, projectItems],
  );

  return (
    <CatalogMenu
      open={open}
      onOpenChange={onOpenChange}
      title="Add Component"
      items={items}
      anchor={anchor}
      onSelect={({ source }) =>
        onSelect({
          classId: source.classId,
          ...(source.properties ? { properties: source.properties } : {}),
        })
      }
      renderLeading={({ source }) => (
        <TypeVisualIcon visual={visualForAddComponentItem(source)} />
      )}
      formatCategory={categoryLabel}
      trailingCategories={TRAILING_CATEGORIES}
      searchLabel="Search Components"
      searchPlaceholder="Search components"
      treeLabel="Components"
      data-testid={testId}
    />
  );
}

function visualForAddComponentItem(item: AddComponentItem) {
  if (item.id.startsWith("asset-")) {
    return resolveTypeVisual({ assetType: item.description });
  }
  return resolveTypeVisual({ classId: item.classId, ancestry: item.ancestry });
}
