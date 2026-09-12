import {
  inputControlFromKey,
  inputKeyFromControl,
  normalizeInputAssetPayload,
  type InputKey,
} from "@babylonslate/core";
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
  addInputActionBinding?(
    input: InputTypeValue,
    key: InputKey,
    options?: Partial<InputBindingValue>,
  ): boolean;
  setInputActionBinding?(binding: InputBindingValue, key: InputKey): boolean;
  removeInputActionBinding?(input: InputTypeValue, key: InputKey): boolean;
  addInputAxisBinding?(
    input: InputTypeValue,
    key: InputKey,
    options?: Partial<InputBindingValue>,
  ): boolean;
  setInputAxisBinding?(binding: InputBindingValue, key: InputKey): boolean;
  removeInputAxisBinding?(input: InputTypeValue, key: InputKey): boolean;
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

interface BindingEdit {
  kind: "action" | "axis";
  mapping: string;
  id: string;
  added: boolean;
  binding: (AxisBinding & { id: string }) | null;
}
const editKey = (edit: Pick<BindingEdit, "kind" | "mapping" | "id">) =>
  JSON.stringify([edit.kind, edit.mapping, edit.id]);

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

function matchingMappings<T extends { id?: string; name: string }>(
  rows: readonly T[],
  key: string,
): T[] {
  const byId = rows.filter((row) => row.id === key);
  if (byId.length) return byId;
  return rows.filter((row) => row.name === key);
}

function slot(
  mappings: InputMappings,
  kind: string,
  mapping: string,
  index: number,
): ActionBinding | AxisBinding | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  const rows =
    kind === "action" ? mappings.actions : kind === "axis" ? mappings.axes : [];
  return matchingMappings(rows, mapping)[0]?.bindings[index];
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

function describeBinding(binding: ActionBinding): InputBindingInfo {
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

/** Session overrides over authored defaults; browser-independent keyboard capture. */
export class InputBindingProfile implements InputBindingControls {
  private defaults: InputMappings;
  private current: InputMappings;
  private overrides = new Map<string, BindingOverride>();
  private edits = new Map<string, BindingEdit>();
  private nextBindingId = 0;
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
    this.edits.clear();
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
              Label: describeBinding(binding).label,
              Key: inputKeyFromControl(binding.device, binding.code) ?? "None",
              Shift: !!binding.modifiers?.shift,
              Ctrl: !!binding.modifiers?.ctrl,
              Alt: !!binding.modifiers?.alt,
              Meta: !!binding.modifiers?.meta,
              Component: (binding as AxisBinding).component === "y" ? "Y" : "X",
              DeadZone: (binding as AxisBinding).deadZone ?? 0,
              Scale: (binding as AxisBinding).scale ?? 1,
              Invert: (binding as AxisBinding).invert ?? false,
              Sensitivity: (binding as AxisBinding).sensitivity ?? 1,
              DigitalValue: (binding as AxisBinding).digitalValue ?? 1,
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

  addInputActionBinding(
    input: InputTypeValue,
    key: InputKey,
    options?: Partial<InputBindingValue>,
  ): boolean {
    return this.addTypedBinding("action", input, key, options);
  }

  addInputAxisBinding(
    input: InputTypeValue,
    key: InputKey,
    options?: Partial<InputBindingValue>,
  ): boolean {
    return this.addTypedBinding("axis", input, key, options);
  }

  setInputActionBinding(binding: InputBindingValue, key: InputKey): boolean {
    return this.setTypedBinding("action", binding, key);
  }

  setInputAxisBinding(binding: InputBindingValue, key: InputKey): boolean {
    return this.setTypedBinding("axis", binding, key);
  }

  removeInputActionBinding(input: InputTypeValue, key: InputKey): boolean {
    return this.removeTypedBinding("action", input, key);
  }

  removeInputAxisBinding(input: InputTypeValue, key: InputKey): boolean {
    return this.removeTypedBinding("axis", input, key);
  }

  private typedMapping(kind: "action" | "axis", input: InputTypeValue) {
    return (kind === "action" ? this.current.actions : this.current.axes).find(
      (row) => !!input?.Asset && row.id === input.Asset,
    );
  }

  private writeEdit(
    kind: "action" | "axis",
    mapping: string,
    binding: AxisBinding & { id: string },
    removed = false,
  ): void {
    const authored = (
      kind === "action" ? this.defaults.actions : this.defaults.axes
    )
      .find((row) => row.id === mapping)
      ?.bindings.some((row) => row.id === binding.id);
    const edit: BindingEdit = {
      kind,
      mapping,
      id: binding.id,
      added: !authored,
      binding: removed ? null : structuredClone(binding),
    };
    if (removed && !authored) this.edits.delete(editKey(edit));
    else this.edits.set(editKey(edit), edit);
  }

  private addTypedBinding(
    kind: "action" | "axis",
    input: InputTypeValue,
    key: InputKey,
    options: Partial<InputBindingValue> = {},
  ): boolean {
    options ??= {};
    const row = this.typedMapping(kind, input);
    const control = inputControlFromKey(key);
    if (!row || !control || !options || typeof options !== "object")
      return false;
    let id: string;
    do {
      id = `runtime-binding-${++this.nextBindingId}`;
    } while (row.bindings.some((binding) => binding.id === id));
    const binding: AxisBinding & { id: string } = { ...control, id };
    for (const [field, flag] of [
      ["Shift", "shift"],
      ["Ctrl", "ctrl"],
      ["Alt", "alt"],
      ["Meta", "meta"],
    ] as const) {
      if (options[field] !== undefined && typeof options[field] !== "boolean")
        return false;
      if (options[field]) (binding.modifiers ??= {})[flag] = true;
    }
    if (kind === "axis") {
      if (
        options.Component !== undefined &&
        options.Component !== "X" &&
        options.Component !== "Y"
      )
        return false;
      if (options.Component)
        binding.component = options.Component === "Y" ? "y" : "x";
      for (const [field, property] of [
        ["DeadZone", "deadZone"],
        ["Scale", "scale"],
        ["Sensitivity", "sensitivity"],
        ["DigitalValue", "digitalValue"],
      ] as const) {
        const value = options[field];
        if (value !== undefined) {
          if (typeof value !== "number" || !Number.isFinite(value))
            return false;
          if (field === "DeadZone" && (value < 0 || value >= 1)) return false;
          binding[property] = value;
        }
      }
      if (options.Invert !== undefined && typeof options.Invert !== "boolean")
        return false;
      if (options.Invert) binding.invert = true;
    }
    this.writeEdit(kind, row.id!, binding);
    this.apply();
    return true;
  }

  private setTypedBinding(
    kind: "action" | "axis",
    binding: InputBindingValue,
    key: InputKey,
  ): boolean {
    const row = this.typedMapping(kind, binding?.Input);
    const current = row?.bindings.find(
      (entry) => !!binding?.Id && entry.id === binding.Id,
    );
    const control = inputControlFromKey(key);
    if (!current?.id || !control) return false;
    this.writeEdit(kind, row!.id!, { ...current, ...control, id: current.id });
    this.apply();
    return true;
  }

  /** Remove every matching key in this asset, including chords and axis components. */
  private removeTypedBinding(
    kind: "action" | "axis",
    input: InputTypeValue,
    key: InputKey,
  ): boolean {
    if (!inputControlFromKey(key)) return false;
    const row = this.typedMapping(kind, input);
    const bindings = row?.bindings.filter(
      (entry) =>
        entry.id && inputKeyFromControl(entry.device, entry.code) === key,
    );
    if (!row || !bindings?.length) return false;
    for (const binding of bindings)
      this.writeEdit(kind, row.id!, { ...binding, id: binding.id! }, true);
    this.apply();
    return true;
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
    return describeBinding(binding);
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
    const mappingRow = matchingMappings(
      kind === "action" ? this.defaults.actions : this.defaults.axes,
      mapping,
    )[0];
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
    const rows =
      kind === "action"
        ? this.defaults.actions
        : kind === "axis"
          ? this.defaults.axes
          : null;
    const selected =
      rows && mapping ? matchingMappings(rows, mapping)[0] : undefined;
    if (!resetAll && !selected) return false;
    mapping = selected?.id ?? selected?.name ?? mapping;
    for (const [key, override] of this.overrides) {
      if (resetAll || (override.kind === kind && override.mapping === mapping))
        this.overrides.delete(key);
    }
    for (const [key, edit] of this.edits) {
      if (resetAll || (edit.kind === kind && edit.mapping === mapping))
        this.edits.delete(key);
    }
    this.cancelRebind();
    this.status = "idle";
    this.apply();
    return true;
  }

  exportBindings(): string {
    return JSON.stringify({
      version: this.edits.size ? 2 : 1,
      overrides: [...this.overrides.values()],
      ...(this.edits.size ? { edits: [...this.edits.values()] } : {}),
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
    const edits = new Map<string, BindingEdit>();
    if (document.version === 2) {
      if (!Array.isArray(document.edits)) return false;
      for (const value of document.edits) {
        if (!value || typeof value !== "object") return false;
        const edit = value as BindingEdit;
        if (
          (edit.kind !== "action" && edit.kind !== "axis") ||
          typeof edit.mapping !== "string" ||
          typeof edit.id !== "string" ||
          !edit.id ||
          typeof edit.added !== "boolean"
        )
          return false;
        const row = (
          edit.kind === "action" ? this.defaults.actions : this.defaults.axes
        ).find((entry) => entry.id === edit.mapping);
        if (
          !row ||
          edit.added === row.bindings.some((binding) => binding.id === edit.id)
        )
          return false;
        if (edit.binding === null) {
          if (edit.added) return false;
        } else {
          if (
            !edit.binding ||
            edit.binding.id !== edit.id ||
            !inputKeyFromControl(edit.binding.device, edit.binding.code)
          )
            return false;
          for (const field of [
            "scale",
            "sensitivity",
            "digitalValue",
            "deadZone",
          ] as const) {
            const value = edit.binding[field];
            if (
              value !== undefined &&
              (typeof value !== "number" || !Number.isFinite(value))
            )
              return false;
          }
          if (
            edit.binding.deadZone !== undefined &&
            (edit.binding.deadZone < 0 || edit.binding.deadZone >= 1)
          )
            return false;
          if (
            edit.binding.component !== undefined &&
            edit.binding.component !== "x" &&
            edit.binding.component !== "y"
          )
            return false;
          if (
            edit.binding.invert !== undefined &&
            typeof edit.binding.invert !== "boolean"
          )
            return false;
          if (
            edit.binding.modifiers !== undefined &&
            (!edit.binding.modifiers ||
              typeof edit.binding.modifiers !== "object" ||
              modifiers.some(
                (flag) =>
                  edit.binding!.modifiers?.[flag] !== undefined &&
                  typeof edit.binding!.modifiers?.[flag] !== "boolean",
              ))
          )
            return false;
          const normalized = normalizeInputAssetPayload(
            edit.kind === "action" ? "InputAction" : "InputAxis",
            { bindings: [edit.binding] },
          ).bindings[0];
          if (!normalized) return false;
          edit.binding = normalized;
        }
        if (edits.has(editKey(edit))) return false;
        edits.set(editKey(edit), structuredClone(edit));
      }
    }
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
        (entry) => (entry.id ?? entry.name) === row.mapping,
      );
      if (candidates.length !== 1) return false;
      const mapping = candidates[0]!;
      if (mapping.id && typeof row.bindingId !== "string") return false;
      const originalAuthored = row.defaultBinding as AxisBinding | undefined;
      const matching = mapping.bindings
        .map((binding, index) => ({ binding, index }))
        .filter(({ binding, index }) =>
          typeof row.bindingId === "string"
            ? binding.id === row.bindingId
            : originalAuthored &&
              authoredSignature(binding) ===
                authoredSignature(originalAuthored) &&
              index === row.index,
        );
      if (matching.length !== 1) return false;
      const { binding: original, index } = matching[0]!;
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
    this.edits = edits;
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
    for (const edit of this.edits.values()) {
      const row = (
        edit.kind === "action" ? this.current.actions : this.current.axes
      ).find((entry) => entry.id === edit.mapping);
      if (!row) continue;
      const index = row.bindings.findIndex((binding) => binding.id === edit.id);
      if (edit.binding === null) {
        if (index >= 0) row.bindings.splice(index, 1);
      } else if (index >= 0) {
        row.bindings[index] = structuredClone(edit.binding);
      } else if (edit.added) {
        row.bindings.push(structuredClone(edit.binding));
      }
    }
    this.onChange(this.current);
  }
}
