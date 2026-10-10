import {
  createActor,
  createDefaultSceneLayer,
  type AxisBinding,
  type PainterCommand,
  type SceneLayerSpawnEntry,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedSceneLayer,
  type SerializedTransform,
} from "@babylonslate/core";
import { engineScriptApiFor, type EngineScriptFunction } from "@babylonslate/object-model";
import {
  comp,
  requireRef,
  SCENE_SAVE_ORDER,
  tf,
  type FeatureTestClassRef,
  type FeatureTestContext,
} from "./context";
import { classGraph, getVar, gNode, gWire, setVar, varMember, type GraphNode } from "./graph";
import { FEATURE_TEST_MATERIAL_NAMES, featureTestMaterialAssetGuid } from "./materials";

/** Folder under `assets/FeatureTest/` for the Scene Layers and their SceneLayerActor Classes. */
export const FEATURE_TEST_SCENE_LAYERS_FOLDER = "SceneLayers";

/** Asset names (Classes are `FT_UI*`, so their class ids never collide with other areas). */
export const FEATURE_TEST_SCENE_LAYER_NAMES = {
  /** Every 2D overlay widget, spawned over the main scene at z-order 10. */
  hud: "FT_HUD",
  /** Small physics-enabled layer (own 2D world), spawned over the main scene at z-order 5. */
  overlayPhysics: "FT_OverlayPhysics",
  listItem: "FT_UIListItem",
  gridItem: "FT_UIGridItem",
  cardA: "FT_UICardA",
  cardB: "FT_UICardB",
  switcher: "FT_UICardSwitcher",
  clickButton: "FT_UIClickButton",
} as const;

/**
 * Workload knobs. Virtualized containers only realize visible rows plus
 * overscan (about 10 list rows and 24 grid cells), so the item counts change
 * scroll range rather than per-frame cost.
 */
export const FEATURE_TEST_SCENE_LAYER_KNOBS = {
  listItemCount: 10_000,
  gridItemCount: 400,
  scrollRows: 10,
  overlayPhysicsBoxes: 8,
  /** Seconds between Card Switcher swaps. */
  switchIntervalSeconds: 2.5,
  painterPixelsPerUnit: 64,
  hudZOrder: 10,
  overlayPhysicsZOrder: 5,
} as const;

const NAMES = FEATURE_TEST_SCENE_LAYER_NAMES;
const KNOBS = FEATURE_TEST_SCENE_LAYER_KNOBS;
const FOLDER = FEATURE_TEST_SCENE_LAYERS_FOLDER;

/**
 * Layer units: the default 32 × 18 canvas (x −16..16, y −9..9). 2D Text sizes
 * and wrap boxes are pixels at the project's default 100 pixels per unit.
 * Backgrounds sit at +Z (behind) and labels at −Z (in front): the overlay
 * camera looks down +Z from z = −10.
 */
const BACK_Z = 0.4;
const ITEM_BACK_Z = 0.05;
const FRONT_Z = -0.05;

const LIST = { width: 4.1, height: 1.7, itemHeight: 0.34, gap: 0.06, overscan: 2 } as const;
const GRID = { width: 4.1, height: 1.6, item: 0.6, gap: 0.08, overscan: 1 } as const;
const CARD = { width: 2.8, height: 0.85 } as const;
const BUTTON = { width: 2.6, height: 0.7 } as const;

/** Guids and Classes the layers are written from. */
interface LayerRefs {
  font: string;
  textMaterial: string;
  overlayMaterial: string;
  panelTexture: string;
  icons: Record<"camera" | "audio" | "particles" | "point_light" | "spot_light" | "navmesh" | "default", string>;
  classes: Record<"listItem" | "gridItem" | "cardA" | "cardB" | "switcher" | "clickButton", PlacedClass>;
}

/** A Class plus the prefab components its layer instances copy. */
interface PlacedClass {
  ref: FeatureTestClassRef;
  components: SerializedComponent[];
}

const layerGuidsByContext = new WeakMap<FeatureTestContext, { hud: string; overlayPhysics: string }>();

/**
 * SceneLayerActor Classes (list and grid items, two switchable cards, a click
 * counter button) and a SceneLayerActorSwitcher Class, then the `FT_HUD` layer
 * with every 2D overlay widget and the physics-enabled `FT_OverlayPhysics`
 * layer. Also binds the 2D Joystick to the Basic 3D Move axis (touch rows)
 * and routes focus activation to the Confirm action.
 */
export async function buildFeatureTestSceneLayers(ctx: FeatureTestContext): Promise<void> {
  const font = requireRef(ctx.assets.fonts.geist, "the Geist Font");
  const overlayMaterial = requireRef(ctx.assets.materials.overlayUnlit, "the overlay unlit Material");
  const icon = (stem: keyof LayerRefs["icons"]) => requireRef(ctx.assets.textures.ui[stem], `the ui_${stem} Texture`);
  const base = {
    font,
    textMaterial: featureTestMaterialAssetGuid(ctx, "Material", FEATURE_TEST_MATERIAL_NAMES.text),
    overlayMaterial,
    panelTexture: requireRef(ctx.assets.textures.colormapPixelArt, "the pixel art colormap Texture"),
    icons: {
      camera: icon("camera"),
      audio: icon("audio"),
      particles: icon("particles"),
      point_light: icon("point_light"),
      spot_light: icon("spot_light"),
      navmesh: icon("navmesh"),
      default: icon("default"),
    },
  };

  const cardA = await saveCard(ctx, base, NAMES.cardA, "Card A", [0.3, 0.55, 1, 0.95]);
  const cardB = await saveCard(ctx, base, NAMES.cardB, "Card B", [1, 0.55, 0.25, 0.95]);
  const refs: LayerRefs = {
    ...base,
    classes: {
      listItem: await saveListItem(ctx, base),
      gridItem: await saveGridItem(ctx, base),
      cardA,
      cardB,
      switcher: await saveSwitcher(ctx, base),
      clickButton: await saveClickButton(ctx, base),
    },
  };

  const hud = await ctx.addSceneDocument({
    kind: "scene-layer",
    folder: FOLDER,
    name: NAMES.hud,
    content: hudLayer(refs),
    order: SCENE_SAVE_ORDER.sceneLayer,
  });
  const overlayPhysics = await ctx.addSceneDocument({
    kind: "scene-layer",
    folder: FOLDER,
    name: NAMES.overlayPhysics,
    content: overlayPhysicsLayer(refs),
    order: SCENE_SAVE_ORDER.sceneLayer,
  });
  layerGuidsByContext.set(ctx, { hud: hud.guid, overlayPhysics: overlayPhysics.guid });

  await bindJoystickToMove(ctx);
  const confirm = ctx.registry
    .list()
    .find((asset) => asset.rootId === "project" && asset.header.type === "InputAction" && asset.header.name === "Confirm");
  const activateInputGuid = requireRef(confirm?.header.guid, "the Basic 3D Confirm Input Action");
  // Enter / Face Button Right activate HUD focus; Space stays Jump.
  ctx.patchSettings((settings) => ({
    ...settings,
    focusNavigation: { ...settings.focusNavigation, enabled: true, activateInputGuid, wrap: true },
  }));
}

/** Spawn `FT_OverlayPhysics` (z 5) and `FT_HUD` (z 10) over the main scene. */
export async function placeFeatureTestSceneLayers(ctx: FeatureTestContext): Promise<void> {
  const guids = layerGuidsByContext.get(ctx);
  if (!guids) throw new Error("FeatureTest Scene Layers were not built before placement.");
  const entries: SceneLayerSpawnEntry[] = [
    { assetGuid: guids.overlayPhysics, zOrder: KNOBS.overlayPhysicsZOrder, enabled: true },
    { assetGuid: guids.hud, zOrder: KNOBS.hudZOrder, enabled: true },
  ];
  const settings = ctx.mainScene.settings;
  settings.sceneLayers = [
    ...settings.sceneLayers.filter((entry) => !entries.some((next) => next.assetGuid === entry.assetGuid)),
    ...entries,
  ];
}

// ---------------------------------------------------------------------------
// FT_HUD

type Rgba = [number, number, number, number];

/**
 * Every overlay widget, kept to the screen edges so the 3D view stays
 * visible: title bar on top, form controls on the left, containers on the
 * right, a widget row and a Class row at the bottom, joystick and painter in
 * the bottom corners.
 */
function hudLayer(refs: LayerRefs): SerializedSceneLayer {
  const layer: SerializedSceneLayer = { ...createDefaultSceneLayer(), name: NAMES.hud };
  layer.settings.layerBounds = { width: 32, height: 18 };
  layer.folders = [
    { id: "ft-ui-folder-header", name: "Header", parentFolderId: null },
    { id: "ft-ui-folder-forms", name: "Form Controls", parentFolderId: null },
    { id: "ft-ui-folder-containers", name: "Containers", parentFolderId: null },
    { id: "ft-ui-folder-widgets", name: "Widget Row", parentFolderId: null },
    { id: "ft-ui-folder-classes", name: "Class Row", parentFolderId: null },
    { id: "ft-ui-folder-input", name: "Joystick And Painter", parentFolderId: null },
  ];
  const add = (actor: SerializedActor) => addLayerActor(layer, actor);
  addHeader(refs, add);
  addForms(refs, add);
  addContainers(refs, add);
  addWidgetRow(refs, add);
  addClassRow(refs, add);
  addJoystickAndPainter(add);
  return layer;
}

type AddActor = (actor: SerializedActor) => void;

/** Title (Text Material + top-center Anchor), Rich Text, material 9-slice Panel and the Safe Area. */
function addHeader(refs: LayerRefs, add: AddActor): void {
  const folderId = "ft-ui-folder-header";
  add(layerActor("ft-ui-title-bar", "Title Bar", [
    ui("ft-ui-title-bar-panel", "2DPanelComponent", {
      source: "material",
      materialGuid: refs.overlayMaterial,
      ...margins(0.08),
      tint: [0.4, 0.3, 0.8, 0.55],
    }),
  ], { position: [0, 7.95, BACK_Z], scale: [16, 1.7], folderId }));
  add(layerActor("ft-ui-title", "Title", [
    ui("ft-ui-title-text", "2DTextComponent", text(refs, "BabylonSlate Feature Test", 44, [900, 60], {
      bold: true,
      alignment: "center",
      outline: 2,
      outlineColor: [0.12, 0.05, 0],
      materialGuid: refs.textMaterial,
      materialUv: "text",
    })),
    ui("ft-ui-title-anchor", "2DAnchorComponent", { anchor: "topCenter", offsetX: 0, offsetY: -0.1 }),
  ], { position: [0, 8.35], folderId }));
  add(layerActor("ft-ui-rich-text", "Rich Text", [
    ui("ft-ui-rich-text-markup", "2DRichTextComponent", {
      ...text(refs, richTextMarkup(refs.icons.camera), 30, [1500, 44], { alignment: "center" }),
      appearModes: ["fade", "slide"],
      appearTransition: "cubicOut",
      appearInterval: 0.03,
      appearDuration: 0.25,
      appearStart: "play",
    }),
  ], { position: [0, 7.55], folderId }));
  // Root Safe Area over the whole canvas: its label lands top-left inside the insets.
  add(layerActor("ft-ui-safe-area", "Safe Area", [
    ui("ft-ui-safe-area-box", "2DSafeAreaComponent", {
      width: 32,
      height: 18,
      horizontalAlignment: "start",
      verticalAlignment: "start",
      insetLeft: 0.3,
      insetRight: 0.3,
      insetTop: 0.25,
      insetBottom: 0.25,
    }),
  ], { folderId }));
  add(layerActor("ft-ui-safe-area-label", "Safe Area Label", [
    ui("ft-ui-safe-area-label-text", "2DTextComponent", text(refs, "Safe Area", 24, [220, 32], { color: [0.7, 0.9, 1] })),
  ], { parentId: "ft-ui-safe-area" }));
}

function richTextMarkup(imageGuid: string): string {
  return [
    "[b]Rich[/b] [i]Text[/i] [color=orange]color[/color] [size=36]size[/size]",
    "[outline=3][outline-color=1a0a3a]outline[/outline-color][/outline] [u]under[/u]",
    `[img=${imageGuid} size=28] [wave=3 intensity=1.2]wave[/wave] [shake=1]shake[/shake]`,
    "[hover=1]hover[/hover] [rotate=10]tilt[/rotate]",
  ].join(" ");
}

/** Left column: Vertical Box of every form control (a nested Horizontal Box holds the toggles). */
function addForms(refs: LayerRefs, add: AddActor): void {
  const folderId = "ft-ui-folder-forms";
  const column = "ft-ui-forms";
  add(layerActor("ft-ui-forms-background", "Forms Background", [
    texturePanel("ft-ui-forms-background-panel", refs.panelTexture),
  ], { position: [-13.45, 2.55, BACK_Z], scale: [4.7, 5.4], folderId }));
  add(layerActor(column, "Form Column", [
    ui(`${column}-box`, "2DVerticalBoxComponent", {
      width: 4.5,
      height: 5.3,
      gap: 0.17,
      paddingTop: 0.2,
      paddingLeft: 0.2,
      paddingRight: 0.2,
      horizontalAlignment: "start",
      verticalAlignment: "start",
    }),
  ], { position: [-13.45, 2.55], folderId }));
  const control = (id: string, name: string, classId: string, properties: Record<string, unknown>, parentId = column) =>
    add(layerActor(id, name, [ui(`${id}-control`, classId, { height: 0.5, fontSize: 0.28, ...properties })], { parentId }));

  add(layerActor("ft-ui-forms-header", "Forms Header", [
    ui("ft-ui-forms-header-text", "2DTextComponent", header(refs, "Form Controls")),
  ], { parentId: column }));
  control("ft-ui-slider", "Slider", "2DSliderComponent", {
    width: 4.1,
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    thumbTextureGuid: refs.icons.point_light,
  });
  control("ft-ui-range-slider", "Range Slider", "2DRangeSliderComponent", {
    width: 4.1,
    min: 0,
    max: 10,
    step: 1,
    lowerValue: 2,
    upperValue: 7,
  });
  const toggles = "ft-ui-toggle-row";
  add(layerActor(toggles, "Toggle Row", [
    ui(`${toggles}-box`, "2DHorizontalBoxComponent", { width: 4.1, height: 0.5, gap: 0.35, verticalAlignment: "center" }),
  ], { parentId: column }));
  control("ft-ui-checkbox", "Checkbox", "2DCheckboxComponent", { width: 0.5, checked: true }, toggles);
  control("ft-ui-radio-low", "Radio Low", "2DRadioButtonComponent", { width: 0.5, group: "quality", checked: true }, toggles);
  control("ft-ui-radio-high", "Radio High", "2DRadioButtonComponent", { width: 0.5, group: "quality" }, toggles);
  control("ft-ui-toggle", "Toggle", "2DToggleComponent", { width: 1, checked: true }, toggles);
  control("ft-ui-text-input", "Text Input", "2DTextInputComponent", {
    width: 4.1,
    text: "FeatureTest",
    placeholder: "Type here",
    maxLength: 24,
  });
  control("ft-ui-numeric-input", "Numeric Input", "2DNumericInputComponent", {
    width: 4.1,
    min: 0,
    max: 100,
    step: 1,
    value: 42,
  });
  control("ft-ui-dropdown", "Dropdown", "2DDropdownComponent", {
    width: 4.1,
    options: ["Low", "Medium", "High", "Epic"],
    selectedIndex: 2,
  });
  // The fill part uses the scrolling overlay Material instead of the native mesh.
  control("ft-ui-progress-bar", "Progress Bar", "2DProgressBarComponent", {
    width: 4.1,
    height: 0.35,
    min: 0,
    max: 1,
    value: 0.65,
    fillMaterialGuid: refs.overlayMaterial,
  });
}

/** Right column: Scroll Box, Virtualized List and Virtualized Grid in a Vertical Box. */
function addContainers(refs: LayerRefs, add: AddActor): void {
  const folderId = "ft-ui-folder-containers";
  const column = "ft-ui-containers";
  add(layerActor("ft-ui-containers-background", "Containers Background", [
    texturePanel("ft-ui-containers-background-panel", refs.panelTexture),
  ], { position: [13.45, 2.2, BACK_Z], scale: [4.7, 6.5], folderId }));
  add(layerActor(column, "Container Column", [
    ui(`${column}-box`, "2DVerticalBoxComponent", {
      width: 4.5,
      height: 6.4,
      gap: 0.17,
      paddingTop: 0.2,
      paddingLeft: 0.2,
      paddingRight: 0.2,
      horizontalAlignment: "start",
      verticalAlignment: "start",
    }),
  ], { position: [13.45, 2.2], folderId }));
  add(layerActor("ft-ui-containers-header", "Containers Header", [
    ui("ft-ui-containers-header-text", "2DTextComponent", header(refs, "Containers")),
  ], { parentId: column }));

  // Scroll Box → Vertical Box (content height) → text rows taller than the viewport.
  add(layerActor("ft-ui-scroll-box", "Scroll Box", [
    ui("ft-ui-scroll-box-viewport", "2DScrollBoxComponent", { width: 4.1, height: 1.9, scrollAxis: "vertical" }),
    containerBackground("ft-ui-scroll-box-background", refs, 4.1, 1.9),
  ], { parentId: column }));
  add(layerActor("ft-ui-scroll-content", "Scroll Content", [
    ui("ft-ui-scroll-content-box", "2DVerticalBoxComponent", {
      width: 4.1,
      heightMode: "content",
      gap: 0.06,
      paddingLeft: 0.1,
      horizontalAlignment: "start",
    }),
  ], { parentId: "ft-ui-scroll-box" }));
  for (let row = 1; row <= KNOBS.scrollRows; row += 1) {
    const label = String(row).padStart(2, "0");
    add(layerActor(`ft-ui-scroll-row-${label}`, `Scroll Row ${label}`, [
      ui(`ft-ui-scroll-row-${label}-text`, "2DTextComponent", text(refs, `Scroll Row ${label}`, 24, [390, 32], {
        color: row % 2 === 0 ? [0.75, 0.85, 1] : [1, 1, 1],
      })),
    ], { parentId: "ft-ui-scroll-content" }));
  }

  add(layerActor("ft-ui-virtual-list", "Virtualized List", [
    ui("ft-ui-virtual-list-container", "2DVirtualizedListComponent", {
      width: LIST.width,
      height: LIST.height,
      gap: LIST.gap,
      itemClassId: refs.classes.listItem.ref.classId,
      itemCount: KNOBS.listItemCount,
      itemWidth: LIST.width,
      itemHeight: LIST.itemHeight,
      overscan: LIST.overscan,
    }),
    containerBackground("ft-ui-virtual-list-background", refs, LIST.width, LIST.height),
  ], { parentId: column }));
  add(layerActor("ft-ui-virtual-grid", "Virtualized Grid", [
    ui("ft-ui-virtual-grid-container", "2DVirtualizedGridComponent", {
      width: GRID.width,
      height: GRID.height,
      gap: GRID.gap,
      itemClassId: refs.classes.gridItem.ref.classId,
      itemCount: KNOBS.gridItemCount,
      itemWidth: GRID.item,
      itemHeight: GRID.item,
      columns: 0,
      overscan: GRID.overscan,
    }),
    containerBackground("ft-ui-virtual-grid-background", refs, GRID.width, GRID.height),
  ], { parentId: column }));
}

/**
 * Bottom Horizontal Box (Padding helper): Texture, Material, the click
 * counter Button, a Spacer, Overlay Box, Mask Panel, Mask and a Focus Target.
 */
function addWidgetRow(refs: LayerRefs, add: AddActor): void {
  const row = "ft-ui-widget-row";
  add(layerActor(row, "Widget Row", [
    ui(`${row}-box`, "2DHorizontalBoxComponent", { width: 23, height: 1, gap: 0.35, verticalAlignment: "center" }),
    ui(`${row}-padding`, "2DPaddingComponent", { paddingLeft: 0.3, paddingRight: 0.3 }, undefined, `${row}-box`),
  ], { position: [0, -6.55], folderId: "ft-ui-folder-widgets" }));
  add(layerActor("ft-ui-texture", "Texture Icon", [
    ui("ft-ui-texture-image", "2DTextureComponent", { textureGuid: refs.icons.camera }),
  ], { parentId: row }));
  add(layerActor("ft-ui-material", "Material Swatch", [
    ui("ft-ui-material-quad", "2DMaterialComponent", { materialGuid: refs.overlayMaterial }, at(0, 0, 0, 0.9)),
  ], { parentId: row }));
  add(classInstance(refs.classes.clickButton, "ft-ui-click-button", "Click Button", { parentId: row }));
  add(layerActor("ft-ui-widget-spacer", "Widget Spacer", [
    ui("ft-ui-widget-spacer-fill", "2DSpacerComponent", { fillWeight: 1 }),
  ], { parentId: row }));

  const overlay = "ft-ui-overlay-box-layout";
  add(layerActor("ft-ui-overlay-box", "Overlay Box", [
    ui(overlay, "2DOverlayBoxComponent", {
      width: 3,
      height: 0.8,
      paddingLeft: 0.1,
      paddingRight: 0.1,
      horizontalAlignment: "center",
      verticalAlignment: "center",
    }),
    ui("ft-ui-overlay-box-fill", "2DMaterialComponent", {
      materialGuid: refs.overlayMaterial,
      tint: [0.9, 0.5, 0.2, 0.9],
      widthMode: "fill",
      heightMode: "fill",
    }, at(0, 0, ITEM_BACK_Z), overlay),
    ui("ft-ui-overlay-box-label", "2DTextComponent", text(refs, "Overlay Box", 24, [280, 30], { alignment: "center" }),
      at(0, 0, FRONT_Z), overlay),
  ], { parentId: row }));

  // Oversized icons: the Mask Panel clips its nested content, the Mask clips its own actor.
  const maskPanel = "ft-ui-mask-panel-clip";
  add(layerActor("ft-ui-mask-panel", "Mask Panel", [
    ui(maskPanel, "2DMaskPanelComponent", {
      width: 1.8,
      height: 0.8,
      horizontalAlignment: "center",
      verticalAlignment: "center",
    }),
    ui("ft-ui-mask-panel-image", "2DTextureComponent", { textureGuid: refs.icons.spot_light }, at(0, 0, 0, 3), maskPanel),
  ], { parentId: row }));
  add(layerActor("ft-ui-mask", "Mask", [
    ui("ft-ui-mask-clip", "2DMaskComponent", { width: 0.8, height: 0.8 }),
    ui("ft-ui-mask-image", "2DTextureComponent", { textureGuid: refs.icons.particles }, at(0, 0, 0, 2)),
  ], { parentId: row }));
  add(layerActor("ft-ui-focus-target", "Focus Target", [
    ui("ft-ui-focus-target-image", "2DTextureComponent", { textureGuid: refs.icons.audio }),
    ui("ft-ui-focus-target-focus", "2DFocusTargetComponent", {}),
  ], { parentId: row }));
}

/**
 * Bottom Horizontal Box (box padding): the Card Switcher, a Spacer and one
 * instance of every item and card Class. The samples keep those Classes in
 * Play's required closure: Switcher entries and `itemClassId` are soft refs.
 */
function addClassRow(refs: LayerRefs, add: AddActor): void {
  const row = "ft-ui-class-row";
  const { classes } = refs;
  add(layerActor(row, "Class Row", [
    ui(`${row}-box`, "2DHorizontalBoxComponent", {
      width: 23,
      height: 0.95,
      gap: 0.35,
      paddingLeft: 0.3,
      paddingRight: 0.3,
      verticalAlignment: "center",
    }),
  ], { position: [0, -8.15], folderId: "ft-ui-folder-classes" }));
  add(classInstance(classes.switcher, "ft-ui-card-switcher", "Card Switcher", {
    parentId: row,
    properties: {
      sceneLayerActors: [classes.cardA.ref.classId, { classId: classes.cardB.ref.classId, defaults: {} }],
      initialIndex: 0,
    },
  }));
  add(layerActor("ft-ui-class-spacer", "Class Spacer", [
    ui("ft-ui-class-spacer-fill", "2DSpacerComponent", { fillWeight: 1 }),
  ], { parentId: row }));
  add(layerActor("ft-ui-samples-label", "Class Samples Label", [
    ui("ft-ui-samples-label-text", "2DTextComponent", text(refs, "Class Samples", 24, [230, 30], { color: [0.7, 0.9, 1] })),
  ], { parentId: row }));
  add(classInstance(classes.listItem, "ft-ui-sample-list-item", "List Item Sample", {
    parentId: row,
    properties: { itemIndex: 7 },
  }));
  add(classInstance(classes.gridItem, "ft-ui-sample-grid-item", "Grid Item Sample", {
    parentId: row,
    properties: { itemIndex: 3 },
  }));
  add(classInstance(classes.cardA, "ft-ui-sample-card-a", "Card A Sample", { parentId: row, scale: [0.6, 0.6] }));
  add(classInstance(classes.cardB, "ft-ui-sample-card-b", "Card B Sample", { parentId: row, scale: [0.6, 0.6] }));
}

/** Joystick (own bottom-left Anchor) and a persistent Painter (anchored by a child anchor-only helper). */
function addJoystickAndPainter(add: AddActor): void {
  const folderId = "ft-ui-folder-input";
  add(layerActor("ft-ui-joystick", "Joystick", [
    ui("ft-ui-joystick-stick", "2DJoystickComponent", {
      radius: 1,
      joystickRadius: 0.42,
      deadZone: 0.12,
      horizontalControl: "joystick-x",
      verticalControl: "joystick-y",
    }),
    ui("ft-ui-joystick-anchor", "2DAnchorComponent", { anchor: "bottomLeft", offsetX: 0.05, offsetY: 0.05 }),
  ], { position: [-14.2, -7.35], folderId }));
  add(layerActor("ft-ui-painter", "Painter", [
    ui("ft-ui-painter-canvas", "2DPainterComponent", {
      width: 3.2,
      height: 2,
      pixelsPerUnit: KNOBS.painterPixelsPerUnit,
      // Authored commands seed the canvas once; clearing every frame would erase them on the first tick.
      clearEachFrame: false,
      commands: painterCommands(),
    }),
  ], { position: [14, -7.35], folderId }));
  add(layerActor("ft-ui-painter-anchor", "Painter Anchor", [
    ui("ft-ui-painter-anchor-pin", "2DAnchorComponent", { anchor: "bottomRight", offsetX: -0.05, offsetY: 0.05 }),
  ], { parentId: "ft-ui-painter" }));
}

/** Painter coordinates are centered layer units (x ±1.6, y ±1, +Y up). */
function painterCommands(): PainterCommand[] {
  const full = Math.PI * 2;
  return [
    {
      kind: "draw",
      fill: true,
      stroke: true,
      fillRule: "nonzero",
      style: { fillColor: [0.1, 0.6, 1, 0.85], strokeColor: [1, 1, 1, 1], strokeWidth: 0.05, lineCap: "round", lineJoin: "round" },
      path: [
        { kind: "move", point: [-1.4, -0.6] },
        { kind: "line", point: [-0.4, 0.85] },
        { kind: "line", point: [0.6, -0.6] },
        { kind: "close" },
      ],
    },
    // A transparent hole punched through the triangle.
    {
      kind: "cutout",
      fillRule: "nonzero",
      path: [{ kind: "ellipse", center: [-0.4, -0.1], radius: [0.15, 0.15], rotation: 0, start: 0, end: full, anticlockwise: false }],
    },
    // Even-odd ring.
    {
      kind: "draw",
      fill: true,
      stroke: false,
      fillRule: "evenodd",
      style: { fillColor: [1, 0.45, 0.1, 1], strokeColor: [0, 0, 0, 1], strokeWidth: 0, lineCap: "butt", lineJoin: "miter" },
      path: [
        { kind: "ellipse", center: [0.95, 0.3], radius: [0.5, 0.5], rotation: 0, start: 0, end: full, anticlockwise: false },
        { kind: "close" },
        { kind: "move", point: [1.23, 0.3] },
        { kind: "ellipse", center: [0.95, 0.3], radius: [0.28, 0.28], rotation: 0, start: 0, end: full, anticlockwise: false },
        { kind: "close" },
      ],
    },
    // A square clipped to a circle mask.
    {
      kind: "pushMask",
      fillRule: "nonzero",
      path: [{ kind: "ellipse", center: [-1.1, 0.55], radius: [0.3, 0.3], rotation: 0, start: 0, end: full, anticlockwise: false }],
    },
    {
      kind: "draw",
      fill: true,
      stroke: false,
      fillRule: "nonzero",
      style: { fillColor: [1, 0.9, 0.2, 1], strokeColor: [0, 0, 0, 1], strokeWidth: 0, lineCap: "butt", lineJoin: "miter" },
      path: [
        { kind: "move", point: [-1.5, 0.15] },
        { kind: "line", point: [-0.85, 0.15] },
        { kind: "line", point: [-0.85, 0.95] },
        { kind: "line", point: [-1.5, 0.95] },
        { kind: "close" },
      ],
    },
    { kind: "popMask" },
    // Stroke-only curve along the bottom edge.
    {
      kind: "draw",
      fill: false,
      stroke: true,
      fillRule: "nonzero",
      style: { fillColor: [0, 0, 0, 0], strokeColor: [0.4, 1, 0.6, 1], strokeWidth: 0.06, lineCap: "round", lineJoin: "round" },
      path: [
        { kind: "move", point: [-1.5, -0.85] },
        { kind: "bezier", control1: [-1, -0.35], control2: [-0.5, -1.05], point: [0, -0.75] },
        { kind: "quadratic", control: [0.75, -0.3], point: [1.5, -0.85] },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// FT_OverlayPhysics

/**
 * Physics-enabled layer: its own 2D world with the layer's gravity. A static
 * pit (floor and two walls) catches dynamic icon boxes dropped at the bottom
 * center of the screen; nothing here collides with the 3D world.
 */
function overlayPhysicsLayer(refs: LayerRefs): SerializedSceneLayer {
  const layer: SerializedSceneLayer = { ...createDefaultSceneLayer(), name: NAMES.overlayPhysics };
  layer.settings.physicsEnabled = true;
  const add = (actor: SerializedActor) => addLayerActor(layer, actor);
  const icons = [refs.icons.default, refs.icons.camera, refs.icons.audio, refs.icons.navmesh];
  const solid = (id: string, name: string, x: number, y: number, width: number, height: number) =>
    add(layerActor(id, name, [
      ui(`${id}-quad`, "2DMaterialComponent", { materialGuid: refs.overlayMaterial, tint: [0.6, 0.65, 0.8, 0.9] }),
      body(`${id}-body`, "static"),
      // Unit box scaled by the actor scale (collider shapes follow actor scale).
      boxCollider(`${id}-collider`, 0.5),
    ], { position: [x, y], scale: [width, height] }));
  solid("ft-ui-physics-floor", "Physics Floor", 0, -5.55, 5.2, 0.2);
  solid("ft-ui-physics-wall-left", "Physics Wall Left", -2.6, -5, 0.2, 1.1);
  solid("ft-ui-physics-wall-right", "Physics Wall Right", 2.6, -5, 0.2, 1.1);
  for (let index = 0; index < KNOBS.overlayPhysicsBoxes; index += 1) {
    const id = `ft-ui-physics-box-${index + 1}`;
    // 64 px icons at 100 px per unit = 0.64 units; the 0.7 actor scale also scales the 0.32 half extents.
    add(layerActor(id, `Physics Box ${index + 1}`, [
      ui(`${id}-image`, "2DTextureComponent", { textureGuid: icons[index % icons.length]! }),
      body(`${id}-body`, "dynamic"),
      boxCollider(`${id}-collider`, 0.32),
    ], {
      position: [-1.6 + (index % 4) * 1.05, -2.4 + Math.floor(index / 4) * 0.8],
      scale: [0.7, 0.7],
      rotationDeg: (index * 23) % 45,
    }));
  }
  return layer;
}

function body(id: string, motionType: "static" | "dynamic"): SerializedComponent {
  return comp(id, "RigidBodyComponent", { motionType, mass: 1 }, undefined, { physicsWorld: "2d" });
}

function boxCollider(id: string, half: number): SerializedComponent {
  return comp(id, "ColliderComponent", {
    shape: { kind: "box2d", halfExtents: { x: half, y: half } },
    friction: 0.6,
    restitution: 0.2,
  }, undefined, { physicsWorld: "2d" });
}

// ---------------------------------------------------------------------------
// Classes

type ClassBase = Omit<LayerRefs, "classes">;

/** Virtualized List row: Begin Play writes `Row <Item Index>` into its label. */
async function saveListItem(ctx: FeatureTestContext, refs: ClassBase): Promise<PlacedClass> {
  const components = [
    ui("prefab-background", "2DMaterialComponent", {
      materialGuid: refs.overlayMaterial,
      tint: [0.2, 0.32, 0.5, 0.85],
    }, at(0, 0, ITEM_BACK_Z, LIST.width, LIST.itemHeight)),
    ui("prefab-label", "2DTextComponent", text(refs, "Row", 22, [380, 28]), at(0, 0, FRONT_Z)),
  ];
  return saveOverlayClass(ctx, NAMES.listItem, "SceneLayerActor", components, itemLabelGraph("Row {index}"));
}

/** Virtualized Grid cell: an icon with its Item Index underneath. */
async function saveGridItem(ctx: FeatureTestContext, refs: ClassBase): Promise<PlacedClass> {
  const components = [
    ui("prefab-icon", "2DTextureComponent", { textureGuid: refs.icons.navmesh }, at(0, 0.05, ITEM_BACK_Z, 0.75)),
    ui("prefab-label", "2DTextComponent", text(refs, "#", 18, [60, 22], { alignment: "center", outline: 1 }),
      at(0, -0.2, FRONT_Z)),
  ];
  return saveOverlayClass(ctx, NAMES.gridItem, "SceneLayerActor", components, itemLabelGraph("#{index}"));
}

/** Switcher card: On Scene Layer Actor Switched To writes its slot index into the label. */
async function saveCard(
  ctx: FeatureTestContext,
  refs: ClassBase,
  name: string,
  label: string,
  tint: Rgba,
): Promise<PlacedClass> {
  const components = [
    ui("prefab-background", "2DMaterialComponent", { materialGuid: refs.overlayMaterial, tint },
      at(0, 0, ITEM_BACK_Z, CARD.width, CARD.height)),
    ui("prefab-label", "2DTextComponent", text(refs, label, 26, [270, 32], { alignment: "center", bold: true }),
      at(0, 0, FRONT_Z)),
  ];
  const nodes = [
    gNode("switched-to", "flow.event.sceneLayerActorSwitchedTo", 0, 0),
    gNode("format", "string.format", 280, 160, { "default:format": `${label} (slot {slot})` }),
    ...setTextNodes(540, 0),
  ];
  const graph = classGraph({
    nodes,
    edges: [
      gWire("switched-to", "execOut", "set-text", "exec"),
      gWire("switched-to", "index", "format", "arg:slot"),
      ...setTextEdges("format"),
    ],
    actorDefaults: { eventTick: "disabled" },
  });
  return saveOverlayClass(ctx, name, "SceneLayerActor", components, graph);
}

/**
 * SceneLayerActorSwitcher subclass: a frame the active card spawns into.
 * Tick accumulates time and every interval a Flip Flop swaps card B / card A
 * through Switch Scene Layer Actor (called on Self).
 */
async function saveSwitcher(ctx: FeatureTestContext, refs: ClassBase): Promise<PlacedClass> {
  const switchFn = engineFunction("SceneLayerActorSwitcher", "Switch Scene Layer Actor");
  const elapsed = varMember("ft-ui-var-elapsed", "Elapsed", "float", 0, { category: "Switcher" });
  const interval = varMember("ft-ui-var-interval", "Interval", "float", KNOBS.switchIntervalSeconds, { category: "Switcher" });
  const switchTo = (id: string, x: number, y: number, index: number) =>
    gNode(id, "functions.call", x, y, {
      functionName: switchFn.name,
      classId: "SceneLayerActorSwitcher",
      implicitSelf: true,
      pins: switchFn.pins.map((pin) => ({ ...pin })),
      runtime: switchFn.runtime,
      "default:index": index,
    });
  const components = [
    ui("prefab-frame", "2DMaterialComponent", {
      materialGuid: refs.overlayMaterial,
      tint: [0.12, 0.12, 0.18, 0.7],
    }, at(0, 0, 0.1, CARD.width + 0.15, CARD.height + 0.1)),
  ];
  const graph = classGraph({
    members: [elapsed, interval],
    components,
    nodes: [
      gNode("tick", "flow.event.tick", 0, 0),
      getVar("get-elapsed", elapsed, 0, 200),
      gNode("advance", "math.add", 220, 200),
      setVar("set-elapsed", elapsed, 420, 0),
      getVar("get-interval", interval, 420, 300),
      gNode("due", "math.greaterEqual", 660, 220),
      gNode("branch", "flow.branch", 860, 0),
      setVar("reset-elapsed", elapsed, 1080, 0, 0),
      gNode("flip", "flow.flipFlop", 1320, 0),
      switchTo("show-b", 1560, -100, 1),
      switchTo("show-a", 1560, 120, 0),
    ],
    edges: [
      gWire("tick", "execOut", "set-elapsed", "execIn"),
      gWire("get-elapsed", "value", "advance", "a"),
      gWire("tick", "deltaSeconds", "advance", "b"),
      gWire("advance", "out", "set-elapsed", "value"),
      gWire("set-elapsed", "execOut", "branch", "execIn"),
      gWire("set-elapsed", "out", "due", "a"),
      gWire("get-interval", "value", "due", "b"),
      gWire("due", "out", "branch", "condition"),
      gWire("branch", "true", "reset-elapsed", "execIn"),
      gWire("reset-elapsed", "execOut", "flip", "execIn"),
      gWire("flip", "a", "show-b", "exec"),
      gWire("flip", "b", "show-a", "exec"),
    ],
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name: NAMES.switcher, parentClass: "SceneLayerActorSwitcher", graph });
  return { ref, components };
}

/** 2D Button with initial focus: On Click increments Clicks and shows the count. */
async function saveClickButton(ctx: FeatureTestContext, refs: ClassBase): Promise<PlacedClass> {
  const clicks = varMember("ft-ui-var-clicks", "Clicks", "int", 0, { category: "Button" });
  const components = [
    ui("prefab-background", "2DMaterialComponent", {
      materialGuid: refs.overlayMaterial,
      tint: [0.25, 0.6, 1, 1],
    }, at(0, 0, ITEM_BACK_Z, BUTTON.width, BUTTON.height)),
    comp("prefab-button", "2DButtonComponent", { focusInitial: true }, undefined, { name: "Button" }),
    ui("prefab-label", "2DTextComponent", text(refs, "Click Me", 26, [250, 32], { alignment: "center", bold: true }),
      at(0, 0, FRONT_Z)),
  ];
  const graph = classGraph({
    members: [clicks],
    components,
    nodes: [
      gNode("click", "flow.event.onClick", 0, 0, {
        componentId: "prefab-button",
        eventQualifier: "Button",
        title: "Event On Click (Button)",
      }),
      getVar("get-clicks", clicks, 0, 200),
      gNode("plus-one", "math.add_int", 220, 200, { "default:b": 1 }),
      setVar("set-clicks", clicks, 420, 0),
      gNode("format", "string.format", 640, 200, { "default:format": "Clicked {count}" }),
      ...setTextNodes(900, 0),
    ],
    edges: [
      gWire("click", "execOut", "set-clicks", "execIn"),
      gWire("get-clicks", "value", "plus-one", "a"),
      gWire("plus-one", "out", "set-clicks", "value"),
      gWire("set-clicks", "execOut", "set-text", "exec"),
      gWire("set-clicks", "out", "format", "arg:count"),
      ...setTextEdges("format"),
    ],
    actorDefaults: { eventTick: "disabled" },
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name: NAMES.clickButton, parentClass: "SceneLayerActor", graph });
  return { ref, components };
}

async function saveOverlayClass(
  ctx: FeatureTestContext,
  name: string,
  parentClass: "SceneLayerActor",
  components: SerializedComponent[],
  graph: SerializedGraph,
): Promise<PlacedClass> {
  const ref = await ctx.saveClass({ folder: FOLDER, name, parentClass, graph: { ...graph, components } });
  return { ref, components };
}

/** Begin Play: format the native Item Index (set by virtualization) into the label. */
function itemLabelGraph(format: string): SerializedGraph {
  return classGraph({
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      itemIndexNode("item-index", 0, 200),
      gNode("format", "string.format", 280, 200, { "default:format": format }),
      ...setTextNodes(540, 0),
    ],
    edges: [
      gWire("begin", "execOut", "set-text", "exec"),
      gWire("item-index", "value", "format", "arg:index"),
      ...setTextEdges("format"),
    ],
    actorDefaults: { eventTick: "disabled" },
  });
}

/** Get of the inherited SceneLayerActor `Item Index` variable on Self. */
function itemIndexNode(id: string, x: number, y: number): GraphNode {
  const variable = engineScriptApiFor("SceneLayerActor")?.variables?.find((entry) => entry.propertyKey === "itemIndex");
  if (!variable) throw new Error("SceneLayerActor has no Item Index variable.");
  return gNode(id, "variables.get", x, y, {
    variableName: variable.name,
    variableId: `engine:SceneLayerActor:var:${variable.propertyKey}`,
    scope: "member",
    implicitSelf: true,
    typeId: variable.typeId,
    classId: "SceneLayerActor",
    propertyKey: variable.propertyKey,
    getOnly: true,
  });
}

/** `label` (first 2D Text on Self) and a Set Text call wired to it; `set-text` takes exec and text. */
function setTextNodes(x: number, y: number): GraphNode[] {
  const setText = engineFunction("2DTextComponent", "Set Text");
  return [
    gNode("label", "component.getNamed", x, y + 200, { componentClassId: "2DTextComponent", implicitSelf: true }),
    gNode("set-text", "functions.call", x + 260, y, {
      functionName: setText.name,
      classId: "2DTextComponent",
      implicitSelf: false,
      pins: setText.pins.map((pin) => ({ ...pin })),
      runtime: setText.runtime,
    }),
  ];
}

function setTextEdges(textSource: string) {
  return [gWire("label", "out", "set-text", "target"), gWire(textSource, "out", "set-text", "text")];
}

function engineFunction(classId: string, name: string): EngineScriptFunction {
  const fn = engineScriptApiFor(classId)?.functions?.find((entry) => entry.name === name);
  if (!fn) throw new Error(`${classId} has no "${name}" function.`);
  return fn;
}

// ---------------------------------------------------------------------------
// Input

/** Touch rows let the HUD joystick drive the Basic 3D `Move` axis (x and y). */
async function bindJoystickToMove(ctx: FeatureTestContext): Promise<void> {
  const move = ctx.registry
    .list()
    .find((asset) => asset.rootId === "project" && asset.header.type === "InputAxis" && asset.header.name === "Move");
  const path = requireRef(move?.path, "the Basic 3D Move Input Axis");
  const payload = (await ctx.host.loadDocument("input-axis", path)) as Record<string, unknown>;
  const bindings: unknown[] = Array.isArray(payload.bindings) ? [...payload.bindings] : [];
  const touch: AxisBinding[] = [
    { id: "ft-ui-touch-joystick-x", device: "touch", code: "joystick-x", component: "x" },
    { id: "ft-ui-touch-joystick-y", device: "touch", code: "joystick-y", component: "y" },
  ];
  const missing = touch.filter((binding) =>
    !bindings.some((entry) => {
      const row = entry as Partial<AxisBinding> | null;
      return row?.device === "touch" && row.code === binding.code;
    }),
  );
  if (missing.length === 0) return;
  await ctx.host.saveDocument("input-axis", path, { ...payload, bindings: [...bindings, ...missing] });
}

// ---------------------------------------------------------------------------
// Authoring helpers

/** Overlay component (editor Add Component defaults plus overrides). */
function ui(
  id: string,
  classId: string,
  overrides: Record<string, unknown>,
  transform?: SerializedTransform,
  parentId?: string,
): SerializedComponent {
  return comp(id, classId, overrides, transform, { parentId: parentId ?? null });
}

/** Component transform: position (x, y, z) and XY scale. */
function at(x: number, y: number, z = 0, scaleX = 1, scaleY = scaleX): SerializedTransform {
  return tf([x, y, z], { scale: [scaleX, scaleY, 1] });
}

function text(
  refs: Pick<LayerRefs, "font">,
  value: string,
  size: number,
  [wrapWidth, wrapHeight]: readonly [number, number],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { text: value, size, wrapWidth, wrapHeight, fontAssetGuid: refs.font, ...extra };
}

function header(refs: Pick<LayerRefs, "font">, value: string): Record<string, unknown> {
  return text(refs, value, 28, [410, 34], { bold: true, color: [1, 0.86, 0.42] });
}

function margins(value: number): Record<string, number> {
  return { marginLeft: value, marginRight: value, marginTop: value, marginBottom: value };
}

/** 9-slice Texture Panel (one 32 px colormap cell per corner), darkened for contrast. */
function texturePanel(id: string, textureGuid: string): SerializedComponent {
  return ui(id, "2DPanelComponent", {
    source: "texture",
    textureGuid,
    ...margins(0.0625),
    tint: [0.09, 0.1, 0.15, 0.82],
  });
}

/** Unparented backdrop beside a root container: keeps its own rect behind the content. */
function containerBackground(id: string, refs: Pick<LayerRefs, "overlayMaterial">, width: number, height: number) {
  return ui(id, "2DMaterialComponent", {
    materialGuid: refs.overlayMaterial,
    tint: [0.15, 0.2, 0.3, 0.6],
  }, at(0, 0, 0.2, width, height));
}

const ORIGIN: readonly [number, number, number?] = [0, 0];
const UNIT_SCALE: readonly [number, number] = [1, 1];

interface LayerActorOptions {
  position?: readonly [number, number, number?];
  scale?: readonly [number, number];
  /** Z rotation in degrees. */
  rotationDeg?: number;
  parentId?: string;
  folderId?: string;
  classId?: string;
  properties?: Record<string, unknown>;
}

function layerActor(
  id: string,
  name: string,
  components: SerializedComponent[],
  options: LayerActorOptions = {},
): SerializedActor {
  const [x, y, z = 0] = options.position ?? ORIGIN;
  const [scaleX, scaleY] = options.scale ?? UNIT_SCALE;
  return createActor(id, name, {
    classId: options.classId ?? "SceneLayerActor",
    parentId: options.parentId ?? null,
    folderId: options.folderId ?? null,
    transform: tf([x, y, z], {
      ...(options.rotationDeg ? { rotationDeg: [0, 0, options.rotationDeg] as [number, number, number] } : {}),
      scale: [scaleX, scaleY, 1],
    }),
    components,
    ...(options.properties ? { properties: options.properties } : {}),
  });
}

/** Class instance with baked prefab rows: `prefab-<suffix>` becomes `<actorId>-<suffix>` with `sourceId` kept. */
function classInstance(
  placed: PlacedClass,
  id: string,
  name: string,
  options: Omit<LayerActorOptions, "classId"> = {},
): SerializedActor {
  const idOf = (componentId: string) => `${id}-${componentId.replace(/^prefab-/, "")}`;
  const components = placed.components.map((template) => ({
    ...structuredClone(template),
    id: idOf(template.id),
    parentId: template.parentId ? idOf(template.parentId) : null,
    sourceId: template.id,
  }));
  return layerActor(id, name, components, { ...options, classId: placed.ref.classId });
}

/** Actor and component ids stay unique within one layer document. */
function addLayerActor(layer: SerializedSceneLayer, next: SerializedActor): void {
  if (layer.actors.some((existing) => existing.id === next.id)) {
    throw new Error(`FeatureTest layer "${layer.name}" repeats actor id "${next.id}".`);
  }
  const used = new Set(layer.actors.flatMap((existing) => existing.components.map((component) => component.id)));
  for (const component of next.components) {
    if (used.has(component.id)) {
      throw new Error(`FeatureTest layer "${layer.name}" repeats component id "${component.id}".`);
    }
    used.add(component.id);
  }
  layer.actors.push(next);
}
