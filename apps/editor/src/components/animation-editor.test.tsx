import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { AnimationEditor, AnimationPreview, AnimationPreviewPanel } from "./animation-editor";

const documents = vi.hoisted(() => ({
  open: [] as { id: string; ref: { path: string }; content: Record<string, unknown> }[],
  assets: [] as { path: string; header: { guid: string; name: string; type: string; payload: Record<string, unknown> } }[],
  readAssetChunk: vi.fn<(path: string, chunkId: string) => Promise<Uint8Array | null>>(async () => null),
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    assetRegistry: {
      list: () => documents.assets,
      getByGuid: (guid: string) => documents.assets.find((asset) => asset.header.guid === guid),
    },
    openDocuments: documents.open,
    readAssetChunk: documents.readAssetChunk,
  })),
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  documents.open = [];
  documents.assets = [];
  documents.readAssetChunk.mockReset();
  documents.readAssetChunk.mockResolvedValue(null);
});

const durationInput = () => screen.getByTestId("property-durationMs") as HTMLInputElement;

describe("AnimationEditor", () => {
  it("edits Duration and keeps the clip's length as the reset default", () => {
    const onChange = vi.fn();
    render(
      <AnimationEditor
        payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 1000, clipDurationMs: 1000 }}
        onChange={onChange}
      />,
    );
    fireEvent.change(durationInput(), { target: { value: "1500" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ clipName: "Walk", modelGuid: "hero", durationMs: 1500, clipDurationMs: 1000 }),
      expect.any(String),
    );
  });

  it("resets an authored Duration to the clip's length", () => {
    const onChange = vi.fn();
    render(
      <AnimationEditor
        payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 2500, clipDurationMs: 1000 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset Duration" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationMs: 1000, clipDurationMs: 1000 }),
      expect.any(String),
    );
  });

  it("shows Duration read-only without an owner to write it", () => {
    render(<AnimationEditor payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 1000 }} />);
    expect(durationInput().disabled).toBe(true);
  });
});

describe("AnimationEditor events", () => {
  const walk = { clipName: "Walk", modelGuid: "hero", skeletonGuid: "rig", durationMs: 1000, clipDurationMs: 1000 };
  const lastPayload = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)![0] as { events?: Array<Record<string, unknown>> };

  it("adds an event at the start with the default Trigger Weight and no action", () => {
    const onChange = vi.fn();
    render(<AnimationEditor payload={walk} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("animation-events-add"));
    expect(lastPayload(onChange).events).toEqual([
      { id: "event-1", name: "Event", timeMs: 0, durationMs: 0, triggerWeight: 0.5, action: null },
    ]);
  });

  it("edits an event's name, time and window length, each field one undo step", () => {
    const onChange = vi.fn();
    const events = [{ id: "e", name: "Footstep", timeMs: 100, durationMs: 0, triggerWeight: 0.5, action: null }];
    render(<AnimationEditor payload={{ ...walk, events }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("property-e-time"), { target: { value: "250" } });
    expect(lastPayload(onChange).events![0]).toMatchObject({ timeMs: 250 });
    expect(onChange.mock.calls.at(-1)![1]).toBe("animation:event:e:time");
    fireEvent.change(screen.getByTestId("property-e-duration"), { target: { value: "150" } });
    expect(lastPayload(onChange).events![0]).toMatchObject({ durationMs: 150 });
  });

  it("chooses Play Sound and shows its Sound and Volume, and removes an event", () => {
    const onChange = vi.fn();
    const events = [{ id: "e", name: "Footstep", timeMs: 100, durationMs: 0, triggerWeight: 0.5, action: { kind: "playSound", assetGuid: "step", volume: 0.8 } }];
    documents.assets = [{ path: "assets/Step.hasset", header: { guid: "step", name: "Step", type: "Audio", payload: {} } }];
    render(<AnimationEditor payload={{ ...walk, events }} onChange={onChange} />);
    expect(screen.getByTestId("property-e-sound").textContent).toContain("Step");
    expect((screen.getByTestId("property-e-volume") as HTMLInputElement).value).toBe("0.8");
    fireEvent.click(screen.getByTestId("animation-events-remove-e"));
    expect(lastPayload(onChange).events).toEqual([]);
  });
});

describe("AnimationPreviewPanel", () => {
  it("reports a failed read of the owning Model's source instead of an empty mesh", async () => {
    documents.open = [{ id: "walk", ref: { path: "assets/Walk.anim3d.hasset" }, content: { clipName: "Walk", modelGuid: "hero" } }];
    documents.assets = [{ path: "assets/hero.model.hasset", header: { guid: "hero", name: "Hero", type: "Model", payload: {} } }];
    documents.readAssetChunk.mockRejectedValueOnce(new Error("Asset chunk assets/hero.model.hasset#source could not be read."));
    render(
      <DocumentWorkspaceProvider documentId="walk">
        <AnimationPreviewPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    expect(await screen.findByText("Failed to Read Mesh")).toBeTruthy();
    expect(screen.getByText("Asset chunk assets/hero.model.hasset#source could not be read.")).toBeTruthy();
    expect(screen.queryByText("No Mesh")).toBeNull();
    expect(documents.readAssetChunk).toHaveBeenCalledWith("assets/hero.model.hasset", "source");
  });
});

describe("AnimationPreview playback", () => {
  /** A glTF file the preview accepts; without an Engine (jsdom) no clip loads, so the clock alone is under test. */
  const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" } }));

  function stubFrames() {
    let now = 0;
    const raf = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextId++;
      raf.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      raf.delete(id);
    });
    return (advanceMs: number) => {
      act(() => {
        now += advanceMs;
        const queued = [...raf.values()];
        raf.clear();
        for (const callback of queued) callback(now);
      });
    };
  }

  const position = () => screen.getByTestId("animation-preview-position").textContent;

  it("plays the authored Duration in real time, pauses, scrubs and restarts", () => {
    const flush = stubFrames();
    render(
      <AnimationPreview
        payload={{ clipName: "Walk", modelGuid: "hero", skeletonGuid: null, sourceAnimationGuid: null, durationMs: 2000, clipDurationMs: 1000 }}
        sourceBytes={gltf}
        materialSlots={[]}
      />,
    );
    expect(position()).toBe("Frame 1/1 · 0/2000 ms");
    flush(0);
    flush(50);
    expect(position()).toBe("Frame 1/1 · 50/2000 ms");
    fireEvent.click(screen.getByTestId("animation-preview-pause"));
    flush(50);
    expect(position()).toBe("Frame 1/1 · 50/2000 ms");
    // Scrubbing moves the playhead and stays paused.
    fireEvent.click(screen.getByTestId("animation-preview-play"));
    // jsdom never measures the track, so Base UI keeps the thumb (and its name) hidden.
    const scrubber = within(screen.getByTestId("animation-preview-scrubber")).getByRole("slider", { hidden: true });
    fireEvent.keyDown(scrubber, { key: "End" });
    expect(position()).toBe("Frame 1/1 · 2000/2000 ms");
    expect(screen.getByTestId("animation-preview-play")).toBeTruthy();
    fireEvent.click(screen.getByTestId("animation-preview-restart"));
    expect(position()).toBe("Frame 1/1 · 0/2000 ms");
  });

  it("stops a clip on its end with Loop off", () => {
    const flush = stubFrames();
    render(
      <AnimationPreview
        payload={{ clipName: "Walk", modelGuid: "hero", skeletonGuid: null, sourceAnimationGuid: null, durationMs: 150 }}
        sourceBytes={gltf}
        materialSlots={[]}
      />,
    );
    fireEvent.click(screen.getByTestId("animation-preview-loop"));
    flush(0);
    flush(100);
    flush(100);
    expect(position()).toBe("Frame 1/1 · 150/150 ms");
    expect(screen.getByTestId("animation-preview-play")).toBeTruthy();
  });

  it("holds time while the preview is not shown", () => {
    const flush = stubFrames();
    render(
      <AnimationPreview
        payload={{ clipName: "Walk", modelGuid: "hero", skeletonGuid: null, sourceAnimationGuid: null, durationMs: 1000 }}
        sourceBytes={gltf}
        materialSlots={[]}
        active={false}
      />,
    );
    flush(0);
    flush(50);
    expect(position()).toBe("Frame 1/1 · 0/1000 ms");
  });

  it("resumes where it stopped, without the time it was hidden", () => {
    const flush = stubFrames();
    const at = (active: boolean) => (
      <AnimationPreview
        payload={{ clipName: "Walk", modelGuid: "hero", skeletonGuid: null, sourceAnimationGuid: null, durationMs: 1000 }}
        sourceBytes={gltf}
        materialSlots={[]}
        active={active}
      />
    );
    const view = render(at(true));
    flush(0);
    flush(40);
    view.rerender(at(false));
    flush(5000);
    view.rerender(at(true));
    flush(30);
    expect(position()).toBe("Frame 1/1 · 70/1000 ms");
  });
});

describe("AnimationEditor additive", () => {
  const walk = { clipName: "Walk", modelGuid: "hero", skeletonGuid: "rig", durationMs: 1000 };
  const written = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)![0] as Record<string, unknown>;
  const choose = (label: string) => {
    fireEvent.click(screen.getByRole("combobox", { name: "Additive" }));
    const option = screen.getByRole("option", { name: label });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  };

  it("makes an Animation additive relative to its first frame, and turns it off again", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AnimationEditor payload={walk} onChange={onChange} />);
    choose("Relative To First Frame");
    expect(written(onChange).additive).toEqual({ base: "firstFrame" });
    // Its base needs no more rows.
    expect(screen.queryByTestId("property-additiveAnimation")).toBeNull();
    rerender(<AnimationEditor payload={{ ...walk, additive: { base: "firstFrame" } }} onChange={onChange} />);
    choose("None");
    expect(written(onChange)).not.toHaveProperty("additive");
  });

  it("names its base Animation and edits the Base Time into it", () => {
    const onChange = vi.fn();
    documents.assets = [{ path: "assets/Idle.hasset", header: { guid: "idle", name: "Idle", type: "Animation", payload: { skeletonGuid: "rig" } } }];
    render(<AnimationEditor payload={{ ...walk, additive: { base: "animation", animationGuid: "idle", timeMs: 0 } }} onChange={onChange} />);
    expect(screen.getByTestId("property-additiveAnimation").textContent).toContain("Idle");
    fireEvent.change(screen.getByTestId("property-additiveTimeMs"), { target: { value: "250" } });
    expect(written(onChange).additive).toEqual({ base: "animation", animationGuid: "idle", timeMs: 250 });
  });
});

describe("AnimationEditor root motion", () => {
  const fall = { clipName: "Death_A", modelGuid: "general", skeletonGuid: "rig", durationMs: 800 };

  it("samples the first bone that travels from the Animation's Model file, shows how far it moves, and turns it off", async () => {
    const onChange = vi.fn();
    documents.assets = [
      { path: "assets/General.model.hasset", header: { guid: "general", name: "General", type: "Model", payload: {} } },
      { path: "assets/Rig.skeleton.hasset", header: { guid: "rig", name: "Rig", type: "Skeleton", payload: { bones: [{ name: "root", parent: -1 }, { name: "hips", parent: 0 }] } } },
    ];
    const glb = new Uint8Array(readFileSync("engine-content/kaykit-assets/Adventurers/Rig_Medium_General.glb"));
    documents.readAssetChunk.mockResolvedValue(glb);
    const { rerender } = render(<AnimationEditor payload={fall} onChange={onChange} />);
    fireEvent.click(within(screen.getByTestId("property-row-rootMotion")).getByRole("checkbox").parentElement!.querySelector("input")!);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(documents.readAssetChunk).toHaveBeenCalledWith("assets/General.model.hasset", "source");
    const written = onChange.mock.calls.at(-1)![0] as { rootMotion: { bone: string; track: { z: number[] } } };
    // The root bone does not move in Death_A; the hips fall back.
    expect(written.rootMotion.bone).toBe("hips");
    rerender(<AnimationEditor payload={{ ...fall, rootMotion: written.rootMotion }} onChange={onChange} />);
    expect(screen.getByTestId("property-row-rootMotionBone").textContent).toContain("Moves 0.45 m and turns 0° each pass");
    fireEvent.click(within(screen.getByTestId("property-row-rootMotion")).getByRole("checkbox").parentElement!.querySelector("input")!);
    await waitFor(() => expect(onChange.mock.calls.at(-1)![0]).not.toHaveProperty("rootMotion"));
  });
});
