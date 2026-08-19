import { useEffect, useRef } from "react";
import {
  PropertyGrid,
  assetRowIdentity,
  colorFromHex,
  colorToHex,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  applyAnchorPreset,
  applyAuthoringFields,
  authoringFieldsFromLayout,
  authoringParentRect,
  clamp01,
  convertLayoutSize,
  matchAnchorPreset,
  parentOwnsChildLayout,
  resizeGridTracks,
  widgetParentId,
  type GridTrackDef,
  type UiControlDescriptor,
  type UserInterfaceDocument,
  type WidgetLayout,
  type WidgetNode,
} from "@babylonslate/ui-runtime";
import { AnchorPresetPicker } from "./ui-anchor-preset";

export type UiAssetPickKind = "nestedUi" | "image" | "font" | "visualOverride" | "material";

export function UiDesignDetails({
  ui,
  selected,
  viewport,
  controls = [],
  actionNames,
  assetLabels,
  onPatchWidget,
  onPatchLayout,
  onPreviewLayout,
  onCommitLayout,
  onPickAsset,
  resolveNested,
}: {
  ui: UserInterfaceDocument;
  selected: WidgetNode;
  viewport: {
    width: number;
    height: number;
    safeArea: { left: number; right: number; top: number; bottom: number };
  };
  controls?: readonly UiControlDescriptor[];
  actionNames: readonly string[];
  assetLabels: {
    nestedUi?: string;
    image?: string;
    font?: string;
    visualOverride?: string;
    material?: string;
  };
  onPatchWidget: (id: string, patch: Partial<WidgetNode>) => void;
  onPatchLayout: (id: string, next: WidgetLayout) => void;
  onPreviewLayout?: (id: string, next: WidgetLayout) => void;
  onCommitLayout?: (id: string, next: WidgetLayout) => void;
  onPickAsset: (kind: UiAssetPickKind) => void;
  resolveNested?: (guid: string) => UserInterfaceDocument | null;
}) {
  const previewedLayoutRef = useRef<WidgetLayout | null>(null);
  const commitLayoutRef = useRef(onCommitLayout);
  commitLayoutRef.current = onCommitLayout;
  useEffect(() => {
    const id = selected.id;
    return () => {
      const pending = previewedLayoutRef.current;
      if (!pending) return;
      previewedLayoutRef.current = null;
      commitLayoutRef.current?.(id, pending);
    };
  }, [selected.id]);
  const parentId = widgetParentId(ui, selected.id);
  const parent = parentId ? ui.widgets[parentId] : null;
  const slotOwned = parent ? parentOwnsChildLayout(parent.kind) : false;
  const parentRect = authoringParentRect(ui, selected.id, {
    viewport: { width: viewport.width, height: viewport.height },
    safeArea: ui.viewportLayer ? viewport.safeArea : undefined,
    controls,
  });
  const presetId = matchAnchorPreset(selected.layout);
  const nested =
    selected.kind === "UserInterface" && selected.nestedUiGuid
      ? resolveNested?.(selected.nestedUiGuid)
      : null;
  const overrideRows: PropertyRow[] = [];
  if (nested) {
    for (const widget of Object.values(nested.widgets)) {
      if (!widget.exposed) continue;
      const patch = selected.overrides?.[widget.id] ?? {};
      overrideRows.push({
        id: `override-${widget.id}-text`,
        kind: "text",
        label: widget.exposed.label,
        value:
          typeof patch.text === "string"
            ? patch.text
            : typeof widget.props.text === "string"
              ? widget.props.text
              : "",
        onChange: (text) =>
          onPatchWidget(selected.id, {
            overrides: {
              ...selected.overrides,
              [widget.id]: { ...patch, text },
            },
          }),
      });
    }
  }

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
    {
      id: "hitTestable",
      kind: "enum",
      label: "Hit Testable",
      value: selected.hitTestable ? "enabled" : "disabled",
      options: [
        { value: "enabled", label: "Enabled" },
        { value: "disabled", label: "Disabled" },
      ],
      onChange: (value) =>
        onPatchWidget(selected.id, { hitTestable: value === "enabled" }),
    },
    ...kindRows(selected, actionNames, assetLabels, onPatchWidget, onPickAsset, parent),
    ...(selected.id === ui.rootId
      ? []
      : [
          {
            id: "exposed",
            kind: "boolean" as const,
            label: "Expose",
            value: Boolean(selected.exposed),
            onChange: (value: boolean) =>
              onPatchWidget(selected.id, {
                exposed: value
                  ? { key: selected.id, label: selected.name }
                  : null,
              }),
          },
        ]),
  ];

  const fields = authoringFieldsFromLayout(parentRect, selected.layout);
  const writeLayout = (next: WidgetLayout) => onPatchLayout(selected.id, next);
  const previewLayout = (next: WidgetLayout) => {
    if (onPreviewLayout) {
      if (!previewedLayoutRef.current) {
        onPreviewLayout(selected.id, selected.layout);
      }
      previewedLayoutRef.current = next;
      onPreviewLayout(selected.id, next);
    } else {
      writeLayout(next);
    }
  };
  const commitLayout = (next: WidgetLayout) => {
    const committed = previewedLayoutRef.current ?? next;
    previewedLayoutRef.current = null;
    if (onCommitLayout) onCommitLayout(selected.id, committed);
    else writeLayout(committed);
  };
  const sizeNumber = (
    id: string,
    label: string,
    value: number,
    apply: (value: number) => WidgetLayout,
  ): PropertyRow =>
    numberRow(
      id,
      label,
      value,
      (next) => previewLayout(apply(next)),
      (next) => commitLayout(apply(next)),
    );

  const sizeRows: PropertyRow[] = [];
  if (fields.pinX) {
    sizeRows.push(
      sizeNumber("width", "Width", selected.layout.width, (width) => ({
        ...selected.layout,
        width,
      })),
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
          writeLayout(
            convertLayoutSize(
              selected.layout,
              "width",
              widthUnit as WidgetLayout["widthUnit"],
              parentRect,
            ),
          ),
      },
    );
  } else {
    sizeRows.push(
      sizeNumber("inset-left", "Left", fields.left, (left) =>
        applyAuthoringFields(selected.layout, parentRect, { left }),
      ),
      sizeNumber("inset-right", "Right", fields.right, (right) =>
        applyAuthoringFields(selected.layout, parentRect, { right }),
      ),
    );
  }
  if (fields.pinY) {
    sizeRows.push(
      sizeNumber("height", "Height", selected.layout.height, (height) => ({
        ...selected.layout,
        height,
      })),
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
          writeLayout(
            convertLayoutSize(
              selected.layout,
              "height",
              heightUnit as WidgetLayout["heightUnit"],
              parentRect,
            ),
          ),
      },
    );
  } else {
    sizeRows.push(
      sizeNumber("inset-top", "Top", fields.top, (top) =>
        applyAuthoringFields(selected.layout, parentRect, { top }),
      ),
      sizeNumber("inset-bottom", "Bottom", fields.bottom, (bottom) =>
        applyAuthoringFields(selected.layout, parentRect, { bottom }),
      ),
    );
  }

  const paddingRows: PropertyRow[] = [];
  if (fields.pinX) {
    paddingRows.push(
      sizeNumber("layout-padding-left", "Padding Left", selected.layout.padding.left, (left) => ({
        ...selected.layout,
        padding: { ...selected.layout.padding, left },
      })),
      sizeNumber("layout-padding-right", "Padding Right", selected.layout.padding.right, (right) => ({
        ...selected.layout,
        padding: { ...selected.layout.padding, right },
      })),
    );
  }
  if (fields.pinY) {
    paddingRows.push(
      sizeNumber("layout-padding-top", "Padding Top", selected.layout.padding.top, (top) => ({
        ...selected.layout,
        padding: { ...selected.layout.padding, top },
      })),
      sizeNumber(
        "layout-padding-bottom",
        "Padding Bottom",
        selected.layout.padding.bottom,
        (bottom) => ({
          ...selected.layout,
          padding: { ...selected.layout.padding, bottom },
        }),
      ),
    );
  }

  const layoutRows: PropertyRow[] = slotOwned
    ? sizeRows
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
            writeLayout({
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
            writeLayout({
              ...selected.layout,
              verticalAlignment: verticalAlignment as WidgetLayout["verticalAlignment"],
            }),
        },
        sizeNumber("left", "Left", selected.layout.left, (left) => ({
          ...selected.layout,
          left,
        })),
        {
          id: "left-unit",
          kind: "enum",
          label: "Left Unit",
          value: selected.layout.leftUnit,
          options: [
            { value: "px", label: "px" },
            { value: "percent", label: "%" },
          ],
          onChange: (leftUnit) =>
            writeLayout(
              convertLayoutSize(
                selected.layout,
                "left",
                leftUnit as WidgetLayout["leftUnit"],
                parentRect,
              ),
            ),
        },
        sizeNumber("top", "Top", selected.layout.top, (top) => ({
          ...selected.layout,
          top,
        })),
        {
          id: "top-unit",
          kind: "enum",
          label: "Top Unit",
          value: selected.layout.topUnit,
          options: [
            { value: "px", label: "px" },
            { value: "percent", label: "%" },
          ],
          onChange: (topUnit) =>
            writeLayout(
              convertLayoutSize(
                selected.layout,
                "top",
                topUnit as WidgetLayout["topUnit"],
                parentRect,
              ),
            ),
        },
        ...paddingRows,
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
    numberRow("z-index", "Z-Index", selected.zIndex ?? 0, (zIndex) =>
      onPatchWidget(selected.id, { zIndex }),
    ),
    numberRow("rotation", "Rotation", selected.layout.rotation, (rotation) =>
      onPatchLayout(selected.id, { ...selected.layout, rotation }),
    ),
    numberRow("scale-x", "Scale X", selected.layout.scaleX, (scaleX) =>
      onPatchLayout(selected.id, { ...selected.layout, scaleX }),
    ),
    numberRow("scale-y", "Scale Y", selected.layout.scaleY, (scaleY) =>
      onPatchLayout(selected.id, { ...selected.layout, scaleY }),
    ),
  ];

  return (
    <div className="flex min-h-0 flex-col">
      <PropertyGrid title="Identity" rows={identity} />
      {overrideRows.length > 0 ? (
        <PropertyGrid title="Overrides" rows={overrideRows} />
      ) : null}
      <AnchorPresetPicker
        value={presetId}
        disabled={slotOwned}
        onChange={(id) =>
          onPatchLayout(selected.id, applyAnchorPreset(selected.layout, parentRect, id))
        }
      />
      {slotOwned ? (
        <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="ui-slot-layout-note">
          Parent slot owns position. Stack-axis size stays authored in pixels.
        </p>
      ) : null}
      <PropertyGrid title="Size" rows={sizeRows} />
      {slotOwned ? null : <PropertyGrid title="Layout" rows={layoutRows} />}
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
  onCommit?: (value: number) => void,
): PropertyRow {
  return { id, kind: "number", label, value, onChange, onCommit };
}

function colorRow(
  id: string,
  label: string,
  css: string | undefined,
  fallback: string,
  onChange: (css: string) => void,
): PropertyRow {
  const authored = typeof css === "string" && css.length > 0;
  const hex = authored && css.startsWith("#") ? css : authored ? fallback : "";
  return {
    id,
    kind: "color",
    label,
    value: authored ? colorFromHex(hex || fallback) : null,
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
    material?: string;
  },
  onPatchWidget: (id: string, patch: Partial<WidgetNode>) => void,
  onPickAsset: (kind: UiAssetPickKind) => void,
  parent: WidgetNode | null,
): PropertyRow[] {
  const rows: PropertyRow[] = [];
  if (parent?.kind === "Grid") {
    rows.push(
      numberRow("grid-column", "Grid Column", selected.gridColumn ?? 0, (gridColumn) =>
        onPatchWidget(selected.id, { gridColumn }),
      ),
      numberRow("grid-row", "Grid Row", selected.gridRow ?? 0, (gridRow) =>
        onPatchWidget(selected.id, { gridRow }),
      ),
    );
  }
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
    selected.kind === "TextBlock" ||
    selected.kind === "Button" ||
    selected.kind === "InputText"
  ) {
    rows.push({
      id: "text",
      kind: "text",
      label: "Text",
      value: typeof selected.props.text === "string" ? selected.props.text : "",
      onChange: (value) =>
        onPatchWidget(selected.id, { props: { ...selected.props, text: value } }),
    });
    if (selected.kind === "TextBlock") {
      rows.push({
        id: "text-wrapping",
        kind: "boolean",
        label: "Wrapping",
        value: Boolean(selected.props.textWrapping),
        onChange: (textWrapping) =>
          onPatchWidget(selected.id, {
            props: { ...selected.props, textWrapping },
          }),
      });
      rows.push({
        id: "resize-to-fit",
        kind: "boolean",
        label: "Resize To Fit",
        value: Boolean(selected.props.resizeToFit),
        onChange: (resizeToFit) =>
          onPatchWidget(selected.id, {
            props: { ...selected.props, resizeToFit },
          }),
      });
    }
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
    rows.push({
      id: "image-stretch",
      kind: "enum",
      label: "Stretch",
      value: String(selected.props.stretch ?? 0),
      options: [
        { value: "0", label: "None" },
        { value: "1", label: "Fill" },
        { value: "2", label: "Uniform" },
        { value: "3", label: "Extend" },
      ],
      onChange: (value) =>
        onPatchWidget(selected.id, {
          props: { ...selected.props, stretch: Number(value) },
        }),
    });
  }
  if (selected.kind === "Material") {
    rows.push({
      id: "material",
      kind: "asset",
      label: "Material",
      value:
        typeof selected.props.materialGuid === "string"
          ? selected.props.materialGuid
          : null,
      placeholder: "None",
      onPick: () => onPickAsset("material"),
      onChange: (value) =>
        onPatchWidget(selected.id, {
          props: { ...selected.props, materialGuid: value },
        }),
      ...assetRowIdentity(
        assetLabels.material
          ? { name: assetLabels.material, type: "Material" }
          : undefined,
      ),
    });
  }
  if (
    selected.kind === "TouchJoystick" ||
    selected.kind === "TouchButton" ||
    selected.kind === "TouchDPad"
  ) {
    rows.push({
      id: "nested-skin",
      kind: "asset",
      label: "Skin",
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
  if (selected.kind === "Checkbox") {
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
  if (selected.kind === "StackPanel") {
    return [
      {
        id: "orientation",
        kind: "enum",
        label: "Orientation",
        value: selected.props.isVertical === false ? "horizontal" : "vertical",
        options: [
          { value: "vertical", label: "Vertical" },
          { value: "horizontal", label: "Horizontal" },
        ],
        onChange: (value) =>
          onPatchWidget(selected.id, {
            props: { ...selected.props, isVertical: value === "vertical" },
          }),
      },
      numberRow("gap", "Spacing", Number(selected.props.gap ?? 8), (gap) =>
        onPatchWidget(selected.id, { props: { ...selected.props, gap } }),
      ),
    ];
  }
  if (selected.kind === "Grid") {
    const patchTracks = (
      key: "columns" | "rows",
      trackKey: "gridColumns" | "gridRows",
      count: number,
    ) => {
      const n = Math.max(1, Math.floor(count) || 1);
      onPatchWidget(selected.id, {
        props: {
          ...selected.props,
          [key]: n,
          [trackKey]: resizeGridTracks(
            Array.isArray(selected.props[trackKey])
              ? (selected.props[trackKey] as GridTrackDef[])
              : undefined,
            n,
          ),
        },
      });
    };
    return [
      numberRow("columns", "Columns", Number(selected.props.columns ?? 2), (columns) =>
        patchTracks("columns", "gridColumns", columns),
      ),
      numberRow("rows", "Rows", Number(selected.props.rows ?? 2), (rows) =>
        patchTracks("rows", "gridRows", rows),
      ),
      numberRow("gap", "Spacing", Number(selected.props.gap ?? 8), (gap) =>
        onPatchWidget(selected.id, { props: { ...selected.props, gap } }),
      ),
    ];
  }
  return [];
}
