import type { UiControlDescriptor } from "@babylonslate/ui-runtime";

export const uiHostStats = {
  apply: 0,
  create: 0,
  present: 0,
  commit: 0,
};

export function resetUiHostStats(): void {
  uiHostStats.apply = 0;
  uiHostStats.create = 0;
  uiHostStats.present = 0;
  uiHostStats.commit = 0;
}

export interface UiApplyHost {
  clear(): void;
  addControl(descriptor: UiControlDescriptor): void;
  setVisible(widgetId: string, visible: boolean): void;
  markAsDirty(): void;
  reconcile?(controls: readonly UiControlDescriptor[]): void;
}

export interface TouchAxisSample {
  controlId: string;
  value: number;
}

/**
 * Applies layout descriptors to an injectable GUI host (Babylon ADT in Play,
 * a recorder in tests). Worker code never measures text.
 */
export function applyUiControls(
  host: UiApplyHost,
  controls: readonly UiControlDescriptor[],
): void {
  uiHostStats.apply += 1;
  if (host.reconcile) {
    host.reconcile(controls);
  } else {
    host.clear();
    for (const control of controls) {
      host.addControl(control);
    }
  }
  host.markAsDirty();
}

export function applyUiControlsIfUnfrozen(
  frozen: boolean,
  host: UiApplyHost,
  controls: readonly UiControlDescriptor[],
): void {
  if (frozen) return;
  applyUiControls(host, controls);
}

export function applyWidgetVisible(
  host: UiApplyHost,
  widgetId: string,
  visible: boolean,
): void {
  host.setVisible(widgetId, visible);
  host.markAsDirty();
}

/** Map a joystick stick offset in [-1, 1] through the widget dead zone. */
export function joystickAxisValue(
  raw: number,
  deadZone: number,
): number {
  const zone = Math.max(0, Math.min(0.95, deadZone));
  const mag = Math.abs(raw);
  if (mag <= zone) return 0;
  const scaled = (mag - zone) / (1 - zone);
  return Math.max(-1, Math.min(1, Math.sign(raw) * scaled));
}

/** Local pointer on a control (top-left origin) → dead-zoned stick axes. */
export function joystickAxesFromLocal(
  localX: number,
  localY: number,
  width: number,
  height: number,
  deadZone: number,
): { x: number; y: number } {
  const halfW = width / 2;
  const halfH = height / 2;
  if (halfW <= 0 || halfH <= 0) return { x: 0, y: 0 };
  const nx = (localX - halfW) / halfW;
  const ny = -((localY - halfH) / halfH);
  return {
    x: joystickAxisValue(nx, deadZone),
    y: joystickAxisValue(ny, deadZone),
  };
}

export class RecordingUiHost implements UiApplyHost {
  controls: UiControlDescriptor[] = [];
  visibility = new Map<string, boolean>();
  dirtyCount = 0;

  clear(): void {
    this.controls = [];
    this.visibility.clear();
  }

  addControl(descriptor: UiControlDescriptor): void {
    this.controls.push(descriptor);
    this.visibility.set(descriptor.id, descriptor.visible);
  }

  setVisible(widgetId: string, visible: boolean): void {
    this.visibility.set(widgetId, visible);
  }

  markAsDirty(): void {
    this.dirtyCount += 1;
  }
}
