import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyPlayAudioLibrary } from "./play-audio";
import { useEditorAudioDebug } from "./use-editor-audio-debug";

const documents = vi.hoisted(() => ({
  openDocuments: [] as Array<{ id: string; ref: { kind: string }; content: unknown }>,
  registryEpoch: 0,
  projectDocument: null as null | {
    settings: { audio: { audioMixerGuid: string | null }; playFrameCap?: number };
  },
  collectPlayAudio: vi.fn<() => Promise<{
    library: import("./play-audio").PlayAudioLibrary;
    loadSourceBytes: import("./play-audio").PlayAudioSourceLoader;
  }>>(),
}));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => documents));

afterEach(() => {
  cleanup();
  documents.openDocuments = [];
  documents.registryEpoch = 0;
  documents.projectDocument = null;
  documents.collectPlayAudio.mockReset();
});

it("refreshes audio drafts and registry changes while ignoring scene edits", async () => {
  const library = emptyPlayAudioLibrary();
  documents.collectPlayAudio.mockResolvedValue({ library, loadSourceBytes: async () => null });
  const { result, rerender } = renderHook(() => useEditorAudioDebug(true));
  await waitFor(() => expect(result.current).toBe(library));
  documents.openDocuments = [{ id: "scene:S", ref: { kind: "scene" }, content: { actors: [] } }];
  rerender();
  expect(documents.collectPlayAudio).toHaveBeenCalledTimes(1);
  documents.openDocuments.push({ id: "sound-attenuation:A", ref: { kind: "sound-attenuation" }, content: { innerRadius: 7 } });
  rerender();
  await waitFor(() => expect(documents.collectPlayAudio).toHaveBeenCalledTimes(2));
  documents.registryEpoch += 1;
  rerender();
  await waitFor(() => expect(documents.collectPlayAudio).toHaveBeenCalledTimes(3));
});

it("reloads when Project Settings select another audio mixer, not for other settings edits", async () => {
  documents.collectPlayAudio.mockResolvedValue({ library: emptyPlayAudioLibrary(), loadSourceBytes: async () => null });
  documents.projectDocument = { settings: { audio: { audioMixerGuid: "mixer-a" } } };
  const { rerender } = renderHook(() => useEditorAudioDebug(true));
  await waitFor(() => expect(documents.collectPlayAudio).toHaveBeenCalledTimes(1));
  documents.projectDocument = { settings: { audio: { audioMixerGuid: "mixer-a" }, playFrameCap: 30 } };
  rerender();
  expect(documents.collectPlayAudio).toHaveBeenCalledTimes(1);
  documents.projectDocument = { settings: { audio: { audioMixerGuid: "mixer-b" } } };
  rerender();
  await waitFor(() => expect(documents.collectPlayAudio).toHaveBeenCalledTimes(2));
});

it("discards a superseded metadata load and clears helpers when selection no longer needs audio", async () => {
  const oldLibrary = emptyPlayAudioLibrary("old");
  const currentLibrary = emptyPlayAudioLibrary("current");
  let finishOld!: (value: Awaited<ReturnType<typeof documents.collectPlayAudio>>) => void;
  documents.collectPlayAudio.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
  documents.collectPlayAudio.mockResolvedValue({ library: currentLibrary, loadSourceBytes: async () => null });
  const { result, rerender } = renderHook(({ enabled }) => useEditorAudioDebug(enabled), { initialProps: { enabled: true } });
  documents.registryEpoch += 1;
  rerender({ enabled: true });
  await waitFor(() => expect(result.current).toBe(currentLibrary));
  await act(async () => finishOld({ library: oldLibrary, loadSourceBytes: async () => null }));
  expect(result.current).toBe(currentLibrary);
  rerender({ enabled: false });
  expect(result.current).toBeUndefined();
});
