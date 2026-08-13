import type {
  EdgeInsets,
  LayoutResult,
  Rect,
  UserInterfaceDocument,
  WidgetKind,
  WidgetLayout,
  WidgetStyle,
} from "./types";
import { flattenLaidOut, normalizeLayout, SAFE_AREA_CONTROL_ID } from "./layout";

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
}

function layoutModeFor(kind: WidgetKind): UiLayoutMode {
  if (kind === "HorizontalBox" || kind === "VerticalBox") return "stack";
  if (kind === "Grid") return "grid";
  if (kind === "ScrollBox") return "scroll";
  return "absolute";
}

function parentMode(kind: WidgetKind | undefined): UiLayoutMode {
  if (!kind) return "absolute";
  return layoutModeFor(kind);
}

/** Depth-first descriptors with `parentId` so the host can nest 1:1. */
export function describeUiControls(
  doc: UserInterfaceDocument,
  layout: LayoutResult,
): UiControlDescriptor[] {
  const flat = flattenLaidOut(layout.tree);
  const parentById = new Map<string, string>();
  const kindById = new Map<string, WidgetKind>();
  for (const node of flat) {
    kindById.set(node.id, node.kind);
    for (const child of node.children) {
      parentById.set(child.id, node.id);
    }
  }
  const gridIndex = new Map<string, number>();
  return flat.map((node) => {
    const widget = node.widget ?? doc.widgets[node.id.split("/").pop() ?? node.id];
    let parentId = parentById.get(node.id) ?? null;
    const parentKind = parentId ? kindById.get(parentId) : undefined;
    if (
      parentId === doc.rootId &&
      parentKind === "Canvas" &&
      !widget?.ignoreSafeArea
    ) {
      parentId = SAFE_AREA_CONTROL_ID;
    }
    const mode = parentMode(parentKind);
    const text =
      typeof widget?.props.text === "string" ? widget.props.text : undefined;
    let gridColumn: number | undefined;
    let gridRow: number | undefined;
    if (mode === "grid" && parentId) {
      const parentWidget = doc.widgets[parentId];
      const columns = Math.max(
        1,
        Math.floor(Number(parentWidget?.props.columns ?? 2) || 2),
      );
      const index = gridIndex.get(parentId) ?? 0;
      gridIndex.set(parentId, index + 1);
      gridColumn = index % columns;
      gridRow = Math.floor(index / columns);
    }
    const layoutFields: WidgetLayout = widget?.layout
      ? normalizeLayout(widget.layout)
      : {
          horizontalAlignment: "left",
          verticalAlignment: "top",
          width: node.rect.width,
          height: node.rect.height,
          widthUnit: "px",
          heightUnit: "px",
          left: 0,
          top: 0,
          padding: { left: 0, right: 0, top: 0, bottom: 0 } satisfies EdgeInsets,
          transformCenter: { x: 0.5, y: 0.5 },
        };
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      parentId,
      layoutMode: mode,
      gridColumn,
      gridRow,
      guiRect: node.rect,
      visible: node.visible,
      text,
      style: widget?.style ?? {},
      props: widget?.props ?? {},
      layout: layoutFields,
      nestedUiGuid: widget?.nestedUiGuid,
      visualOverrideGuid: widget?.visualOverrideGuid,
      ignoreSafeArea: widget?.ignoreSafeArea === true,
    };
  });
}
