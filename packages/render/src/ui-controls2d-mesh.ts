import { Color3, MeshBuilder, VertexData, type AbstractMesh, type Mesh, type Scene, type StandardMaterial } from "@babylonjs/core";
import { parseUIControl2DProperties, uiControl2DFraction, type UIControl2DProperties } from "@babylonslate/core";
import { applyAlbedoTexture, restoreAlbedoMaterial, type MeshAssetContext } from "./mesh-assets";
import { createOverlayUnlitMaterial } from "./overlay-texture-quad";
import { applyOverlayVisualStyle, enableOverlayVisualMaterial } from "./overlay-visual-style";
import { createText2DMesh } from "./text2d-mesh";
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
    for (const [index, child] of [track, fill, thumb, upperThumb, indicator].entries()) {
      child.parent = mesh;
      child.position.z = -0.002 * (index + 1);
      child.metadata = { uiControl2DDecoration: true };
    }
    // Keep the parent at unit scale: component transforms and authored layout
    // apply to it, while vertex dimensions provide its intrinsic hit rectangle.
    let dimensions = "";
    let menu: Mesh[] = [];
    let menuKey = "";
    const label = (id: string, text: string, width: number, height: number, x = 0, y = 0) => {
      const p = visual.properties;
      const key = JSON.stringify([text, width, height, p.fontSize, p.textColor]);
      let entry = labels.get(id);
      if (entry?.key !== key) {
        entry?.mesh.dispose();
        const ppu = assets?.pixelsPerUnit ?? 100;
        const next = createText2DMesh(scene, `${name}:${id}`, {
          text, renderer: "bitmap", size: p.fontSize * ppu, color: Color3.FromHexString(p.textColor).asArray(),
          alignment: "center", verticalAlignment: "center", wrapWidth: width * ppu, wrapHeight: height * ppu, hitTest: "ignore",
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
      if (dimensions !== `${p.width}:${p.height}`) {
        VertexData.CreatePlane({ width: p.width, height: p.height }).applyToMesh(mesh);
        dimensions = `${p.width}:${p.height}`;
      }
      for (const part of [track, fill, thumb, upperThumb, indicator]) part.setEnabled(false);
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
        label("label", p.text || p.placeholder, p.width * 0.94, p.height * 0.9);
      } else if (kind === "2DNumericInputComponent") {
        label("label", String(p.value), p.width * 0.78, p.height * 0.9, -p.width * 0.1);
        label("increment", "+", p.width * 0.2, p.height * 0.45, p.width * 0.4, p.height * 0.25);
        label("decrement", "−", p.width * 0.2, p.height * 0.45, p.width * 0.4, -p.height * 0.25);
      } else if (kind === "2DDropdownComponent") {
        label("label", p.options[p.selectedIndex] ?? p.placeholder, p.width * 0.85, p.height * 0.9, -p.width * 0.05);
        label("arrow", visual.expanded ? "−" : "+", p.width * 0.15, p.height * 0.8, p.width * 0.42);
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
    };
    controls.set(mesh, visual);
    mesh.onDisposeObservable.addOnce(() => { controls.delete(mesh); for (const entry of labels.values()) entry.mesh.dispose(); bundle.dispose(); });
    render();
    return mesh;
  } catch (error) { bundle.dispose(); throw error; }
}
