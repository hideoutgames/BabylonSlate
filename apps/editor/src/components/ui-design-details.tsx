import {
  PropertyGrid,
  assetRowIdentity,
  colorFromHex,
  colorToHex,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  ZERO_INSETS,
  applyAnchorPreset,
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
        {
          id: "horizontal-alignment",
          kind: "enum",
          label: "Horizontal",
          value: selected.layout.horizontalAlignment,
          options: [
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
          ],
          onChange: (horizontalAlignment) =>
            onPatchLayout(selected.id, {
              ...selected.layout,
              horizontalAlignment: horizontalAlignment as WidgetLayout["horizontalAlignment"],
            }),
        },
        {
          id: "vertical-alignment",
          kind: "enum",
          label: "Vertical",
          value: selected.layout.verticalAlignment,
          options: [
            { value: "top", label: "Top" },
            { value: "center", label: "Center" },
            { value: "bottom", label: "Bottom" },
          ],
          onChange: (verticalAlignment) =>
            onPatchLayout(selected.id, {
              ...selected.layout,
              verticalAlignment: verticalAlignment as WidgetLayout["verticalAlignment"],
            }),
        },
        numberRow("left", "Left", selected.layout.left, (left) =>
          onPatchLayout(selected.id, { ...selected.layout, left }),
        ),
        numberRow("top", "Top", selected.layout.top, (top) =>
          onPatchLayout(selected.id, { ...selected.layout, top }),
        ),
        numberRow("width", "Width", selected.layout.width, (width) =>
          onPatchLayout(selected.id, { ...selected.layout, width }),
        ),
        {
          id: "width-unit",
          kind: "enum",
          label: "Width Unit",
          value: selected.layout.widthUnit,
          options: [
            { value: "px", label: "px" },
            { value: "percent", label: "%" },
          ],
          onChange: (widthUnit) =>
            onPatchLayout(selected.id, {
              ...selected.layout,
              widthUnit: widthUnit as WidgetLayout["widthUnit"],
            }),
        },
        numberRow("height", "Height", selected.layout.height, (height) =>
          onPatchLayout(selected.id, { ...selected.layout, height }),
        ),
        {
          id: "height-unit",
          kind: "enum",
          label: "Height Unit",
          value: selected.layout.heightUnit,
          options: [
            { value: "px", label: "px" },
            { value: "percent", label: "%" },
          ],
          onChange: (heightUnit) =>
            onPatchLayout(selected.id, {
              ...selected.layout,
              heightUnit: heightUnit as WidgetLayout["heightUnit"],
            }),
        },
        numberRow("layout-padding-left", "Padding Left", selected.layout.padding.left, (left) =>
          onPatchLayout(selected.id, {
            ...selected.layout,
            padding: { ...selected.layout.padding, left },
          }),
        ),
        numberRow("layout-padding-right", "Padding Right", selected.layout.padding.right, (right) =>
          onPatchLayout(selected.id, {
            ...selected.layout,
            padding: { ...selected.layout.padding, right },
          }),
        ),
        numberRow("layout-padding-top", "Padding Top", selected.layout.padding.top, (top) =>
          onPatchLayout(selected.id, {
            ...selected.layout,
            padding: { ...selected.layout.padding, top },
          }),
        ),
        numberRow(
          "layout-padding-bottom",
          "Padding Bottom",
          selected.layout.padding.bottom,
          (bottom) =>
            onPatchLayout(selected.id, {
              ...selected.layout,
              padding: { ...selected.layout.padding, bottom },
            }),
        ),
        ...(parent?.kind === "Canvas"
          ? [
              {
                id: "ignore-safe-area",
                kind: "boolean" as const,
                label: "Ignore Safe Area",
                value: selected.ignoreSafeArea === true,
                onChange: (ignoreSafeArea: boolean) =>
                  onPatchWidget(selected.id, { ignoreSafeArea }),
              },
            ]
          : []),
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
      id: "transform-center",
      kind: "vector3",
      label: "Transform Center",
      value: [selected.layout.transformCenter.x, selected.layout.transformCenter.y, 0],
      axes: ["X", "Y"],
      onChange: ([x, y]) =>
        onPatchLayout(selected.id, {
          ...selected.layout,
          transformCenter: { x: clamp01(x), y: clamp01(y) },
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
      onPick: () => onPickAsset("nestedUi"),
      onChange: (value) => onPatchWidget(selected.id, { nestedUiGuid: value }),
      ...assetRowIdentity(
        assetLabels.nestedUi
          ? { name: assetLabels.nestedUi, type: "UserInterface" }
          : undefined,
      ),
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
      onPick: () => onPickAsset("font"),
      ...assetRowIdentity(
        assetLabels.font
          ? { name: assetLabels.font, type: "Font" }
          : selected.style.fontFamily
            ? { name: selected.style.fontFamily, type: "Font" }
            : undefined,
      ),
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
      onPick: () => onPickAsset("image"),
      onChange: (value) =>
        onPatchWidget(selected.id, {
          props: { ...selected.props, imageGuid: value },
        }),
      ...assetRowIdentity(
        assetLabels.image
          ? { name: assetLabels.image, type: "Texture" }
          : undefined,
      ),
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
      onPick: () => onPickAsset("visualOverride"),
      onChange: (value) => onPatchWidget(selected.id, { visualOverrideGuid: value }),
      ...assetRowIdentity(
        assetLabels.visualOverride
          ? { name: assetLabels.visualOverride, type: "UserInterface" }
          : undefined,
      ),
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
