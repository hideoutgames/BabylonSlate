import {
  createActor,
  createDefaultSceneLayer,
  createTimelineClip,
  customEasingCurve,
  text2DCustomAppearMode,
  type AxisBinding,
  type PainterCommand,
  type SceneLayerSpawnEntry,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedSceneLayer,
  type SerializedTransform,
} from "@haptic/core";
import {
  engineScriptApiFor, RICH_TEXT_2D_APPEAR_MODE_CLASS_ID, RICH_TEXT_2D_DECORATOR_CLASS_ID, RICH_TEXT_2D_LETTER_EFFECT_CLASS_ID,
  RICH_TEXT_2D_LETTER_CLASS_ID, RICH_TEXT_DECORATE_FUNCTION, RICH_TEXT_GET_KEYS_FUNCTION, RICH_TEXT_GET_TAG_FUNCTION,
  type EngineOverridableFunction, type EngineScriptFunction,
} from "@haptic/object-model";
import {
  comp,
  requireRef,
  SCENE_SAVE_ORDER,
  tf,
  type FeatureTestClassRef,
  type FeatureTestContext,
} from "./context";
import { classGraph, fnGraph, gChain, getVar, gExec, gNode, gWire, printString, setVar, varMember, type GraphNode } from "./graph";
import { FEATURE_TEST_MATERIAL_NAMES, featureTestMaterialAssetGuid } from "./materials";
import { ownedActorProbeScript } from "./scene-scripts";
import { FEATURE_TEST_EASING_CURVE_CLASS, featureTestCameraShakes } from "./scripting";
import { withFeatureTestHudPulse } from "./timeline";

/** Folder under `assets/FeatureTest/` for the Scene Layers and their SceneLayerActor Classes. */
const FEATURE_TEST_SCENE_LAYERS_FOLDER = "SceneLayers";

/** Asset names (Classes are `FT_UI*`, so their class ids never collide with other areas). */
const FEATURE_TEST_SCENE_LAYER_NAMES = {
  /** Every 2D overlay widget, spawned over the main scene at z-order 10. */
  hud: "FT_HUD",
  /** Small physics-enabled layer (own 2D world), spawned over the main scene at z-order 5. */
  overlayPhysics: "FT_OverlayPhysics",
  /** A Desired canvas at True Pixel Size, its top right in the screen's, spawned over the main scene at z-order 15. */
  badge: "FT_Badge",
  listItem: "FT_UIListItem",
  gridItem: "FT_UIGridItem",
  cardA: "FT_UICardA",
  cardB: "FT_UICardB",
  switcher: "FT_UICardSwitcher",
  clickButton: "FT_UIClickButton",
  pitCounter: "FT_UIPitCounter",
  cameraRig: "FT_UICameraRig",
  /** Rich Text 2D Appear Mode: each letter's Opacity and Tint follow its reveal Alpha. */
  richTextMode: "FT_RichTextRiseMode",
  /** Rich Text 2D Letter Effect: tilts the letters inside its `[fx]` tag by the tag's own `tilt` keyword. */
  richTextEffect: "FT_RichTextTiltEffect",
  /** Rich Text 2D Decorator: its `[hint=<color> size=<n>]…[/hint]` tag colours and sizes what it wraps. */
  richTextDecorator: "FT_RichTextHintTag",
  /** The HUD's rich text: notes when its reveal finishes (Event On Appear Finished). */
  richTextLabel: "FT_UIRichText",
} as const;

/**
 * Workload knobs. Virtualized containers only realize visible rows plus
 * overscan (about 10 list rows and 24 grid cells), so the item counts change
 * scroll range rather than per-frame cost.
 */
const FEATURE_TEST_SCENE_LAYER_KNOBS = {
  listItemCount: 10_000,
  gridItemCount: 400,
  scrollRows: 10,
  overlayPhysicsBoxes: 8,
  /** Seconds between Card Switcher swaps. */
  switchIntervalSeconds: 2.5,
  /** The Painter canvas's pixel density: 1.92 × 1.2 units at 107 keep its 205 × 128 pixels. */
  painterPixelsPerUnit: 107,
  hudZOrder: 10,
  badgeZOrder: 15,
  overlayPhysicsZOrder: 5,
  /** Seconds each FT_UICameraRig tween takes. */
  cameraTweenSeconds: 1.5,
} as const;

const NAMES = FEATURE_TEST_SCENE_LAYER_NAMES;
const KNOBS = FEATURE_TEST_SCENE_LAYER_KNOBS;
const FOLDER = FEATURE_TEST_SCENE_LAYERS_FOLDER;

/**
 * Layer units: FT_HUD is laid out for the default Fullscreen canvas, the project's
 * 1920 × 1080 Custom Resolution at 100 Pixels Per Unit: 19.2 × 10.8 units
 * (x −9.6..9.6, y −5.4..5.4). 2D Text sizes and wrap boxes are pixels at 100
 * pixels per unit.
 * Backgrounds sit at +Z (behind) and labels at −Z (in front): the overlay
 * camera looks down +Z from z = −10.
 */
const BACK_Z = 0.4;
const ITEM_BACK_Z = 0.05;
const FRONT_Z = -0.05;

const LIST = { width: 2.46, height: 1.02, itemHeight: 0.204, gap: 0.036, overscan: 2 } as const;
const GRID = { width: 2.46, height: 0.96, item: 0.36, gap: 0.048, overscan: 1 } as const;
const CARD = { width: 1.68, height: 0.51 } as const;
const BUTTON = { width: 1.56, height: 0.42 } as const;

/** Guids and Classes the layers are written from. */
interface LayerRefs {
  font: string;
  /** Ark Pixel 12px Proportional, a pixel Font. */
  pixelFont: string;
  textMaterial: string;
  overlayMaterial: string;
  /** The User Interface showcase Materials, and the Instance the Progress Bar's track draws. */
  uiMaterials: Record<"roundedPanel" | "roundedPanelInstance" | "healthBar" | "cooldown", string>;
  panelTexture: string;
  /** The optional one-shot Audio asset, which the rich text's reveal plays. */
  sound: string | null;
  /** Class ids of the custom Appear Mode and Letter Effect the rich text uses, and the rich text's own Class. */
  richText: { mode: string; effect: string; label: PlacedClass };
  icons: Record<"camera" | "audio" | "particles" | "point_light" | "spot_light" | "navmesh" | "default", string>;
  classes: Record<"listItem" | "gridItem" | "cardA" | "cardB" | "switcher" | "clickButton" | "pitCounter" | "cameraRig", PlacedClass>;
  /** FT_Timeline and its FT_HudPulse clip asset, which FT_HUD's script plays. */
  timeline: { timeline: string; hudPulse: string };
}

/** A Class plus the prefab components its layer instances copy. */
interface PlacedClass {
  ref: FeatureTestClassRef;
  components: SerializedComponent[];
}

const layerGuidsByContext = new WeakMap<FeatureTestContext, { hud: string; overlayPhysics: string; badge: string }>();

/**
 * SceneLayerActor Classes (list and grid items, two switchable cards, a click
 * counter button) and a SceneLayerActorSwitcher Class, then the `FT_HUD` layer
 * with every 2D overlay widget and the physics-enabled `FT_OverlayPhysics`
 * layer. Also binds the 2D Joystick to the Basic 3D Move axis (touch rows)
 * and routes focus activation to the Confirm action.
 */
export async function buildFeatureTestSceneLayers(ctx: FeatureTestContext): Promise<void> {
  const font = requireRef(ctx.assets.fonts.onest, "the Onest Font");
  const overlayMaterial = requireRef(ctx.assets.materials.overlayUnlit, "the overlay unlit Material");
  const icon = (stem: keyof LayerRefs["icons"]) => requireRef(ctx.assets.textures.ui[stem], `the ui_${stem} Texture`);
  const base = {
    font,
    pixelFont: requireRef(ctx.assets.fonts.arkPixel, "the Ark Pixel Font"),
    textMaterial: featureTestMaterialAssetGuid(ctx, "Material", FEATURE_TEST_MATERIAL_NAMES.text),
    overlayMaterial,
    uiMaterials: {
      roundedPanel: featureTestMaterialAssetGuid(ctx, "Material", FEATURE_TEST_MATERIAL_NAMES.uiRoundedPanel),
      roundedPanelInstance: featureTestMaterialAssetGuid(ctx, "MaterialInstance", FEATURE_TEST_MATERIAL_NAMES.uiRoundedPanelInstance),
      healthBar: featureTestMaterialAssetGuid(ctx, "Material", FEATURE_TEST_MATERIAL_NAMES.uiHealthBar),
      cooldown: featureTestMaterialAssetGuid(ctx, "Material", FEATURE_TEST_MATERIAL_NAMES.uiCooldown),
    },
    panelTexture: requireRef(ctx.assets.textures.colormapPixelArt, "the pixel art colormap Texture"),
    sound: ctx.assets.audio.oneShot,
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
      pitCounter: await savePitCounter(ctx, base),
      cameraRig: await saveCameraRig(ctx),
    },
    timeline: { timeline: requireRef(ctx.assets.timeline, "FT_Timeline"), hudPulse: requireRef(ctx.assets.hudPulse, "FT_HudPulse") },
    richText: await saveRichTextClasses(ctx, base),
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
  const badge = await ctx.addSceneDocument({
    kind: "scene-layer",
    folder: FOLDER,
    name: NAMES.badge,
    content: badgeLayer(refs),
    order: SCENE_SAVE_ORDER.sceneLayer,
  });
  layerGuidsByContext.set(ctx, { hud: hud.guid, overlayPhysics: overlayPhysics.guid, badge: badge.guid });

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
    { assetGuid: guids.badge, zOrder: KNOBS.badgeZOrder, enabled: true },
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
 * visible: title bar on top, form controls on the left with the User Interface
 * Material showcase under them, containers on the right, a widget row and a
 * Class row at the bottom, joystick and painter in the bottom corners.
 */
function hudLayer(refs: LayerRefs): SerializedSceneLayer {
  const layer: SerializedSceneLayer = { ...createDefaultSceneLayer(), name: NAMES.hud };
  // The HUD and its Scene Layer Script stay live while `ft_system pause` pauses the game.
  layer.settings.tickOnPause = true;
  layer.folders = [
    { id: "ft-ui-folder-header", name: "Header", parentFolderId: null },
    { id: "ft-ui-folder-forms", name: "Form Controls", parentFolderId: null },
    { id: "ft-ui-folder-containers", name: "Containers", parentFolderId: null },
    { id: "ft-ui-folder-widgets", name: "Widget Row", parentFolderId: null },
    { id: "ft-ui-folder-classes", name: "Class Row", parentFolderId: null },
    { id: "ft-ui-folder-input", name: "Joystick And Painter", parentFolderId: null },
    { id: "ft-ui-folder-ui-materials", name: "User Interface Materials", parentFolderId: null },
  ];
  const add = (actor: SerializedActor) => addLayerActor(layer, actor);
  addHeader(refs, add);
  addForms(refs, add);
  addContainers(refs, add);
  addWidgetRow(refs, add);
  addClassRow(refs, add);
  addJoystickAndPainter(add);
  addUserInterfaceMaterials(refs, add);
  // The SceneLayerScript of every FT_HUD instance probes its own title.
  const title = layer.actors.find((actor) => actor.id === "ft-ui-title");
  if (!title) throw new Error("FT_HUD has no title for its Scene Layer Script.");
  // Scene Layers keep Timeline Clips too; each FT_HUD instance plays its own Reveal.
  const reveal = createTimelineClip("ft-timeline-clip-hud-reveal", "Reveal");
  layer.timelineClips = [reveal];
  layer.script = withScalabilityReport(
    withFeatureTestHudPulse(ownedActorProbeScript("FT_HUD", title, { clip: reveal }), refs.timeline, "report", "get-component"),
  );
  return layer;
}

/**
 * Event On Scalability Changed on the Scene Layer itself: each FT_HUD prints the
 * status of the renderer's answer to a quality request, such as `ft_cel` or
 * `quality low`.
 */
function withScalabilityReport(graph: SerializedGraph): SerializedGraph {
  const y = 2400;
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      gNode("scalability-changed", "flow.event.scalabilityChanged", 0, y),
      gNode("scalability-result", "struct.break", 260, y + 180, {
        structGuid: "engine:ScalabilitySnapshot", fields: [{ name: "result", typeId: "struct", typeClassId: "engine:ScalabilityResult" }],
      }),
      gNode("scalability-status", "struct.break", 520, y + 180, {
        structGuid: "engine:ScalabilityResult", fields: [{ name: "status", typeId: "enum", typeClassId: "engine:ScalabilityStatus" }],
      }),
      gNode("scalability-status-text", "enum.toString", 780, y + 180, { enumGuid: "engine:ScalabilityStatus" }),
      gNode("scalability-text", "string.format", 1040, y + 180, { "default:format": "FT_HUD heard Scalability Changed ({status})" }),
      gNode("scalability-print", "debug.printString", 1300, y, { "default:key": "ft-hud-scalability", "default:duration": 6 }),
    ],
    edges: [
      ...graph.edges,
      gWire("scalability-changed", "execOut", "scalability-print", "execIn"),
      gWire("scalability-changed", "settings", "scalability-result", "in"),
      gWire("scalability-result", "result", "scalability-status", "in"),
      gWire("scalability-status", "status", "scalability-status-text", "in"),
      gWire("scalability-status-text", "out", "scalability-text", "arg:status"),
      gWire("scalability-text", "out", "scalability-print", "inString"),
    ],
  };
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
  ], { position: [0, 4.77, BACK_Z], scale: [9.6, 1.02], folderId }));
  add(layerActor("ft-ui-title", "Title", [
    ui("ft-ui-title-text", "2DTextComponent", text(refs, "Haptic Feature Test", 26.4, [540, 36], {
      bold: true,
      alignment: "center",
      outline: 1.2,
      outlineColor: [0.12, 0.05, 0],
      materialGuid: refs.textMaterial,
      materialUv: "text",
    })),
    ui("ft-ui-title-anchor", "2DAnchorComponent", { anchor: "topCenter", offsetX: 0, offsetY: -0.06 }),
  ], { position: [0, 5.01], folderId }));
  add(classInstance(refs.richText.label, "ft-ui-rich-text", "Rich Text", { position: [0, 4.53], folderId }));
  // Root Safe Area over the whole canvas: its label lands top-left inside the insets.
  add(layerActor("ft-ui-safe-area", "Safe Area", [
    ui("ft-ui-safe-area-box", "2DSafeAreaComponent", {
      width: 19.2,
      height: 10.8,
      horizontalAlignment: "start",
      verticalAlignment: "start",
      insetLeft: 0.18,
      insetRight: 0.18,
      insetTop: 0.15,
      insetBottom: 0.15,
    }),
  ], { folderId }));
  // A pixel Font draws at whole multiples of its Pixel Size: Scale 1 is 12 px (the nearest to the 14.4 px that 0.6 of the old 24 px asks for), and the size tag rounds to Scale 2 (24 px, 28.8 px wanted).
  add(layerActor("ft-ui-pixel-text", "Pixel Text", [
    ui("ft-ui-pixel-text-markup", "2DRichTextComponent", {
      text: "[color=7fd3ff]Pixel Font[/color] Ark 像素 ピクセル [size=24]2x[/size]",
      fontAssetGuid: refs.pixelFont,
      pixelScale: 1,
      outline: 1.2,
      outlineColor: [0.05, 0.08, 0.2],
      wrapWidth: 384,
      wrapHeight: 48,
      alignment: "left",
    }),
  ], { position: [-7.32, 3.78], folderId }));
  // No Font of its own: the label draws with the project Default Font (Onest).
  add(layerActor("ft-ui-safe-area-label", "Safe Area Label", [
    ui("ft-ui-safe-area-label-text", "2DTextComponent", text(refs, "Safe Area", 14.4, [132, 19.2], { color: [0.7, 0.9, 1], fontAssetGuid: null })),
  ], { parentId: "ft-ui-safe-area" }));
}

/** The `tilt` keyword the Letter Effect declares with Get Keys and reads with Get Tag Value. */
const TILT_KEY = "tilt";
/** The tag FT_RichTextHintTag handles, and the keyword its Decorate reads with Get Tag Value. */
const HINT_TAG = "hint";
const HINT_SIZE_KEY = "size";

/** The custom `[fx]` word sits in a `[hint]` tag, whose Decorator turns it into a colour and size around that word. */
function richTextMarkup(imageGuid: string, effectClassId: string): string {
  return [
    "[b]Rich[/b] [i]Text[/i] [color=orange]color[/color] [size=21.6]size[/size]",
    "[outline=1.8][outline-color=1a0a3a]outline[/outline-color][/outline] [u]under[/u]",
    `[img=${imageGuid} size=16.8] [wave=3 intensity=1.2]wave[/wave] [shake=1]shake[/shake]`,
    "[hover=1]hover[/hover] [rotate=10]tilt[/rotate]",
    `[${HINT_TAG}=yellow ${HINT_SIZE_KEY}=19.8][fx=${effectClassId} ${TILT_KEY}=8]custom[/fx][/${HINT_TAG}]`,
  ].join(" ");
}

/** A Class function member overriding the engine function `fn` of `base`. */
function engineOverride(id: string, base: string, fn: EngineOverridableFunction) {
  return {
    id, kind: "function" as const, name: fn.name,
    pins: fn.pins.map((pin) => ({ ...pin })),
    overrides: { classId: base, name: fn.name },
  };
}

/**
 * Rich Text 2D Decorator: Get Tag returns `hint`, and Decorate turns `[hint=<color> size=<n>]Content[/hint]` into
 * `[color=<color>][size=<n>]Content[/size][/color]`, its size read with Get Tag Value.
 */
async function saveRichTextDecorator(ctx: FeatureTestContext): Promise<void> {
  const getTag = engineOverride("ft-ui-fn-get-tag", RICH_TEXT_2D_DECORATOR_CLASS_ID, RICH_TEXT_GET_TAG_FUNCTION);
  const decorate = engineOverride("ft-ui-fn-decorate", RICH_TEXT_2D_DECORATOR_CLASS_ID, RICH_TEXT_DECORATE_FUNCTION);
  const pinOf = (fn: EngineOverridableFunction, direction: "in" | "out", index = 0) =>
    fn.pins.filter((pin) => pin.direction === direction && pin.typeId !== "exec")[index]!.name;
  const markup = "format";
  // Get Tag's Output holds the tag as its Tag literal.
  const getTagGraph = fnGraph(getTag);
  const getTagOutput = getTagGraph.nodes.find((node) => node.id === `${getTag.id}-output`)!;
  getTagOutput.data = { ...getTagOutput.data, [`default:${pinOf(RICH_TEXT_GET_TAG_FUNCTION, "out")}`]: HINT_TAG };
  await ctx.saveClass({
    folder: FOLDER, name: NAMES.richTextDecorator, parentClass: RICH_TEXT_2D_DECORATOR_CLASS_ID,
    graph: classGraph({
      members: [getTag, decorate],
      nodes: [],
      edges: [],
      functionGraphs: {
        [getTag.id]: getTagGraph,
        [decorate.id]: fnGraph(decorate, {
          nodes: [
            gNode("size", "richText.getTagValue", 240, 320, { "default:key": HINT_SIZE_KEY }),
            gNode(markup, "string.format", 480, 240, { "default:format": "[color={value}][size={size}]{content}[/size][/color]" }),
          ],
          edges: [
            gWire(`${decorate.id}-input`, pinOf(RICH_TEXT_DECORATE_FUNCTION, "in", 0), markup, "arg:value"),
            gWire("size", "value", markup, "arg:size"),
            gWire(`${decorate.id}-input`, pinOf(RICH_TEXT_DECORATE_FUNCTION, "in", 1), markup, "arg:content"),
            gWire(markup, "out", `${decorate.id}-output`, pinOf(RICH_TEXT_DECORATE_FUNCTION, "out")),
          ],
        }),
      },
    }),
  });
}

/** Get or Set of a Rich Text letter's variable; its Target is the Letter. */
function letterVariableNode(id: string, propertyKey: string, x: number, y: number): GraphNode {
  const variable = engineScriptApiFor(RICH_TEXT_2D_LETTER_CLASS_ID)?.variables?.find((entry) => entry.propertyKey === propertyKey);
  if (!variable) throw new Error(`${RICH_TEXT_2D_LETTER_CLASS_ID} has no ${propertyKey} variable.`);
  return gNode(id, "variables.set", x, y, {
    variableName: variable.name,
    variableId: `engine:${RICH_TEXT_2D_LETTER_CLASS_ID}:var:${variable.propertyKey}`,
    scope: "member",
    typeId: variable.typeId,
    classId: RICH_TEXT_2D_LETTER_CLASS_ID,
    propertyKey: variable.propertyKey,
  });
}

/**
 * The custom Appear Mode, Letter Effect and Decorator the HUD's rich text uses, and the rich text's own Class, whose
 * Event On Appear Finished sets Revealed once its reveal (Play On Start) ends.
 */
async function saveRichTextClasses(ctx: FeatureTestContext, refs: ClassBase): Promise<LayerRefs["richText"]> {
  // Each letter fades in from red: Opacity and the Tint's green and blue follow its Alpha.
  const mode = await ctx.saveClass({
    folder: FOLDER, name: NAMES.richTextMode, parentClass: RICH_TEXT_2D_APPEAR_MODE_CLASS_ID,
    graph: classGraph({
      nodes: [
        gNode("appear", "flow.event.richTextLetterAppear", 0, 0),
        letterVariableNode("set-opacity", "opacity", 320, 0),
        gNode("tint", "struct.makeColor", 320, 200, { "default:r": 1, "default:a": 1 }),
        letterVariableNode("set-tint", "tint", 640, 0),
      ],
      edges: [
        gExec("appear", "set-opacity"),
        gWire("appear", "letter", "set-opacity", "target"),
        gWire("appear", "alpha", "set-opacity", "value"),
        gExec("set-opacity", "set-tint"),
        gWire("appear", "letter", "set-tint", "target"),
        gWire("appear", "alpha", "tint", "g"),
        gWire("appear", "alpha", "tint", "b"),
        gWire("tint", "out", "set-tint", "value"),
      ],
    }),
  });
  // Get Keys declares `tilt`; each tagged letter's Rotation is that tag value as a number.
  const getKeys = engineOverride("ft-ui-fn-get-keys", RICH_TEXT_2D_LETTER_EFFECT_CLASS_ID, RICH_TEXT_GET_KEYS_FUNCTION);
  const keysPin = RICH_TEXT_GET_KEYS_FUNCTION.pins.find((pin) => pin.direction === "out" && pin.typeId !== "exec")!.name;
  const effect = await ctx.saveClass({
    folder: FOLDER, name: NAMES.richTextEffect, parentClass: RICH_TEXT_2D_LETTER_EFFECT_CLASS_ID,
    graph: classGraph({
      members: [getKeys],
      nodes: [
        gNode("update", "flow.event.richTextUpdateLetters", 0, 0),
        gNode("each", "flow.forEach", 320, 0),
        gNode("tilt-value", "richText.getTagValue", 320, 200, { "default:key": TILT_KEY }),
        gNode("tilt-number", "string.parseFloat", 560, 200),
        letterVariableNode("set-rotation", "rotation", 800, 0),
      ],
      edges: [
        gExec("update", "each"),
        gWire("update", "letters", "each", "array"),
        gWire("each", "loopBody", "set-rotation", "execIn"),
        gWire("each", "element", "set-rotation", "target"),
        gWire("tilt-value", "value", "tilt-number", "in"),
        gWire("tilt-number", "out", "set-rotation", "value"),
      ],
      functionGraphs: {
        [getKeys.id]: fnGraph(getKeys, {
          nodes: [gNode("keys", "array.make", 400, 240, { count: 1, "default:item0": TILT_KEY })],
          edges: [gWire("keys", "out", `${getKeys.id}-output`, keysPin)],
        }),
      },
    }),
  });
  await saveRichTextDecorator(ctx);
  const revealed = varMember("ft-ui-var-revealed", "Revealed", "bool", false, { category: "Rich Text" });
  const lastLetter = varMember("ft-ui-var-last-letter", "Last Letter", "int", -1, { category: "Rich Text" });
  const components = [
    ui("prefab-markup", "2DRichTextComponent", {
      ...text(refs, richTextMarkup(refs.icons.camera, effect.classId), 18, [900, 26.4], { alignment: "center" }),
      appearModes: ["fade", "slide", text2DCustomAppearMode(mode.classId)],
      appearTransition: customEasingCurve(FEATURE_TEST_EASING_CURVE_CLASS),
      appearInterval: 0.03,
      appearDuration: 0.25,
      appearStart: "play",
      appearSound: true,
      appearSoundAssetGuid: refs.sound,
      appearSoundPlay: "everyFourthLetter",
      appearSoundOffset: 0.02,
    }),
  ];
  const markupEvent = (id: string, type: string, title: string, y: number) => gNode(id, type, 0, y, {
    componentId: "prefab-markup",
    eventQualifier: "Markup",
    title: `${title} (Markup)`,
  });
  const label = await saveOverlayClass(ctx, NAMES.richTextLabel, "SceneLayerActor", components, classGraph({
    members: [revealed, lastLetter],
    nodes: [
      // Each letter's Index as it starts appearing; the reveal ends on the last one.
      markupEvent("letter-shown", "flow.event.richTextLetterShown", "Event On Letter Shown", 0),
      setVar("set-last-letter", lastLetter, 320, 0),
      markupEvent("appear-finished", "flow.event.richTextAppearFinished", "Event On Appear Finished", 300),
      setVar("set-revealed", revealed, 320, 300, true),
      getVar("get-last-letter", lastLetter, 320, 500),
      gNode("letters-shown", "math.greaterEqual", 560, 500, { "default:b": 1 }),
      gNode("assert-letters-shown", "debug.assert", 800, 300, { "default:message": "FT_UIRichText finished its reveal before On Letter Shown ran" }),
      printString("print-appear-finished", 1040, 300, "FT_UIRichText heard On Appear Finished (Markup)"),
    ],
    edges: [
      gWire("letter-shown", "execOut", "set-last-letter", "execIn"),
      gWire("letter-shown", "index", "set-last-letter", "value"),
      gWire("appear-finished", "execOut", "set-revealed", "execIn"),
      gWire("get-last-letter", "value", "letters-shown", "a"),
      gWire("letters-shown", "out", "assert-letters-shown", "condition"),
      ...gChain("set-revealed", "assert-letters-shown", "print-appear-finished"),
    ],
    actorDefaults: { eventTick: "disabled" },
  }));
  return { mode: mode.classId, effect: effect.classId, label };
}

/** Left column: Vertical Box of every form control (a nested Horizontal Box holds the toggles). */
function addForms(refs: LayerRefs, add: AddActor): void {
  const folderId = "ft-ui-folder-forms";
  const column = "ft-ui-forms";
  add(layerActor("ft-ui-forms-background", "Forms Background", [
    texturePanel("ft-ui-forms-background-panel", refs.panelTexture),
  ], { position: [-8.07, 1.53, BACK_Z], scale: [2.82, 3.24], folderId }));
  add(layerActor(column, "Form Column", [
    ui(`${column}-box`, "2DVerticalBoxComponent", {
      width: 2.7,
      height: 3.18,
      gap: 0.102,
      paddingTop: 0.12,
      paddingLeft: 0.12,
      paddingRight: 0.12,
      horizontalAlignment: "start",
      verticalAlignment: "start",
    }),
  ], { position: [-8.07, 1.53], folderId }));
  const control = (id: string, name: string, classId: string, properties: Record<string, unknown>, parentId = column) =>
    add(layerActor(id, name, [ui(`${id}-control`, classId, { height: 0.3, fontSize: 0.168, ...properties })], { parentId }));

  add(layerActor("ft-ui-forms-header", "Forms Header", [
    ui("ft-ui-forms-header-text", "2DTextComponent", header(refs, "Form Controls")),
  ], { parentId: column }));
  control("ft-ui-slider", "Slider", "2DSliderComponent", {
    width: 2.46,
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    thumbTextureGuid: refs.icons.point_light,
  });
  control("ft-ui-range-slider", "Range Slider", "2DRangeSliderComponent", {
    width: 2.46,
    min: 0,
    max: 10,
    step: 1,
    lowerValue: 2,
    upperValue: 7,
  });
  const toggles = "ft-ui-toggle-row";
  add(layerActor(toggles, "Toggle Row", [
    ui(`${toggles}-box`, "2DHorizontalBoxComponent", { width: 2.46, height: 0.3, gap: 0.21, verticalAlignment: "center" }),
  ], { parentId: column }));
  control("ft-ui-checkbox", "Checkbox", "2DCheckboxComponent", { width: 0.3, checked: true }, toggles);
  control("ft-ui-radio-low", "Radio Low", "2DRadioButtonComponent", { width: 0.3, group: "quality", checked: true }, toggles);
  control("ft-ui-radio-high", "Radio High", "2DRadioButtonComponent", { width: 0.3, group: "quality" }, toggles);
  control("ft-ui-toggle", "Toggle", "2DToggleComponent", { width: 0.6, checked: true }, toggles);
  control("ft-ui-text-input", "Text Input", "2DTextInputComponent", {
    width: 2.46,
    text: "FeatureTest",
    placeholder: "Type here",
    inputType: "email",
    maxLength: 24,
  });
  control("ft-ui-numeric-input", "Numeric Input", "2DNumericInputComponent", {
    width: 2.46,
    min: 0,
    max: 100,
    step: 1,
    value: 42,
  });
  control("ft-ui-dropdown", "Dropdown", "2DDropdownComponent", {
    width: 2.46,
    options: ["Low", "Medium", "High", "Epic"],
    selectedIndex: 2,
  });
  // The fill part uses the scrolling overlay Material and the track an Instance of the rounded panel Material,
  // instead of the native mesh.
  control("ft-ui-progress-bar", "Progress Bar", "2DProgressBarComponent", {
    width: 2.46,
    height: 0.21,
    min: 0,
    max: 1,
    value: 0.65,
    fillMaterialGuid: refs.overlayMaterial,
    trackMaterialGuid: refs.uiMaterials.roundedPanelInstance,
  });
}

/** Right column: Scroll Box, Virtualized List and Virtualized Grid in a Vertical Box. */
function addContainers(refs: LayerRefs, add: AddActor): void {
  const folderId = "ft-ui-folder-containers";
  const column = "ft-ui-containers";
  add(layerActor("ft-ui-containers-background", "Containers Background", [
    texturePanel("ft-ui-containers-background-panel", refs.panelTexture),
  ], { position: [8.07, 1.32, BACK_Z], scale: [2.82, 3.9], folderId }));
  add(layerActor(column, "Container Column", [
    ui(`${column}-box`, "2DVerticalBoxComponent", {
      width: 2.7,
      height: 3.84,
      gap: 0.102,
      paddingTop: 0.12,
      paddingLeft: 0.12,
      paddingRight: 0.12,
      horizontalAlignment: "start",
      verticalAlignment: "start",
    }),
  ], { position: [8.07, 1.32], folderId }));
  add(layerActor("ft-ui-containers-header", "Containers Header", [
    ui("ft-ui-containers-header-text", "2DTextComponent", header(refs, "Containers")),
  ], { parentId: column }));

  // Scroll Box → Vertical Box (content height) → text rows taller than the viewport.
  add(layerActor("ft-ui-scroll-box", "Scroll Box", [
    ui("ft-ui-scroll-box-viewport", "2DScrollBoxComponent", { width: 2.46, height: 1.14, scrollAxis: "vertical" }),
    containerBackground("ft-ui-scroll-box-background", refs, 2.46, 1.14),
  ], { parentId: column }));
  add(layerActor("ft-ui-scroll-content", "Scroll Content", [
    ui("ft-ui-scroll-content-box", "2DVerticalBoxComponent", {
      width: 2.46,
      heightMode: "content",
      gap: 0.036,
      paddingLeft: 0.06,
      horizontalAlignment: "start",
    }),
  ], { parentId: "ft-ui-scroll-box" }));
  for (let row = 1; row <= KNOBS.scrollRows; row += 1) {
    const label = String(row).padStart(2, "0");
    add(layerActor(`ft-ui-scroll-row-${label}`, `Scroll Row ${label}`, [
      ui(`ft-ui-scroll-row-${label}-text`, "2DTextComponent", text(refs, `Scroll Row ${label}`, 14.4, [234, 19.2], {
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
    ui(`${row}-box`, "2DHorizontalBoxComponent", { width: 13.8, height: 0.6, gap: 0.21, verticalAlignment: "center" }),
    ui(`${row}-padding`, "2DPaddingComponent", { paddingLeft: 0.18, paddingRight: 0.18 }, undefined, `${row}-box`),
  ], { position: [0, -3.93], folderId: "ft-ui-folder-widgets" }));
  add(layerActor("ft-ui-texture", "Texture Icon", [
    ui("ft-ui-texture-image", "2DTextureComponent", { textureGuid: refs.icons.camera }, at(0, 0, 0, 0.6)),
  ], { parentId: row }));
  add(layerActor("ft-ui-material", "Material Swatch", [
    ui("ft-ui-material-quad", "2DMaterialComponent", { materialGuid: refs.overlayMaterial }, at(0, 0, 0, 0.54)),
  ], { parentId: row }));
  add(classInstance(refs.classes.clickButton, "ft-ui-click-button", "Click Button", { parentId: row }));
  add(layerActor("ft-ui-widget-spacer", "Widget Spacer", [
    ui("ft-ui-widget-spacer-fill", "2DSpacerComponent", { fillWeight: 1 }),
  ], { parentId: row }));

  const overlay = "ft-ui-overlay-box-layout";
  add(layerActor("ft-ui-overlay-box", "Overlay Box", [
    ui(overlay, "2DOverlayBoxComponent", {
      width: 1.8,
      height: 0.48,
      paddingLeft: 0.06,
      paddingRight: 0.06,
      horizontalAlignment: "center",
      verticalAlignment: "center",
    }),
    ui("ft-ui-overlay-box-fill", "2DMaterialComponent", {
      materialGuid: refs.overlayMaterial,
      tint: [0.9, 0.5, 0.2, 0.9],
      widthMode: "fill",
      heightMode: "fill",
    }, at(0, 0, ITEM_BACK_Z), overlay),
    ui("ft-ui-overlay-box-label", "2DTextComponent", text(refs, "Overlay Box", 14.4, [168, 18], { alignment: "center" }),
      at(0, 0, FRONT_Z), overlay),
  ], { parentId: row }));

  // Oversized icons: the Mask Panel clips its nested content, the Mask clips its own actor.
  const maskPanel = "ft-ui-mask-panel-clip";
  add(layerActor("ft-ui-mask-panel", "Mask Panel", [
    ui(maskPanel, "2DMaskPanelComponent", {
      width: 1.08,
      height: 0.48,
      horizontalAlignment: "center",
      verticalAlignment: "center",
    }),
    ui("ft-ui-mask-panel-image", "2DTextureComponent", { textureGuid: refs.icons.spot_light }, at(0, 0, 0, 1.8), maskPanel),
  ], { parentId: row }));
  add(layerActor("ft-ui-mask", "Mask", [
    ui("ft-ui-mask-clip", "2DMaskComponent", { width: 0.48, height: 0.48 }),
    ui("ft-ui-mask-image", "2DTextureComponent", { textureGuid: refs.icons.particles }, at(0, 0, 0, 1.2)),
  ], { parentId: row }));
  add(layerActor("ft-ui-focus-target", "Focus Target", [
    ui("ft-ui-focus-target-image", "2DTextureComponent", { textureGuid: refs.icons.audio }, at(0, 0, 0, 0.6)),
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
      width: 13.8,
      height: 0.57,
      gap: 0.21,
      paddingLeft: 0.18,
      paddingRight: 0.18,
      verticalAlignment: "center",
    }),
  ], { position: [0, -4.89], folderId: "ft-ui-folder-classes" }));
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
    ui("ft-ui-samples-label-text", "2DTextComponent", text(refs, "Class Samples", 14.4, [138, 18], { color: [0.7, 0.9, 1] })),
  ], { parentId: row }));
  add(classInstance(classes.listItem, "ft-ui-sample-list-item", "List Item Sample", {
    parentId: row,
    properties: { itemIndex: 7 },
  }));
  add(classInstance(classes.gridItem, "ft-ui-sample-grid-item", "Grid Item Sample", {
    parentId: row,
    properties: { itemIndex: 3 },
  }));
  add(classInstance(classes.cardA, "ft-ui-sample-card-a", "Card A Sample", { parentId: row, scale: [0.36, 0.36] }));
  add(classInstance(classes.cardB, "ft-ui-sample-card-b", "Card B Sample", { parentId: row, scale: [0.36, 0.36] }));
}

/**
 * Under the form controls: User Interface Materials on 2D Material components. A rounded, bordered panel behind a
 * health bar (Linear Progress at its Progress parameter) and a radial cooldown that sweeps with Time.
 */
function addUserInterfaceMaterials(refs: LayerRefs, add: AddActor): void {
  const folderId = "ft-ui-folder-ui-materials";
  const { uiMaterials } = refs;
  add(layerActor("ft-ui-materials-panel", "User Interface Panel", [
    ui("ft-ui-materials-panel-quad", "2DMaterialComponent", { materialGuid: uiMaterials.roundedPanel }),
  ], { position: [-8.07, -1.74, BACK_Z], scale: [2.82, 2.7], folderId }));
  add(layerActor("ft-ui-materials", "User Interface Materials", [
    ui("ft-ui-materials-header", "2DTextComponent", { ...header(refs, "User Interface Materials"), alignment: "center" }, at(0, 1.08)),
    ui("ft-ui-materials-health-bar", "2DMaterialComponent", { materialGuid: uiMaterials.healthBar }, at(0, 0.6, 0, 2.34, 0.24)),
    ui("ft-ui-materials-cooldown", "2DMaterialComponent", { materialGuid: uiMaterials.cooldown }, at(0, -0.42, 0, 1.2, 1.2)),
  ], { position: [-8.07, -1.74], folderId }));
}

/** Joystick (own bottom-left Anchor) and a persistent Painter (anchored by a child anchor-only helper). */
function addJoystickAndPainter(add: AddActor): void {
  const folderId = "ft-ui-folder-input";
  add(layerActor("ft-ui-joystick", "Joystick", [
    ui("ft-ui-joystick-stick", "2DJoystickComponent", {
      radius: 0.6,
      joystickRadius: 0.252,
      deadZone: 0.12,
      horizontalControl: "joystick-x",
      verticalControl: "joystick-y",
    }),
    ui("ft-ui-joystick-anchor", "2DAnchorComponent", { anchor: "bottomLeft", offsetX: 0.03, offsetY: 0.03 }),
  ], { position: [-8.52, -4.41], folderId }));
  add(layerActor("ft-ui-painter", "Painter", [
    ui("ft-ui-painter-canvas", "2DPainterComponent", {
      width: 1.92,
      height: 1.2,
      pixelsPerUnit: KNOBS.painterPixelsPerUnit,
      // Authored commands seed the canvas once; clearing every frame would erase them on the first tick.
      clearEachFrame: false,
      commands: painterCommands(),
    }),
  ], { position: [8.4, -4.41], folderId }));
  add(layerActor("ft-ui-painter-anchor", "Painter Anchor", [
    ui("ft-ui-painter-anchor-pin", "2DAnchorComponent", { anchor: "bottomRight", offsetX: -0.03, offsetY: 0.03 }),
  ], { parentId: "ft-ui-painter" }));
}

/** Painter coordinates are centered layer units (x ±0.96, y ±0.6, +Y up). */
function painterCommands(): PainterCommand[] {
  const full = Math.PI * 2;
  return [
    {
      kind: "draw",
      fill: true,
      stroke: true,
      fillRule: "nonzero",
      style: { fillColor: [0.1, 0.6, 1, 0.85], strokeColor: [1, 1, 1, 1], strokeWidth: 0.03, lineCap: "round", lineJoin: "round" },
      path: [
        { kind: "move", point: [-0.84, -0.36] },
        { kind: "line", point: [-0.24, 0.51] },
        { kind: "line", point: [0.36, -0.36] },
        { kind: "close" },
      ],
    },
    // A transparent hole punched through the triangle.
    {
      kind: "cutout",
      fillRule: "nonzero",
      path: [{ kind: "ellipse", center: [-0.24, -0.06], radius: [0.09, 0.09], rotation: 0, start: 0, end: full, anticlockwise: false }],
    },
    // Even-odd ring.
    {
      kind: "draw",
      fill: true,
      stroke: false,
      fillRule: "evenodd",
      style: { fillColor: [1, 0.45, 0.1, 1], strokeColor: [0, 0, 0, 1], strokeWidth: 0, lineCap: "butt", lineJoin: "miter" },
      path: [
        { kind: "ellipse", center: [0.57, 0.18], radius: [0.3, 0.3], rotation: 0, start: 0, end: full, anticlockwise: false },
        { kind: "close" },
        { kind: "move", point: [0.738, 0.18] },
        { kind: "ellipse", center: [0.57, 0.18], radius: [0.168, 0.168], rotation: 0, start: 0, end: full, anticlockwise: false },
        { kind: "close" },
      ],
    },
    // A square clipped to a circle mask.
    {
      kind: "pushMask",
      fillRule: "nonzero",
      path: [{ kind: "ellipse", center: [-0.66, 0.33], radius: [0.18, 0.18], rotation: 0, start: 0, end: full, anticlockwise: false }],
    },
    {
      kind: "draw",
      fill: true,
      stroke: false,
      fillRule: "nonzero",
      style: { fillColor: [1, 0.9, 0.2, 1], strokeColor: [0, 0, 0, 1], strokeWidth: 0, lineCap: "butt", lineJoin: "miter" },
      path: [
        { kind: "move", point: [-0.9, 0.09] },
        { kind: "line", point: [-0.51, 0.09] },
        { kind: "line", point: [-0.51, 0.57] },
        { kind: "line", point: [-0.9, 0.57] },
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
      style: { fillColor: [0, 0, 0, 0], strokeColor: [0.4, 1, 0.6, 1], strokeWidth: 0.036, lineCap: "round", lineJoin: "round" },
      path: [
        { kind: "move", point: [-0.9, -0.51] },
        { kind: "bezier", control1: [-0.6, -0.21], control2: [-0.3, -0.63], point: [0, -0.45] },
        { kind: "quadratic", control: [0.45, -0.18], point: [0.9, -0.51] },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// FT_Badge

/**
 * One label on a Desired canvas at True Pixel Size with Root Top Right: the
 * canvas wraps the label wherever it is authored, and Play shows it at one
 * pixel per design pixel with its top right in the screen's top right.
 */
function badgeLayer(refs: LayerRefs): SerializedSceneLayer {
  const layer: SerializedSceneLayer = { ...createDefaultSceneLayer(), name: NAMES.badge };
  layer.settings.canvas = { ...layer.settings.canvas, sizeMode: "desired", rootAnchor: "topRight", scaling: "truePixelSize" };
  addLayerActor(layer, layerActor("ft-ui-badge", "Badge", [
    ui("ft-ui-badge-text", "2DTextComponent", text(refs, "True Pixel Size", 16, [150, 22], {
      alignment: "right",
      color: [0.75, 0.95, 1],
      outline: 1,
      outlineColor: [0.05, 0.08, 0.2],
    })),
  ], { position: [3, 2] }));
  return layer;
}

// ---------------------------------------------------------------------------
// FT_OverlayPhysics

/**
 * Physics-enabled layer: its own 2D world with the layer's gravity. A static
 * pit (floor and two walls) catches dynamic icon boxes dropped at the bottom
 * center of the screen; nothing here collides with the 3D world. A counter
 * under the pit queries this layer's world (not the main Scene's) for them.
 */
function overlayPhysicsLayer(refs: LayerRefs): SerializedSceneLayer {
  const layer: SerializedSceneLayer = { ...createDefaultSceneLayer(), name: NAMES.overlayPhysics };
  layer.settings.physicsEnabled = true;
  // A Custom canvas of 3200 x 1800 px at 100 Pixels Per Unit keeps the 32 x 18 units this layer's physics is laid
  // out for, fitted to the screen as a Fullscreen canvas is.
  layer.settings.canvas = { ...layer.settings.canvas, sizeMode: "custom", customSizePx: { width: 3200, height: 1800 } };
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
  add(classInstance(refs.classes.pitCounter, "ft-ui-physics-pit-counter", "Pit Counter", { position: [0, -6.1] }));
  add(classInstance(refs.classes.cameraRig, "ft-ui-physics-camera-rig", "Camera Rig"));
  return layer;
}

/** The pit FT_UIPitCounter watches, centered on the floor's top edge. */
const PIT = { center: [0, -5] as const, radius: 2.6 } as const;

/**
 * Tick runs Sphere Overlap Actors (Dynamic) over the pit. A Scene Layer
 * actor's query reads its own layer's world, so it counts the layer's boxes
 * and never the main Scene's bodies at the same coordinates. The label is set
 * only when the count changes.
 */
async function savePitCounter(ctx: FeatureTestContext, refs: ClassBase): Promise<PlacedClass> {
  const shown = varMember("ft-ui-var-pit-shown", "Shown", "int", -1, { category: "Pit Counter" });
  const components = [
    ui("prefab-label", "2DTextComponent", text(refs, "In pit: 0", 24, [240, 30], { alignment: "center", bold: true }),
      at(0, 0, FRONT_Z)),
  ];
  const graph = classGraph({
    members: [shown],
    components,
    nodes: [
      gNode("tick", "flow.event.tick", 0, 0),
      gNode("center", "vector.make3", 0, 200, { "default:x": PIT.center[0], "default:y": PIT.center[1], "default:z": 0 }),
      gNode("overlap", "physics.sphereOverlap", 240, 0, { "default:radius": PIT.radius, "default:channel": "Dynamic" }),
      getVar("get-shown", shown, 240, 300),
      gNode("changed", "math.notEquals", 480, 220),
      gNode("branch", "flow.branch", 680, 0),
      setVar("set-shown", shown, 900, 0),
      gNode("format", "string.format", 1120, 200, { "default:format": "In pit: {count}" }),
      ...setTextNodes(1360, 0),
    ],
    edges: [
      gWire("tick", "execOut", "overlap", "execIn"),
      gWire("center", "out", "overlap", "center"),
      gWire("overlap", "execOut", "branch", "execIn"),
      gWire("overlap", "count", "changed", "a"),
      gWire("get-shown", "value", "changed", "b"),
      gWire("changed", "out", "branch", "condition"),
      gWire("branch", "true", "set-shown", "execIn"),
      gWire("overlap", "count", "set-shown", "value"),
      gWire("set-shown", "execOut", "set-text", "exec"),
      gWire("set-shown", "out", "format", "arg:count"),
      ...setTextEdges("format"),
    ],
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name: NAMES.pitCounter, parentClass: "SceneLayerActor", graph });
  return { ref, components };
}

/**
 * Begin Play moves this layer's Layer Camera (Get Layer Camera on Self)
 * through each of its members: it tweens Camera Location, Zoom and Rotation
 * from their current values (Get nodes into A), then sets them back and adds
 * a Camera Offset so the pit ends where it was authored.
 */
async function saveCameraRig(ctx: FeatureTestContext): Promise<PlacedClass> {
  const shakes = featureTestCameraShakes(ctx);
  const seconds = { "default:duration": KNOBS.cameraTweenSeconds, "default:curve": "sineInOut" };
  const offset = engineFunction("LayerCamera", "Add Camera Offset");
  const graph = classGraph({
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      layerCameraNode("camera", 0, 200),
      cameraVariableNode("location", "get", "location", 240, 300),
      cameraVariableNode("zoom", "get", "zoom", 480, 300),
      cameraVariableNode("rotation", "get", "rotation", 720, 300),
      gNode("pan", "tween.layerCameraLocation", 240, 0, { ...seconds, "default:b": { x: 0, y: -0.6 } }),
      // Zoom eases along the project's custom easing curve.
      gNode("zoom-in", "tween.layerCameraZoom", 480, 0, { ...seconds, "default:curve": customEasingCurve(FEATURE_TEST_EASING_CURVE_CLASS), "default:b": 1.15 }),
      gNode("turn", "tween.layerCameraRotation", 720, 0, { ...seconds, "default:b": 4 }),
      cameraVariableNode("reset-rotation", "set", "rotation", 960, 0, { "default:value": 0 }),
      cameraVariableNode("reset-zoom", "set", "zoom", 1200, 0, { "default:value": 1 }),
      cameraVariableNode("reset-location", "set", "location", 1440, 0, { "default:value": { x: 0, y: -0.3 } }),
      gNode("offset", "functions.call", 1680, 0, {
        functionName: offset.name,
        classId: "LayerCamera",
        pins: offset.pins.map((pin) => ({ ...pin })),
        runtime: offset.runtime,
        "default:delta": { x: 0, y: 0.3 },
      }),
      // The rig's own layer shakes once its camera has moved: Play Camera Shake On Scene Layer.
      gNode("own-layer", "scene-layer.getOwningSceneLayer", 1920, 200),
      gNode("layer-shake", "camera.playShakeOnSceneLayer", 1920, 0, { "default:shake": shakes.hit, "default:scale": 0.3 }),
    ],
    edges: [
      ...gChain("begin", "pan", "zoom-in", "turn", "reset-rotation", "reset-zoom", "reset-location"),
      gWire("reset-location", "execOut", "offset", "exec"),
      gWire("offset", "execOut", "layer-shake", "execIn"),
      gWire("own-layer", "out", "layer-shake", "sceneLayer"),
      ...["location", "zoom", "rotation", "reset-rotation", "reset-zoom", "reset-location", "offset", "pan", "zoom-in", "turn"]
        .map((target) => gWire("camera", "value", target, "target")),
      gWire("location", "value", "pan", "a"),
      gWire("zoom", "value", "zoom-in", "a"),
      gWire("rotation", "value", "turn", "a"),
    ],
  });
  return saveOverlayClass(ctx, NAMES.cameraRig, "SceneLayerActor", [], graph);
}

/** Get of the inherited SceneLayerActor `Layer Camera` on Self: its own layer's camera. */
function layerCameraNode(id: string, x: number, y: number): GraphNode {
  const variable = engineScriptApiFor("SceneLayerActor")?.variables?.find((entry) => entry.propertyKey === "layerCamera");
  if (!variable) throw new Error("SceneLayerActor has no Layer Camera variable.");
  return gNode(id, "variables.get", x, y, {
    variableName: variable.name,
    variableId: `engine:SceneLayerActor:var:${variable.propertyKey}`,
    scope: "member",
    implicitSelf: true,
    typeId: variable.typeId,
    typeClassId: variable.typeClassId,
    classId: "SceneLayerActor",
    propertyKey: variable.propertyKey,
    getOnly: true,
  });
}

/** Get or Set of a Layer Camera's Camera Location, Rotation or Zoom; its Target is the Layer Camera. */
function cameraVariableNode(id: string, access: "get" | "set", propertyKey: string, x: number, y: number,
  extra: Record<string, unknown> = {}): GraphNode {
  const variable = engineScriptApiFor("LayerCamera")?.variables?.find((entry) => entry.propertyKey === propertyKey);
  if (!variable) throw new Error(`LayerCamera has no ${propertyKey} variable.`);
  return gNode(id, access === "get" ? "variables.get" : "variables.set", x, y, {
    variableName: variable.name,
    variableId: `engine:LayerCamera:var:${variable.propertyKey}`,
    scope: "member",
    typeId: variable.typeId,
    classId: "LayerCamera",
    propertyKey: variable.propertyKey,
    ...extra,
  });
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

type ClassBase = Omit<LayerRefs, "classes" | "timeline" | "richText">;

/** Virtualized List row: Begin Play writes `Row <Item Index>` into its label. */
async function saveListItem(ctx: FeatureTestContext, refs: ClassBase): Promise<PlacedClass> {
  const components = [
    ui("prefab-background", "2DMaterialComponent", {
      materialGuid: refs.overlayMaterial,
      tint: [0.2, 0.32, 0.5, 0.85],
    }, at(0, 0, ITEM_BACK_Z, LIST.width, LIST.itemHeight)),
    ui("prefab-label", "2DTextComponent", text(refs, "Row", 13.2, [228, 16.8]), at(0, 0, FRONT_Z)),
  ];
  return saveOverlayClass(ctx, NAMES.listItem, "SceneLayerActor", components, itemLabelGraph("Row {index}"));
}

/** Virtualized Grid cell: an icon with its Item Index underneath. */
async function saveGridItem(ctx: FeatureTestContext, refs: ClassBase): Promise<PlacedClass> {
  const components = [
    ui("prefab-icon", "2DTextureComponent", { textureGuid: refs.icons.navmesh }, at(0, 0.03, ITEM_BACK_Z, 0.45)),
    ui("prefab-label", "2DTextComponent", text(refs, "#", 10.8, [36, 13.2], { alignment: "center", outline: 0.6 }),
      at(0, -0.12, FRONT_Z)),
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
    ui("prefab-label", "2DTextComponent", text(refs, label, 15.6, [162, 19.2], { alignment: "center", bold: true }),
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
    }, at(0, 0, 0.1, CARD.width + 0.09, CARD.height + 0.06)),
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
    ui("prefab-label", "2DTextComponent", text(refs, "Click Me", 15.6, [150, 19.2], { alignment: "center", bold: true }),
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
      gNode("plus-one", "math.add", 220, 200, { aType: "int", bType: "int", "default:b": 1 }),
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
  return text(refs, value, 16.8, [246, 20.4], { bold: true, color: [1, 0.86, 0.42] });
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
