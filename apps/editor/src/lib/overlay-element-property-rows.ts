import {
  parseJoystick2DProperties,
  parseOverlayPanelProperties,
  SCENE_LAYER_ANCHOR_LABELS,
  SCENE_LAYER_ANCHORS,
  SCENE_LAYER_HIT_TEST_LABELS,
  SCENE_LAYER_HIT_TESTS,
  SCENE_LAYER_PANEL_SOURCE_LABELS,
  SCENE_LAYER_PANEL_SOURCES,
  type SerializedComponent,
} from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import {
  assetRow,
  genericRows,
  rowId,
  sliderRow,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
} from "./component-property-row-helpers";
import { focusPropertyRows } from "./focus-property-rows";

export function anchor2DPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const current = String(component.properties.anchor ?? "center");
  return [
    {
      kind: "enum",
      id: rowId(actorId, component.id, "anchor"),
      label: "Anchor",
      value: current,
      options: SCENE_LAYER_ANCHORS.map((value) => ({
        value,
        label: SCENE_LAYER_ANCHOR_LABELS[value],
      })),
      onChange: (next) => update("anchor", next),
    },
    ...genericRows(actorId, component, update, new Set(["anchor"])),
  ];
}

export function joystick2DPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const joystick = parseJoystick2DProperties(component.properties);
  const numeric = (property: "radius" | "joystickRadius" | "deadZone", label: string, min: number, max?: number): PropertyRow => ({
    kind: "number", id: rowId(actorId, component.id, property), label, value: joystick[property], min, max,
    onChange: value => update(property, value),
  });
  const axis = (property: "horizontalControl" | "verticalControl", label: string): PropertyRow => ({
    kind: "enum", id: rowId(actorId, component.id, property), label, value: joystick[property],
    options: [
      { value: "joystick-x", label: "Joystick X" }, { value: "joystick-y", label: "Joystick Y" },
      { value: "dpad-x", label: "D-Pad X" }, { value: "dpad-y", label: "D-Pad Y" },
    ],
    description: "Select the Touch binding used by your Input Axis asset.",
    onChange: value => update(property, value),
  });
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled", value: joystick.enabled, onChange: value => update("enabled", value) },
    assetRow(actorId, component, "backgroundMaterialGuid", "Background Material", ["Material", "MaterialInstance"], update, context, "Pick Background Material"),
    assetRow(actorId, component, "joystickMaterialGuid", "Joystick Material", ["Material", "MaterialInstance"], update, context, "Pick Joystick Material"),
    numeric("radius", "Background Radius", 0.01),
    numeric("joystickRadius", "Joystick Radius", 0.01, joystick.radius * 0.95),
    numeric("deadZone", "Dead Zone", 0, 0.99),
    axis("horizontalControl", "Horizontal Axis"), axis("verticalControl", "Vertical Axis"),
  ];
}

/** 2D Button, 2D Texture and 2D Material. */
export function visual2DPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const hitTest = String(
    component.properties.hitTest ??
      (component.classId === "2DButtonComponent" ? "block" : "ignore"),
  );
  const assetProperty =
    component.classId === "2DMaterialComponent"
      ? "materialGuid"
      : component.classId === "2DTextureComponent"
        ? "textureGuid"
        : null;
  const assetRows = assetProperty
    ? [
        assetRow(
          actorId,
          component,
          assetProperty,
          assetProperty === "materialGuid" ? "Material" : "Texture",
          assetProperty === "materialGuid" ? ["Material", "MaterialInstance"] : ["Texture"],
          update,
          context,
          assetProperty === "materialGuid"
            ? "Pick Material"
            : "Pick Texture",
        ),
      ]
    : [];
  return [
    ...assetRows,
    ...(component.classId === "2DButtonComponent" ? focusPropertyRows(actorId, component, update, context.focusTargets) : []),
    {
      kind: "enum",
      id: rowId(actorId, component.id, "hitTest"),
      label: "Hit Test",
      value: hitTest,
      options: SCENE_LAYER_HIT_TESTS.map((value) => ({
        value,
        label: SCENE_LAYER_HIT_TEST_LABELS[value],
      })),
      onChange: (next) => update("hitTest", next),
    },
    ...genericRows(
      actorId,
      component,
      update,
      new Set([
        "hitTest",
        ...(assetProperty ? [assetProperty] : []),
        ...(component.classId === "2DButtonComponent" ? ["focusEnabled", "focusInitial", "focusUp", "focusDown", "focusLeft", "focusRight", "focused"] : []),
      ]),
    ),
  ];
}

export function panel2DPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const parsed = parseOverlayPanelProperties(component.properties);
  const assetProperty =
    parsed.source === "material" ? "materialGuid" : "textureGuid";
  return [
    {
      kind: "enum",
      id: rowId(actorId, component.id, "source"),
      label: "Source",
      value: parsed.source,
      options: SCENE_LAYER_PANEL_SOURCES.map((value) => ({
        value,
        label: SCENE_LAYER_PANEL_SOURCE_LABELS[value],
      })),
      onChange: (next) => update("source", next),
    },
    assetRow(
      actorId,
      component,
      assetProperty,
      parsed.source === "material" ? "Material" : "Texture",
      parsed.source === "material" ? ["Material", "MaterialInstance"] : ["Texture"],
      update,
      context,
      parsed.source === "material" ? "Pick Material" : "Pick Texture",
    ),
    sliderRow(
      actorId,
      component.id,
      "marginLeft",
      "Margin Left",
      parsed.marginLeft,
      0,
      1,
      update,
      0.01,
      0,
    ),
    sliderRow(
      actorId,
      component.id,
      "marginRight",
      "Margin Right",
      parsed.marginRight,
      0,
      1,
      update,
      0.01,
      0,
    ),
    sliderRow(
      actorId,
      component.id,
      "marginTop",
      "Margin Top",
      parsed.marginTop,
      0,
      1,
      update,
      0.01,
      0,
    ),
    sliderRow(
      actorId,
      component.id,
      "marginBottom",
      "Margin Bottom",
      parsed.marginBottom,
      0,
      1,
      update,
      0.01,
      0,
    ),
    {
      kind: "enum",
      id: rowId(actorId, component.id, "hitTest"),
      label: "Hit Test",
      value: parsed.hitTest,
      options: SCENE_LAYER_HIT_TESTS.map((value) => ({
        value,
        label: SCENE_LAYER_HIT_TEST_LABELS[value],
      })),
      onChange: (next) => update("hitTest", next),
    },
    ...genericRows(
      actorId,
      component,
      update,
      new Set([
        "source",
        "textureGuid",
        "materialGuid",
        "marginLeft",
        "marginRight",
        "marginTop",
        "marginBottom",
        "hitTest",
      ]),
    ),
  ];
}
