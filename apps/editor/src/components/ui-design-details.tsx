import {
  PropertyGrid,
  colorFromHex,
  colorToHex,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  ZERO_INSETS,
  applyAnchorPreset,
  applyAuthoringFields,
  authoringFieldsFromLayout,
  clamp01,
  laidOutParentRect,
  matchAnchorPreset,
  parentOwnsChildLayout,
  widgetParentId,
  type LayoutResult,
  type UserInterfaceDocument,
  type WidgetLayout,
  type WidgetNode,
} from "@babylonslate/ui-runtime";
import { AnchorPresetPicker } from "./ui-anchor-preset";

export function UiDesignDetails({
  ui,
  selected,
  layout,
  actionNames,
  assetLabels,
  onPatchWidget,
  onPatchLayout,
  onPickAsset,
}: {
  ui: UserInterfaceDocument;
  selected: WidgetNode;
  layout: LayoutResult;
  actionNames: readonly string[];
  assetLabels: {
    nestedUi?: string;
    image?: string;
    font?: string;
    visualOverride?: string;
  };
  onPatchWidget: (id: string, patch: Partial<WidgetNode>) => void;
  onPatchLayout: (id: string, next: WidgetLayout) => void;
  onPickAsset: (kind: "nestedUi" | "image" | "font" | "visualOverride") => void;
}) {
  const parentId = widgetParentId(ui, selected.id);
  const parent = parentId ? ui.widgets[parentId] : null;
  const slotOwned = parent ? parentOwnsChildLayout(parent.kind) : false;
  const parentRect = laidOutParentRect(layout, selected.id);
  const fields = authoringFieldsFromLayout(parentRect, selected.layout);
  const presetId = matchAnchorPreset(selected.layout);
  const padding = selected.style.padding ?? ZERO_INSETS;

  const identity: PropertyRow[] = [
    {
      id: "name",
      kind: "text",
      label: "Name",
      value: selected.name,
      onChange: (value) => onPatchWidget(selected.id, { name: value }),
    },
    {
      id: "visible",
      kind: "boolean",
      label: "Visible",
      value: selected.visible,
      onChange: (value) => onPatchWidget(selected.id, { visible: value }),
    },
    ...kindRows(selected, actionNames, assetLabels, onPatchWidget, onPickAsset),
  ];

  const layoutRows: PropertyRow[] = slotOwned
    ? []
    : [
        ...(fields.pinX
          ? [
              numberRow("pos-x", "Pos X", fields.posX, (posX) =>
                onPatchLayout(
                  selected.id,
                  applyAuthoringFields(selected.layout, parentRect, { posX }),
                ),
              ),
              numberRow("width", "Width", fields.width, (width) =>
                onPatchLayout(
                  selected.id,
                  applyAuthoringFields(selected.layout, parentRect, { width }),
                ),
              ),
            ]
          : [
              numberRow("left", "Left", fields.left, (left) =>
                onPatchLayout(
                  selected.id,
                  applyAuthoringFields(selected.layout, parentRect, { left }),
                ),
              ),
              numberRow("right", "Right", fields.right, (right) =>
                onPatchLayout(
                  selected.id,
                  applyAuthoringFields(selected.layout, parentRect, { right }),
                ),
              ),
            ]),
        ...(fields.pinY
          ? [
              numberRow("pos-y", "Pos Y", fields.posY, (posY) =>
                onPatchLayout(
                  selected.id,
                  applyAuthoringFields(selected.layout, parentRect, { posY }),
                ),
              ),
              numberRow("height", "Height", fields.height, (height) =>
                onPatchLayout(
                  selected.id,
                  applyAuthoringFields(selected.layout, parentRect, { height }),
                ),
              ),
            ]
          : [
              numberRow("top", "Top", fields.top, (top) =>
                onPatchLayout(
                  selected.id,
                  applyAuthoringFields(selected.layout, parentRect, { top }),
                ),
              ),
              numberRow("bottom", "Bottom", fields.bottom, (bottom) =>
                onPatchLayout(
                  selected.id,
                  applyAuthoringFields(selected.layout, parentRect, { bottom }),
                ),
              ),
            ]),
        {
          id: "pivot",
          kind: "vector3",
          label: "Pivot",
          value: [selected.layout.pivot.x, selected.layout.pivot.y, 0],
          axes: ["X", "Y"],
          onChange: ([x, y]) =>
            onPatchLayout(selected.id, {
              ...selected.layout,
              pivot: { x: clamp01(x), y: clamp01(y) },
            }),
        },
      ];

  const styleRows: PropertyRow[] = [
    colorRow("background", "Background", selected.style.background, "#333333", (background) =>
      onPatchWidget(selected.id, { style: { ...selected.style, background } }),
    ),
    colorRow("color", "Color", selected.style.color, "#ffffff", (color) =>
      onPatchWidget(selected.id, { style: { ...selected.style, color } }),
    ),
    numberRow("font-size", "Font Size", selected.style.fontSize ?? 18, (fontSize) =>
      onPatchWidget(selected.id, { style: { ...selected.style, fontSize } }),
    ),
    {
      id: "opacity",
      kind: "slider",
      label: "Opacity",
      value: selected.style.opacity ?? 1,
      min: 0,
      max: 1,
      step: 0.05,
      onChange: (opacity) =>
        onPatchWidget(selected.id, { style: { ...selected.style, opacity } }),
    },
    numberRow("padding-left", "Padding Left", padding.left, (left) =>
      onPatchWidget(selected.id, {
        style: { ...selected.style, padding: { ...padding, left } },
      }),
    ),
    numberRow("padding-right", "Padding Right", padding.right, (right) =>
      onPatchWidget(selected.id, {
        style: { ...selected.style, padding: { ...padding, right } },
      }),
    ),
    numberRow("padding-top", "Padding Top", padding.top, (top) =>
      onPatchWidget(selected.id, {
        style: { ...selected.style, padding: { ...padding, top } },
      }),
    ),
    numberRow("padding-bottom", "Padding Bottom", padding.bottom, (bottom) =>
      onPatchWidget(selected.id, {
        style: { ...selected.style, padding: { ...padding, bottom } },
      }),
    ),
    ...containerPropRows(selected, onPatchWidget),
  ];

  const advanced: PropertyRow[] = [
    {
      id: "raw-anchor-min",
      kind: "vector3",
      label: "Anchor Min",
      value: [selected.layout.anchorMin.x, selected.layout.anchorMin.y, 0],
      axes: ["X", "Y"],
      onChange: ([x, y]) =>
        onPatchLayout(selected.id, {
          ...selected.layout,
          anchorMin: { x: clamp01(x), y: clamp01(y) },
        }),
    },
    {
      id: "raw-anchor-max",
      kind: "vector3",
      label: "Anchor Max",
      value: [selected.layout.anchorMax.x, selected.layout.anchorMax.y, 0],
      axes: ["X", "Y"],
      onChange: ([x, y]) =>
        onPatchLayout(selected.id, {
          ...selected.layout,
          anchorMax: { x: clamp01(x), y: clamp01(y) },
        }),
    },
    {
      id: "raw-offset-min",
      kind: "vector3",
      label: "Offset Min",
      value: [selected.layout.offsetMin.x, selected.layout.offsetMin.y, 0],
      axes: ["X", "Y"],
      onChange: ([x, y]) =>
        onPatchLayout(selected.id, {
          ...selected.layout,
          offsetMin: { x, y },
        }),
    },
    {
      id: "raw-offset-max",
      kind: "vector3",
      label: "Offset Max",
      value: [selected.layout.offsetMax.x, selected.layout.offsetMax.y, 0],
      axes: ["X", "Y"],
      onChange: ([x, y]) =>
        onPatchLayout(selected.id, {
          ...selected.layout,
          offsetMax: { x, y },
        }),
    },
  ];

  return (
    <div className="flex min-h-0 flex-col">
      <PropertyGrid title="Identity" rows={identity} />
      <AnchorPresetPicker
        value={presetId}
        disabled={slotOwned}
        onChange={(id) =>
          onPatchLayout(selected.id, applyAnchorPreset(selected.layout, parentRect, id))
        }
      />
      {slotOwned ? (
        <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="ui-slot-layout-note">
          Parent slot owns layout. Move and resize are disabled.
        </p>
      ) : (
        <PropertyGrid title="Layout" rows={layoutRows} />
      )}
      <PropertyGrid title="Style" rows={styleRows} />
      <PropertyGrid title="Advanced" rows={advanced} />
    </div>
  );
}

function numberRow(
  id: string,
  label: string,
  value: number,
  onChange: (value: number) => void,
): PropertyRow {
  return { id, kind: "number", label, value, onChange };
}

function colorRow(
  id: string,
  label: string,
  css: string | undefined,
  fallback: string,
  onChange: (css: string) => void,
): PropertyRow {
  const hex = css?.startsWith("#") ? css : fallback;
  return {
    id,
    kind: "color",
    label,
    value: colorFromHex(hex),
    onChange: (next) => onChange(colorToHex(next)),
  };
}

function kindRows(
  selected: WidgetNode,
  actionNames: readonly string[],
  assetLabels: {
    nestedUi?: string;
    image?: string;
    font?: string;
    visualOverride?: string;
  },
  onPatchWidget: (id: string, patch: Partial<WidgetNode>) => void,
  onPickAsset: (kind: "nestedUi" | "image" | "font" | "visualOverride") => void,
): PropertyRow[] {
  const rows: PropertyRow[] = [];
  if (selected.kind === "UserInterface") {
    rows.push({
      id: "nestedUi",
      kind: "asset",
      label: "User Interface",
      value: selected.nestedUiGuid ?? null,
      placeholder: "None",
      displayLabel: assetLabels.nestedUi,
      onPick: () => onPickAsset("nestedUi"),
      onChange: (value) => onPatchWidget(selected.id, { nestedUiGuid: value }),
    });
  }
  if (
    selected.kind === "Text" ||
    selected.kind === "Button" ||
    selected.kind === "TextInput"
  ) {
    rows.push({
      id: "text",
      kind: "text",
      label: "Text",
      value: typeof selected.props.text === "string" ? selected.props.text : "",
      onChange: (value) =>
        onPatchWidget(selected.id, { props: { ...selected.props, text: value } }),
    });
    rows.push({
      id: "font",
      kind: "asset",
      label: "Font",
      value: null,
      placeholder: "None",
      displayLabel: assetLabels.font ?? selected.style.fontFamily,
      onPick: () => onPickAsset("font"),
      onChange: (value) => {
        if (value === null) {
          onPatchWidget(selected.id, {
            style: { ...selected.style, fontFamily: undefined },
          });
        }
      },
    });
  }
  if (selected.kind === "Image") {
    rows.push({
      id: "image",
      kind: "asset",
      label: "Image",
      value:
        typeof selected.props.imageGuid === "string"
          ? selected.props.imageGuid
          : (selected.style.imageGuid ?? null),
      placeholder: "None",
      displayLabel: assetLabels.image,
      onPick: () => onPickAsset("image"),
      onChange: (value) =>
        onPatchWidget(selected.id, {
          props: { ...selected.props, imageGuid: value },
        }),
    });
  }
  if (
    selected.kind === "Button" ||
    selected.kind === "TouchJoystick" ||
    selected.kind === "TouchButton"
  ) {
    rows.push({
      id: "visual-override",
      kind: "asset",
      label: "Visual Override",
      value: selected.visualOverrideGuid ?? null,
      placeholder: "None",
      displayLabel: assetLabels.visualOverride,
      onPick: () => onPickAsset("visualOverride"),
      onChange: (value) => onPatchWidget(selected.id, { visualOverrideGuid: value }),
    });
  }
  if (selected.kind === "TouchButton") {
    rows.push({
      id: "action",
      kind: "enum",
      label: "Action",
      value: String(selected.props.action ?? ""),
      options: actionNames.map((name) => ({ value: name, label: name })),
      onChange: (value) =>
        onPatchWidget(selected.id, { props: { ...selected.props, action: value } }),
    });
    rows.push({
      id: "control-id",
      kind: "text",
      label: "Control Id",
      value: String(selected.props.controlId ?? ""),
      onChange: (value) =>
        onPatchWidget(selected.id, {
          props: { ...selected.props, controlId: value },
        }),
    });
  }
  if (selected.kind === "CheckBox") {
    rows.push({
      id: "checked",
      kind: "boolean",
      label: "Checked",
      value: Boolean(selected.props.checked),
      onChange: (checked) =>
        onPatchWidget(selected.id, { props: { ...selected.props, checked } }),
    });
  }
  if (selected.kind === "Slider" || selected.kind === "ProgressBar") {
    rows.push(
      numberRow("value", "Value", Number(selected.props.value ?? 0), (value) =>
        onPatchWidget(selected.id, { props: { ...selected.props, value } }),
      ),
    );
  }
  if (selected.kind === "Slider") {
    rows.push(
      numberRow("min", "Min", Number(selected.props.min ?? 0), (min) =>
        onPatchWidget(selected.id, { props: { ...selected.props, min } }),
      ),
      numberRow("max", "Max", Number(selected.props.max ?? 1), (max) =>
        onPatchWidget(selected.id, { props: { ...selected.props, max } }),
      ),
    );
  }
  if (selected.kind === "TouchJoystick" || selected.kind === "TouchDPad") {
    rows.push(
      numberRow("dead-zone", "Dead Zone", Number(selected.props.deadZone ?? 0.15), (deadZone) =>
        onPatchWidget(selected.id, { props: { ...selected.props, deadZone } }),
      ),
      {
        id: "control-id-x",
        kind: "text",
        label: "Control Id X",
        value: String(selected.props.controlIdX ?? ""),
        onChange: (value) =>
          onPatchWidget(selected.id, {
            props: { ...selected.props, controlIdX: value },
          }),
      },
      {
        id: "control-id-y",
        kind: "text",
        label: "Control Id Y",
        value: String(selected.props.controlIdY ?? ""),
        onChange: (value) =>
          onPatchWidget(selected.id, {
            props: { ...selected.props, controlIdY: value },
          }),
      },
    );
  }
  if (selected.kind === "TouchJoystick") {
    rows.push({
      id: "origin",
      kind: "enum",
      label: "Origin",
      value: String(selected.props.origin ?? "fixed"),
      options: [
        { value: "fixed", label: "Fixed" },
        { value: "floating", label: "Floating" },
      ],
      onChange: (value) =>
        onPatchWidget(selected.id, { props: { ...selected.props, origin: value } }),
    });
    rows.push({
      id: "auto-hide",
      kind: "boolean",
      label: "Auto Hide",
      value: Boolean(selected.props.autoHide),
      onChange: (autoHide) =>
        onPatchWidget(selected.id, { props: { ...selected.props, autoHide } }),
    });
  }
  return rows;
}

function containerPropRows(
  selected: WidgetNode,
  onPatchWidget: (id: string, patch: Partial<WidgetNode>) => void,
): PropertyRow[] {
  if (selected.kind === "HorizontalBox" || selected.kind === "VerticalBox") {
    return [
      numberRow("gap", "Gap", Number(selected.props.gap ?? 8), (gap) =>
        onPatchWidget(selected.id, { props: { ...selected.props, gap } }),
      ),
    ];
  }
  if (selected.kind === "Grid") {
    return [
      numberRow("columns", "Columns", Number(selected.props.columns ?? 2), (columns) =>
        onPatchWidget(selected.id, { props: { ...selected.props, columns } }),
      ),
      numberRow("rows", "Rows", Number(selected.props.rows ?? 2), (rows) =>
        onPatchWidget(selected.id, { props: { ...selected.props, rows } }),
      ),
      numberRow("gap", "Gap", Number(selected.props.gap ?? 8), (gap) =>
        onPatchWidget(selected.id, { props: { ...selected.props, gap } }),
      ),
    ];
  }
  if (selected.kind === "SizeBox") {
    return [
      numberRow("box-width", "Box Width", Number(selected.props.width ?? 100), (width) =>
        onPatchWidget(selected.id, { props: { ...selected.props, width } }),
      ),
      numberRow("box-height", "Box Height", Number(selected.props.height ?? 100), (height) =>
        onPatchWidget(selected.id, { props: { ...selected.props, height } }),
      ),
    ];
  }
  return [];
}
