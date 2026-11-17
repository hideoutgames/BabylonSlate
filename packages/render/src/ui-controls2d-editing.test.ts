// @vitest-environment jsdom
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { createUIControl2DMesh, uiControl2DMesh } from "./ui-controls2d-mesh";
import { UIControls2DInput, type SceneLayerControlEvent } from "./ui-controls2d-input";
import { text2DMeshLayout } from "./text2d-mesh";
import { layerCanvas } from "./scene-layer-canvas-fixtures";

const dispose: Array<() => void> = [];
beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
afterEach(() => { for (const cleanup of dispose.splice(0).reverse()) cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function editing(classId = "2DTextInputComponent", navigate?: (reverse: boolean) => void, extra: Record<string, unknown> = {}) {
  const engine = new NullEngine({ renderWidth: 800, renderHeight: 450, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
  dispose.push(() => engine.dispose());
  const compositor = new SceneLayerCompositor({ engine });
  const layer = compositor.create({ type: "sceneLayerCreate", layerId: "controls", assetGuid: "controls", zOrder: 0, ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(32, 18) });
  const mesh = createUIControl2DMesh(layer.scene, "control", { classId, properties: { text: "ABCD", value: 12, max: 100, width: 4, height: 1, ...extra } }, undefined, "field");
  mesh.metadata = { ...mesh.metadata, overlayActorGuid: "actor" };
  const canvas = document.createElement("canvas"); canvas.tabIndex = 0; document.body.append(canvas);
  const events: SceneLayerControlEvent[] = [];
  const input = new UIControls2DInput(() => compositor.layers(), () => ({ width: 800, height: 450 }), event => events.push(event), canvas, navigate);
  dispose.push(() => input.reset());
  input.down(1, [{ layerId: "controls", actorGuid: "actor", componentId: "field", controlMeshName: "control", hitTest: "block" }], 400, 225);
  input.release(1);
  const native = document.querySelector<HTMLInputElement>("[data-testid=scene-layer-native-input]")!;
  const visual = uiControl2DMesh(mesh)!;
  const caret = layer.scene.getMeshByName("control:caret")!;
  const selection = layer.scene.getMeshByName("control:selection")!;
  const renderedText = () => text2DMeshLayout(layer.scene.getMeshByName("control:label") as typeof mesh)?.items.map(item => item.ch ?? "").join("");
  return { visual, native, caret, selection, input, events, renderedText };
}

it("shows caret and native selection changes, previews IME composition and publishes only committed text", () => {
  const { visual, native, caret, selection, events, renderedText, input } = editing();
  expect(caret.isEnabled()).toBe(true);
  native.setSelectionRange(0, 4);
  native.dispatchEvent(new Event("select"));
  expect(caret.isEnabled()).toBe(false);
  expect(selection.isEnabled()).toBe(true);
  expect(selection.scaling.x).toBeGreaterThan(0.4);
  native.setSelectionRange(4, 4);
  native.dispatchEvent(new Event("select"));
  const end = caret.position.x;
  native.setSelectionRange(0, 0);
  native.dispatchEvent(new Event("select"));
  expect(caret.position.x).toBeLessThan(end);
  expect(selection.isEnabled()).toBe(false);

  native.dispatchEvent(new CompositionEvent("compositionstart"));
  native.value = "日本語"; native.setSelectionRange(3, 3);
  native.dispatchEvent(new InputEvent("input", { isComposing: true }));
  expect(renderedText()).toBe("日本語");
  expect(visual.properties.text).toBe("ABCD");
  native.dispatchEvent(new CompositionEvent("compositionend"));
  expect(visual.properties.text).toBe("日本語");
  expect(events.filter(event => event.action === "change").map(event => event.value)).toEqual(["日本語"]);
  native.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(events.filter(event => event.action === "commit").at(-1)?.value).toBe("日本語");
  expect(document.querySelector("[data-testid=scene-layer-native-input]")).toBeNull();
  expect(caret.isEnabled()).toBe(false);
  input.reset();
});

it("shows a numeric editing draft and cancels it without publishing a value", () => {
  const { native, visual, renderedText, caret, events } = editing("2DNumericInputComponent");
  native.value = "42"; native.setSelectionRange(2, 2); native.dispatchEvent(new InputEvent("input"));
  expect(renderedText()).toBe("42");
  expect(visual.properties.value).toBe(12);
  expect(caret.isEnabled()).toBe(true);
  native.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(renderedText()).toBe("12");
  expect(events.some(event => event.action === "change")).toBe(false);
  expect(document.querySelector("[data-testid=scene-layer-native-input]")).toBeNull();
});

it("reopens a text editor only after authoritative Tab focus acknowledges an eligible input", () => {
  const requests: boolean[] = [];
  const { native, visual, input } = editing("2DTextInputComponent", reverse => requests.push(reverse));
  native.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  expect(requests).toEqual([false]);
  expect(document.querySelector("[data-testid=scene-layer-native-input]")).toBeNull();
  expect(visual.focused).toBe(false);
  input.syncFocus(visual.mesh, true, true);
  expect(document.querySelector<HTMLInputElement>("[data-testid=scene-layer-native-input]")?.value).toBe("ABCD");
  expect(visual.focused).toBe(true);
});

it.each(["2DTextInputComponent", "2DNumericInputComponent"])("retains pointer selection in %s instead of transferring it to scrolling", classId => {
  const { input, visual, native } = editing(classId);
  input.down(2, [{ layerId: "controls", actorGuid: "actor", componentId: "field", controlMeshName: "control", hitTest: "block" }], 375, 225);
  expect(input.allowsScroll(2)).toBe(false);
  expect(input.cancelForScroll(2)).toBe(false);
  input.move(2, 425, 225);
  expect(input.owns(2)).toBe(true);
  expect((native.selectionEnd ?? 0) - (native.selectionStart ?? 0)).toBeGreaterThan(0);
  expect(visual.focused).toBe(true);
  input.release(2);
});

it("writes a control's background colour only when focus changes it, and draws the selection at its own alpha", () => {
  const { visual } = editing();
  const background = visual.surfaces[0]!.fallback.binding;
  visual.setFocused(false);
  visual.update({ classId: visual.classId, properties: visual.properties });
  const resting = background.color;
  visual.update({ classId: visual.classId, properties: visual.properties });
  expect(background.color).toBe(resting);
  visual.setFocused(true);
  expect(background.color).not.toBe(resting);
  expect(background.color).not.toEqual(resting);
  visual.setFocused(false);
  expect(background.color).toBe(resting);
  const selection = visual.surfaces.find((surface) => surface.mesh.name.endsWith(":selection"))!;
  expect(selection.fallback.binding.alpha).toBe(0.4);
});

it.each([
  { inputType: "text", type: "text", inputMode: "text" },
  { inputType: "number", type: "text", inputMode: "decimal" },
  { inputType: "integer", type: "text", inputMode: "numeric" },
  { inputType: "email", type: "text", inputMode: "email" },
  { inputType: "password", type: "password", inputMode: "text" },
  { inputType: "url", type: "text", inputMode: "url" },
  { inputType: "phone", type: "text", inputMode: "tel" },
])("asks for the $inputType keyboard", ({ inputType, type, inputMode }) => {
  const { native } = editing("2DTextInputComponent", undefined, { text: "", inputType });
  expect(native.type).toBe(type);
  expect(native.inputMode).toBe(inputMode);
});

it("keeps only a Number's characters as the player types and hides a Password behind bullets", () => {
  const number = editing("2DTextInputComponent", undefined, { text: "", inputType: "number" });
  number.native.value = "-1a2,5.7-"; number.native.dispatchEvent(new InputEvent("input"));
  // The field itself is corrected, so the caret and the next key act on what is kept.
  expect(number.native.value).toBe("-12.57");
  expect(number.visual.properties.text).toBe("-12.57");
  expect(number.renderedText()).toBe("-12.57");
  document.body.replaceChildren();

  const password = editing("2DTextInputComponent", undefined, { text: "ab", inputType: "password", placeholder: "Secret" });
  expect(password.renderedText()).toBe("\u2022\u2022");
  password.native.value = "ab c\u{1F642}"; password.native.dispatchEvent(new InputEvent("input"));
  // One bullet per character, spaces and emoji included; the stored text is what was typed.
  expect(password.renderedText()).toBe("\u2022\u2022\u2022\u2022\u2022");
  expect(password.visual.properties.text).toBe("ab c\u{1F642}");
  password.native.value = ""; password.native.dispatchEvent(new InputEvent("input"));
  expect(password.renderedText()).toBe("");
  password.native.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  // Empty and no longer being edited: the placeholder shows as written, not as bullets.
  expect(password.renderedText()).toBe("Secret");
});

