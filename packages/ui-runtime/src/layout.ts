import type {
  EdgeInsets,
  LaidOutWidget,
  LayoutResult,
  Rect,
  ScaleRule,
  TextMeasurer,
  UserInterfaceDocument,
  Vec2,
  WidgetLayout,
  WidgetNode,
} from "./types";
import { CONTAINER_KINDS, DEFAULT_DESIRED_SIZE } from "./types";

export function clamp01(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return 1;
  return Math.max(0, Math.min(1, value));
}

export function normalizeLayout(slot: WidgetLayout): WidgetLayout {
  const minX = clamp01(slot.anchorMin.x);
  const minY = clamp01(slot.anchorMin.y);
  return {
    anchorMin: { x: minX, y: minY },
    anchorMax: {
      x: Math.max(minX, clamp01(slot.anchorMax.x)),
      y: Math.max(minY, clamp01(slot.anchorMax.y)),
    },
    offsetMin: { ...slot.offsetMin },
    offsetMax: { ...slot.offsetMax },
    pivot: { x: clamp01(slot.pivot.x), y: clamp01(slot.pivot.y) },
  };
}

export function computeAnchoredRect(parent: Rect, slot: WidgetLayout): Rect {
  const layout = normalizeLayout(slot);
  const left = parent.x + parent.width * layout.anchorMin.x + layout.offsetMin.x;
  const bottom =
    parent.y + parent.height * layout.anchorMin.y + layout.offsetMin.y;
  const right =
    parent.x + parent.width * layout.anchorMax.x + layout.offsetMax.x;
  const top = parent.y + parent.height * layout.anchorMax.y + layout.offsetMax.y;
  return {
    x: left,
    y: bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, top - bottom),
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
    y: rect.y + insets.bottom,
    width: Math.max(0, rect.width - insets.left - insets.right),
    height: Math.max(0, rect.height - insets.bottom - insets.top),
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

export function designCanvasRect(
  viewport: Rect,
  design: { width: number; height: number },
  rule: ScaleRule,
): Rect {
  const scale = designScale(viewport, design, rule);
  const width = design.width * scale;
  const height = design.height * scale;
  return {
    x: viewport.x + (viewport.width - width) / 2,
    y: viewport.y + (viewport.height - height) / 2,
    width,
    height,
  };
}

/** Convert engine-space (Y-up, bottom-left) to Babylon GUI (Y-down, top-left). */
export function toGuiRect(rect: Rect, parentHeight: number): Rect {
  return {
    x: rect.x,
    y: parentHeight - rect.y - rect.height,
    width: rect.width,
    height: rect.height,
  };
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
    if (nested) return { ...nested.desiredSize };
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
    pivot: { x: node.pivot.x + dx, y: node.pivot.y + dy },
    children: node.children.map((child) =>
      prefixAndOffset(child, prefix, dx, dy),
    ),
  };
}

function layoutChildren(
  parent: WidgetNode,
  parentRect: Rect,
  doc: UserInterfaceDocument,
  measurer: TextMeasurer,
  options: LayoutOptions,
): LaidOutWidget[] {
  const padding = parent.style.padding ?? {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  };
  const inner = insetRect(parentRect, padding);
  const gap = numberProp(parent.props, "gap", 0);
  const childIds = parent.children.filter((id) => doc.widgets[id]);
  const resolveNested = options.resolveNested;

  if (
    parent.kind === "Canvas" ||
    parent.kind === "Overlay" ||
    parent.kind === "ScrollBox" ||
    parent.kind === "Border"
  ) {
    return childIds.map((id) =>
      layoutWidget(doc.widgets[id]!, inner, doc, measurer, options),
    );
  }

  if (parent.kind === "SizeBox") {
    const size = preferredSize(parent, measurer, resolveNested);
    const box: Rect = {
      x: inner.x,
      y: inner.y + inner.height - size.height,
      width: size.width,
      height: size.height,
    };
    return childIds.map((id) =>
      layoutWidget(doc.widgets[id]!, box, doc, measurer, options),
    );
  }

  if (parent.kind === "HorizontalBox") {
    let x = inner.x;
    const count = childIds.length;
    const flexTotal = Math.max(count, 1);
    const available = inner.width - gap * Math.max(count - 1, 0);
    return childIds.map((id) => {
      const child = doc.widgets[id]!;
      const hint = preferredSize(child, measurer, resolveNested);
      const width = CONTAINER_KINDS.has(child.kind)
        ? available / flexTotal
        : hint.width;
      const slot: Rect = {
        x,
        y: inner.y,
        width,
        height: inner.height,
      };
      x += width + gap;
      return layoutWidget(child, slot, doc, measurer, options, true);
    });
  }

  if (parent.kind === "VerticalBox") {
    let y = inner.y + inner.height;
    const count = childIds.length;
    const flexTotal = Math.max(count, 1);
    const available = inner.height - gap * Math.max(count - 1, 0);
    return childIds.map((id) => {
      const child = doc.widgets[id]!;
      const hint = preferredSize(child, measurer, resolveNested);
      const height = CONTAINER_KINDS.has(child.kind)
        ? available / flexTotal
        : hint.height;
      y -= height;
      const slot: Rect = {
        x: inner.x,
        y,
        width: inner.width,
        height,
      };
      y -= gap;
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
        y: inner.y + inner.height - (row + 1) * cellH - row * gap,
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

function layoutNestedTree(
  widget: WidgetNode,
  rect: Rect,
  options: LayoutOptions,
): LaidOutWidget[] {
  const guid = widget.nestedUiGuid;
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
      designResolution: nested.desiredSize ?? nested.designResolution,
    },
    { width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
    {
      measurer: options.measurer,
      resolveNested: options.resolveNested,
      seenGuids: nextSeen,
    },
  );
  return nestedLayout.tree
    ? [prefixAndOffset(nestedLayout.tree, widget.id, rect.x, rect.y)]
    : [];
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
    : computeAnchoredRect(parentRect, widget.layout);
  const pivot = pivotPoint(rect, widget.layout.pivot);
  const nestedChildren =
    widget.kind === "UserInterface" || widget.nestedUiGuid
      ? layoutNestedTree(widget, rect, options)
      : [];
  return {
    id: widget.id,
    kind: widget.kind,
    name: widget.name,
    rect,
    pivot,
    visible: widget.visible,
    widget,
    children: !widget.visible
      ? []
      : nestedChildren.length > 0
        ? nestedChildren
        : layoutChildren(widget, rect, doc, measurer, options),
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
  const safe = options.safeArea
    ? insetRect(viewportRect, options.safeArea)
    : viewportRect;
  const scale = designScale(safe, doc.designResolution, doc.scaleRule);
  const canvas = designCanvasRect(safe, doc.designResolution, doc.scaleRule);
  const root = doc.widgets[doc.rootId];
  return {
    canvas,
    scale,
    tree: root
      ? layoutWidget(root, canvas, doc, measurer, options)
      : null,
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

export function roundRect(rect: Rect, digits = 3): Rect {
  const f = 10 ** digits;
  return {
    x: Math.round(rect.x * f) / f,
    y: Math.round(rect.y * f) / f,
    width: Math.round(rect.width * f) / f,
    height: Math.round(rect.height * f) / f,
  };
}
