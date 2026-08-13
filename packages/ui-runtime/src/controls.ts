import type { UserInterfaceDocument, WidgetKind, WidgetStyle, Rect, LayoutResult } from "./types";
import { flattenLaidOut, toGuiRect } from "./layout";

export interface UiControlDescriptor {
  id: string;
  kind: WidgetKind;
  name: string;
  guiRect: Rect;
  visible: boolean;
  text?: string;
  style: WidgetStyle;
  props: Record<string, unknown>;
  nestedUiGuid?: string | null;
  visualOverrideGuid?: string | null;
}

export function describeUiControls(
  doc: UserInterfaceDocument,
  layout: LayoutResult,
  viewportHeight: number,
): UiControlDescriptor[] {
  return flattenLaidOut(layout.tree).map((node) => {
    const widget = node.widget ?? doc.widgets[node.id];
    const text =
      typeof widget?.props.text === "string" ? widget.props.text : undefined;
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      guiRect: toGuiRect(node.rect, viewportHeight),
      visible: node.visible,
      text,
      style: widget?.style ?? {},
      props: widget?.props ?? {},
      nestedUiGuid: widget?.nestedUiGuid,
      visualOverrideGuid: widget?.visualOverrideGuid,
    };
  });
}
