import type { WidgetKind } from "./types";
import { canonicalWidgetKind, ZERO_INSETS } from "./types";

type GridTrackDef = { value: number; isPixel: boolean };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function insetsFrom(value: unknown): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} | null {
  const record = asRecord(value);
  const left = record.left;
  const right = record.right;
  const top = record.top;
  const bottom = record.bottom;
  if (
    typeof left !== "number" &&
    typeof right !== "number" &&
    typeof top !== "number" &&
    typeof bottom !== "number"
  ) {
    return null;
  }
  return {
    left: typeof left === "number" && Number.isFinite(left) ? left : 0,
    right: typeof right === "number" && Number.isFinite(right) ? right : 0,
    top: typeof top === "number" && Number.isFinite(top) ? top : 0,
    bottom: typeof bottom === "number" && Number.isFinite(bottom) ? bottom : 0,
  };
}

function paddingIsEmpty(value: unknown): boolean {
  const padding = insetsFrom(value);
  if (!padding) return true;
  return (
    padding.left === 0 &&
    padding.right === 0 &&
    padding.top === 0 &&
    padding.bottom === 0
  );
}

function starTracks(count: number): GridTrackDef[] {
  const n = Math.max(1, Math.floor(count) || 1);
  return Array.from({ length: n }, () => ({ value: 1, isPixel: false }));
}

function migrateLayout(
  raw: unknown,
  stackAxis: "width" | "height" | null,
): Record<string, unknown> {
  const layout = asRecord(raw);
  const next: Record<string, unknown> = {
    ...layout,
    leftUnit: layout.leftUnit === "percent" ? "percent" : "px",
    topUnit: layout.topUnit === "percent" ? "percent" : "px",
    padding: insetsFrom(layout.padding) ?? { ...ZERO_INSETS },
  };
  if (stackAxis === "height" && next.heightUnit !== "px") {
    next.heightUnit = "px";
    if (typeof next.height !== "number" || next.height <= 0) next.height = 36;
  }
  if (stackAxis === "width" && next.widthUnit !== "px") {
    next.widthUnit = "px";
    if (typeof next.width !== "number" || next.width <= 0) next.width = 160;
  }
  return next;
}

function kindProps(rawKind: unknown, props: Record<string, unknown>): Record<string, unknown> {
  if (rawKind === "HorizontalBox") return { ...props, isVertical: false };
  if (rawKind === "VerticalBox") return { ...props, isVertical: true };
  if (rawKind === "Border") return { ...props, thickness: props.thickness ?? 1 };
  return props;
}

/**
 * UserInterface schema v2 → v3: Babylon kinds, left/top units, Grid tracks,
 * stack-axis pixels, single padding channel.
 */
export function migrateUserInterfaceV3(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const widgets = asRecord(payload.widgets);
  const nextWidgets: Record<string, unknown> = {};
  const parentKind = new Map<string, string>();
  const parentIsVertical = new Map<string, boolean>();
  for (const [, value] of Object.entries(widgets)) {
    const record = asRecord(value);
    const kind = typeof record.kind === "string" ? record.kind : "";
    const children = Array.isArray(record.children) ? record.children : [];
    const props = asRecord(record.props);
    for (const childId of children) {
      if (typeof childId !== "string") continue;
      parentKind.set(childId, kind);
      if (kind === "VerticalBox") parentIsVertical.set(childId, true);
      if (kind === "HorizontalBox") parentIsVertical.set(childId, false);
      if (kind === "StackPanel") parentIsVertical.set(childId, props.isVertical !== false);
    }
  }

  for (const [id, value] of Object.entries(widgets)) {
    if (!value || typeof value !== "object") {
      nextWidgets[id] = value;
      continue;
    }
    const record = asRecord(value);
    const rawKind = record.kind;
    const kind = canonicalWidgetKind(rawKind) as WidgetKind;
    const props = kindProps(rawKind, asRecord(record.props));
    const style = asRecord(record.style);
    const parent = parentKind.get(id);
    const stackAxis =
      parent === "HorizontalBox" ||
      (parent === "StackPanel" && parentIsVertical.get(id) === false)
        ? "width"
        : parent === "VerticalBox" ||
            (parent === "StackPanel" && parentIsVertical.get(id) === true)
          ? "height"
          : null;
    let layout = migrateLayout(record.layout, stackAxis);
    const stylePadding = insetsFrom(style.padding);
    if (stylePadding && paddingIsEmpty(layout.padding)) {
      layout = { ...layout, padding: stylePadding };
    }
    const nextStyle = { ...style };
    delete nextStyle.padding;

    const next: Record<string, unknown> = {
      ...record,
      kind,
      props,
      style: nextStyle,
      layout,
    };

    if (
      typeof record.visualOverrideGuid === "string" &&
      record.visualOverrideGuid.length > 0
    ) {
      if (
        (kind === "TouchJoystick" ||
          kind === "TouchButton" ||
          kind === "TouchDPad") &&
        typeof next.nestedUiGuid !== "string"
      ) {
        next.nestedUiGuid = record.visualOverrideGuid;
      }
      if (kind === "Button") {
        const style = asRecord(next.style);
        if (typeof style.imageGuid !== "string" || style.imageGuid.length === 0) {
          next.style = { ...style, imageGuid: record.visualOverrideGuid };
        }
      }
      next.visualOverrideGuid = null;
    }

    if (kind === "Grid") {
      const columns = Math.max(1, Math.floor(Number(props.columns ?? 2)) || 2);
      const rows = Math.max(1, Math.floor(Number(props.rows ?? 2)) || 2);
      if (!Array.isArray(props.gridColumns)) props.gridColumns = starTracks(columns);
      if (!Array.isArray(props.gridRows)) props.gridRows = starTracks(rows);
      next.props = props;
    }

    nextWidgets[id] = next;
  }

  for (const value of Object.values(nextWidgets)) {
    const record = asRecord(value);
    if (record.kind !== "Grid") continue;
    const props = asRecord(record.props);
    const columns = Math.max(
      1,
      Math.floor(Number(props.columns ?? (props.gridColumns as unknown[] | undefined)?.length ?? 2)) ||
        2,
    );
    const children = Array.isArray(record.children) ? record.children : [];
    children.forEach((childId, index) => {
      if (typeof childId !== "string") return;
      const child = asRecord(nextWidgets[childId]);
      if (typeof child.gridColumn !== "number") child.gridColumn = index % columns;
      if (typeof child.gridRow !== "number") child.gridRow = Math.floor(index / columns);
      nextWidgets[childId] = child;
    });
  }

  return { ...payload, widgets: nextWidgets };
}
