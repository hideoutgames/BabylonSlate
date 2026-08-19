import type {
  LayoutResult,
  Rect,
  UserInterfaceDocument,
  WidgetKind,
  WidgetLayout,
  WidgetNode,
  WidgetStyle,
} from "./types";
import { defaultHitTestableFor } from "./types";
import { normalizeLayout, previewRect, SAFE_AREA_CONTROL_ID } from "./layout";

export type UiLayoutMode = "absolute" | "stack" | "grid" | "scroll";

export interface UiControlDescriptor {
  id: string;
  kind: WidgetKind;
  name: string;
  parentId: string | null;
  layoutMode: UiLayoutMode;
  gridColumn?: number;
  gridRow?: number;
  guiRect: Rect;
  visible: boolean;
  text?: string;
  style: WidgetStyle;
  props: Record<string, unknown>;
  layout: WidgetLayout;
  nestedUiGuid?: string | null;
  visualOverrideGuid?: string | null;
  ignoreSafeArea?: boolean;
  hitTestable: boolean;
  zIndex?: number;
}

export interface DescribeUiControlsOptions {
  resolveNested?: (guid: string) => UserInterfaceDocument | null;
  parentSize?: { width: number; height: number };
  applySafeArea?: boolean;
  idPrefix?: string;
  parentId?: string | null;
  skipRoot?: boolean;
  seenGuids?: ReadonlySet<string>;
}

function hostsNestedVisual(widget: WidgetNode): boolean {
  return (
    widget.kind === "UserInterface" ||
    widget.kind === "TouchJoystick" ||
    widget.kind === "TouchButton" ||
    widget.kind === "TouchDPad"
  );
}

function layoutModeFor(kind: WidgetKind): UiLayoutMode {
  if (kind === "StackPanel") return "stack";
  if (kind === "Grid") return "grid";
  if (kind === "ScrollViewer") return "scroll";
  return "absolute";
}

function parentMode(kind: WidgetKind | undefined): UiLayoutMode {
  if (!kind) return "absolute";
  return layoutModeFor(kind);
}

function isLayoutResult(value: unknown): value is LayoutResult {
  return (
    !!value &&
    typeof value === "object" &&
    "tree" in value &&
    "canvas" in value &&
    "scale" in value
  );
}

function prefixId(prefix: string, id: string): string {
  return prefix ? `${prefix}${id}` : id;
}

function descriptorFor(
  widget: WidgetNode,
  id: string,
  parentId: string | null,
  layoutMode: UiLayoutMode,
  parentRect: Rect,
  gridColumn?: number,
  gridRow?: number,
): UiControlDescriptor {
  const layout = normalizeLayout(widget.layout);
  const text =
    typeof widget.props.text === "string" ? widget.props.text : undefined;
  return {
    id,
    kind: widget.kind,
    name: widget.name,
    parentId,
    layoutMode,
    gridColumn,
    gridRow,
    guiRect: previewRect(parentRect, layout),
    visible: widget.visible,
    text,
    style: widget.style ?? {},
    props: widget.props ?? {},
    layout,
    nestedUiGuid: widget.nestedUiGuid,
    visualOverrideGuid: widget.visualOverrideGuid,
    ignoreSafeArea: widget.ignoreSafeArea === true,
    hitTestable: widget.hitTestable ?? defaultHitTestableFor(widget.kind),
    zIndex: widget.zIndex,
  };
}

function applySlotOverrides(
  out: UiControlDescriptor[],
  start: number,
  prefix: string,
  overrides: Record<string, Record<string, unknown>> | undefined,
): void {
  if (!overrides) return;
  for (let i = start; i < out.length; i++) {
    const row = out[i];
    if (!row) continue;
    const localId = prefix && row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
    const patch = overrides[localId];
    if (!patch) continue;
    if (typeof patch.text === "string") row.text = patch.text;
    if (typeof patch.visible === "boolean") row.visible = patch.visible;
    if (typeof patch.color === "string") {
      row.style = { ...row.style, color: patch.color };
    }
    if (typeof patch.imageGuid === "string" || patch.imageGuid === null) {
      row.props = { ...row.props, imageGuid: patch.imageGuid };
    }
  }
}

function walkDocument(
  doc: UserInterfaceDocument,
  options: DescribeUiControlsOptions,
  out: UiControlDescriptor[],
): void {
  const prefix = options.idPrefix ?? "";
  const parentSize = options.parentSize ?? doc.designResolution;
  const parentRect: Rect = {
    x: 0,
    y: 0,
    width: parentSize.width,
    height: parentSize.height,
  };
  const applySafeArea = options.applySafeArea !== false && !options.skipRoot;
  const seen = new Set(options.seenGuids ?? []);
  const root = doc.widgets[doc.rootId];
  if (!root) return;

  if (!options.skipRoot) {
    out.push(
      descriptorFor(
        root,
        prefixId(prefix, root.id),
        options.parentId ?? null,
        "absolute",
        parentRect,
      ),
    );
  }

  const slotParentId = options.skipRoot
    ? (options.parentId ?? null)
    : prefixId(prefix, root.id);
  const childParentFor = (child: WidgetNode): string | null => {
    if (options.skipRoot) return slotParentId;
    if (applySafeArea && !child.ignoreSafeArea) return SAFE_AREA_CONTROL_ID;
    return slotParentId;
  };

  const visitChildren = (
    parent: WidgetNode,
    parentPrefixedId: string,
    parentKind: WidgetKind,
    rect: Rect,
  ) => {
    const mode = parentMode(parentKind);
    parent.children.forEach((childId, index) => {
      const child = doc.widgets[childId];
      if (!child) return;
      const prefixed = prefixId(prefix, child.id);
      const parentId =
        parent.id === doc.rootId && !options.skipRoot
          ? childParentFor(child)
          : parentPrefixedId;
      let gridColumn: number | undefined = child.gridColumn;
      let gridRow: number | undefined = child.gridRow;
      if (mode === "grid") {
        const columns = Math.max(
          1,
          Math.floor(Number(parent.props.columns ?? 2) || 2),
        );
        gridColumn = child.gridColumn ?? (index % columns);
        gridRow = child.gridRow ?? Math.floor(index / columns);
      }
      out.push(
        descriptorFor(child, prefixed, parentId, mode, rect, gridColumn, gridRow),
      );
      const nestedGuid = child.nestedUiGuid ?? child.visualOverrideGuid;
      if (nestedGuid && options.resolveNested && hostsNestedVisual(child)) {
        if (!seen.has(nestedGuid)) {
          const nested = options.resolveNested(nestedGuid);
          if (nested) {
            const start = out.length;
            walkDocument(
              nested,
              {
                ...options,
                idPrefix: `${prefixed}/`,
                parentId: prefixed,
                skipRoot: true,
                applySafeArea: false,
                seenGuids: new Set(seen).add(nestedGuid),
                parentSize: {
                  width: Math.max(1, child.layout.width),
                  height: Math.max(1, child.layout.height),
                },
              },
              out,
            );
            applySlotOverrides(out, start, `${prefixed}/`, child.overrides);
          }
        }
      }
      visitChildren(child, prefixed, child.kind, previewRect(rect, child.layout));
    });
  };

  visitChildren(
    root,
    options.skipRoot ? (options.parentId ?? "") : prefixId(prefix, root.id),
    root.kind,
    parentRect,
  );
}

/** Depth-first descriptors with `parentId` so the host can nest 1:1. */
export function describeUiControls(
  doc: UserInterfaceDocument,
  layoutOrOptions?: LayoutResult | DescribeUiControlsOptions,
): UiControlDescriptor[] {
  const options: DescribeUiControlsOptions = isLayoutResult(layoutOrOptions)
    ? {
        parentSize: {
          width: layoutOrOptions.canvas.width,
          height: layoutOrOptions.canvas.height,
        },
      }
    : (layoutOrOptions ?? {});
  const out: UiControlDescriptor[] = [];
  walkDocument(doc, options, out);
  return out;
}

export function scopeUiControlIds(
  controls: readonly UiControlDescriptor[],
  instanceId: string,
): UiControlDescriptor[] {
  const prefix = instanceId.trim();
  if (!prefix) return [...controls];
  return controls.map((control) => ({
    ...control,
    id: `${prefix}:${control.id}`,
    parentId: control.parentId ? `${prefix}:${control.parentId}` : null,
  }));
}
