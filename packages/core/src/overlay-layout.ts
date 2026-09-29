import { identitySerializedTransform, type SerializedActor, type SerializedComponent, type SerializedTransform } from "./scene";
import { parsePainter2DProperties } from "./painter2d";
import { parseText2DProperties } from "./text2d";
import { parseRichText } from "./rich-text";

export const OVERLAY_LAYOUT_CLASSES = ["2DScrollBoxComponent", "2DVerticalBoxComponent", "2DHorizontalBoxComponent", "2DOverlayBoxComponent", "2DPaddingComponent", "2DSpacerComponent"] as const;
export function isOverlayLayoutClass(classId: string): boolean { return (OVERLAY_LAYOUT_CLASSES as readonly string[]).includes(classId); }
export type OverlayLayoutRect = { x: number; y: number; width: number; height: number };
export type OverlayLayoutMode = "fixed" | "content" | "fill";
export type OverlayLayoutProperties = {
  width: number; height: number; widthMode: OverlayLayoutMode; heightMode: OverlayLayoutMode; fillWeight: number;
  gap: number; horizontalAlignment: "start" | "center" | "end" | "stretch"; verticalAlignment: "start" | "center" | "end" | "stretch";
  paddingLeft: number; paddingRight: number; paddingTop: number; paddingBottom: number;
  scrollX: number; scrollY: number; scrollAxis: "vertical" | "horizontal" | "both";
};
const finite = (v: unknown, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const positive = (v: unknown, fallback = 0) => Math.max(0, finite(v, fallback));
const mode = (v: unknown, fallback: OverlayLayoutMode): OverlayLayoutMode => v === "fixed" || v === "fill" || v === "content" ? v : fallback;
const alignment = (v: unknown): OverlayLayoutProperties["horizontalAlignment"] => v === "center" || v === "end" || v === "stretch" ? v : "start";
export function parseOverlayLayoutProperties(value: Record<string, unknown> = {}, classId = "2DOverlayBoxComponent"): OverlayLayoutProperties {
  const spacer = classId === "2DSpacerComponent";
  const box = isOverlayLayoutClass(classId) && classId !== "2DPaddingComponent" && !spacer;
  return {
    width: positive(value.width, box ? 4 : 1), height: positive(value.height, box ? 4 : 1),
    widthMode: mode(value.widthMode, spacer ? "fill" : box ? "fixed" : "content"),
    heightMode: mode(value.heightMode, spacer ? "fill" : box ? "fixed" : "content"), fillWeight: positive(value.fillWeight, 1),
    gap: positive(value.gap), horizontalAlignment: alignment(value.horizontalAlignment), verticalAlignment: alignment(value.verticalAlignment),
    paddingLeft: positive(value.paddingLeft), paddingRight: positive(value.paddingRight), paddingTop: positive(value.paddingTop), paddingBottom: positive(value.paddingBottom),
    scrollX: positive(value.scrollX), scrollY: positive(value.scrollY), scrollAxis: value.scrollAxis === "horizontal" || value.scrollAxis === "both" ? value.scrollAxis : "vertical",
  };
}
export type OverlayLayoutEntry = {
  actorId: string; componentId?: string; rect: OverlayLayoutRect; clip: OverlayLayoutRect | null;
  /** False when this element or an actor/component ancestor is hidden or disabled. */
  interactive?: boolean;
  scrollAncestors: string[]; scroll?: { x: number; y: number; maxX: number; maxY: number; axis: OverlayLayoutProperties["scrollAxis"]; viewport: OverlayLayoutRect; scaleX: number; scaleY: number };
};
export type OverlayLayoutResult = { actors: SerializedActor[]; entries: Map<string, OverlayLayoutEntry> };
export type OverlayLayoutOptions = { pixelsPerUnit?: number; textureSize?: (guid: string) => { width: number; height: number } | undefined; /** Measure authored bounds even without layout components. */ includeUnmanagedBounds?: boolean };
export const overlayLayoutKey = (actorId: string, componentId?: string): string => componentId ? `${actorId}/${componentId}` : actorId;
export function intersectOverlayRects(a: OverlayLayoutRect | null, b: OverlayLayoutRect): OverlayLayoutRect {
  if (!a) return { ...b };
  const left = Math.max(a.x - a.width / 2, b.x - b.width / 2), right = Math.min(a.x + a.width / 2, b.x + b.width / 2);
  const bottom = Math.max(a.y - a.height / 2, b.y - b.height / 2), top = Math.min(a.y + a.height / 2, b.y + b.height / 2);
  return { x: (left + right) / 2, y: (bottom + top) / 2, width: Math.max(0, right - left), height: Math.max(0, top - bottom) };
}
export function overlayRectContains(rect: OverlayLayoutRect, x: number, y: number): boolean {
  return rect.width > 0 && rect.height > 0 && Math.abs(x - rect.x) <= rect.width / 2 && Math.abs(y - rect.y) <= rect.height / 2;
}
type Pose = { x: number; y: number; angle: number; sx: number; sy: number };
const origin: Pose = { x: 0, y: 0, angle: 0, sx: 1, sy: 1 };
function pose(t: SerializedTransform): Pose {
  const [x, y, z, w] = t.rotation;
  return { x: t.position[0], y: t.position[1], sx: t.scale[0], sy: t.scale[1], angle: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) };
}
function compose(a: Pose, b: Pose): Pose {
  const c = Math.cos(a.angle), s = Math.sin(a.angle);
  return { x: a.x + c * b.x * a.sx - s * b.y * a.sy, y: a.y + s * b.x * a.sx + c * b.y * a.sy, angle: a.angle + b.angle, sx: a.sx * b.sx, sy: a.sy * b.sy };
}
function relative(a: Pose, world: Pose): Pose {
  const c = Math.cos(a.angle), s = Math.sin(a.angle), x = world.x - a.x, y = world.y - a.y;
  return { x: (c * x + s * y) / (a.sx || 1), y: (-s * x + c * y) / (a.sy || 1), angle: world.angle - a.angle, sx: world.sx / (a.sx || 1), sy: world.sy / (a.sy || 1) };
}
function rectAt(world: Pose, width: number, height: number): OverlayLayoutRect {
  const c = Math.abs(Math.cos(world.angle)), s = Math.abs(Math.sin(world.angle));
  return { x: world.x, y: world.y, width: c * width * Math.abs(world.sx) + s * height * Math.abs(world.sy), height: s * width * Math.abs(world.sx) + c * height * Math.abs(world.sy) };
}
type Node = {
  key: string; actor: SerializedActor; component?: SerializedComponent; classId: string; props: OverlayLayoutProperties;
  local: SerializedTransform; parent: Node | null; actualParent: Node | null; children: Node[]; proxy?: Node;
  native: [number, number]; desired: [number, number]; size: [number, number]; world?: Pose; managed: boolean;
};
function nativeSize(component: SerializedComponent, options: OverlayLayoutOptions): [number, number] {
  const p = component.properties, ppu = positive(options.pixelsPerUnit, 100) || 100;
  if (component.classId === "2DTextComponent" || component.classId === "2DRichTextComponent") {
    const rich = component.classId === "2DRichTextComponent", text = parseText2DProperties(p, { rich });
    const spans = rich ? parseRichText(text.text, text) : [{ kind: "text" as const, text: text.text, style: text }];
    let width = 0, height = 0, lineWidth = 0, lineHeight = 0;
    const finishLine = () => { width = Math.max(width, lineWidth); height += lineHeight || text.size * 1.2; lineWidth = 0; lineHeight = 0; };
    for (const span of spans) {
      if (span.kind === "image") { lineWidth += span.size; lineHeight = Math.max(lineHeight, span.size); continue; }
      for (const character of span.text) {
        if (character === "\n") { finishLine(); continue; }
        lineWidth += span.style.size * 0.6; lineHeight = Math.max(lineHeight, span.style.size * 1.2);
      }
    }
    finishLine();
    return [(text.wrapWidth || Math.max(text.size, width)) / ppu, (text.wrapHeight || height) / ppu];
  }
  if (component.classId === "2DTextureComponent") {
    const size = options.textureSize?.(String(p.textureGuid ?? ""));
    if (size) return [size.width / ppu, size.height / ppu];
  }
  if (component.classId === "2DPainterComponent") { const painter = parsePainter2DProperties(p); return [painter.width, painter.height]; }
  return [1, 1];
}

/** Measure then arrange the two authored hierarchies without changing source data.
 * Dimensions/gaps/padding/scroll are SceneLayer world units. Array order is layout order.
 */
export function resolveOverlayLayout(source: readonly SerializedActor[], options: OverlayLayoutOptions = {}): OverlayLayoutResult {
  const hasLayout = source.some(a => a.components.some(c => isOverlayLayoutClass(c.classId)));
  if (!hasLayout && !options.includeUnmanagedBounds) return { actors: source as SerializedActor[], entries: new Map() };
  const actors = source.map(a => ({ ...a, transform: structuredClone(a.transform), components: a.components.map(c => ({ ...c, properties: { ...c.properties }, transform: structuredClone(c.transform ?? identitySerializedTransform()) })) }));
  const nodes = new Map<string, Node>(), actorNodes = new Map<string, Node>();
  for (const actor of actors) {
    const node: Node = { key: actor.id, actor, classId: "actor", props: parseOverlayLayoutProperties({}, "actor"), local: actor.transform, parent: null, actualParent: null, children: [], native: [1, 1], desired: [1, 1], size: [1, 1], managed: false };
    nodes.set(node.key, node); actorNodes.set(actor.id, node);
    for (const component of actor.components) {
      const key = overlayLayoutKey(actor.id, component.id);
      nodes.set(key, { key, actor, component, classId: component.classId, props: parseOverlayLayoutProperties(component.properties, component.classId), local: component.transform!, parent: node, actualParent: node, children: [], native: nativeSize(component, options), desired: [1, 1], size: [1, 1], managed: false });
    }
  }
  for (const node of nodes.values()) {
    if (node.component) {
      const parent = node.component.parentId ? nodes.get(overlayLayoutKey(node.actor.id, node.component.parentId)) : undefined;
      node.parent = node.actualParent = parent ?? actorNodes.get(node.actor.id)!;
    } else {
      node.parent = node.actualParent = actorNodes.get(node.actor.parentId ?? "") ?? null;
      node.proxy = node.actor.components.map(c => nodes.get(overlayLayoutKey(node.actor.id, c.id))!).find(c => !c.component?.parentId && isOverlayLayoutClass(c.classId) && c.classId !== "2DPaddingComponent");
      if (node.proxy) node.props = node.proxy.props;
    }
  }
  // Outliner children belong to their parent's root box, just like explicit component children.
  for (const node of actorNodes.values()) if (node.parent?.proxy) node.parent = node.parent.proxy;
  // Padding helper actors decorate their immediate parent's content and occupy no slot.
  for (const node of nodes.values()) {
    const seen = new Set([node.key]); let parent = node.parent;
    while (parent && !seen.has(parent.key)) { seen.add(parent.key); parent = parent.parent; }
    if (parent) node.parent = null; // Malformed cyclic documents remain finite.
    node.parent?.children.push(node);
  }
  const surfaceClasses = new Set(["2DTextureComponent", "2DMaterialComponent", "2DPanelComponent", "2DTextComponent", "2DRichTextComponent", "2DPainterComponent", "SpriteComponent", "MeshComponent"]);
  const interactionOnly = (n: Node) => n.classId === "2DAnchorComponent" || n.classId === "2DFocusTargetComponent" || n.classId === "2DButtonComponent" && (
    n.actor.components.some(c => surfaceClasses.has(c.classId)) || (n.actor.parentId ? actors.find(a => a.id === n.actor.parentId)?.components.some(c => surfaceClasses.has(c.classId)) : false)
  );
  const paddingOnly = (n: Node) => n.classId === "2DPaddingComponent" || n.classId === "actor" && n.children.length > 0 && n.children.every(c => c.classId === "2DPaddingComponent" || interactionOnly(c));
  const visible = (n: Node) => n.actor.visible !== false && n.component?.properties.visible !== false && n.component?.properties.enabled !== false;
  function participates(n: Node): boolean {
    if (!visible(n) || paddingOnly(n) || interactionOnly(n)) return false;
    if (n.classId === "actor") return n.children.some(participates);
    return isOverlayLayoutClass(n.classId) || surfaceClasses.has(n.classId) || n.classId === "2DButtonComponent";
  }
  const items = (n: Node) => n.children.filter(participates);
  const inset = (n: Node) => {
    // A root component box lends its dimensions to its actor, but owns padding once.
    if (n.proxy) return { left: 0, right: 0, top: 0, bottom: 0 };
    const p = { left: n.props.paddingLeft, right: n.props.paddingRight, top: n.props.paddingTop, bottom: n.props.paddingBottom };
    const helpers = [...n.children, ...(n.parent?.proxy === n ? n.parent.children.filter(child => child !== n) : [])].filter(child => visible(child) && paddingOnly(child));
    for (const child of helpers) {
      for (const padding of child.classId === "actor" ? child.children.filter(c => c.classId === "2DPaddingComponent" && visible(c)) : [child]) {
        const v = padding.props;
        p.left += v.paddingLeft; p.right += v.paddingRight; p.top += v.paddingTop; p.bottom += v.paddingBottom;
      }
    }
    return p;
  };
  const measured = new Set<string>();
  function measure(n: Node): [number, number] {
    if (measured.has(n.key)) return n.desired;
    measured.add(n.key);
    const children = items(n), sizes = children.map(measure), padding = inset(n);
    let content: [number, number] = n.component ? n.native : [0, 0];
    if (isOverlayLayoutClass(n.classId) || n.classId === "actor") {
      const vertical = n.classId === "2DVerticalBoxComponent", horizontal = n.classId === "2DHorizontalBoxComponent";
      content = [horizontal ? sizes.reduce((s, v) => s + v[0], 0) + n.props.gap * Math.max(0, sizes.length - 1) : Math.max(0, ...sizes.map(s => s[0])), vertical ? sizes.reduce((s, v) => s + v[1], 0) + n.props.gap * Math.max(0, sizes.length - 1) : Math.max(0, ...sizes.map(s => s[1]))];
      content[0] += padding.left + padding.right; content[1] += padding.top + padding.bottom;
      if (n.classId === "2DSpacerComponent") content = [n.props.width, n.props.height];
    }
    if (n.proxy) content = measure(n.proxy).slice() as [number, number];
    const w = n.props.widthMode === "fixed" && n.classId !== "actor" ? n.props.width : content[0];
    const h = n.props.heightMode === "fixed" && n.classId !== "actor" ? n.props.height : content[1];
    n.size = [w, h];
    n.desired = [w * Math.abs(n.local.scale[0]), h * Math.abs(n.local.scale[1])];
    return n.desired;
  }
  for (const node of nodes.values()) measure(node);
  const entries = new Map<string, OverlayLayoutEntry>();
  const arranged = new Set<string>();
  function arrange(n: Node, parentPose: Pose, allocation?: [number, number], center?: [number, number], clip: OverlayLayoutRect | null = null, scrollAncestors: string[] = []) {
    if (arranged.has(n.key)) return;
    arranged.add(n.key);
    const local = pose(n.local);
    let width = allocation ? allocation[0] / (Math.abs(local.sx) || 1) : n.size[0], height = allocation ? allocation[1] / (Math.abs(local.sy) || 1) : n.size[1];
    if (center) { local.x = center[0]; local.y = center[1]; n.managed = true; }
    const container = isOverlayLayoutClass(n.classId) || n.classId === "actor";
    if (!container && allocation) {
      local.sx *= n.native[0] > 0 ? width / n.native[0] : 1;
      local.sy *= n.native[1] > 0 ? height / n.native[1] : 1;
      width = n.native[0]; height = n.native[1];
    }
    n.world = compose(parentPose, local);
    const rect = rectAt(n.world, container ? width : n.native[0], container ? height : n.native[1]);
    const entry: OverlayLayoutEntry = { actorId: n.actor.id, ...(n.component ? { componentId: n.component.id } : {}), rect, clip, scrollAncestors,
      interactive: visible(n) && (!n.parent || entries.get(n.parent.key)?.interactive !== false) };
    entries.set(n.key, entry);
    if (n.component && isOverlayLayoutClass(n.classId)) { n.component.properties.layoutResolvedWidth = width; n.component.properties.layoutResolvedHeight = height; }
    const padding = inset(n), innerW = Math.max(0, width - padding.left - padding.right), innerH = Math.max(0, height - padding.top - padding.bottom);
    const children = items(n), vertical = n.classId === "2DVerticalBoxComponent", horizontal = n.classId === "2DHorizontalBoxComponent", scroll = n.classId === "2DScrollBoxComponent";
    const innerX = (padding.left - padding.right) / 2, innerY = (padding.bottom - padding.top) / 2;
    let childClip = clip, ancestors = scrollAncestors;
    let scrollX = 0, scrollY = 0;
    if (scroll) {
      const contentW = Math.max(innerW, ...children.map(c => c.desired[0])), contentH = Math.max(innerH, ...children.map(c => c.desired[1]));
      const maxX = n.props.scrollAxis === "vertical" ? 0 : Math.max(0, contentW - innerW), maxY = n.props.scrollAxis === "horizontal" ? 0 : Math.max(0, contentH - innerH);
      scrollX = Math.min(n.props.scrollX, maxX); scrollY = Math.min(n.props.scrollY, maxY);
      const viewport = rectAt(compose(n.world, { ...origin, x: innerX, y: innerY }), innerW, innerH);
      entry.scroll = { x: scrollX, y: scrollY, maxX, maxY, axis: n.props.scrollAxis, viewport, scaleX: Math.abs(n.world.sx), scaleY: Math.abs(n.world.sy) };
      childClip = intersectOverlayRects(clip, viewport);
      ancestors = [...ancestors, n.key];
    }
    const main = horizontal ? 0 : 1, mainSize = horizontal ? innerW : innerH;
    const fixed = children.reduce((sum, c) => sum + ((main === 0 ? c.props.widthMode : c.props.heightMode) === "fill" ? 0 : c.desired[main]), 0);
    const weight = children.reduce((sum, c) => sum + ((main === 0 ? c.props.widthMode : c.props.heightMode) === "fill" ? c.props.fillWeight : 0), 0);
    const available = Math.max(0, mainSize - fixed - n.props.gap * Math.max(0, children.length - 1));
    const total = fixed + (weight ? available : 0) + n.props.gap * Math.max(0, children.length - 1);
    const mainAlign = horizontal ? n.props.horizontalAlignment : n.props.verticalAlignment;
    let cursor = Math.max(0, mainSize - total) * (mainAlign === "end" ? 1 : mainAlign === "center" ? 0.5 : 0);
    for (const child of n.children) {
      if (!hasLayout) { arrange(child, n.world, undefined, undefined, childClip, ancestors); continue; }
      if (!children.includes(child) || paddingOnly(child)) { arrange(child, n.world, undefined, undefined, childClip, ancestors); continue; }
      const hasPadding = padding.left + padding.right + padding.top + padding.bottom > 0;
      if (n.classId === "actor" && !n.proxy && !hasPadding) { arrange(child, n.world, undefined, undefined, childClip, ancestors); continue; }
      if (!container && !hasPadding || n.classId === "2DSpacerComponent" || n.classId === "2DPaddingComponent") { arrange(child, n.world, undefined, undefined, childClip, ancestors); continue; }
      let w = child.desired[0], h = child.desired[1];
      const proxy = child === n.proxy;
      if (proxy || child.props.widthMode === "fill" || n.props.horizontalAlignment === "stretch") w = innerW;
      if (proxy || child.props.heightMode === "fill" || n.props.verticalAlignment === "stretch") h = innerH;
      if (horizontal && child.props.widthMode === "fill") w = weight ? available * child.props.fillWeight / weight : 0;
      if (vertical && child.props.heightMode === "fill") h = weight ? available * child.props.fillWeight / weight : 0;
      if (scroll) { if (n.props.scrollAxis !== "vertical") w = Math.max(w, child.desired[0]); if (n.props.scrollAxis !== "horizontal") h = Math.max(h, child.desired[1]); }
      const alignOffset = (space: number, size: number, align: string) => (space - size) * (align === "end" ? 1 : align === "center" ? 0.5 : 0);
      let x = -innerW / 2 + w / 2 + alignOffset(innerW, w, n.props.horizontalAlignment), y = innerH / 2 - h / 2 - alignOffset(innerH, h, n.props.verticalAlignment);
      if (horizontal) { x = -innerW / 2 + cursor + w / 2; cursor += w + n.props.gap; }
      if (vertical) { y = innerH / 2 - cursor - h / 2; cursor += h + n.props.gap; }
      if (n.classId === "actor" && n.proxy) { x = child.local.position[0]; y = child.local.position[1]; }
      arrange(child, n.world, [Math.max(0, w), Math.max(0, h)], [x + innerX - scrollX, y + innerY + scrollY], childClip, ancestors);
    }
  }
  for (const node of nodes.values()) if (!node.parent) arrange(node, origin);
  for (const node of nodes.values()) {
    if (!node.world || !node.managed) continue;
    const local = relative(node.actualParent?.world ?? origin, node.world);
    node.local.position[0] = local.x; node.local.position[1] = local.y;
    node.local.scale[0] = local.sx; node.local.scale[1] = local.sy;
    // Layout preserves authored rotation; the logical parent may be a component proxy.
    if (node.parent !== node.actualParent) node.local.rotation = [0, 0, Math.sin(local.angle / 2), Math.cos(local.angle / 2)];
  }
  return { actors: hasLayout ? actors : source as SerializedActor[], entries };
}
