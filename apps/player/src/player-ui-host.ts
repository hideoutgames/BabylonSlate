import type { Scene } from "@babylonjs/core/scene";
import { mimeForGuiTextureBytes } from "@babylonslate/assets";
import type { UiWidgetEventControl } from "@babylonslate/bridge";
import {
  applyAdtIdeal,
  applyFontRegistryToHost,
  applyUiControls,
  attachFullscreenGui,
  FontRegistry,
  RecordingUiHost,
  type FontAssetEntry,
  type UiApplyHost,
  type UiWidgetEvent,
} from "@babylonslate/render";
import {
  describeUiControls,
  devicePresetForViewport,
  layoutUserInterface,
  type DevicePreset,
  type UserInterfaceDocument,
} from "@babylonslate/ui-runtime";
import type { MaterialDocument, MaterialFunctionDocument } from "@babylonslate/shader-graph";
import {
  inputModeAllowsGuiHits,
  parseInputMode,
} from "@babylonslate/core";

export type PlayerUiInstance = { instanceId: string; assetGuid: string };

export type PlayerUiHost = {
  apply(instanceId: string, assetGuid: string): void;
  remove(instanceId: string): void;
  setVisible(instanceId: string, widgetId: string, visible: boolean): void;
  setInputMode(mode: string): void;
  handleWidgetEvent(event: UiWidgetEvent): void;
  resolveImageUrl(guid: string): string | null;
  instances(): readonly PlayerUiInstance[];
  resize(width: number, height: number): void;
  dispose(): void;
};

export type PlayerUiHostOptions = {
  library:
    | ReadonlyMap<string, UserInterfaceDocument>
    | Readonly<Record<string, UserInterfaceDocument>>;
  textureBytes?: ReadonlyMap<string, Uint8Array>;
  scene?: Scene | null;
  host?: UiApplyHost;
  viewport?: { width: number; height: number };
  onWidgetEvent?: (event: UiWidgetEventControl) => void;
  onTouchAxis?: (controlId: string, value: number) => void;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  attachGui?: typeof attachFullscreenGui;
  disposeAttached?: () => void;
  designerPresets?: readonly DevicePreset[];
  fontEntries?: readonly FontAssetEntry[];
  applyFonts?: typeof applyFontRegistryToHost;
  resolveInterfaceMaterial?: (guid: string) => MaterialDocument | null;
  materialFunctions?: () => Record<string, MaterialFunctionDocument>;
  resolveTexture?: (guid: string) => import("@babylonjs/core/Materials/Textures/texture").Texture | null;
};

function documentFromLibrary(
  library: PlayerUiHostOptions["library"],
  guid: string,
): UserInterfaceDocument | undefined {
  if (library instanceof Map) return library.get(guid);
  return (library as Readonly<Record<string, UserInterfaceDocument>>)[guid];
}

function mimeForTextureBytes(bytes: Uint8Array): string | null {
  return mimeForGuiTextureBytes(bytes);
}

function scopeControlId(instanceId: string, id: string | null | undefined): string | null {
  if (!id) return null;
  return `${instanceId}:${id}`;
}

export function createPlayerUiHost(options: PlayerUiHostOptions): PlayerUiHost {
  const rows: PlayerUiInstance[] = [];
  const hidden = new Set<string>();
  const imageUrls = new Map<string, string>();
  let viewport = {
    width: Math.max(1, options.viewport?.width ?? 1920),
    height: Math.max(1, options.viewport?.height ?? 1080),
  };
  const createObjectURL =
    options.createObjectURL ??
    ((blob: Blob) =>
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(blob)
        : null);
  const revokeObjectURL =
    options.revokeObjectURL ??
    ((url: string) => {
      if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
      }
    });
  const applyFonts = options.applyFonts ?? applyFontRegistryToHost;
  const extras = options.designerPresets ?? [];
  let attached: ReturnType<typeof attachFullscreenGui> | null = null;
  let fallbackHost: UiApplyHost | null = options.host ?? null;
  let disposed = false;
  let allowGuiHits = true;

  const resolveImageUrl = (guid: string): string | null => {
    const id = guid.trim();
    if (!id) return null;
    const cached = imageUrls.get(id);
    if (cached) return cached;
    const bytes = options.textureBytes?.get(id);
    if (!bytes || bytes.byteLength === 0) return null;
    const mime = mimeForTextureBytes(bytes);
    if (!mime) return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = createObjectURL(new Blob([copy], { type: mime }));
    if (!url) return null;
    imageUrls.set(id, url);
    return url;
  };

  const resolveNested = (guid: string) =>
    documentFromLibrary(options.library, guid) ?? null;

  const handleWidgetEvent = (event: UiWidgetEvent): void => {
    if (disposed) return;
    const raw = event.widgetId;
    const sep = raw.indexOf(":");
    if (sep <= 0) return;
    const instanceId = raw.slice(0, sep);
    const widgetId = raw.slice(sep + 1);
    if (!widgetId || !rows.some((row) => row.instanceId === instanceId)) return;
    options.onWidgetEvent?.({
      type: "uiWidgetEvent",
      instanceId,
      widgetId,
      kind: event.kind,
      ...("value" in event ? { value: event.value } : {}),
    });
  };

  const applyHost = (): UiApplyHost => {
    if (fallbackHost) return fallbackHost;
    if (attached) return attached.host;
    if (options.scene) {
      const first = rows
        .map((row) => documentFromLibrary(options.library, row.assetGuid))
        .find((doc) => doc);
      const attach = options.attachGui ?? attachFullscreenGui;
      attached = attach(options.scene, {
        name: "player-hud",
        interactive: true,
        allowGuiHits,
        width: viewport.width,
        height: viewport.height,
        designResolution: first?.designResolution ?? viewport,
        scaleRule: first?.scaleRule ?? "shortestSide",
        safeArea: devicePresetForViewport(
          viewport.width,
          viewport.height,
          extras,
        ).safeArea,
        resolveImageUrl,
        resolveInterfaceMaterial: options.resolveInterfaceMaterial,
        materialFunctions: options.materialFunctions,
        resolveTexture: options.resolveTexture,
        onTouchAxis: options.onTouchAxis,
        onWidgetEvent: handleWidgetEvent,
      });
      if ((options.fontEntries?.length ?? 0) > 0) {
        const registry = new FontRegistry();
        void applyFonts(registry, options.fontEntries!, () => {
          attached?.adt.markAsDirty();
        });
      }
      return attached.host;
    }
    fallbackHost = new RecordingUiHost();
    return fallbackHost;
  };

  const rebuild = (): void => {
    const host = applyHost();
    const preset = devicePresetForViewport(
      viewport.width,
      viewport.height,
      extras,
    );
    const first = rows
      .map((row) => documentFromLibrary(options.library, row.assetGuid))
      .find((doc) => doc);
    if (attached) {
      applyAdtIdeal(
        attached.adt,
        first?.designResolution ?? viewport,
        first?.scaleRule ?? "shortestSide",
      );
    }
    const controls = rows.flatMap((row) => {
      const document = documentFromLibrary(options.library, row.assetGuid);
      if (!document) return [];
      const layout = layoutUserInterface(document, viewport, {
        safeArea: preset.safeArea,
        resolveNested,
      });
      return describeUiControls(document, layout)
        .map((control) => ({
          ...control,
          id: `${row.instanceId}:${control.id}`,
          parentId: scopeControlId(row.instanceId, control.parentId),
        }))
        .filter((control) => control.visible && !hidden.has(control.id));
    });
    applyUiControls(host, controls);
  };

  return {
    apply(instanceId, assetGuid) {
      if (disposed) return;
      const id = instanceId.trim();
      const guid = assetGuid.trim();
      if (!id || !guid) return;
      if (rows.some((row) => row.instanceId === id)) return;
      if (!documentFromLibrary(options.library, guid)) return;
      rows.push({ instanceId: id, assetGuid: guid });
      rebuild();
    },
    remove(instanceId) {
      const id = instanceId.trim();
      const next = rows.filter((row) => row.instanceId !== id);
      if (next.length === rows.length) return;
      rows.length = 0;
      rows.push(...next);
      for (const key of [...hidden]) {
        if (key.startsWith(`${id}:`)) hidden.delete(key);
      }
      rebuild();
    },
    setVisible(instanceId, widgetId, visible) {
      const scoped = scopeControlId(instanceId.trim(), widgetId.trim());
      if (!scoped) return;
      if (visible) hidden.delete(scoped);
      else hidden.add(scoped);
      rebuild();
    },
    handleWidgetEvent,
    resolveImageUrl,
    instances: () => [...rows],
    setInputMode(mode) {
      allowGuiHits = inputModeAllowsGuiHits(parseInputMode(mode));
      attached?.setAllowGuiHits?.(allowGuiHits);
    },
    resize(width, height) {
      viewport = { width: Math.max(1, width), height: Math.max(1, height) };
      if (rows.length > 0) rebuild();
    },
    dispose() {
      disposed = true;
      rows.length = 0;
      hidden.clear();
      fallbackHost?.clear();
      attached?.dispose();
      attached = null;
      options.disposeAttached?.();
      for (const url of imageUrls.values()) revokeObjectURL(url);
      imageUrls.clear();
    },
  };
}

export function applyPlayerUiCommand(
  host: PlayerUiHost,
  command: { type: string } & Record<string, unknown>,
): boolean {
  if (command.type === "uiApply") {
    host.apply(String(command.instanceId ?? ""), String(command.assetGuid ?? ""));
    return true;
  }
  if (command.type === "uiRemove") {
    host.remove(String(command.instanceId ?? ""));
    return true;
  }
  if (command.type === "uiSetVisible") {
    host.setVisible(
      String(command.instanceId ?? ""),
      String(command.widgetId ?? ""),
      command.visible === true,
    );
    return true;
  }
  if (command.type === "setInputMode") {
    host.setInputMode(String(command.mode ?? "All"));
    return true;
  }
  return false;
}
