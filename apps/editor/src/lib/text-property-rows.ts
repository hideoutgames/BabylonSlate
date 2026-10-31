import {
  DEFAULT_TEXT2D_WRAP_HEIGHT,
  DEFAULT_TEXT2D_WRAP_WIDTH,
  parseText2DProperties,
  parseText3DProperties,
  resolveText2DRenderer,
  SCENE_LAYER_HIT_TEST_LABELS,
  SCENE_LAYER_HIT_TESTS,
  TEXT2D_ALIGNMENT_LABELS,
  TEXT2D_ALIGNMENTS,
  TEXT2D_RENDERER_LABELS,
  TEXT2D_RENDERERS,
  TEXT2D_VERTICAL_ALIGNMENT_LABELS,
  TEXT2D_VERTICAL_ALIGNMENTS,
  TEXT3D_ALIGNMENT_LABELS,
  TEXT3D_ALIGNMENTS,
  text2dMsdfDescription,
  text2dMsdfStatus,
  type SerializedComponent,
} from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import {
  assetRow,
  genericRows,
  rowId,
  sliderRow,
  unlitCastShadowsRow,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
} from "./component-property-row-helpers";
import { richTextAppearPropertyRows } from "./rich-text-appear-property-rows";

export function text3DPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const parsed = parseText3DProperties(component.properties);
  const hasFacetype = Boolean(
    parsed.fontAssetGuid && context.fontHasFacetype?.(parsed.fontAssetGuid),
  );
  const rows: PropertyRow[] = [
    sliderRow(
      actorId,
      component.id,
      "size",
      "Size",
      parsed.size,
      0.01,
      100,
      update,
      0.01,
      1,
    ),
    {
      kind: "color",
      id: rowId(actorId, component.id, "color"),
      label: "Color",
      value: parsed.color,
      defaultValue: [1, 1, 1],
      onChange: (next) => update("color", next),
    },
    {
      kind: "enum",
      id: rowId(actorId, component.id, "alignment"),
      label: "Alignment",
      value: parsed.alignment,
      defaultValue: "left",
      options: TEXT3D_ALIGNMENTS.map((value) => ({
        value,
        label: TEXT3D_ALIGNMENT_LABELS[value],
      })),
      onChange: (next) => update("alignment", next),
    },
    assetRow(
      actorId,
      component,
      "fontAssetGuid",
      "Font",
      ["Font"],
      update,
      context,
      "Pick Font",
    ),
    unlitCastShadowsRow(actorId, component, update),
  ];
  if (!hasFacetype) {
    rows.push({
      kind: "text",
      id: rowId(actorId, component.id, "typeface-note"),
      label: "Typeface",
      value: "Bundled ASCII (no Font facetype chunk)",
      disabled: true,
      onChange: () => {},
    });
  }
  rows.push(
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["text", "size", "color", "fontAssetGuid", "alignment", "editorOnly", "castShadows"]),
    ),
  );
  return rows;
}

/** 2D Text and 2D Rich Text. */
export function text2DPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const parsed = parseText2DProperties(component.properties, {
    rich: component.classId === "2DRichTextComponent",
  });
  const hasMsdfPair = Boolean(
    parsed.fontAssetGuid &&
      context.fontHasMsdfJson?.(parsed.fontAssetGuid) &&
      context.fontHasMsdfPng?.(parsed.fontAssetGuid),
  );
  const msdfStatus = text2dMsdfStatus(parsed.fontAssetGuid, {
    json: Boolean(
      parsed.fontAssetGuid && context.fontHasMsdfJson?.(parsed.fontAssetGuid),
    ),
    png: Boolean(
      parsed.fontAssetGuid && context.fontHasMsdfPng?.(parsed.fontAssetGuid),
    ),
  });
  const rendererValue = resolveText2DRenderer(parsed.renderer, hasMsdfPair);
  const font = assetRow(
    actorId,
    component,
    "fontAssetGuid",
    "Font",
    ["Font"],
    update,
    context,
    "Pick Font",
  ) as Extract<PropertyRow, { kind: "asset" }>;
  const coerceRendererOnFontChange = (next: string | null) => {
    const guid = typeof next === "string" && next.trim() ? next.trim() : null;
    const pair = Boolean(
      guid && context.fontHasMsdfJson?.(guid) && context.fontHasMsdfPng?.(guid),
    );
    update(
      "fontAssetGuid",
      next,
      !pair && parsed.renderer === "msdf" ? { renderer: "bitmap" } : undefined,
    );
  };
  const msdfStyleNote =
    rendererValue === "msdf"
      ? " Bold thickens the field; Italic shears glyphs. True bold/italic faces need a second atlas (not in v1)."
      : "";
  return [
    ...(component.classId === "2DRichTextComponent" ? richTextAppearPropertyRows(actorId, component, update) : []),
    {
      ...font,
      description:
        "Bitmap uses the source FontFace. MSDF needs a JSON + PNG atlas on this Font.",
      onChange: coerceRendererOnFontChange,
    },
    {
      ...assetRow(actorId, component, "materialGuid", "Text Material", ["Material", "MaterialInstance"], update, context, "Pick Text Material"),
      kind: "asset",
      description: "A Text-domain Material multiplies the glyph and rich-text colors while preserving letter coverage.",
      onPick: () => context.onPickAsset({ componentId: component.id, property: "materialGuid", allowedTypes: ["Material", "MaterialInstance"], materialDomain: "text", title: "Pick Text Material" }),
    } as Extract<PropertyRow, { kind: "asset" }>,
    {
      kind: "enum",
      id: rowId(actorId, component.id, "materialUv"),
      label: "Material UV",
      value: parsed.materialUv,
      defaultValue: "text",
      options: [{ value: "text", label: "Text Box" }, { value: "glyph", label: "Each Glyph" }],
      onChange: (next) => update("materialUv", next),
    },
    {
      kind: "enum",
      id: rowId(actorId, component.id, "renderer"),
      label: "Renderer",
      value: rendererValue,
      defaultValue: "bitmap",
      options: TEXT2D_RENDERERS.map((value) => ({
        value,
        label: TEXT2D_RENDERER_LABELS[value],
        disabled: value === "msdf" && msdfStatus !== "ready",
      })),
      description: `${text2dMsdfDescription(msdfStatus)}${msdfStyleNote}`,
      onChange: (next) => {
        const pair = Boolean(
          parsed.fontAssetGuid &&
            context.fontHasMsdfJson?.(parsed.fontAssetGuid) &&
            context.fontHasMsdfPng?.(parsed.fontAssetGuid),
        );
        update("renderer", resolveText2DRenderer(next, pair));
      },
    },
    sliderRow(
      actorId,
      component.id,
      "size",
      "Size",
      parsed.size,
      1,
      256,
      update,
      1,
      32,
    ),
    {
      kind: "color",
      id: rowId(actorId, component.id, "color"),
      label: "Color",
      value: parsed.color,
      defaultValue: [1, 1, 1],
      onChange: (next) => update("color", next),
    },
    sliderRow(
      actorId,
      component.id,
      "outline",
      "Outline",
      parsed.outline,
      0,
      16,
      update,
      1,
      0,
    ),
    {
      kind: "color",
      id: rowId(actorId, component.id, "outlineColor"),
      label: "Outline Color",
      value: parsed.outlineColor,
      defaultValue: [0, 0, 0],
      onChange: (next) => update("outlineColor", next),
    },
    {
      kind: "enum",
      id: rowId(actorId, component.id, "alignment"),
      label: "Alignment",
      value: parsed.alignment,
      defaultValue: "left",
      options: TEXT2D_ALIGNMENTS.map((value) => ({
        value,
        label: TEXT2D_ALIGNMENT_LABELS[value],
      })),
      onChange: (next) => update("alignment", next),
    },
    {
      kind: "enum",
      id: rowId(actorId, component.id, "verticalAlignment"),
      label: "Vertical Alignment",
      value: parsed.verticalAlignment,
      defaultValue: "center",
      options: TEXT2D_VERTICAL_ALIGNMENTS.map((value) => ({
        value,
        label: TEXT2D_VERTICAL_ALIGNMENT_LABELS[value],
      })),
      onChange: (next) => update("verticalAlignment", next),
    },
    {
      kind: "slider",
      id: rowId(actorId, component.id, "wrapWidth"),
      label: "Wrap Width",
      value: parsed.wrapWidth,
      min: 0,
      max: 1024,
      step: 1,
      defaultValue: DEFAULT_TEXT2D_WRAP_WIDTH,
      description:
        "0 keeps newlines only until the 2D transform box is resized. Greater than 0 wraps at this width.",
      onChange: (next) => update("wrapWidth", next),
    },
    {
      kind: "slider",
      id: rowId(actorId, component.id, "wrapHeight"),
      label: "Wrap Height",
      value: parsed.wrapHeight,
      min: 0,
      max: 1024,
      step: 1,
      defaultValue: DEFAULT_TEXT2D_WRAP_HEIGHT,
      description:
        "Gizmo frame height in px. Extra lines may overflow top and bottom.",
      onChange: (next) => update("wrapHeight", next),
    },
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "bold"),
      label: "Bold",
      value: parsed.bold,
      defaultValue: false,
      onChange: (next) => update("bold", next),
    },
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "italic"),
      label: "Italic",
      value: parsed.italic,
      defaultValue: false,
      onChange: (next) => update("italic", next),
    },
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "underline"),
      label: "Underline",
      value: parsed.underline,
      defaultValue: false,
      onChange: (next) => update("underline", next),
    },
    {
      kind: "enum",
      id: rowId(actorId, component.id, "hitTest"),
      label: "Hit Test",
      value: parsed.hitTest,
      defaultValue: "ignore",
      options: SCENE_LAYER_HIT_TESTS.map((value) => ({
        value,
        label: SCENE_LAYER_HIT_TEST_LABELS[value],
      })),
      description:
        parsed.hitTest === "ignore"
          ? "Clicks pass through this text. Pointer events still need a 2D Button on the same actor."
          : parsed.hitTest === "block"
            ? "Clicks hit this text and stop. Pointer events still need a 2D Button on the same actor."
            : "Clicks hit this text and continue. Pointer events still need a 2D Button on the same actor.",
      onChange: (next) => update("hitTest", next),
    },
    ...genericRows(
      actorId,
      component,
      update,
      new Set([
        "text",
        "materialGuid",
        "materialUv",
        "fontAssetGuid",
        "renderer",
        "size",
        "color",
        "outline",
        "outlineColor",
        "alignment",
        "verticalAlignment",
        "wrapWidth",
        "wrapHeight",
        "bold",
        "italic",
        "underline",
        "hitTest",
        "appearModes",
        "appearTransition",
        "appearStart",
        "appearInterval",
        "appearDuration",
      ]),
    ),
  ];
}
