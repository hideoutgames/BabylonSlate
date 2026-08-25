import { OctagonAlertIcon, SaveIcon } from "lucide-react";
import { useState } from "react";
import {
  AssetPicker,
  AssetOpenProvider,
  AssetPickerControl,
  AtlasTileGrid,
  BindingCodePicker,
  CatalogDialog,
  ClassPicker,
  SceneComponentPicker,
  ContextMenuOverlay,
  InputMappingEditor,
  NamedListEditor,
  NamePromptDialog,
  AddFunctionDialog,
  NestedMenu,
  NumericDragField,
  PanelFrame,
  ParameterListEditor,
  PinListEditor,
  PinTypePicker,
  VariableTypeFields,
  PropertyGrid,
  SearchDialog,
  SearchDropdown,
  SelectableText,
  ToolbarStrip,
  TreeView,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  TypeColorMark,
  TYPE_VISUAL_ICON_TILE_SIZE,
  TypeVisualIcon,
  assetRowIdentity,
  classRowIdentity,
  resolveTypeVisual,
  selectedPickerIdentity,
  useContextMenu,
  type NestedMenuItem,
  type ParameterRow,
  type PinListRow,
  type PinPickerType,
  type PropertyRow,
  type TreeViewNode,
  type VariableTypeFieldsValue,
} from "@babylonslate/editor-kit";
import {
  ensureTilesetTiles,
  normalizeTilesetPayload,
} from "@babylonslate/assets";
import { createDefaultInputMappings } from "@babylonslate/input";
import { ASSET_COLOR_VAR, PIN_COLOR_VAR } from "@babylonslate/ui/lib/data-types";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@babylonslate/ui/components/alert-dialog";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Separator } from "@babylonslate/ui/components/separator";
import { Skeleton } from "@babylonslate/ui/components/skeleton";
import { Slider } from "@babylonslate/ui/components/slider";
import { Switch } from "@babylonslate/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@babylonslate/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";

const GALLERY_NESTED_ITEMS: NestedMenuItem[] = [
  { id: "rename", label: "Rename", onSelect: () => {} },
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
      { id: "duplicate", label: "Duplicate", onSelect: () => {} },
      {
        id: "export",
        type: "submenu",
        label: "Export",
        items: [{ id: "gltf", label: "glTF", onSelect: () => {} }],
      },
    ],
  },
];

function GalleryNestedMenus() {
  const { menu, closeMenu, openMenuAt } = useContextMenu({
    items: GALLERY_NESTED_ITEMS,
  });

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Nested menu</h3>
      <div className="flex flex-wrap items-center gap-2">
        <NestedMenu
          items={GALLERY_NESTED_ITEMS}
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

const GALLERY_TREE_NODES: TreeViewNode[] = [
  { id: "root", label: "Scene Root", depth: 0, hasChildren: true, expanded: true },
  { id: "player", label: "Player", depth: 1, hasChildren: false, expanded: false },
  { id: "ground", label: "Ground", depth: 1, hasChildren: false, expanded: false },
];

function GalleryComposites() {
  const [position, setPosition] = useState<[number, number, number]>([0, 1, 0]);
  const [speed, setSpeed] = useState(4);
  const [friction, setFriction] = useState(0.5);
  const [physicsLayer, setPhysicsLayer] = useState(1);
  const [visible, setVisible] = useState(true);
  const [tint, setTint] = useState<[number, number, number]>([1, 0, 0]);
  const [selectedId, setSelectedId] = useState("player");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [classPickerOpen, setClassPickerOpen] = useState(false);
  const [atlasTileId, setAtlasTileId] = useState(1);
  const [sceneComponentPickerOpen, setSceneComponentPickerOpen] =
    useState(false);
  const [namePromptOpen, setNamePromptOpen] = useState(false);
  const [addFunctionOpen, setAddFunctionOpen] = useState(false);
  const [layers, setLayers] = useState(["Default", "Foreground"]);
  const [mappings, setMappings] = useState(createDefaultInputMappings);
  const [parameters, setParameters] = useState<ParameterRow[]>([
    { id: "gallery-amount", name: "amount", type: "float" },
  ]);
  const [pinType, setPinType] = useState<PinPickerType>("float");
  const [variableType, setVariableType] = useState<VariableTypeFieldsValue>({
    typeId: "float",
    container: "single",
  });
  const [bindingCode, setBindingCode] = useState("Space");
  const [pins, setPins] = useState<PinListRow[]>([
    { id: "gallery-hit", name: "hit", type: "bool", direction: "out" },
    {
      id: "gallery-target",
      name: "target",
      type: "object",
      direction: "in",
      typeClassId: "Actor",
    },
  ]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>("gallery-target");

  const rows: PropertyRow[] = [
    {
      kind: "vector3",
      id: "gallery-position",
      label: "Position",
      value: position,
      defaultValue: [0, 0, 0],
      onChange: (value) => setPosition([value[0], value[1], value[2]]),
    },
    {
      kind: "number",
      id: "gallery-speed",
      label: "Speed",
      value: speed,
      defaultValue: 4,
      sensitivity: 0.05,
      onChange: setSpeed,
    },
    {
      kind: "slider",
      id: "gallery-friction",
      label: "Friction",
      value: friction,
      defaultValue: 0.5,
      min: 0,
      max: 1,
      onChange: setFriction,
    },
    {
      kind: "flags",
      id: "gallery-layer",
      label: "Layer",
      value: physicsLayer,
      defaultValue: 1,
      bitCount: 4,
      labels: ["Default", "Player", "World", "UI"],
      onChange: setPhysicsLayer,
    },
    {
      kind: "boolean",
      id: "gallery-visible",
      label: "Visible",
      value: visible,
      defaultValue: true,
      onChange: setVisible,
    },
    {
      kind: "color",
      id: "gallery-tint",
      label: "Tint",
      value: tint,
      defaultValue: [1, 0, 0],
      onChange: setTint,
    },
    {
      kind: "enum",
      id: "gallery-mode",
      label: "Viewport Mode",
      value: "3d",
      options: [
        { value: "3d", label: "3D" },
        { value: "2d", label: "2D" },
      ],
      onChange: () => {},
    },
    {
      kind: "asset",
      id: "gallery-mesh",
      label: "Mesh",
      value: "gallery-asset",
      placeholder: "None",
      onPick: () => setPickerOpen(true),
      onChange: () => {},
      ...assetRowIdentity({ name: "Rock", type: "Mesh" }),
    },
    {
      kind: "asset",
      id: "gallery-texture",
      label: "Texture",
      value: "gallery-texture",
      placeholder: "None",
      onPick: () => setPickerOpen(true),
      onChange: () => {},
      ...assetRowIdentity({ name: "Grass", type: "Texture" }),
    },
  ];

  return (
    <AssetOpenProvider
      value={{
        canOpen: (guid) => guid === "gallery-texture",
        openAsset: () => {},
      }}
    >
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border">
        <PanelFrame title="Property grid" data-testid="gallery-property-grid">
          <PropertyGrid rows={rows} />
        </PanelFrame>
      </div>
      <div className="rounded-lg border border-border">
        <PanelFrame
          title="Property grid (horizontal)"
          data-testid="gallery-property-grid-horizontal"
        >
          <PropertyGrid
            orientation="horizontal"
            rows={[
              {
                kind: "text",
                id: "gallery-inspect-name",
                label: "Name",
                value: "Hero",
                disabled: true,
                onChange: () => {},
              },
              {
                kind: "number",
                id: "gallery-inspect-health",
                label: "Health",
                value: 10,
                disabled: true,
                onChange: () => {},
              },
            ]}
          />
        </PanelFrame>
      </div>
      <div className="rounded-lg border border-border">
        <PanelFrame title="Atlas tile grid" data-testid="gallery-atlas-tile-grid">
          <div className="h-48">
            <AtlasTileGrid
              tileset={ensureTilesetTiles(
                normalizeTilesetPayload({
                  atlasWidth: 32,
                  atlasHeight: 16,
                  tileWidth: 16,
                  tileHeight: 16,
                  tiles: [
                    { id: 1, collision: "full" },
                    { id: 2, collision: "none" },
                  ],
                }),
              )}
              imageUrl={null}
              selectedId={atlasTileId}
              onSelect={setAtlasTileId}
              data-testid="gallery-atlas"
            />
          </div>
        </PanelFrame>
      </div>
      <div className="rounded-lg border border-border">
        <PanelFrame title="Parameter list" data-testid="gallery-parameter-list">
          <ParameterListEditor rows={parameters} onChange={setParameters} />
        </PanelFrame>
      </div>
      <div className="rounded-lg border border-border p-3" data-testid="gallery-pin-type-picker">
        <div className="mb-2 text-sm font-medium">Pin Type Picker</div>
        <PinTypePicker value={pinType} onChange={setPinType} />
      </div>
      <div className="rounded-lg border border-border p-3" data-testid="gallery-variable-type-fields">
        <div className="mb-2 text-sm font-medium">Variable Type Fields</div>
        <VariableTypeFields value={variableType} onChange={setVariableType} />
      </div>
      <div className="rounded-lg border border-border p-3" data-testid="gallery-binding-code-picker">
        <div className="mb-2 text-sm font-medium">Binding Code Picker</div>
        <BindingCodePicker
          device="key"
          code={bindingCode}
          onChange={setBindingCode}
          data-testid="gallery-binding-code"
        />
      </div>
      <div className="rounded-lg border border-border">
        <PanelFrame title="Pin list" data-testid="gallery-pin-list">
          <PinListEditor
            rows={pins}
            onChange={setPins}
            selectedId={selectedPinId}
            onSelect={setSelectedPinId}
            showDirection
            classEntries={[
              { id: "Actor", name: "Actor", group: "Engine" },
              { id: "MyGame", name: "My Game", group: "Project" },
            ]}
          />
        </PanelFrame>
      </div>
      <div className="rounded-lg border border-border p-3" data-testid="gallery-data-types">
        <div className="mb-2 text-sm font-medium">Data Types</div>
        <div className="flex flex-wrap gap-3">
          <TypeColorMark colorVar={PIN_COLOR_VAR.bool} label="Bool" />
          <TypeColorMark colorVar={PIN_COLOR_VAR.float} label="Float" />
          <TypeColorMark colorVar={PIN_COLOR_VAR.vector} label="Vector" />
          <TypeColorMark colorVar={PIN_COLOR_VAR.object} label="Object" />
          <TypeColorMark colorVar={ASSET_COLOR_VAR.texture} label="Texture" />
          <TypeColorMark colorVar={ASSET_COLOR_VAR.class} label="Class" />
          <TypeColorMark colorVar={ASSET_COLOR_VAR.folder} label="Folder" />
        </div>
      </div>
      <div
        className="rounded-lg border border-border p-3"
        data-testid="gallery-type-visuals"
      >
        <div className="mb-2 text-sm font-medium">Type Visuals</div>
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex flex-col items-center gap-1">
            <TypeVisualIcon
              visual={resolveTypeVisual({ assetType: "Scene" })}
              data-testid="gallery-type-visual-chrome"
            />
            <span className="text-[10px] text-muted-foreground">Chrome 16</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <TypeVisualIcon
              visual={resolveTypeVisual({ assetType: "Texture" })}
              size={TYPE_VISUAL_ICON_TILE_SIZE}
              data-testid="gallery-type-visual-tile"
            />
            <span className="text-[10px] text-muted-foreground">Tile 40</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <TypeVisualIcon
              visual={resolveTypeVisual({
                assetType: "Class",
                parentClass: "Actor",
              })}
              size={TYPE_VISUAL_ICON_TILE_SIZE}
            />
            <span className="text-[10px] text-muted-foreground">Class tile</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <TypeVisualIcon
              visual={resolveTypeVisual({ assetType: "AnimationGraph" })}
              size={TYPE_VISUAL_ICON_TILE_SIZE}
              data-testid="gallery-type-visual-animation-graph"
            />
            <span className="text-[10px] text-muted-foreground">Animation Graph</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <TypeVisualIcon
              visual={resolveTypeVisual({ assetType: "BehaviourTree" })}
              size={TYPE_VISUAL_ICON_TILE_SIZE}
              data-testid="gallery-type-visual-behaviour-tree"
            />
            <span className="text-[10px] text-muted-foreground">Behaviour Tree</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <TypeVisualIcon
              visual={resolveTypeVisual({ assetType: "Model" })}
              size={TYPE_VISUAL_ICON_TILE_SIZE}
              data-testid="gallery-type-visual-model"
            />
            <span className="text-[10px] text-muted-foreground">Model</span>
          </div>
        </div>
      </div>
      <div className="h-40 overflow-hidden rounded-lg border border-border">
        <PanelFrame title="Tree view" data-testid="gallery-tree-view">
          <TreeView
            nodes={GALLERY_TREE_NODES}
            selectedId={selectedId}
            onSelect={setSelectedId}
            data-testid="gallery-tree"
          />
        </PanelFrame>
      </div>
      <div className="h-40 overflow-hidden rounded-lg border border-border">
        <PanelFrame title="Windowed list" data-testid="gallery-windowed-list">
          <ScrollArea className="h-full p-2">
            <WindowedList
              itemCount={80}
              rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}
            >
              {(index) => (
                <div className="flex h-full items-center text-sm">
                  Row {index + 1}
                </div>
              )}
            </WindowedList>
          </ScrollArea>
        </PanelFrame>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <NumericDragField
            label="Drag"
            value={speed}
            onChange={setSpeed}
            data-testid="gallery-numeric-drag"
          />
        </div>
        <Button variant="outline" onClick={() => setSearchOpen(true)}>
          Open search dialog
        </Button>
        <SearchDropdown
          title="Tile Palette"
          items={[
            { id: "0", label: "Empty", description: "Tile 0" },
            { id: "1", label: "Tile 1", description: "Full" },
          ]}
          onSelect={() => {}}
          data-testid="gallery-search-dropdown"
        >
          <Button variant="outline">Open search dropdown</Button>
        </SearchDropdown>
        <Button variant="outline" className="h-auto" onClick={() => setPickerOpen(true)}>
          {selectedPickerIdentity(
            assetRowIdentity({ name: "Rock", type: "Mesh" }),
            "Open asset picker",
          )}
        </Button>
        <AssetPickerControl value="gallery-texture">
          <Button
            variant="outline"
            className="h-auto"
            data-testid="gallery-texture-picker"
            onClick={() => setPickerOpen(true)}
          >
            {selectedPickerIdentity(
              assetRowIdentity({ name: "Grass", type: "Texture" }),
              "Open asset picker",
            )}
          </Button>
        </AssetPickerControl>
        <Button variant="outline" className="h-auto" onClick={() => setClassPickerOpen(true)}>
          {selectedPickerIdentity(
            classRowIdentity({ id: "MyGame", name: "My Game" }),
            "Open class picker",
          )}
        </Button>
        <Button
          variant="outline"
          className="h-auto"
          onClick={() => setSceneComponentPickerOpen(true)}
        >
          {selectedPickerIdentity(
            {
              displayLabel: "Hero Camera",
              displayType: "CameraComponent",
              visual: { classId: "CameraComponent", family: "class" },
            },
            "Open scene component picker",
          )}
        </Button>
        <Button variant="outline" onClick={() => setNamePromptOpen(true)}>
          Open name prompt
        </Button>
      </div>
      <GalleryNestedMenus />
      <div className="rounded-lg border border-border p-3">
        <NamedListEditor
          title="Named List"
          values={layers}
          onChange={setLayers}
          data-testid="gallery-named-list"
        />
      </div>
      <div className="rounded-lg border border-border p-3">
        <InputMappingEditor
          value={mappings}
          onChange={setMappings}
          data-testid="gallery-input-mapping"
        />
      </div>
      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Add Component"
        items={[
          { id: "mesh", label: "MeshComponent", description: "Renderable mesh" },
          { id: "camera", label: "CameraComponent", description: "Scene camera" },
          ...Array.from({ length: 18 }, (_, index) => ({
            id: `extra-${index}`,
            label: `Gallery Item ${index}`,
            description: "Overflow row",
          })),
        ]}
        onSelect={() => {}}
        data-testid="gallery-search-dialog"
      />
      <AssetPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={[{ guid: "gallery-asset", name: "Rock", type: "Mesh" }]}
        onPick={() => {}}
        data-testid="gallery-asset-picker"
      />
      <ClassPicker
        open={classPickerOpen}
        onOpenChange={setClassPickerOpen}
        classes={[
          { id: "GameInstance", name: "Game Instance", group: "Engine" },
          { id: "MyGame", name: "My Game", group: "Project" },
        ]}
        onPick={() => {}}
        data-testid="gallery-class-picker"
      />
      <SceneComponentPicker
        open={sceneComponentPickerOpen}
        onOpenChange={setSceneComponentPickerOpen}
        components={[
          {
            actorId: "hero",
            componentId: "hero-cam",
            actorName: "Hero",
            componentTitle: "Camera",
            classId: "CameraComponent",
          },
        ]}
        allowedClassIds={["CameraComponent"]}
        onPick={() => {}}
        data-testid="gallery-scene-component-picker"
      />
      <NamePromptDialog
        open={namePromptOpen}
        onOpenChange={setNamePromptOpen}
        title="Add Variable"
        label="Variable Name"
        onSubmit={() => {}}
        data-testid="gallery-name-prompt"
      />
      <AddFunctionDialog
        open={addFunctionOpen}
        onOpenChange={setAddFunctionOpen}
        items={[
          {
            id: "interface:g:Apply Damage",
            name: "Apply Damage",
            description: "Interface · Damageable",
            overwritten: false,
            kind: "interface",
          },
        ]}
        onCreateEmpty={() => {}}
        onPick={() => {}}
      />
    </div>
    </AssetOpenProvider>
  );
}

function GalleryTouchControls() {
  const [tool, setTool] = useState("translate");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [category, setCategory] = useState("appearance");
  const [search, setSearch] = useState("");

  return (
    <>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Touch actions</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="touch" variant="outline" data-testid="gallery-touch-button">
            Outline action
          </Button>
          <Button size="touch-icon" variant="outline" aria-label="Save">
            <SaveIcon />
          </Button>
          <ToggleGroup
            variant="outline"
            size="touch"
            spacing={1}
            value={[tool]}
            onValueChange={(value) => {
              if (value[0]) setTool(value[0]);
            }}
            aria-label="Gizmo tool"
            data-testid="gallery-toggle-group"
          >
            <ToggleGroupItem value="translate">Move</ToggleGroupItem>
            <ToggleGroupItem value="rotate">Rotate</ToggleGroupItem>
            <ToggleGroupItem value="scale">Scale</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <p className="text-sm text-muted-foreground">
          Outline marks an action. Toggle fill (`aria-pressed`) marks the active tool.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Settings catalog</h2>
        <Button
          size="touch"
          variant="outline"
          data-testid="gallery-open-catalog"
          onClick={() => setCatalogOpen(true)}
        >
          Open grouped catalog
        </Button>
        <CatalogDialog
          open={catalogOpen}
          onOpenChange={setCatalogOpen}
          title="Engine Settings"
          description="Search is not autofocused so iPad does not raise the keyboard."
          categories={[
            { id: "appearance", label: "Appearance" },
            { id: "viewport", label: "Viewport" },
            { id: "templates", label: "Templates" },
          ]}
          groups={[
            { label: "Rendering", ids: ["appearance", "viewport"] },
            { label: "Project", ids: ["templates"] },
          ]}
          activeCategoryId={category}
          onCategoryChange={setCategory}
          search={search}
          onSearchChange={setSearch}
          data-testid="gallery-catalog"
        >
          <p className="text-sm text-muted-foreground">
            Project Settings and Engine Settings are separate catalog modals.
          </p>
        </CatalogDialog>
        <p
          className="text-sm text-muted-foreground"
          data-testid="gallery-prefab-tab-note"
        >
          Class documents show Prefab as a full-size center-group tab beside Graph,
          not a 160px sidebar strip. The Components tree stays in the left dock.
        </p>
      </section>
    </>
  );
}

function GalleryForms() {
  const [volume, setVolume] = useState(0.5);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">Forms</h2>
      <Card>
        <CardHeader>
          <CardTitle>Field group</CardTitle>
          <CardDescription>Engine Settings field pattern.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="gallery-name">Name</FieldLabel>
              <Input id="gallery-name" defaultValue="Sample" />
            </Field>
            <Field>
              <FieldLabel htmlFor="gallery-volume">Volume</FieldLabel>
              <Slider
                id="gallery-volume"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                data-testid="gallery-slider"
                onValueChange={(next) => {
                  const value = Array.isArray(next) ? next[0] : next;
                  if (typeof value === "number") setVolume(value);
                }}
              />
            </Field>
            <Field orientation="horizontal">
              <Switch id="gallery-switch" defaultChecked />
              <FieldLabel htmlFor="gallery-switch">Enabled</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="gallery-check" defaultChecked />
              <FieldLabel htmlFor="gallery-check">Generate thumbnails</FieldLabel>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </section>
  );
}

function GalleryDangerDialog() {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="outline" data-testid="gallery-danger-dialog-open" />
        }
      >
        Open Danger Dialog
      </AlertDialogTrigger>
      <AlertDialogContent
        variant="destructive"
        data-testid="gallery-danger-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogMedia data-testid="gallery-danger-dialog-media">
            <OctagonAlertIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete Items?</AlertDialogTitle>
          <AlertDialogDescription>
            This action is not undoable. The selected assets will be removed
            permanently.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="touch">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            size="touch"
            data-testid="gallery-danger-dialog-confirm"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ComponentGallery() {
  return (
    <div
      className="flex min-h-svh h-dvh flex-col overflow-hidden bg-background text-foreground"
      data-testid="component-gallery"
    >
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-semibold">Component Gallery</h1>
        <p className="text-sm text-muted-foreground">
          Dev-only audit surface for Neutral chrome tokens and editor-kit composites.
          Open with{" "}
          <SelectableText className="font-mono text-xs">
            ?test=1&amp;gallery=1
          </SelectableText>
          .
        </p>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-4xl flex-col gap-8 p-6">
          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Actions</h2>
            <div className="flex flex-wrap gap-2">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
            </div>
            <GalleryDangerDialog />
          </section>

          <GalleryTouchControls />

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Feedback</h2>
            <Alert>
              <AlertTitle>Default alert</AlertTitle>
              <AlertDescription>Layered charcoal surface tokens.</AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge className="bg-vector text-background">Vector</Badge>
            </div>
            <Skeleton className="h-10 w-full max-w-sm" />
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyTitle>Empty state</EmptyTitle>
                <EmptyDescription>No items to show.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </section>

          <GalleryForms />

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Tabs</h2>
            <Tabs defaultValue="general">
              <TabsList>
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="rendering">Rendering</TabsTrigger>
              </TabsList>
              <TabsContent value="general" className="pt-4 text-sm text-muted-foreground">
                General settings content
              </TabsContent>
              <TabsContent value="rendering" className="pt-4 text-sm text-muted-foreground">
                Rendering settings content
              </TabsContent>
            </Tabs>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Tooltip</h2>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="outline" data-testid="gallery-tooltip-trigger" />}
              >
                Hover or focus
              </TooltipTrigger>
              <TooltipContent>Tooltip content</TooltipContent>
            </Tooltip>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">editor-kit composites</h2>
            <div className="overflow-hidden rounded-lg border border-border">
              <ToolbarStrip data-testid="gallery-toolbar-strip">
                <Button size="touch-icon" variant="outline" aria-label="Move">
                  Move
                </Button>
                <Separator orientation="vertical" className="h-8" />
                <Button size="touch" variant="outline">
                  Snap
                </Button>
              </ToolbarStrip>
              <PanelFrame title="Panel frame" data-testid="gallery-panel-frame">
                <p className="p-4 text-sm text-muted-foreground">
                  Docked panel body uses PanelFrame + ScrollArea in real panels.
                </p>
              </PanelFrame>
            </div>
            <GalleryComposites />
          </section>

          <Separator />
          <p className="text-xs text-muted-foreground">
            Touch-target minimum: <code>var(--touch-target)</code> (
            <span data-testid="gallery-touch-target-token">44px</span>)
          </p>
        </div>
      </ScrollArea>
    </div>
  );
}
