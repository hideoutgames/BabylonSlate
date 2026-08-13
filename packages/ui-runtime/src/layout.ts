import type {
  EdgeInsets,
  LaidOutWidget,
  LayoutResult,
  Rect,
  ScaleRule,
  TextMeasurer,
  UserInterfaceDocument,
  Vec2,
  WidgetNode,
} from "./types";
import { CONTAINER_KINDS, DEFAULT_DESIRED_SIZE, ZERO_INSETS } from "./types";
import { clamp01, previewRect } from "./preview-rect";

export { clamp01, previewRect, roundRect } from "./preview-rect";

export const SAFE_AREA_CONTROL_ID = "__safeArea";

export function normalizeLayout(
  slot: import("./types").WidgetLayout,
): import("./types").WidgetLayout {
  const h = slot.horizontalAlignment;
  const v = slot.verticalAlignment;
  return {
    horizontalAlignment:
      h === "center" || h === "right" || h === "left" ? h : "left",
    verticalAlignment: v === "center" || v === "bottom" || v === "top" ? v : "top",
    width: Number.isFinite(slot.width) ? slot.width : 0,
    height: Number.isFinite(slot.height) ? slot.height : 0,
    widthUnit: slot.widthUnit === "percent" ? "percent" : "px",
    heightUnit: slot.heightUnit === "percent" ? "percent" : "px",
    left: Number.isFinite(slot.left) ? slot.left : 0,
    top: Number.isFinite(slot.top) ? slot.top : 0,
    padding: {
      left: Number.isFinite(slot.padding?.left) ? slot.padding.left : 0,
      right: Number.isFinite(slot.padding?.right) ? slot.padding.right : 0,
      top: Number.isFinite(slot.padding?.top) ? slot.padding.top : 0,
      bottom: Number.isFinite(slot.padding?.bottom) ? slot.padding.bottom : 0,
    },
    transformCenter: {
      x: clamp01(slot.transformCenter?.x ?? 0.5),
      y: clamp01(slot.transformCenter?.y ?? 0.5),
    },
  };
}

export function pivotPoint(rect: Rect, pivot: Vec2): Vec2 {
  return {
    x: rect.x + rect.width * clamp01(pivot.x),
    y: rect.y + rect.height * clamp01(pivot.y),
  };
}

export function insetRect(rect: Rect, insets: EdgeInsets): Rect {
  return {
    x: rect.x + insets.left,
    y: rect.y + insets.top,
    width: Math.max(0, rect.width - insets.left - insets.right),
    height: Math.max(0, rect.height - insets.top - insets.bottom),
  };
}

export function designScale(
  viewport: { width: number; height: number },
  design: { width: number; height: number },
  rule: ScaleRule,
): number {
  const sx = design.width > 0 ? viewport.width / design.width : 1;
  const sy = design.height > 0 ? viewport.height / design.height : 1;
  switch (rule) {
    case "fitWidth":
      return sx;
    case "fitHeight":
      return sy;
    case "shortestSide":
      return Math.min(sx, sy);
  }
}

/** Rects are already GUI (top-left, Y-down). */
export function toGuiRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export const STUB_TEXT_MEASURER: TextMeasurer = {
  measure(text, _fontStack, fontSize) {
    const size = fontSize > 0 ? fontSize : 18;
    return { width: text.length * size * 0.5, height: size * 1.2 };
  },
};

export interface LayoutOptions {
  measurer?: TextMeasurer;
  safeArea?: EdgeInsets;
  resolveNested?: (guid: string) => UserInterfaceDocument | null;
  seenGuids?: ReadonlySet<string>;
  /** When true, rects stay in design pixels (nested apply / host slots). */
  designSpace?: boolean;
}

function numberProp(props: Record<string, unknown>, key: string, fallback: number): number {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function preferredSize(
  widget: WidgetNode,
  measurer: TextMeasurer,
  resolveNested?: (guid: string) => UserInterfaceDocument | null,
): { width: number; height: number } {
  const fontSize =
    typeof widget.style.fontSize === "number" ? widget.style.fontSize : 18;
  const fontStack = widget.style.fontFamily ?? "sans-serif";
  if (widget.kind === "Text" || widget.kind === "Button") {
    const text = typeof widget.props.text === "string" ? widget.props.text : "";
    return measurer.measure(text, fontStack, fontSize);
  }
  if (widget.kind === "SizeBox") {
    return {
      width: numberProp(widget.props, "width", 100),
      height: numberProp(widget.props, "height", 100),
    };
  }
  if (widget.kind === "UserInterface") {
    const nested =
      widget.nestedUiGuid && resolveNested
        ? resolveNested(widget.nestedUiGuid)
        : null;
    if (nested) return contentDesiredSize(nested, { measurer, resolveNested });
    return { ...DEFAULT_DESIRED_SIZE };
  }
  if (widget.kind === "Spacer") {
    return { width: 0, height: 0 };
  }
  if (widget.kind === "TouchJoystick") {
    return { width: 160, height: 160 };
  }
  if (widget.kind === "TouchButton") {
    return { width: 72, height: 72 };
  }
  if (widget.kind === "TouchDPad") {
    return { width: 160, height: 160 };
  }
  return { width: 80, height: 32 };
}

function intrinsicWidgetSize(
  widget: WidgetNode,
  doc: UserInterfaceDocument,
  measurer: TextMeasurer,
  resolveNested?: (guid: string) => UserInterfaceDocument | null,
): { width: number; height: number } {
  const childIds = widget.children.filter((id) => doc.widgets[id]);
  const gap = numberProp(widget.props, "gap", 0);
  if (widget.kind === "HorizontalBox" && childIds.length > 0) {
    const sizes = childIds.map((id) =>
      intrinsicWidgetSize(doc.widgets[id]!, doc, measurer, resolveNested),
    );
    return {
      width:
        sizes.reduce((sum, size) => sum + size.width, 0) +
        gap * Math.max(0, sizes.length - 1),
      height: sizes.reduce((max, size) => Math.max(max, size.height), 0),
    };
  }
  if (widget.kind === "VerticalBox" && childIds.length > 0) {
    const sizes = childIds.map((id) =>
      intrinsicWidgetSize(doc.widgets[id]!, doc, measurer, resolveNested),
    );
    return {
      width: sizes.reduce((max, size) => Math.max(max, size.width), 0),
      height:
        sizes.reduce((sum, size) => sum + size.height, 0) +
        gap * Math.max(0, sizes.length - 1),
    };
  }
  const layout = normalizeLayout(widget.layout);
  const hint = preferredSize(widget, measurer, resolveNested);
  return {
    width: layout.widthUnit === "px" ? layout.width : hint.width,
    height: layout.heightUnit === "px" ? layout.height : hint.height,
  };
}

/**
 * Authoring size for Desired mode and nested UserInterface slots.
 * AABB of canvas children from the origin, using px sizes (or preferred
 * size when a side is %). Empty documents keep {@link DEFAULT_DESIRED_SIZE}.
 */
export function contentDesiredSize(
  doc: UserInterfaceDocument,
  options: Pick<LayoutOptions, "measurer" | "resolveNested"> = {},
): { width: number; height: number } {
  const measurer = options.measurer ?? STUB_TEXT_MEASURER;
  const root = doc.widgets[doc.rootId];
  if (!root || root.children.length === 0) {
    return { ...DEFAULT_DESIRED_SIZE };
  }
  let maxX = 0;
  let maxY = 0;
  for (const id of root.children) {
    const child = doc.widgets[id];
    if (!child) continue;
    const layout = normalizeLayout(child.layout);
    const size = intrinsicWidgetSize(
      child,
      doc,
      measurer,
      options.resolveNested,
    );
    maxX = Math.max(
      maxX,
      layout.left + layout.padding.left + size.width + layout.padding.right,
    );
    maxY = Math.max(
      maxY,
      layout.top + layout.padding.top + size.height + layout.padding.bottom,
    );
  }
  if (maxX < 1 || maxY < 1) return { ...DEFAULT_DESIRED_SIZE };
  return {
    width: Math.max(1, Math.ceil(maxX)),
    height: Math.max(1, Math.ceil(maxY)),
  };
}

function mapRect(rect: Rect, canvas: Rect, scale: number): Rect {
  return {
    x: canvas.x + rect.x * scale,
    y: canvas.y + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

function mapTree(node: LaidOutWidget, canvas: Rect, scale: number): LaidOutWidget {
  return {
    ...node,
    rect: mapRect(node.rect, canvas, scale),
    transformCenter: {
      x: canvas.x + node.transformCenter.x * scale,
      y: canvas.y + node.transformCenter.y * scale,
    },
    children: node.children.map((child) => mapTree(child, canvas, scale)),
  };
}

function prefixAndOffset(
  node: LaidOutWidget,
  prefix: string,
  dx: number,
  dy: number,
): LaidOutWidget {
  return {
    ...node,
    id: `${prefix}/${node.id}`,
    rect: { ...node.rect, x: node.rect.x + dx, y: node.rect.y + dy },
    transformCenter: {
      x: node.transformCenter.x + dx,
      y: node.transformCenter.y + dy,
    },
    children: node.children.map((child) =>
      prefixAndOffset(child, prefix, dx, dy),
    ),
  };
}

function layoutNestedTree(
  widget: WidgetNode,
  rect: Rect,
  options: LayoutOptions,
): LaidOutWidget[] {
  const guid = widget.nestedUiGuid ?? widget.visualOverrideGuid;
  if (!guid || !options.resolveNested) return [];
  const seen = options.seenGuids ?? new Set<string>();
  if (seen.has(guid)) return [];
  const nested = options.resolveNested(guid);
  if (!nested) return [];
  const nextSeen = new Set(seen);
  nextSeen.add(guid);
  const nestedLayout = layoutUserInterface(
    {
      ...nested,
      designResolution: contentDesiredSize(nested, {
        measurer: options.measurer,
        resolveNested: options.resolveNested,
      }),
    },
    { width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
    {
      measurer: options.measurer,
      resolveNested: options.resolveNested,
      seenGuids: nextSeen,
      designSpace: true,
    },
  );
  return nestedLayout.tree
    ? [prefixAndOffset(nestedLayout.tree, widget.id, rect.x, rect.y)]
    : [];
}

function layoutChildren(
  parent: WidgetNode,
  parentRect: Rect,
  doc: UserInterfaceDocument,
  measurer: TextMeasurer,
  options: LayoutOptions,
  childParent: Rect,
): LaidOutWidget[] {
  const padding = parent.style.padding ?? ZERO_INSETS;
  const inner = insetRect(childParent, padding);
  const gap = numberProp(parent.props, "gap", 0);
  const childIds = parent.children.filter((id) => doc.widgets[id]);
  const resolveNested = options.resolveNested;

  if (
    parent.kind === "Canvas" ||
    parent.kind === "Overlay" ||
    parent.kind === "ScrollBox" ||
    parent.kind === "Border"
  ) {
    return childIds.map((id) => {
      const child = doc.widgets[id]!;
      const full = insetRect(parentRect, padding);
      const slot =
        parent.kind === "Canvas" && !child.ignoreSafeArea
          ? insetRect(childParent, padding)
          : parent.kind === "Canvas"
            ? full
            : full;
      return layoutWidget(child, slot, doc, measurer, options);
    });
  }

  if (parent.kind === "SizeBox") {
    const size = preferredSize(parent, measurer, resolveNested);
    const box: Rect = {
      x: inner.x,
      y: inner.y,
      width: size.width,
      height: size.height,
    };
    return childIds.map((id) =>
      layoutWidget(doc.widgets[id]!, box, doc, measurer, options, true),
    );
  }

  if (parent.kind === "HorizontalBox") {
    let x = inner.x;
    return childIds.map((id) => {
      const child = doc.widgets[id]!;
      const hint = preferredSize(child, measurer, resolveNested);
      const width = CONTAINER_KINDS.has(child.kind)
        ? Math.max(0, (inner.width - gap * Math.max(childIds.length - 1, 0)) / Math.max(childIds.length, 1))
        : hint.width;
      const slot: Rect = { x, y: inner.y, width, height: inner.height };
      x += width + gap;
      return layoutWidget(child, slot, doc, measurer, options, true);
    });
  }

  if (parent.kind === "VerticalBox") {
    let y = inner.y;
    return childIds.map((id) => {
      const child = doc.widgets[id]!;
      const hint = preferredSize(child, measurer, resolveNested);
      const height = CONTAINER_KINDS.has(child.kind)
        ? Math.max(0, (inner.height - gap * Math.max(childIds.length - 1, 0)) / Math.max(childIds.length, 1))
        : hint.height;
      const slot: Rect = { x: inner.x, y, width: inner.width, height };
      y += height + gap;
      return layoutWidget(child, slot, doc, measurer, options, true);
    });
  }

  if (parent.kind === "Grid") {
    const columns = Math.max(1, Math.floor(numberProp(parent.props, "columns", 2)));
    const rows = Math.max(1, Math.floor(numberProp(parent.props, "rows", 2)));
    const cellW = (inner.width - gap * (columns - 1)) / columns;
    const cellH = (inner.height - gap * (rows - 1)) / rows;
    return childIds.map((id, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns) % rows;
      const slot: Rect = {
        x: inner.x + col * (cellW + gap),
        y: inner.y + row * (cellH + gap),
        width: cellW,
        height: cellH,
      };
      return layoutWidget(doc.widgets[id]!, slot, doc, measurer, options, true);
    });
  }

  return childIds.map((id) =>
    layoutWidget(doc.widgets[id]!, inner, doc, measurer, options),
  );
}

function layoutWidget(
  widget: WidgetNode,
  parentRect: Rect,
  doc: UserInterfaceDocument,
  measurer: TextMeasurer,
  options: LayoutOptions,
  fillSlot = false,
): LaidOutWidget {
  const rect = fillSlot
    ? parentRect
    : previewRect(parentRect, normalizeLayout(widget.layout));
  const transformCenter = pivotPoint(rect, widget.layout.transformCenter ?? { x: 0.5, y: 0.5 });
  const nestedChildren =
    widget.kind === "UserInterface" || widget.nestedUiGuid || widget.visualOverrideGuid
      ? layoutNestedTree(widget, rect, options)
      : [];
  return {
    id: widget.id,
    kind: widget.kind,
    name: widget.name,
    rect,
    transformCenter,
    visible: widget.visible,
    widget,
    children: !widget.visible
      ? []
      : nestedChildren.length > 0
        ? nestedChildren
        : layoutChildren(widget, rect, doc, measurer, options, rect),
  };
}

export function layoutUserInterface(
  doc: UserInterfaceDocument,
  viewport: { width: number; height: number },
  options: LayoutOptions = {},
): LayoutResult {
  const measurer = options.measurer ?? STUB_TEXT_MEASURER;
  const viewportRect: Rect = {
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  };
  const scale = designScale(viewport, doc.designResolution, doc.scaleRule);
  const designParent: Rect = {
    x: 0,
    y: 0,
    width: doc.designResolution.width,
    height: doc.designResolution.height,
  };
  const safeDesign: EdgeInsets = options.safeArea
    ? {
        left: options.safeArea.left / scale,
        right: options.safeArea.right / scale,
        top: options.safeArea.top / scale,
        bottom: options.safeArea.bottom / scale,
      }
    : ZERO_INSETS;
  const root = doc.widgets[doc.rootId];
  if (!root) {
    return { canvas: options.designSpace ? designParent : viewportRect, scale, tree: null };
  }
  const tree = layoutWidget(root, designParent, doc, measurer, {
    ...options,
    measurer,
  });
  if (root.kind === "Canvas" && (safeDesign.top || safeDesign.bottom || safeDesign.left || safeDesign.right)) {
    const safeRect = insetRect(designParent, safeDesign);
    tree.children = layoutChildren(
      root,
      tree.rect,
      doc,
      measurer,
      { ...options, measurer },
      safeRect,
    );
  }
  if (options.designSpace) {
    return { canvas: designParent, scale: 1, tree };
  }
  return {
    canvas: viewportRect,
    scale,
    tree: mapTree(tree, { x: 0, y: 0, width: 0, height: 0 }, scale),
  };
}

export function flattenLaidOut(tree: LaidOutWidget | null): LaidOutWidget[] {
  if (!tree) return [];
  const out: LaidOutWidget[] = [tree];
  for (const child of tree.children) {
    out.push(...flattenLaidOut(child));
  }
  return out;
}
