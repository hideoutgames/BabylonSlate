import { Matrix, Vector3 } from "@babylonjs/core";
import { clampUIControl2DValue, normalizeUIControl2DText, uiControl2DValueAt, type OverlayPointerHit } from "@babylonslate/core";
import { uiControl2DMesh, type UIControl2DMesh } from "./ui-controls2d-mesh";
import type { SceneLayerView } from "./scene-layer-compositor";

export type SceneLayerControlEvent = {
  layerId: string; actorGuid: string; componentId: string;
  action: "change" | "commit" | "focus" | "blur" | "activate";
  value?: number | boolean | string; secondaryValue?: number;
};
type Target = { visual: UIControl2DMesh; layer: SceneLayerView; actorGuid: string; componentId: string };
type Capture = Target & { rangeThumb: "lower" | "upper"; x: number; y: number };

/** SceneLayer control capture plus an invisible native editor for IME/mobile keyboards. */
export class UIControls2DInput {
  private readonly captures = new Map<number, Capture>();
  private readonly ignoredPointers = new Set<number>();
  private focused: Target | null = null;
  private editor: HTMLInputElement | null = null;
  private composing = false;
  private editorValue = "";

  constructor(
    private readonly layers: () => readonly SceneLayerView[],
    private readonly size: () => { width: number; height: number },
    private readonly emit: (event: SceneLayerControlEvent) => void,
    private readonly canvas?: HTMLCanvasElement,
  ) {}

  owns(pointerId: number): boolean { return this.captures.has(pointerId) || this.ignoredPointers.has(pointerId); }

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
      const local = this.local(target, x, y);
      if (!local) return true;
      const p = visual.properties;
      const sampled = uiControl2DValueAt(local.x, local.y, p);
      const rangeThumb = Math.abs(sampled - p.lowerValue) <= Math.abs(sampled - p.upperValue) ? "lower" : "upper";
      this.captures.set(pointerId, { ...target, rangeThumb, x, y });
      if (visual.classId === "2DSliderComponent" || visual.classId === "2DRangeSliderComponent") this.move(pointerId, x, y);
      if (visual.classId === "2DTextInputComponent" || (visual.classId === "2DNumericInputComponent" && local.x < p.width * 0.3)) this.openEditor(target);
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
    const value = uiControl2DValueAt(local.x, local.y, p);
    if (capture.visual.classId === "2DSliderComponent") this.change(capture, value);
    else if (capture.visual.classId === "2DRangeSliderComponent") {
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
    const inside = Math.abs(local.x) <= p.width / 2 && Math.abs(local.y) <= p.height / 2;
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

  keyDown(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault" | "stopPropagation">): boolean {
    if (event.key === "Tab") {
      const targets: Target[] = [];
      for (const layer of this.layers()) for (const mesh of layer.scene.meshes) {
        const visual = uiControl2DMesh(mesh);
        const actorGuid = mesh.metadata?.overlayActorGuid;
        const componentId = mesh.metadata?.overlayControlComponentId;
        if (!visual || !actorGuid || !componentId || visual.classId === "2DProgressBarComponent") continue;
        const target = { visual, layer, actorGuid: String(actorGuid), componentId: String(componentId) };
        if (this.usable(target)) targets.push(target);
      }
      if (!targets.length) return false;
      const index = targets.findIndex(target => target.visual === this.focused?.visual);
      this.focus(targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length]!);
      if (this.focused && ["2DTextInputComponent", "2DNumericInputComponent"].includes(this.focused.visual.classId)) this.openEditor(this.focused);
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
    input.addEventListener("compositionend", () => { this.composing = false; this.edit(target); });
    input.addEventListener("input", () => { if (!this.composing) this.edit(target); });
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
    if (target && this.usable(target)) {
      const text = commit ? input.value : this.editorValue;
      if (target.visual.classId === "2DNumericInputComponent") {
        const value = Number(text);
        if (text.trim() && Number.isFinite(value)) this.change(target, clampUIControl2DValue(value, target.visual.properties));
      } else this.change(target, normalizeUIControl2DText(text, target.visual.properties));
      if (commit) this.commit(target);
    }
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
