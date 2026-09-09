import type {
  InputTypeValue,
  InputBindingValue,
  InputControlValue,
} from "@babylonslate/core";
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
  getInputBindings?(input: InputTypeValue): InputBindingValue[];
  setInputControl?(
    binding: InputBindingValue,
    control: InputControlValue,
  ): boolean;
  beginInputRebind?(binding: InputBindingValue): boolean;
  resetInputBindings?(input: InputTypeValue): boolean;

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
  bindingId?: string;
  kind: "action" | "axis";
  mapping: string;
  index: number;
  defaultBinding: AxisBinding;
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

/** Canonical semantic identity also distinguishes chords and 2D axis slots. */
const authoredSignature = (binding: AxisBinding) =>
  JSON.stringify([
    binding.device,
    binding.code,
    ...modifiers.map((name) => binding.modifiers?.[name] === true),
    binding.component ?? "x",
    binding.digitalValue ?? 1,
    binding.deadZone ?? 0,
    binding.scale ?? 1,
    binding.invert === true,
    binding.sensitivity ?? 1,
  ]);

function slot(
  mappings: InputMappings,
  kind: string,
  mapping: string,
  index: number,
): ActionBinding | AxisBinding | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  const rows =
    kind === "action" ? mappings.actions : kind === "axis" ? mappings.axes : [];
  return rows.find(
    (row) =>
      row.id === mapping || row.name === mapping || row.legacyName === mapping,
  )?.bindings[index];
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
  private modifierCandidate: string | null = null;
  private readonly onChange: (mappings: InputMappings) => void;
  private readonly onCaptureStart: () => void;

  constructor(
    mappings: InputMappings,
    onChange: (mappings: InputMappings) => void,
    onCaptureStart: () => void,
  ) {
    this.onChange = onChange;
    this.onCaptureStart = onCaptureStart;
    this.defaults = normalizeInputMappings(mappings);
    this.current = structuredClone(this.defaults);
  }

  setDefaults(mappings: InputMappings): void {
    this.defaults = normalizeInputMappings(mappings);
    this.overrides.clear();
    this.target = null;
    this.modifierCandidate = null;
    this.status = "idle";
    this.apply();
  }

  getInputBindings(input: InputTypeValue): InputBindingValue[] {
    const row = [...this.current.actions, ...this.current.axes].find(
      (entry) => entry.id === input?.Asset,
    );
    if (!row) return [];
    return row.bindings.flatMap((binding) =>
      binding.id
        ? [
            {
              Input: { Name: row.name, Asset: row.id! },
              Id: binding.id,
              Control: {
                Device: binding.device,
                Code: binding.code,
                Shift: !!binding.modifiers?.shift,
                Ctrl: !!binding.modifiers?.ctrl,
                Alt: !!binding.modifiers?.alt,
                Meta: !!binding.modifiers?.meta,
              },
            },
          ]
        : [],
    );
  }

  private typedSlot(binding: InputBindingValue) {
    for (const kind of ["action", "axis"] as const) {
      const row = (
        kind === "action" ? this.current.actions : this.current.axes
      ).find((entry) => entry.id === binding?.Input?.Asset);
      const index =
        row?.bindings.findIndex((entry) => entry.id === binding?.Id) ?? -1;
      if (row && index >= 0) return { kind, mapping: row.id!, index };
    }
    return null;
  }

  setInputControl(
    binding: InputBindingValue,
    control: InputControlValue,
  ): boolean {
    const target = this.typedSlot(binding);
    return (
      !!target &&
      !!control &&
      this.setBinding(
        target.kind,
        target.mapping,
        target.index,
        control.Device,
        control.Code,
        control.Shift,
        control.Ctrl,
        control.Alt,
        control.Meta,
      )
    );
  }

  beginInputRebind(binding: InputBindingValue): boolean {
    const target = this.typedSlot(binding);
    return (
      !!target && this.beginRebind(target.kind, target.mapping, target.index)
    );
  }

  resetInputBindings(input: InputTypeValue): boolean {
    const kind = this.current.actions.some((row) => row.id === input?.Asset)
      ? "action"
      : "axis";
    return this.resetBindings(kind, input?.Asset);
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
    const mappingRow = (
      kind === "action" ? this.defaults.actions : this.defaults.axes
    ).find(
      (row) =>
        row.id === mapping ||
        row.name === mapping ||
        row.legacyName === mapping,
    );
    mapping = mappingRow?.id ?? mapping;
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
      ...(original.id ? { bindingId: original.id } : {}),
      defaultBinding: structuredClone(original),
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
    this.modifierCandidate = null;
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
    this.modifierCandidate = null;
    this.status = "cancelled";
  }

  clearInputState(): void {
    this.heldKeys.clear();
    this.blockedKeys.clear();
    this.target = null;
    this.modifierCandidate = null;
    this.status = "idle";
  }

  resetBindings(kind?: string, mapping?: string): boolean {
    const resetAll = kind === undefined && mapping === undefined;
    mapping =
      [...this.defaults.actions, ...this.defaults.axes].find(
        (row) =>
          row.id === mapping ||
          row.name === mapping ||
          row.legacyName === mapping,
      )?.id ?? mapping;
    const rows =
      kind === "action"
        ? this.defaults.actions
        : kind === "axis"
          ? this.defaults.axes
          : null;
    if (
      !resetAll &&
      (!mapping ||
        !rows?.some(
          (row) =>
            row.id === mapping ||
            row.name === mapping ||
            row.legacyName === mapping,
        ))
    )
      return false;
    for (const [key, override] of this.overrides) {
      if (resetAll || (override.kind === kind && override.mapping === mapping))
        this.overrides.delete(key);
    }
    this.cancelRebind();
    this.status = "idle";
    this.apply();
    return true;
  }

  exportBindings(): string {
    return JSON.stringify({
      version: 2,
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
    if (
      (document.version !== 1 && document.version !== 2) ||
      !Array.isArray(document.overrides)
    )
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
      const mappings =
        row.kind === "action" ? this.defaults.actions : this.defaults.axes;
      const candidates = mappings.filter(
        (entry) =>
          entry.id === row.mapping ||
          entry.name === row.mapping ||
          entry.legacyName === row.mapping,
      );
      if (candidates.length !== 1) return false;
      const mapping = candidates[0]!;
      const originalAuthored = row.defaultBinding as AxisBinding | undefined;
      const matching = mapping.bindings
        .map((binding, index) => ({ binding, index }))
        .filter(({ binding, index }) =>
          typeof row.bindingId === "string"
            ? binding.id === row.bindingId
            : originalAuthored &&
              authoredSignature(binding) ===
                authoredSignature(originalAuthored) &&
              (!mapping.id ? index === row.index : true),
        );
      if (matching.length !== 1) return false;
      const { binding: original, index } = matching[0]!;
      row.mapping = mapping.id ?? mapping.name;
      row.index = index;
      if (
        modifiers.some(
          (name) => row[name] !== undefined && typeof row[name] !== "boolean",
        )
      )
        return false;
      const override: BindingOverride = {
        kind: row.kind,
        mapping: mapping.id ?? mapping.name,
        index,
        ...(original.id ? { bindingId: original.id } : {}),
        defaultBinding: structuredClone(original),
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
    if (
      this.target &&
      event.phase === "up" &&
      event.code === this.modifierCandidate
    ) {
      this.blockedKeys.delete(event.code);
      this.completeCapture(event.code);
      return false;
    }
    if (this.blockedKeys.has(event.code)) {
      if (event.phase === "up") this.blockedKeys.delete(event.code);
      return false;
    }
    if (!this.target) return true;
    if (event.phase === "down") this.blockedKeys.add(event.code);
    if (event.phase !== "down" || wasHeld) return false;
    if (modifierKeys.has(event.code)) {
      this.modifierCandidate = event.code;
      return false;
    }
    if (event.code === "Escape") {
      this.cancelRebind();
      return false;
    }
    this.completeCapture(event.code);
    return false;
  }

  private completeCapture(code: string): void {
    const target = this.target!;
    const held = (name: string) =>
      code !== `${name}Left` &&
      code !== `${name}Right` &&
      (this.heldKeys.has(`${name}Left`) || this.heldKeys.has(`${name}Right`));
    this.setBinding(
      target.kind,
      target.mapping,
      target.index,
      "key",
      code,
      held("Shift"),
      held("Control"),
      held("Alt"),
      held("Meta"),
    );
    this.target = null;
    this.modifierCandidate = null;
    this.status = "completed";
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
