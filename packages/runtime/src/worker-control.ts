import type {
  ControlMessage,
  UiWidgetEventControl,
  UserInterfaceWidgetMeta,
} from "@babylonslate/bridge";

export type UiRuntimeControlTarget = {
  registerUserInterfaceDocument(
    guid: string,
    widgets: readonly UserInterfaceWidgetMeta[],
  ): void;
  dispatchUiWidgetEvent(event: UiWidgetEventControl): void;
};

/**
 * Route UserInterface control messages onto a live RuntimeDriver.
 * Returns true when the message was a UI control (so the worker switch can stop).
 */
export function applyUiRuntimeControl(
  runtime: UiRuntimeControlTarget,
  msg: ControlMessage,
): boolean {
  if (msg.type === "loadUserInterfaces") {
    for (const document of msg.documents) {
      runtime.registerUserInterfaceDocument(document.guid, document.widgets);
    }
    return true;
  }
  if (msg.type === "uiWidgetEvent") {
    runtime.dispatchUiWidgetEvent(msg);
    return true;
  }
  return false;
}
