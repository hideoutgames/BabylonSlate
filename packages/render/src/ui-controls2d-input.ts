import { Matrix, Vector3, type Mesh } from "@babylonjs/core";
import { clampUIControl2DValue, normalizeUIControl2DText, uiControl2DValueAt, type OverlayPointerHit } from "@babylonslate/core";
import { uiControl2DMesh, type UIControl2DMesh } from "./ui-controls2d-mesh";
import type { SceneLayerView } from "./scene-layer-compositor";

export type SceneLayerControlEvent = {
  layerId: string; actorGuid: string; componentId: string;
  action: "change" | "commit" | "focus" | "blur" | "activate";
  value?: number | boolean | string; secondaryValue?: number;
};
type Target = { visual: UIControl2DMesh; layer: SceneLayerView; actorGuid: string; componentId: string };
type Capture = Target & { rangeThumb: "lower" | "upper" | null; interaction: "press" | "drag" | "edit"; x: number; y: number; startX: number; startY: number; selectionAnchor?: number };

/** SceneLayer control capture plus an invisible native editor for IME/mobile keyboards. */
export class UIControls2DInput {
  private readonly captures = new Map<number, Capture>();
  private readonly ignoredPointers = new Set<number>();
  private focused: Target | null = null;
  private editor: HTMLInputElement | null = null;
  private composing = false;
  private editorValue = "";
  private removeSelectionListener: (() => void) | null = null;
  private synchronizingFocus = false;
  private readonly layers: () => readonly SceneLayerView[];
  private readonly size: () => { width: number; height: number };
  private readonly emit: (event: SceneLayerControlEvent) => void;
  private readonly canvas?: HTMLCanvasElement;
  private readonly navigate?: (reverse: boolean) => void;

  constructor(
    layers: () => readonly SceneLayerView[],
    size: () => { width: number; height: number },
    emit: (event: SceneLayerControlEvent) => void,
    canvas?: HTMLCanvasElement,
    navigate?: (reverse: boolean) => void,
  ) { this.layers = layers; this.size = size; this.emit = emit; this.canvas = canvas; this.navigate = navigate; }

  /** The native text editor is part of the game surface; focusing it is not leaving the canvas. */
  ownsElement(element: EventTarget | null): boolean { return element !== null && element === this.editor; }

  owns(pointerId: number): boolean { return this.captures.has(pointerId) || this.ignoredPointers.has(pointerId); }

  /** Press controls yield touch drags to a containing scroll view; value drags and text selection keep ownership. */
  allowsScroll(pointerId: number): boolean { return this.captures.get(pointerId)?.interaction === "press"; }

  cancelForScroll(pointerId: number): boolean {
    const capture = this.captures.get(pointerId);
    if (!capture || capture.interaction !== "press") return false;
    if (!capture.visual.mesh.isDisposed()) capture.visual.setExpanded(false);
    return this.release(pointerId, true);
  }

  private usable(target: Target): boolean {
    const { mesh, properties } = target.visual;
    return properties.enabled && !mesh.isDisposed() && mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0
      && properties.opacity * properties.tint[3] > 0 && this.layers().includes(target.layer);
  }

  private local(target: Target, x: number, y: number): Vector3 | null {
    const size = this.size();
    const matrix = target.visual.mesh.computeWorldMatrix(true);
    if (Math.abs(matrix.determinant()) < 1e-12) return null;
    const world = new Vector3((x / Math.max(1, size.width) - 0.5) * target.layer.layerBounds.width,
      (0.5 - y / Math.max(1, size.height)) * target.layer.layerBounds.height, matrix.getTranslation().z);
    return Vector3.TransformCoordinates(world, Matrix.Invert(matrix));
  }

  private event(target: Target, action: SceneLayerControlEvent["action"], value?: SceneLayerControlEvent["value"], secondaryValue?: number): void {
    this.emit({ layerId: target.layer.layerId, actorGuid: target.actorGuid, componentId: target.componentId, action,
      ...(value !== undefined ? { value } : {}), ...(secondaryValue !== undefined ? { secondaryValue } : {}) });
  }

  private value(target: Target): { value: number | boolean | string; secondaryValue?: number } {
    const p = target.visual.properties;
    switch (target.visual.classId) {
      case "2DCheckboxComponent": case "2DRadioButtonComponent": case "2DToggleComponent": return { value: p.checked };
      case "2DTextInputComponent": return { value: p.text };
      case "2DDropdownComponent": return { value: p.selectedIndex };
      case "2DRangeSliderComponent": return { value: p.lowerValue, secondaryValue: p.upperValue };
      default: return { value: p.value };
    }
  }

  private change(target: Target, value: number | boolean | string, secondaryValue?: number): void {
    if (target.visual.properties.readOnly) return;
    const before = this.value(target);
    if (before.value === value && before.secondaryValue === secondaryValue) return;
    const p = { ...target.visual.properties };
    switch (target.visual.classId) {
      case "2DCheckboxComponent": case "2DRadioButtonComponent": case "2DToggleComponent": p.checked = value === true; break;
      case "2DTextInputComponent": p.text = String(value); break;
      case "2DDropdownComponent": p.selectedIndex = Number(value); break;
      case "2DRangeSliderComponent": p.lowerValue = Number(value); p.upperValue = secondaryValue ?? p.upperValue; break;
      default: p.value = Number(value);
    }
    target.visual.update({ classId: target.visual.classId, properties: p });
    this.event(target, "change", value, secondaryValue);
  }

  private commit(target: Target): void { const value = this.value(target); this.event(target, "commit", value.value, value.secondaryValue); }

  down(pointerId: number, hits: readonly OverlayPointerHit[], x: number, y: number): boolean {
    if (this.owns(pointerId)) return true;
    for (const hit of hits) {
      if (!hit.controlMeshName || !hit.componentId) continue;
      const layer = this.layers().find(entry => entry.layerId === hit.layerId);
      const mesh = layer?.scene.getMeshByName(hit.controlMeshName);
      const visual = mesh && uiControl2DMesh(mesh);
      if (!layer || !visual) continue;
      const target = { visual, layer, actorGuid: hit.actorGuid, componentId: hit.componentId };
      if (!this.usable(target)) continue;
      if ([...this.captures.values()].some(capture => capture.visual === visual)) {
        this.ignoredPointers.add(pointerId); return true;
      }
      this.focus(target);
      if (!this.usable(target)) return true;
      const local = this.local(target, x, y);
      if (!local) return true;
      const p = visual.properties;
      const sampled = uiControl2DValueAt(local.x, local.y, p);
      // Coincident handles have no nearest thumb. Leave an exact hit undecided
      // until movement establishes which side of the interval should expand.
      const rangeThumb = p.lowerValue === p.upperValue
        ? sampled > p.upperValue ? "upper" : sampled < p.lowerValue ? "lower" : null
        : Math.abs(sampled - p.lowerValue) <= Math.abs(sampled - p.upperValue) ? "lower" : "upper";
      const drag = visual.classId === "2DSliderComponent" || visual.classId === "2DRangeSliderComponent";
      const edit = visual.classId === "2DTextInputComponent" || (visual.classId === "2DNumericInputComponent" && local.x < p.width * 0.3);
      const capture: Capture = { ...target, rangeThumb, interaction: p.readOnly ? "press" : drag ? "drag" : edit ? "edit" : "press", x, y, startX: x, startY: y };
      this.captures.set(pointerId, capture);
      if (drag) this.move(pointerId, x, y);
      if (edit) {
        this.openEditor(target);
        if (this.editor) {
          capture.selectionAnchor = visual.textOffsetAt(local.x, local.y);
          this.editor.setSelectionRange(capture.selectionAnchor, capture.selectionAnchor);
          this.updateEditing(target);
        }
      }
      return true;
    }
    this.focus(null);
    return false;
  }

  move(pointerId: number, x: number, y: number): boolean {
    if (this.ignoredPointers.has(pointerId)) return true;
    const capture = this.captures.get(pointerId);
    if (!capture) return false;
    if (!this.usable(capture)) { this.release(pointerId, true); return true; }
    capture.x = x; capture.y = y;
    const local = this.local(capture, x, y);
    if (!local) { this.release(pointerId, true); return true; }
    const p = capture.visual.properties;
    if (this.editor && this.focused?.visual === capture.visual && capture.selectionAnchor !== undefined) {
      const offset = capture.visual.textOffsetAt(local.x, local.y);
      this.editor.setSelectionRange(Math.min(offset, capture.selectionAnchor), Math.max(offset, capture.selectionAnchor), offset < capture.selectionAnchor ? "backward" : "forward");
      this.updateEditing(capture);
      return true;
    }
    const value = uiControl2DValueAt(local.x, local.y, p);
    if (capture.visual.classId === "2DSliderComponent") this.change(capture, value);
    else if (capture.visual.classId === "2DRangeSliderComponent") {
      if (capture.rangeThumb === null) {
        if (value === p.lowerValue) return true;
        capture.rangeThumb = value > p.upperValue ? "upper" : "lower";
      }
      this.change(capture, capture.rangeThumb === "lower" ? Math.min(value, p.upperValue) : p.lowerValue,
        capture.rangeThumb === "upper" ? Math.max(value, p.lowerValue) : p.upperValue);
    }
    return true;
  }

  release(pointerId: number, cancelled = false, x?: number, y?: number): boolean {
    if (this.ignoredPointers.delete(pointerId)) return true;
    const capture = this.captures.get(pointerId);
    if (!capture) return false;
    this.captures.delete(pointerId);
    if (cancelled || !this.usable(capture)) return true;
    const { visual } = capture;
    const p = visual.properties;
    const local = this.local(capture, x ?? capture.x, y ?? capture.y);
    if (!local) return true;
    if (visual.classId === "2DSliderComponent" || visual.classId === "2DRangeSliderComponent") { this.commit(capture); return true; }
    const inside = (Math.abs(local.x) <= p.width / 2 && Math.abs(local.y) <= p.height / 2)
      || Math.hypot((x ?? capture.x) - capture.startX, (y ?? capture.y) - capture.startY) < 8;
    if (visual.classId === "2DDropdownComponent" && visual.expanded && Math.abs(local.x) <= p.width / 2 && local.y < -p.height / 2) {
      const index = Math.floor((-local.y - p.height / 2) / p.height);
      if (index >= 0 && index < p.options.length) { this.change(capture, index); this.commit(capture); visual.setExpanded(false); }
    } else if (inside) {
      if (visual.classId === "2DCheckboxComponent" || visual.classId === "2DToggleComponent" || visual.classId === "2DRadioButtonComponent") {
        this.change(capture, visual.classId === "2DRadioButtonComponent" ? true : !p.checked); this.commit(capture);
      } else if (visual.classId === "2DDropdownComponent") visual.setExpanded(!visual.expanded);
      else if (visual.classId === "2DNumericInputComponent" && local.x >= p.width * 0.3 && !p.readOnly) {
        this.change(capture, clampUIControl2DValue(p.value + (local.y >= 0 ? 1 : -1) * (p.step || 1), p)); this.commit(capture);
      }
    }
    return true;
  }

  private focus(target: Target | null): void {
    if (this.focused?.visual === target?.visual) return;
    this.closeEditor(true);
    if (this.focused) {
      if (!this.focused.visual.mesh.isDisposed()) {
        this.focused.visual.setExpanded(false); this.focused.visual.setFocused(false);
      }
      this.event(this.focused, "blur");
    }
    this.focused = target;
    if (target) { target.visual.setFocused(true); this.event(target, "focus"); this.canvas?.focus({ preventScroll: true }); }
  }

  /** Graph/gamepad focus is authoritative and must not echo another focus event. */
  syncFocus(mesh: Mesh, focused: boolean, beginEditing = false): void {
    if (this.synchronizingFocus) return;
    const visual = uiControl2DMesh(mesh);
    const layer = this.layers().find(entry => entry.scene === mesh.getScene());
    if (!visual || !layer) return;
    if (focused === (this.focused?.visual === visual)) {
      if (focused && beginEditing && this.focused && ["2DTextInputComponent", "2DNumericInputComponent"].includes(visual.classId)) this.openEditor(this.focused);
      return;
    }
    if (!focused && this.focused?.visual !== visual) return;
    this.synchronizingFocus = true;
    try {
      this.closeEditor(true);
      if (this.focused && !this.focused.visual.mesh.isDisposed()) {
        this.focused.visual.setExpanded(false); this.focused.visual.setFocused(false);
      }
      this.focused = focused ? { visual, layer, actorGuid: String(mesh.metadata?.overlayActorGuid ?? ""), componentId: String(mesh.metadata?.overlayControlComponentId ?? "") } : null;
      visual.setFocused(focused);
      if (focused && beginEditing && this.focused && ["2DTextInputComponent", "2DNumericInputComponent"].includes(visual.classId)) this.openEditor(this.focused);
    } finally { this.synchronizingFocus = false; }
  }

  keyDown(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault" | "stopPropagation">): boolean {
    if (event.key === "Tab") {
      if (!this.navigate) return false;
      this.closeEditor(true);
      if (this.focused && !this.focused.visual.mesh.isDisposed()) {
        this.focused.visual.setExpanded(false); this.focused.visual.setFocused(false);
      }
      // Keep the simulation's current candidate for ordered navigation, while
      // withholding local edits until its authoritative focus response arrives.
      this.focused = null;
      this.canvas?.focus({ preventScroll: true });
      this.navigate(event.shiftKey);
    } else {
      const target = this.focused;
      if (!target || !this.usable(target)) return false;
      const { visual } = target; const p = visual.properties;
      if (event.key === "Escape") { this.closeEditor(false); visual.setExpanded(false); }
      else if (this.editor) return false;
      else if (event.key === " " || event.key === "Enter") {
        if (["2DCheckboxComponent", "2DToggleComponent", "2DRadioButtonComponent"].includes(visual.classId)) {
          this.change(target, visual.classId === "2DRadioButtonComponent" ? true : !p.checked); this.commit(target);
        } else if (visual.classId === "2DDropdownComponent") visual.setExpanded(!visual.expanded);
        else if (["2DTextInputComponent", "2DNumericInputComponent"].includes(visual.classId)) this.openEditor(target);
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
        if (visual.classId === "2DDropdownComponent") {
          const index = event.key === "Home" ? 0 : event.key === "End" ? p.options.length - 1 : p.selectedIndex + (event.key === "ArrowUp" ? -1 : 1);
          this.change(target, Math.max(-1, Math.min(p.options.length - 1, index))); this.commit(target);
        } else if (["2DSliderComponent", "2DRangeSliderComponent", "2DNumericInputComponent"].includes(visual.classId) && !p.readOnly) {
          const range = visual.classId === "2DRangeSliderComponent";
          const value = range ? event.shiftKey ? p.upperValue : p.lowerValue : p.value;
          const next = event.key === "Home" ? p.min : event.key === "End" ? p.max : clampUIControl2DValue(value + direction * (p.step || (p.max - p.min) / 100), p);
          this.change(target, range ? event.shiftKey ? p.lowerValue : Math.min(next, p.upperValue) : next,
            range ? event.shiftKey ? Math.max(next, p.lowerValue) : p.upperValue : undefined);
          this.commit(target);
        } else return false;
      } else return false;
    }
    event.preventDefault(); event.stopPropagation(); return true;
  }

  private openEditor(target: Target): void {
    if (!this.canvas || this.editor || target.visual.properties.readOnly) return;
    const doc = this.canvas.ownerDocument;
    const input = doc.createElement("input");
    input.type = "text";
    input.inputMode = target.visual.classId === "2DNumericInputComponent" ? "decimal" : "text";
    input.value = String(this.value(target).value);
    input.dataset.testid = "scene-layer-native-input";
    input.setAttribute("aria-label", target.visual.properties.placeholder || (input.inputMode === "decimal" ? "Numeric Input" : "Text Input"));
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText = "position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;font-size:16px;border:0;padding:0;";
    const rect = this.canvas.getBoundingClientRect();
    input.style.left = `${rect.left}px`; input.style.top = `${rect.top}px`;
    this.editor = input; this.editorValue = input.value;
    input.addEventListener("compositionstart", () => { this.composing = true; });
    input.addEventListener("compositionend", () => { this.composing = false; this.edit(target); this.updateEditing(target); });
    input.addEventListener("input", () => { if (!this.composing) this.edit(target); this.updateEditing(target); });
    input.addEventListener("select", () => this.updateEditing(target));
    input.addEventListener("keyup", () => this.updateEditing(target));
    const onSelection = () => { if (doc.activeElement === input) this.updateEditing(target); };
    doc.addEventListener("selectionchange", onSelection);
    this.removeSelectionListener = () => doc.removeEventListener("selectionchange", onSelection);
    input.addEventListener("keydown", event => {
      event.stopPropagation();
      if (this.composing || event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); this.closeEditor(true); this.canvas?.focus({ preventScroll: true }); }
      else if (event.key === "Escape") { event.preventDefault(); this.closeEditor(false); this.canvas?.focus({ preventScroll: true }); }
      else if (event.key === "Tab") this.keyDown(event);
    });
    input.addEventListener("blur", () => { if (this.editor === input) this.focus(null); });
    doc.body.append(input);
    input.focus({ preventScroll: true });
    input.select();
    this.updateEditing(target);
  }

  private updateEditing(target: Target): void {
    if (!this.editor || !this.usable(target)) return;
    target.visual.setEditing(this.editor.value, this.editor.selectionStart ?? 0, this.editor.selectionEnd ?? 0);
  }

  private edit(target: Target): void {
    if (!this.editor || !this.usable(target)) return;
    if (target.visual.classId === "2DTextInputComponent") {
      const text = normalizeUIControl2DText(this.editor.value, target.visual.properties);
      if (text !== this.editor.value) this.editor.value = text;
      this.change(target, text);
    }
  }

  private closeEditor(commit: boolean): void {
    const input = this.editor; const target = this.focused;
    if (!input) return;
    this.editor = null; this.composing = false;
    this.removeSelectionListener?.(); this.removeSelectionListener = null;
    if (target && this.usable(target)) {
      const text = commit ? input.value : this.editorValue;
      if (target.visual.classId === "2DNumericInputComponent") {
        const value = Number(text);
        if (text.trim() && Number.isFinite(value)) this.change(target, clampUIControl2DValue(value, target.visual.properties));
      } else this.change(target, normalizeUIControl2DText(text, target.visual.properties));
      if (commit) this.commit(target);
    }
    if (target && !target.visual.mesh.isDisposed()) target.visual.setEditing(null);
    input.remove();
  }

  refresh(): void {
    for (const [id, target] of this.captures) if (!this.usable(target)) this.release(id, true);
    if (this.focused && !this.usable(this.focused)) this.focus(null);
  }

  reset(): void {
    for (const id of this.captures.keys()) this.release(id, true);
    this.ignoredPointers.clear(); this.closeEditor(false); this.focus(null);
  }
}
