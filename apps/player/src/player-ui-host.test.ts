import { describe, expect, it, vi } from "vitest";
import type { CommandMessage, UiWidgetEventControl } from "@babylonslate/bridge";
import {
  createDefaultUserInterface,
  createWidget,
  pinLayout,
} from "@babylonslate/ui-runtime";
import { RecordingUiHost } from "@babylonslate/render";
import {
  applyPlayerUiCommand,
  createPlayerUiHost,
  type PlayerUiHostOptions,
} from "./player-ui-host";

function hudDocument() {
  const doc = createDefaultUserInterface("HUD");
  const button = createWidget(
    "play-btn",
    "Button",
    "Play",
    pinLayout("center", "center", 160, 40),
  );
  const logo = createWidget(
    "logo",
    "Image",
    "Logo",
    pinLayout("left", "top", 64, 64),
  );
  logo.props.imageGuid = "tex-logo";
  doc.widgets[button.id] = button;
  doc.widgets[logo.id] = logo;
  doc.widgets[doc.rootId]!.children.push(button.id, logo.id);
  return doc;
}

function createTestHost(
  extras: Partial<PlayerUiHostOptions> = {},
): ReturnType<typeof createPlayerUiHost> & { recording: RecordingUiHost } {
  const recording = extras.host instanceof RecordingUiHost
    ? extras.host
    : new RecordingUiHost();
  const host = createPlayerUiHost({
    library: new Map([["hud-1", hudDocument()]]),
    textureBytes: new Map([["tex-logo", new Uint8Array([0x89, 0x50, 0x4e, 0x47])]]),
    host: recording,
    viewport: { width: 800, height: 600 },
    createObjectURL: (blob) => `blob:test/${blob.size}`,
    revokeObjectURL: extras.revokeObjectURL ?? (() => {}),
    ...extras,
  });
  return Object.assign(host, { recording });
}

describe("createPlayerUiHost", () => {
  it("applies a packed UserInterface and prefixes instance-scoped control ids", () => {
    const host = createTestHost();
    host.apply("ui-1", "hud-1");
    expect(host.instances()).toEqual([{ instanceId: "ui-1", assetGuid: "hud-1" }]);
    expect(host.recording.controls.map((control) => control.id)).toEqual(
      expect.arrayContaining(["ui-1:canvas", "ui-1:play-btn", "ui-1:logo"]),
    );
    expect(host.resolveImageUrl("tex-logo")).toBe("blob:test/4");
  });

  it("does not treat packed KTX2 bytes as a GUI Image source", () => {
    const ktx2 = new Uint8Array([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const host = createTestHost({
      textureBytes: new Map([["tex-logo", ktx2]]),
    });
    expect(host.resolveImageUrl("tex-logo")).toBeNull();
  });

  it("stacks later Apply instances after earlier ones so they paint and pick on top", () => {
    const host = createTestHost();
    host.apply("ui-1", "hud-1");
    host.apply("ui-2", "hud-1");
    const ids = host.recording.controls.map((control) => control.id);
    expect(ids.indexOf("ui-1:canvas")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("ui-2:canvas")).toBeGreaterThan(ids.indexOf("ui-1:canvas"));
    expect(ids.indexOf("ui-2:play-btn")).toBeGreaterThan(ids.indexOf("ui-1:play-btn"));
    expect(host.instances().map((row) => row.instanceId)).toEqual(["ui-1", "ui-2"]);
  });

  it("keeps two instances independent and honors instance-scoped visibility", () => {
    const host = createTestHost();
    host.apply("ui-1", "hud-1");
    host.apply("ui-2", "hud-1");
    host.setVisible("ui-1", "play-btn", false);
    const ids = host.recording.controls.map((control) => control.id);
    expect(ids).toContain("ui-2:play-btn");
    expect(ids).not.toContain("ui-1:play-btn");
    expect(host.recording.visibility.get("ui-1:play-btn")).not.toBe(true);
  });

  it("removes an instance and ignores widget events after removal", () => {
    const events: UiWidgetEventControl[] = [];
    const host = createTestHost({
      onWidgetEvent: (event) => events.push(event),
    });
    host.apply("ui-1", "hud-1");
    host.handleWidgetEvent({ kind: "click", widgetId: "ui-1:play-btn" });
    expect(events).toEqual([
      { type: "uiWidgetEvent", instanceId: "ui-1", widgetId: "play-btn", kind: "click" },
    ]);
    host.remove("ui-1");
    expect(host.instances()).toEqual([]);
    expect(host.recording.controls).toEqual([]);
    host.handleWidgetEvent({ kind: "click", widgetId: "ui-1:play-btn" });
    expect(events).toHaveLength(1);
  });

  it("revokes image blob URLs and clears the ADT host on dispose", () => {
    const revoked: string[] = [];
    const recording = new RecordingUiHost();
    let adtDisposed = false;
    const host = createPlayerUiHost({
      library: new Map([["hud-1", hudDocument()]]),
      textureBytes: new Map([["tex-logo", new Uint8Array([0x89, 0x50, 0x4e, 0x47])]]),
      host: recording,
      viewport: { width: 400, height: 300 },
      createObjectURL: () => "blob:test/logo",
      revokeObjectURL: (url) => {
        revoked.push(url);
      },
      disposeAttached: () => {
        adtDisposed = true;
      },
    });
    host.apply("ui-1", "hud-1");
    expect(host.resolveImageUrl("tex-logo")).toBe("blob:test/logo");
    host.dispose();
    expect(revoked).toEqual(["blob:test/logo"]);
    expect(recording.controls).toEqual([]);
    expect(adtDisposed).toBe(true);
    expect(host.instances()).toEqual([]);
  });

  it("uses packed designer presets for Safe Area when the viewport matches", () => {
    const phone = {
      id: "custom-phone",
      label: "Phone",
      width: 390,
      height: 844,
      safeArea: { left: 0, right: 0, top: 47, bottom: 34 },
    };
    const without = createTestHost({
      viewport: { width: 390, height: 844 },
    });
    without.apply("ui-1", "hud-1");
    const logoWithout = without.recording.controls.find(
      (control) => control.id === "ui-1:logo",
    );
    const withPreset = createTestHost({
      viewport: { width: 390, height: 844 },
      designerPresets: [phone],
    });
    withPreset.apply("ui-1", "hud-1");
    const logoWith = withPreset.recording.controls.find(
      (control) => control.id === "ui-1:logo",
    );
    expect(logoWithout?.guiRect.y).toBeDefined();
    expect(logoWith?.guiRect.y).toBeGreaterThan(logoWithout!.guiRect.y);
  });

  it("dirties the HUD ADT after packed fonts register", async () => {
    const markAsDirty = vi.fn();
    const applyFonts = vi.fn(
      async (
        _registry: unknown,
        entries: readonly { family: string }[],
        dirty: () => void,
      ) => {
        expect(entries.map((entry) => entry.family)).toEqual(["Display Face"]);
        dirty();
      },
    );
    const attachGui = vi.fn(() => ({
      adt: { markAsDirty },
      host: new RecordingUiHost(),
      setAllowGuiHits: vi.fn(),
      dispose: vi.fn(),
    }));
    const host = createPlayerUiHost({
      library: new Map([["hud-1", hudDocument()]]),
      scene: {} as never,
      attachGui: attachGui as never,
      applyFonts,
      fontEntries: [
        {
          guid: "font-1",
          family: "Display Face",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
      viewport: { width: 800, height: 600 },
    });
    host.apply("ui-1", "hud-1");
    await vi.waitFor(() => expect(applyFonts).toHaveBeenCalledTimes(1));
    expect(markAsDirty).toHaveBeenCalled();
    const firstCall = attachGui.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[1]).toMatchObject({
      interactive: true,
      designResolution: hudDocument().designResolution,
    });
  });
});

describe("applyPlayerUiCommand", () => {
  it("routes uiApply, uiSetVisible, and uiRemove onto the host", () => {
    const host = createTestHost();
    expect(
      applyPlayerUiCommand(host, {
        type: "uiApply",
        instanceId: "ui-1",
        classId: "UserInterface:hud-1",
        assetGuid: "hud-1",
      } satisfies CommandMessage),
    ).toBe(true);
    expect(host.instances()).toEqual([{ instanceId: "ui-1", assetGuid: "hud-1" }]);
    applyPlayerUiCommand(host, {
      type: "uiSetVisible",
      instanceId: "ui-1",
      widgetId: "play-btn",
      visible: false,
    });
    expect(
      host.recording.controls.some((control) => control.id === "ui-1:play-btn"),
    ).toBe(false);
    applyPlayerUiCommand(host, { type: "uiRemove", instanceId: "ui-1" });
    expect(host.instances()).toEqual([]);
  });

  it("routes setInputMode onto the HUD host", () => {
    const host = createTestHost();
    expect(
      applyPlayerUiCommand(host, {
        type: "setInputMode",
        mode: "Game",
      } satisfies CommandMessage),
    ).toBe(true);
  });

  it("ignores scene and render commands", () => {
    const host = createTestHost();
    expect(applyPlayerUiCommand(host, { type: "stats", frameId: 1, tickIndex: 1, scriptMs: 0, physicsMs: 0 })).toBe(
      false,
    );
    expect(
      applyPlayerUiCommand(host, { type: "assignMesh", slotId: 1, meshAssetGuid: null }),
    ).toBe(false);
  });
});
