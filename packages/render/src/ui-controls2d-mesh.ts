import { Color3, MeshBuilder, VertexData, type AbstractMesh, type Mesh, type Scene, type StandardMaterial } from "@babylonjs/core";
import { parseUIControl2DProperties, uiControl2DFraction, type UIControl2DProperties } from "@babylonslate/core";
import { applyAlbedoTexture, restoreAlbedoMaterial, type MeshAssetContext } from "./mesh-assets";
import { createOverlayUnlitMaterial } from "./overlay-texture-quad";
import { applyOverlayVisualStyle, enableOverlayVisualMaterial } from "./overlay-visual-style";
import { createText2DMesh, text2DMeshLayout } from "./text2d-mesh";
import { VisualBundle } from "./visual-bundle";

type Surface = { mesh: Mesh; role: "background" | "track" | "fill" | "thumb" | "indicator"; fallback: StandardMaterial };
export type UIControl2DSource = { classId: string; properties: Record<string, unknown> | UIControl2DProperties };
export interface UIControl2DMesh {
  mesh: Mesh;
  classId: string;
  properties: UIControl2DProperties;
  surfaces: Surface[];
  expanded: boolean;
  focused: boolean;
  update(source: UIControl2DSource): void;
  setExpanded(expanded: boolean): void;
  setFocused(focused: boolean): void;
  setEditing(text: string | null, start?: number, end?: number): void;
  textOffsetAt(x: number, y: number): number;
}

const controls = new WeakMap<AbstractMesh, UIControl2DMesh>();
export function uiControl2DMesh(mesh: AbstractMesh): UIControl2DMesh | undefined { return controls.get(mesh); }

/** Authored materials are borrowed. Texture bindings retain and release their own leases. */
export function refreshUIControl2DMaterials(root: Mesh, assets?: MeshAssetContext): void {
  for (const mesh of [root, ...root.getChildMeshes()]) {
    const visual = controls.get(mesh);
    if (!visual) continue;
    for (const surface of visual.surfaces) {
      const materialGuid = visual.properties[`${surface.role}MaterialGuid`];
      const textureGuid = visual.properties[`${surface.role}TextureGuid`];
      const material = materialGuid ? assets?.resolveMaterial?.(materialGuid, { scene: mesh.getScene(), unlit: true }) : null;
      if (textureGuid && !materialGuid) {
        if (!restoreAlbedoMaterial(surface.mesh)) surface.mesh.material = surface.fallback;
        applyAlbedoTexture(surface.mesh, mesh.getScene(), textureGuid, assets, { alwaysBlend: true });
      } else {
        applyAlbedoTexture(surface.mesh, mesh.getScene(), null, assets);
        surface.mesh.material = surface.fallback;
      }
      if (material) surface.mesh.material = material;
      enableOverlayVisualMaterial(surface.mesh);
      if (surface.role === "background") {
        for (const child of mesh.getChildMeshes()) if (child.metadata?.uiControl2DOption) child.material = surface.mesh.material;
      }
    }
  }
}

/** Native SceneLayer surfaces and Text2D glyphs, shared by authoring and Play. */
export function createUIControl2DMesh(scene: Scene, name: string, source: UIControl2DSource, assets?: MeshAssetContext, componentId?: string): Mesh {
  const bundle = new VisualBundle();
  const surfaces: Surface[] = [];
  const labels = new Map<string, { mesh: Mesh; key: string }>();
  const surface = (role: Surface["role"], suffix: string, color: string): Mesh => {
    const mesh = bundle.ownRenderUser(MeshBuilder.CreatePlane(suffix, { size: 1 }, scene));
    const fallback = createOverlayUnlitMaterial(scene, suffix, bundle);
    fallback.emissiveColor = Color3.FromHexString(color);
    mesh.material = fallback;
    mesh.isPickable = false;
    mesh.alphaIndex = surfaces.length;
    surfaces.push({ mesh, role, fallback });
    return mesh;
  };
  try {
    const mesh = surface("background", name, "#272b35");
    const background = surfaces[0]!;
    const track = surface("track", `${name}:track`, "#525968");
    const fill = surface("fill", `${name}:fill`, "#539ce3");
    const thumb = surface("thumb", `${name}:thumb`, "#eeeeee");
    const upperThumb = surface("thumb", `${name}:upper-thumb`, "#eeeeee");
    const indicator = surface("indicator", `${name}:indicator`, "#539ce3");
    const caret = surface("indicator", `${name}:caret`, "#eeeeee");
    const selection = surface("indicator", `${name}:selection`, "#539ce3");
    surfaces.find(entry => entry.mesh === selection)!.fallback.alpha = 0.4;
    for (const [index, child] of [track, fill, thumb, upperThumb, indicator, caret, selection].entries()) {
      child.parent = mesh;
      child.position.z = -0.002 * (index + 1);
      child.metadata = { uiControl2DDecoration: true };
    }
    // Keep the parent at unit scale: component transforms and authored layout
    // apply to it, while vertex dimensions provide its intrinsic hit rectangle.
    let dimensions = "";
    let editingText: string | null = null;
    let selectionStart = 0;
    let selectionEnd = 0;
    let menu: Mesh[] = [];
    let menuKey = "";
    const label = (id: string, text: string, width: number, height: number, x = 0, y = 0, singleLine = false) => {
      const p = visual.properties;
      const key = JSON.stringify([text, width, height, p.fontSize, p.textColor, singleLine]);
      let entry = labels.get(id);
      if (entry?.key !== key) {
        entry?.mesh.dispose();
        const ppu = assets?.pixelsPerUnit ?? 100;
        const next = createText2DMesh(scene, `${name}:${id}`, {
          text, renderer: "bitmap", size: p.fontSize * ppu, color: Color3.FromHexString(p.textColor).asArray(),
          alignment: "center", verticalAlignment: "center", wrapWidth: singleLine ? 0 : width * ppu, wrapHeight: height * ppu, hitTest: "ignore",
        }, assets);
        next.parent = mesh;
        for (const child of [next, ...next.getChildMeshes()]) {
          child.isPickable = false;
          child.metadata = { ...child.metadata, uiControl2DDecoration: true };
          child.alphaIndex = 20;
        }
        entry = { mesh: next, key };
        labels.set(id, entry);
      }
      entry.mesh.position.set(x, y, -0.02);
      const measured = text2DMeshLayout(entry.mesh);
      entry.mesh.scaling.setAll(singleLine && measured && measured.width > width ? width / measured.width : 1);
      entry.mesh.setEnabled(true);
      applyOverlayVisualStyle(entry.mesh, p);
    };
    const place = (part: Mesh, width: number, height: number, x = 0, y = 0) => {
      part.setEnabled(width > 0 && height > 0);
      part.scaling.set(Math.max(width, 0.0001), Math.max(height, 0.0001), 1);
      part.position.x = x; part.position.y = y;
    };
    const render = () => {
      const p = visual.properties;
      const kind = visual.classId;
      const radio = kind === "2DRadioButtonComponent";
      const discBackground = radio && !p.backgroundMaterialGuid && !p.backgroundTextureGuid;
      const discIndicator = radio && !p.indicatorMaterialGuid && !p.indicatorTextureGuid;
      const shapeKey = `${p.width}:${p.height}:${discBackground}:${discIndicator}`;
      if (dimensions !== shapeKey) {
        const geometry = discBackground ? VertexData.CreateDisc({ radius: 0.5, tessellation: 48 }) : VertexData.CreatePlane({ size: 1 });
        if (geometry.positions) for (let index = 0; index < geometry.positions.length; index += 3) {
          geometry.positions[index] = geometry.positions[index]! * p.width;
          geometry.positions[index + 1] = geometry.positions[index + 1]! * p.height;
        }
        geometry.applyToMesh(mesh);
        (discIndicator ? VertexData.CreateDisc({ radius: 0.5, tessellation: 48 }) : VertexData.CreatePlane({ size: 1 })).applyToMesh(indicator);
        dimensions = shapeKey;
      }
      for (const part of [track, fill, thumb, upperThumb, indicator, caret, selection]) part.setEnabled(false);
      for (const entry of labels.values()) entry.mesh.setEnabled(false);
      const interactive = p.enabled && kind !== "2DProgressBarComponent";
      mesh.isPickable = interactive;
      mesh.metadata = { ...mesh.metadata, overlayControlMeshName: name, overlayControlComponentId: componentId,
        overlayHitTest: interactive ? "block" : "ignore", overlayHasButton: false };
      background.fallback.emissiveColor = Color3.FromHexString(visual.focused ? "#3a485d" : "#272b35");
      if (["2DSliderComponent", "2DRangeSliderComponent", "2DProgressBarComponent"].includes(kind)) {
        const vertical = p.orientation === "vertical";
        const length = vertical ? p.height : p.width;
        const cross = vertical ? p.width : p.height;
        const lower = kind === "2DRangeSliderComponent" ? uiControl2DFraction(p.lowerValue, p) : 0;
        const upper = uiControl2DFraction(kind === "2DRangeSliderComponent" ? p.upperValue : p.value, p);
        const along = (part: Mesh, size: number, thickness: number, offset = 0) => place(part, vertical ? thickness : size, vertical ? size : thickness, vertical ? 0 : offset, vertical ? offset : 0);
        along(track, length, cross * 0.24);
        along(fill, (upper - lower) * length, cross * 0.24, ((upper + lower) / 2 - 0.5) * length);
        if (kind !== "2DProgressBarComponent") {
          const thumbSize = Math.min(cross * 0.8, length * 0.1);
          along(thumb, thumbSize, cross * 0.8, ((kind === "2DRangeSliderComponent" ? lower : upper) - 0.5) * length);
          if (kind === "2DRangeSliderComponent") along(upperThumb, thumbSize, cross * 0.8, (upper - 0.5) * length);
        }
      } else if (kind === "2DCheckboxComponent" || kind === "2DRadioButtonComponent") {
        if (p.checked) place(indicator, p.width * 0.6, p.height * 0.6);
      } else if (kind === "2DToggleComponent") {
        place(track, p.width * 0.9, p.height * 0.7);
        if (p.checked) place(fill, p.width * 0.9, p.height * 0.7);
        place(thumb, p.height * 0.65, p.height * 0.65, (p.checked ? 1 : -1) * Math.max(0, p.width - p.height) * 0.4);
      } else if (kind === "2DTextInputComponent") {
        label("label", editingText ?? (p.text || p.placeholder), p.width * 0.94, p.height * 0.9, 0, 0, true);
      } else if (kind === "2DNumericInputComponent") {
        label("label", editingText ?? String(p.value), p.width * 0.78, p.height * 0.9, -p.width * 0.1, 0, true);
        label("increment", "+", p.width * 0.2, p.height * 0.45, p.width * 0.4, p.height * 0.25);
        label("decrement", "−", p.width * 0.2, p.height * 0.45, p.width * 0.4, -p.height * 0.25);
      } else if (kind === "2DDropdownComponent") {
        label("label", p.options[p.selectedIndex] ?? p.placeholder, p.width * 0.85, p.height * 0.9, -p.width * 0.05);
        if (p.indicatorMaterialGuid || p.indicatorTextureGuid) {
          const size = Math.min(p.width * 0.14, p.height * 0.7);
          place(indicator, size, size, p.width * 0.42);
        } else label("arrow", visual.expanded ? "−" : "+", p.width * 0.15, p.height * 0.8, p.width * 0.42);
      }
      if (visual.focused && editingText !== null) {
        const textMesh = labels.get("label")?.mesh;
        const items = textMesh && text2DMeshLayout(textMesh)?.items.filter(item => item.kind === "glyph");
        if (textMesh && items) {
          const startIndex = Array.from(editingText.slice(0, selectionStart)).length;
          const endIndex = Array.from(editingText.slice(0, selectionEnd)).length;
          const point = (index: number) => {
            const item = items[index]; const last = items.at(-1);
            return item ? item.x - item.width / 2 : last ? last.x + last.width / 2 : 0;
          };
          const start = point(startIndex) * textMesh.scaling.x + textMesh.position.x;
          const end = point(endIndex) * textMesh.scaling.x + textMesh.position.x;
          const height = Math.min(p.fontSize * 1.2, p.height * 0.85);
          if (selectionStart === selectionEnd) place(caret, Math.max(0.012, p.fontSize * 0.045), height, start);
          else place(selection, Math.max(0.001, end - start), height, (start + end) / 2);
          caret.position.z = -0.06; selection.position.z = -0.025;
          caret.alphaIndex = 24; selection.alphaIndex = 19;
        }
      }
      const nextMenuKey = visual.expanded ? JSON.stringify([p.options, p.width, p.height, p.fontSize, p.textColor]) : "";
      if (nextMenuKey !== menuKey) {
        for (const part of menu) part.dispose();
        menu = []; menuKey = nextMenuKey;
        if (visual.expanded && kind === "2DDropdownComponent") {
          p.options.forEach((option, index) => {
            const row = MeshBuilder.CreatePlane(`${name}:option:${index}`, { width: p.width, height: p.height }, scene);
            row.parent = mesh; row.material = background.fallback;
            row.position.set(0, -(index + 1) * p.height, -0.04);
            row.alphaIndex = 30;
            row.isPickable = interactive;
            row.metadata = { ...mesh.metadata, uiControl2DOption: true };
            applyOverlayVisualStyle(row, p);
            menu.push(row);
            label(`option-label:${index}`, option, p.width * 0.94, p.height * 0.9, 0, -(index + 1) * p.height);
            const text = labels.get(`option-label:${index}`)!.mesh;
            text.position.z = -0.05;
            for (const child of text.getChildMeshes()) child.alphaIndex = 31;
          });
        }
      } else if (visual.expanded) {
        p.options.forEach((_option, index) => labels.get(`option-label:${index}`)?.mesh.setEnabled(true));
      }
      for (const row of menu) {
        row.isPickable = interactive;
        row.metadata = { ...row.metadata, overlayHitTest: interactive ? "block" : "ignore" };
        applyOverlayVisualStyle(row, p);
      }
      applyOverlayVisualStyle(mesh, p);
      refreshUIControl2DMaterials(mesh, assets);
    };
    const visual: UIControl2DMesh = {
      mesh, classId: source.classId, properties: parseUIControl2DProperties(source.classId, source.properties), surfaces,
      expanded: false, focused: false,
      update(next) { visual.classId = next.classId; visual.properties = parseUIControl2DProperties(next.classId, next.properties); render(); },
      setExpanded(expanded) { if (visual.expanded !== expanded) { visual.expanded = expanded; render(); } },
      setFocused(focused) { if (visual.focused !== focused) { visual.focused = focused; render(); } },
      setEditing(text, start = 0, end = start) {
        if (editingText === text && selectionStart === start && selectionEnd === end) return;
        editingText = text; selectionStart = start; selectionEnd = end; render();
      },
      textOffsetAt(x, _y) {
        const entry = labels.get("label");
        const text = editingText ?? (visual.classId === "2DNumericInputComponent" ? String(visual.properties.value) : visual.properties.text);
        const items = entry && text2DMeshLayout(entry.mesh)?.items.filter(item => item.kind === "glyph");
        if (!entry || !items) return text.length;
        const local = (x - entry.mesh.position.x) / entry.mesh.scaling.x;
        const index = items.findIndex(item => local < item.x);
        return index < 0 ? text.length : Array.from(text).slice(0, index).join("").length;
      },
    };
    controls.set(mesh, visual);
    mesh.onDisposeObservable.addOnce(() => { controls.delete(mesh); for (const entry of labels.values()) entry.mesh.dispose(); bundle.dispose(); });
    render();
    return mesh;
  } catch (error) { bundle.dispose(); throw error; }
}
