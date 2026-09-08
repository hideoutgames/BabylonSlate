import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultAudioPayload } from "@babylonslate/assets";
import { AudioClips, AudioDetails, AudioPreview } from "./audio-editor";

const audioIO = vi.hoisted(() => ({
  pick: vi.fn(async () => [{ name: "new.wav", bytes: new Uint8Array([1, 2, 3]) }]),
  write: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));
vi.mock("@babylonslate/vfs", async (original) => ({
  ...await original<typeof import("@babylonslate/vfs")>(),
  pickImportFiles: audioIO.pick,
}));

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "ch-1", name: "SFX", type: "AudioChannel" },
          path: "assets/SFX.channel.babasset",
        },
        {
          header: { guid: "att-1", name: "Near", type: "SoundAttenuation" },
          path: "assets/Near.atten.babasset",
        },
      ],
    },
    readAssetChunk: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    writeAudioClipChunk: audioIO.write,
    removeAudioClipChunk: audioIO.remove,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Audio editor docks", () => {
  it("shows a failed project audio write without adding an unsaved clip", async () => {
    audioIO.write.mockRejectedValueOnce(new Error("Folder access revoked"));
    const onChange = vi.fn();
    render(<AudioClips path="assets/Jump.babasset" assetName="Jump" payload={{ clips: [{ chunkId: "source", name: "Jump", weight: 1 }] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("audio-add-clip"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Folder access revoked"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("audio-add-clip").hasAttribute("disabled")).toBe(false);
  });

  it("keeps the clip listed when its project storage removal fails", async () => {
    audioIO.remove.mockRejectedValueOnce(new Error("Folder is offline"));
    const onChange = vi.fn();
    render(<AudioClips path="assets/Jump.babasset" assetName="Jump" payload={{ clips: [{ chunkId: "source", name: "Jump", weight: 1 }, { chunkId: "clip-1", name: "Second", weight: 1 }] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("audio-clip-1-remove"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Folder is offline"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("audio-clip-1-name").textContent).toBe("Second");
  });
  it("keeps Preview Play, Loop, and waveform on the Preview surface", () => {
    render(
      <AudioPreview
        path="assets/Jump.babasset"
        payload={createDefaultAudioPayload() as unknown as Record<string, unknown>}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("audio-preview")).toBeTruthy();
    expect(screen.getByTestId("audio-preview-play")).toBeTruthy();
    expect(screen.getByTestId("audio-preview-loop")).toBeTruthy();
    expect(screen.getByTestId("audio-preview-waveform")).toBeTruthy();
    expect(screen.queryByTestId("property-volume")).toBeNull();
    expect(screen.queryByTestId("audio-clips")).toBeNull();
  });

  it("puts Volume, Loop, Pitch, Channel, and Attenuation on Details", () => {
    render(
      <AudioDetails
        payload={{ volume: 0.5 }}
        assetName="Jump"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("property-volume")).toBeTruthy();
    expect(screen.getByTestId("property-loop")).toBeTruthy();
    expect(screen.getByTestId("property-pitch")).toBeTruthy();
    expect(screen.getByTestId("property-pitchRandom")).toBeTruthy();
    expect(screen.getByTestId("property-audioChannelGuid")).toBeTruthy();
    expect(screen.getByTestId("property-soundAttenuationGuid")).toBeTruthy();
    expect(screen.queryByTestId("audio-clips")).toBeNull();
    expect(screen.queryByTestId("audio-preview-play")).toBeNull();
  });

  it("hides Pitch when Randomize Pitch is on and keeps min/max", () => {
    render(
      <AudioDetails
        payload={{ pitchRandom: true, pitchMin: 0.5, pitchMax: 1.5 }}
        assetName="Jump"
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("property-pitch")).toBeNull();
    expect(screen.getByTestId("property-pitchRandom")).toBeTruthy();
    expect(screen.getByTestId("property-pitchMin")).toBeTruthy();
    expect(screen.getByTestId("property-pitchMax")).toBeTruthy();
  });

  it("fills an empty source clip name as read-only text and keeps Weight editable", async () => {
    const onChange = vi.fn();
    render(
      <AudioClips
        path="assets/Jump.babasset"
        payload={{}}
        assetName="Jump"
        onChange={onChange}
      />,
    );
    const name = screen.getByTestId("audio-clip-0-name");
    expect(name.tagName).not.toBe("INPUT");
    expect(name.textContent).toBe("Jump");
    expect(screen.getByTestId("audio-clip-0-weight")).toBeTruthy();
    expect(screen.getByTestId("audio-add-clip")).toBeTruthy();
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          clips: [expect.objectContaining({ chunkId: "source", name: "Jump" })],
        }),
      );
    });
  });

  it("does not treat a filled clip name as an input", () => {
    render(
      <AudioClips
        path="assets/Jump.babasset"
        payload={{
          clips: [{ chunkId: "source", name: "jump", weight: 2 }],
        }}
        assetName="Jump"
        onChange={vi.fn()}
      />,
    );
    const name = screen.getByTestId("audio-clip-0-name");
    expect(name.tagName).not.toBe("INPUT");
    expect(name.textContent).toBe("jump");
    expect(screen.getByTestId("audio-clip-0-weight")).toBeTruthy();
  });
});
