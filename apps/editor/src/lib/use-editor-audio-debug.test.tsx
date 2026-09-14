import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyPlayAudioLibrary } from "./play-audio";
import { useEditorAudioDebug } from "./use-editor-audio-debug";

const documents = vi.hoisted(() => ({
  openDocuments: [] as Array<{ id: string; ref: { kind: string }; content: unknown }>,
  registryVersion: 0,
  collectPlayAudio: vi.fn<() => Promise<{
    library: import("./play-audio").PlayAudioLibrary;
    loadSourceBytes: import("./play-audio").PlayAudioSourceLoader;
  }>>(),
}));
vi.mock("../context/document-context", () => ({ useDocuments: () => documents }));

afterEach(() => {
  cleanup();
  documents.openDocuments = [];
  documents.registryVersion = 0;
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
  documents.registryVersion += 1;
  rerender();
  await waitFor(() => expect(documents.collectPlayAudio).toHaveBeenCalledTimes(3));
});

it("discards a superseded metadata load and clears helpers when selection no longer needs audio", async () => {
  const oldLibrary = emptyPlayAudioLibrary("old");
  const currentLibrary = emptyPlayAudioLibrary("current");
  let finishOld!: (value: Awaited<ReturnType<typeof documents.collectPlayAudio>>) => void;
  documents.collectPlayAudio.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
  documents.collectPlayAudio.mockResolvedValue({ library: currentLibrary, loadSourceBytes: async () => null });
  const { result, rerender } = renderHook(({ enabled }) => useEditorAudioDebug(enabled), { initialProps: { enabled: true } });
  documents.registryVersion += 1;
  rerender({ enabled: true });
  await waitFor(() => expect(result.current).toBe(currentLibrary));
  await act(async () => finishOld({ library: oldLibrary, loadSourceBytes: async () => null }));
  expect(result.current).toBe(currentLibrary);
  rerender({ enabled: false });
  expect(result.current).toBeUndefined();
});
