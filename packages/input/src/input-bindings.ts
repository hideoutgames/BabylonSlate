import { bindingCodeLabel } from "./binding-catalog";
import {
  normalizeInputMappings,
  type ActionBinding,
  type AxisBinding,
  type InputDevice,
  type InputMappings,
} from "./mappings";
import type { RawInputEvent } from "./ring-buffer";

export interface InputBindingInfo {
  device: InputDevice;
  code: string;
  label: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export interface InputBindingControls {
  getBinding(
    kind: string,
    mapping: string,
    index: number,
  ): InputBindingInfo | null;
  setBinding(
    kind: string,
    mapping: string,
    index: number,
    device: string,
    code: string,
    shift?: boolean,
    ctrl?: boolean,
    alt?: boolean,
    meta?: boolean,
  ): boolean;
  beginRebind(kind: string, mapping: string, index: number): boolean;
  getRebindStatus(): "idle" | "listening" | "completed" | "cancelled";
  cancelRebind(): void;
  resetBindings(kind?: string, mapping?: string): boolean;
  exportBindings(): string;
  importBindings(data: string): boolean;
}

interface BindingOverride {
  kind: "action" | "axis";
  mapping: string;
  index: number;
  defaultDevice: InputDevice;
  defaultCode: string;
  device: InputDevice;
  code: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

const devices: readonly string[] = [
  "key",
  "mouseButton",
  "pointer",
  "gamepadButton",
  "gamepadAxis",
  "touch",
];
const modifiers = ["shift", "ctrl", "alt", "meta"] as const;
const modifierKeys = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);
const overrideKey = (kind: string, mapping: string, index: number) =>
  JSON.stringify([kind, mapping, index]);

function slot(
  mappings: InputMappings,
  kind: string,
  mapping: string,
  index: number,
): ActionBinding | AxisBinding | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  const rows =
    kind === "action" ? mappings.actions : kind === "axis" ? mappings.axes : [];
  return rows.find((row) => row.name === mapping)?.bindings[index];
}

function validControl(device: unknown, code: unknown): device is InputDevice {
  if (
    typeof device !== "string" ||
    !devices.includes(device) ||
    typeof code !== "string" ||
    !code.trim()
  )
    return false;
  if (device === "mouseButton") return /^\d+$/.test(code);
  if (device === "pointer") return code === "primary" || /^\d+$/.test(code);
  if (device === "gamepadButton" || device === "gamepadAxis")
    return /^\d+:\d+$/.test(code);
  return true;
}

/** Session overrides over authored defaults; browser-independent keyboard capture. */
export class InputBindingProfile implements InputBindingControls {
  private defaults: InputMappings;
  private current: InputMappings;
  private overrides = new Map<string, BindingOverride>();
  private heldKeys = new Set<string>();
  private blockedKeys = new Set<string>();
  private target: { kind: string; mapping: string; index: number } | null =
    null;
  private status: ReturnType<InputBindingControls["getRebindStatus"]> = "idle";

  constructor(
    mappings: InputMappings,
    private readonly onChange: (mappings: InputMappings) => void,
    private readonly onCaptureStart: () => void,
  ) {
    this.defaults = normalizeInputMappings(mappings);
    this.current = structuredClone(this.defaults);
  }

  setDefaults(mappings: InputMappings): void {
    this.defaults = normalizeInputMappings(mappings);
    this.overrides.clear();
    this.target = null;
    this.status = "idle";
    this.apply();
  }

  getBinding(
    kind: string,
    mapping: string,
    index: number,
  ): InputBindingInfo | null {
    const binding = slot(this.current, kind, mapping, index);
    if (!binding) return null;
    const flags = {
      shift: binding.modifiers?.shift === true,
      ctrl: binding.modifiers?.ctrl === true,
      alt: binding.modifiers?.alt === true,
      meta: binding.modifiers?.meta === true,
    };
    const prefix = [
      flags.ctrl && "Ctrl",
      flags.shift && "Shift",
      flags.alt && "Alt",
      flags.meta && "Meta",
    ].filter(Boolean);
    return {
      device: binding.device,
      code: binding.code,
      label: [...prefix, bindingCodeLabel(binding.device, binding.code)].join(
        " + ",
      ),
      ...flags,
    };
  }

  setBinding(
    kind: string,
    mapping: string,
    index: number,
    device: string,
    code: string,
    shift = false,
    ctrl = false,
    alt = false,
    meta = false,
  ): boolean {
    const original = slot(this.defaults, kind, mapping, index);
    if (
      !original ||
      (kind !== "action" && kind !== "axis") ||
      !validControl(device, code)
    )
      return false;
    const override: BindingOverride = {
      kind,
      mapping,
      index,
      defaultDevice: original.device,
      defaultCode: original.code,
      device,
      code,
    };
    const flags = { shift, ctrl, alt, meta };
    for (const name of modifiers)
      if (flags[name] === true) override[name] = true;
    const key = overrideKey(kind, mapping, index);
    if (
      device === original.device &&
      code === original.code &&
      modifiers.every(
        (name) =>
          (override[name] === true) === (original.modifiers?.[name] === true),
      )
    ) {
      this.overrides.delete(key);
    } else {
      this.overrides.set(key, override);
    }
    this.apply();
    return true;
  }

  beginRebind(kind: string, mapping: string, index: number): boolean {
    if (!slot(this.current, kind, mapping, index)) return false;
    this.target = { kind, mapping, index };
    this.status = "listening";
    for (const key of this.heldKeys) this.blockedKeys.add(key);
    this.onCaptureStart();
    return true;
  }

  getRebindStatus(): ReturnType<InputBindingControls["getRebindStatus"]> {
    return this.status;
  }

  cancelRebind(): void {
    if (!this.target) return;
    this.target = null;
    this.status = "cancelled";
  }

  clearInputState(): void {
    this.heldKeys.clear();
    this.blockedKeys.clear();
    this.target = null;
    this.status = "idle";
  }

  resetBindings(kind = "", mapping = ""): boolean {
    const rows =
      kind === "action"
        ? this.defaults.actions
        : kind === "axis"
          ? this.defaults.axes
          : null;
    if (
      (kind !== "" && !rows) ||
      (mapping !== "" && !rows?.some((row) => row.name === mapping))
    )
      return false;
    for (const [key, override] of this.overrides) {
      if (
        (!kind || override.kind === kind) &&
        (!mapping || override.mapping === mapping)
      )
        this.overrides.delete(key);
    }
    this.cancelRebind();
    this.status = "idle";
    this.apply();
    return true;
  }

  exportBindings(): string {
    return JSON.stringify({
      version: 1,
      overrides: [...this.overrides.values()],
    });
  }

  importBindings(data: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object") return false;
    const document = parsed as Record<string, unknown>;
    if (document.version !== 1 || !Array.isArray(document.overrides))
      return false;
    const next = new Map<string, BindingOverride>();
    for (const value of document.overrides) {
      if (!value || typeof value !== "object") return false;
      const row = value as Record<string, unknown>;
      if (
        (row.kind !== "action" && row.kind !== "axis") ||
        typeof row.mapping !== "string" ||
        typeof row.index !== "number" ||
        !validControl(row.device, row.code)
      )
        return false;
      const original = slot(this.defaults, row.kind, row.mapping, row.index);
      if (
        !original ||
        row.defaultDevice !== original.device ||
        row.defaultCode !== original.code
      )
        return false;
      if (
        modifiers.some(
          (name) => row[name] !== undefined && typeof row[name] !== "boolean",
        )
      )
        return false;
      const override: BindingOverride = {
        kind: row.kind,
        mapping: row.mapping,
        index: row.index,
        defaultDevice: original.device,
        defaultCode: original.code,
        device: row.device,
        code: row.code as string,
      };
      for (const name of modifiers)
        if (row[name] === true) override[name] = true;
      const key = overrideKey(override.kind, override.mapping, override.index);
      if (next.has(key)) return false;
      next.set(key, override);
    }
    this.overrides = next;
    this.cancelRebind();
    this.status = "idle";
    this.apply();
    return true;
  }

  /** Observe physical keys even while suppressing their gameplay events. */
  accepts(event: RawInputEvent): boolean {
    if (event.kind !== "key") return true;
    const wasHeld = this.heldKeys.has(event.code);
    if (event.phase === "down") this.heldKeys.add(event.code);
    else this.heldKeys.delete(event.code);
    if (this.blockedKeys.has(event.code)) {
      if (event.phase === "up") this.blockedKeys.delete(event.code);
      return false;
    }
    if (!this.target) return true;
    if (event.phase === "down") this.blockedKeys.add(event.code);
    if (event.phase !== "down" || wasHeld || modifierKeys.has(event.code))
      return false;
    if (event.code === "Escape") {
      this.cancelRebind();
      return false;
    }
    const target = this.target;
    const held = (name: string) =>
      this.heldKeys.has(`${name}Left`) || this.heldKeys.has(`${name}Right`);
    this.setBinding(
      target.kind,
      target.mapping,
      target.index,
      "key",
      event.code,
      held("Shift"),
      held("Control"),
      held("Alt"),
      held("Meta"),
    );
    this.target = null;
    this.status = "completed";
    return false;
  }

  private apply(): void {
    this.current = structuredClone(this.defaults);
    for (const override of this.overrides.values()) {
      const binding = slot(
        this.current,
        override.kind,
        override.mapping,
        override.index,
      )!;
      binding.device = override.device;
      binding.code = override.code;
      delete binding.modifiers;
      for (const name of modifiers) {
        if (override[name]) (binding.modifiers ??= {})[name] = true;
      }
    }
    this.onChange(this.current);
  }
}
