import { useState } from "react";
import {
  CatalogCard,
  CatalogCardGrid,
  CatalogResultRow,
  ContextMenuOverlay,
  NestedMenu,
  ToolbarOverflow,
  ToolbarOverflowItem,
  ToolbarOverflowMenu,
  ToolbarOverflowTrack,
  TypeVisualIcon,
  resolveTypeVisual,
  useContextMenu,
  type NestedMenuItem,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";

const GALLERY_NESTED_ITEMS: NestedMenuItem[] = [
  { id: "rename", label: "Rename", shortcut: "F2", onSelect: () => {} },
  {
    id: "view",
    type: "radio-group",
    value: "pbr",
    closeOnClick: false,
    onValueChange: () => {},
    items: [
      { id: "pbr", label: "PBR", value: "pbr" },
      { id: "unlit", label: "Unlit", value: "unlit" },
    ],
  },
  {
    id: "more",
    type: "submenu",
    label: "More",
    items: [
      { id: "duplicate", label: "Duplicate", shortcut: "Mod+D", onSelect: () => {} },
      {
        id: "export",
        type: "submenu",
        label: "Export",
        items: [{ id: "gltf", label: "glTF", onSelect: () => {} }],
      },
    ],
  },
];

export function GalleryNestedMenus() {
  const [showGrid, setShowGrid] = useState(true);
  const items: NestedMenuItem[] = [
    ...GALLERY_NESTED_ITEMS,
    {
      id: "grid", type: "checkbox", label: "Show Grid", shortcut: "Shift+G",
      checked: showGrid, onCheckedChange: setShowGrid, closeOnClick: false,
    },
  ];
  const { menu, closeMenu, openMenuAt } = useContextMenu({
    items,
  });

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Nested menu</h3>
      <div className="flex flex-wrap items-center gap-2">
        <NestedMenu
          items={items}
          trigger={
            <Button variant="outline" data-testid="gallery-nested-menu">
              Nested Menu
            </Button>
          }
          contentTestId="gallery-nested-menu-content"
        />
        <Button
          variant="outline"
          data-testid="gallery-nested-overlay"
          onClick={(event) => openMenuAt(event.clientX, event.clientY)}
        >
          Open Context Overlay
        </Button>
      </div>
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
    </div>
  );
}

export function GalleryToolbarOverflow() {
  const actions = ["Undo", "Redo", "Compile"] as const;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Toolbar overflow</h3>
      <ToolbarOverflow className="w-44 rounded-md border" data-testid="gallery-toolbar-overflow">
        <ToolbarOverflowTrack className="flex items-center gap-0.5 p-0.5">
          <Button size="sm" variant="outline">Save</Button>
          {actions.map((label, index) => (
            <ToolbarOverflowItem
              key={label}
              id={label}
              priority={index + 1}
              items={[{ id: label, label, onSelect: () => undefined, disabled: label === "Redo" }]}
            >
              <Button size="sm" variant="outline">{label}</Button>
            </ToolbarOverflowItem>
          ))}
          <ToolbarOverflowMenu />
        </ToolbarOverflowTrack>
      </ToolbarOverflow>
    </div>
  );
}

export function GalleryCatalogRows() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-2" data-testid="gallery-catalog-rows">
      <h2 className="text-lg font-medium">Catalog Results</h2>
      <div role="group" aria-label="Catalog Results">
        {[
          { title: "Mesh", description: "Rendering", classId: "MeshComponent" },
          { title: "Camera", description: "Camera", classId: "CameraComponent" },
        ].map((item, index) => (
          <CatalogResultRow
            key={item.classId}
            title={item.title}
            description={item.description}
            leading={<TypeVisualIcon visual={resolveTypeVisual({ classId: item.classId })} />}
            active={selected === item.classId}
            striped={index % 2 === 1}
            onSelect={() => setSelected(item.classId)}
          />
        ))}
      </div>
      <h2 className="text-lg font-medium">Catalog Cards</h2>
      <div className="max-w-xl" data-testid="gallery-catalog-cards">
        <CatalogCardGrid label="Catalog Cards">
          {[
            { title: "Box", subtitle: "Shapes", visual: resolveTypeVisual({ classId: "MeshComponent", family: "class" }) },
            { title: "Point Light", subtitle: "Lights", visual: resolveTypeVisual({ classId: "LightComponent", family: "class" }) },
            { title: "Hero", subtitle: "Model", visual: resolveTypeVisual({ assetType: "Model" }) },
          ].map((item) => (
            <CatalogCard
              key={item.title}
              title={item.title}
              subtitle={item.subtitle}
              visual={item.visual}
              onSelect={() => setSelected(item.title)}
            />
          ))}
        </CatalogCardGrid>
      </div>
    </section>
  );
}
