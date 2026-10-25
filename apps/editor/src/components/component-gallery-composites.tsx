import type { AssetLoadingPolicy } from "@haptic/core";
import { useState } from "react";
import {
  AssetCreateProvider,
  type AssetCreateApi,
  AssetPicker,
  AssetOpenProvider,
  AssetPickerControl,
  AtlasTileGrid,
  BindingCodePicker,
  ClassPicker,
  SceneComponentPicker,
  NamedListEditor,
  EntryListEditor,
  ArrayProperty,
  DisclosureSection,
  NamePromptDialog,
  AddMemberMenu,
  NumericDragField,
  PanelFrame,
  ParameterListEditor,
  AssetLoadingField,
  PinListEditor,
  PinTypePicker,
  VariableTypeFields,
  PropertyGrid,
  SearchDialog,
  SearchDropdown,
  MultilineTextField,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  TypeColorMark,
  TYPE_VISUAL_ICON_TILE_SIZE,
  TypeVisualIcon,
  assetRowIdentity,
  classRowIdentity,
  resolveTypeVisual,
  selectedPickerIdentity,
  type CurveKey,
  type ParameterRow,
  type PinListRow,
  type PinPickerType,
  type PropertyRow,
  type VariableTypeFieldsValue,
} from "@haptic/editor-kit";
import { ensureTilesetTiles, normalizeTilesetPayload } from "@haptic/assets";
import { ASSET_COLOR_VAR, PIN_COLOR_VAR } from "@haptic/ui/lib/data-types";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { GalleryTreeExample } from "./component-gallery-tree";
import { GalleryModuleStack, GalleryParticleFields } from "./component-gallery-particles";
import {
  GalleryCatalogRows,
  GalleryNestedMenus,
  GalleryToolbarOverflow,
} from "./component-gallery-menus";

/** Demo creation for the picker Create New rows; resolves to existing gallery entries. */
const GALLERY_ASSET_CREATE: AssetCreateApi = {
  canCreate: (type) => type === "Material",
  typeLabel: (type) => type,
  createAsset: async () => "gallery-material",
  createClass: async () => "MyGame",
};

function GalleryDisclosure() {
  const [open, setOpen] = useState(false);
  return (
    <DisclosureSection title="Rendering Overrides" open={open} onOpenChange={setOpen} data-testid="gallery-disclosure">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="gallery-disclosure-value">Shadow Distance</FieldLabel>
          <Input id="gallery-disclosure-value" defaultValue="200" />
        </Field>
      </FieldGroup>
    </DisclosureSection>
  );
}

export function GalleryComposites() {
  const [position, setPosition] = useState<[number, number, number]>([0, 1, 0]);
  const [speed, setSpeed] = useState(4);
  const [friction, setFriction] = useState(0.5);
  const [physicsLayer, setPhysicsLayer] = useState(1);
  const [visible, setVisible] = useState(true);
  const [tint, setTint] = useState<[number, number, number]>([1, 0, 0]);
  const [lifetimeRange, setLifetimeRange] = useState<[number, number]>([0.8, 1.2]);
  const [fadeCurve, setFadeCurve] = useState<CurveKey[]>([
    { t: 0, value: 1 },
    { t: 1, value: 0 },
  ]);
  const [startColor, setStartColor] = useState<[number, number, number, number]>([
    1, 0.54, 0, 0.8,
  ]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [classPickerOpen, setClassPickerOpen] = useState(false);
  const [atlasTileId, setAtlasTileId] = useState(1);
  const [sceneComponentPickerOpen, setSceneComponentPickerOpen] =
    useState(false);
  const [namePromptOpen, setNamePromptOpen] = useState(false);
  const [layers, setLayers] = useState(["Default", "Foreground"]);
  const [entryItems, setEntryItems] = useState(["One", "Two"]);
  const [arrayItems, setArrayItems] = useState(["foreground"]);
  const [parameters, setParameters] = useState<ParameterRow[]>([
    { id: "gallery-amount", name: "amount", type: "float" },
  ]);
  const [pinType, setPinType] = useState<PinPickerType>("float");
  const [variableType, setVariableType] = useState<VariableTypeFieldsValue>({
    typeId: "float",
    container: "single",
  });
  const [loading, setLoading] = useState<AssetLoadingPolicy>("soft");
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
  const [markup, setMarkup] = useState("[color=green]Hello[/color]");

  const rows: PropertyRow[] = [
    {
      kind: "text",
      id: "gallery-entry-id",
      label: "Entry ID",
      value: "first-tint",
      readOnly: true,
      onChange: () => {},
    },
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
      kind: "range",
      id: "gallery-lifetime-range",
      label: "Lifetime",
      unit: "s",
      value: lifetimeRange,
      defaultValue: [0.8, 1.2],
      min: 0.01,
      onChange: setLifetimeRange,
    },
    {
      kind: "curve",
      id: "gallery-fade",
      label: "Fade",
      value: fadeCurve,
      defaultValue: [
        { t: 0, value: 1 },
        { t: 1, value: 0 },
      ],
      valueMin: 0,
      valueMax: 1,
      onChange: setFadeCurve,
    },
    {
      kind: "color4",
      id: "gallery-start-color",
      label: "Start Color",
      value: startColor,
      defaultValue: [1, 1, 1, 1],
      onChange: setStartColor,
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
      ...assetRowIdentity({ name: "Rock", type: "Model" }),
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
            readOnly
            rows={[
              {
                kind: "text",
                id: "gallery-inspect-name",
                label: "Name",
                value: "Hero",
                onChange: () => {},
              },
              {
                kind: "number",
                id: "gallery-inspect-health",
                label: "Health",
                value: 10,
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
      <div className="rounded-lg border border-border p-3" data-testid="gallery-asset-loading-field">
        <div className="mb-2 text-sm font-medium">Asset Loading Field</div>
        <AssetLoadingField value={loading} onChange={setLoading} data-testid="gallery-asset-loading" />
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
      <div className="grid gap-3 lg:grid-cols-2" data-testid="gallery-tree-examples">
        <GalleryTreeExample />
        <GalleryTreeExample touch />
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
        <div className="w-full max-w-md">
          <Field>
            <FieldLabel htmlFor="gallery-markup-autocomplete">Markup</FieldLabel>
            <MultilineTextField
              id="gallery-markup-autocomplete"
              title="Markup"
              markup
              value={markup}
              onChange={setMarkup}
              data-testid="gallery-markup-autocomplete"
            />
          </Field>
        </div>
        <Button variant="outline" className="h-auto" onClick={() => setPickerOpen(true)}>
          {selectedPickerIdentity(
            assetRowIdentity({ name: "Rock", type: "Model" }),
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
        <AddMemberMenu
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
          data-testid="gallery-add-member-menu"
        >
          <Button variant="outline">Open add function menu</Button>
        </AddMemberMenu>
      </div>
      <GalleryNestedMenus />
      <GalleryToolbarOverflow />
      <GalleryCatalogRows />
      <GalleryDisclosure />
      <GalleryModuleStack />
      <GalleryParticleFields />
      <div className="rounded-lg border border-border p-3">
        <NamedListEditor
          title="Named List"
          values={layers}
          onChange={setLayers}
          data-testid="gallery-named-list"
        />
      </div>
      <div className="rounded-lg border border-border p-3">
        <EntryListEditor
          title="Entry List"
          items={entryItems}
          onChange={setEntryItems}
          onCreate={() => "New"}
          addLabel="Add Item"
          data-testid="gallery-entry-list"
          renderItemHeader={({ index }) => (
            <span className="truncate text-sm">Entry {index + 1}</span>
          )}
          renderItem={({ item, index, onChange }) => (
            <Input
              value={item}
              onChange={(event) => onChange(event.target.value)}
              data-testid={`gallery-entry-${index}`}
            />
          )}
        />
      </div>
      <div className="rounded-lg border border-border p-3">
        <ArrayProperty
          label="Array Property" value={arrayItems} onChange={setArrayItems}
          options={[
            { id: "background", label: "Background", value: "background" },
            { id: "foreground", label: "Foreground", value: "foreground" },
            { id: "overlay", label: "Overlay", value: "overlay" },
          ]}
          unique defaultValue={[]} emptyLabel="No Layers"
          description="Each layer can appear once. Add, replace, reorder, or remove entries."
          data-testid="gallery-array-property"
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
      <AssetCreateProvider value={GALLERY_ASSET_CREATE}>
        <AssetPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          assets={[
            { guid: "gallery-asset", name: "Rock", type: "Model" },
            { guid: "gallery-material", name: "Stone", type: "Material" },
          ]}
          allowedTypes={["Material"]}
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
          createBaseClass="GameInstance"
          onPick={() => {}}
          data-testid="gallery-class-picker"
        />
      </AssetCreateProvider>
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
    </div>
    </AssetOpenProvider>
  );
}
