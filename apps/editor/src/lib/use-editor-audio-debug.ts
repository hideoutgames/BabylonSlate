import { useEffect, useState } from "react";
import { useDocuments } from "../context/document-context";
import type { PlayAudioLibrary } from "./play-audio";

/** Selection helpers need audio metadata only; source clips remain unloaded. */
export function useEditorAudioDebug(enabled: boolean): PlayAudioLibrary | undefined {
  const { collectPlayAudio, openDocuments, projectDocument, registryEpoch } = useDocuments();
  const [library, setLibrary] = useState<PlayAudioLibrary>();
  // Scene/gizmo changes also replace openDocuments. Only audio drafts should
  // reload the metadata; registryEpoch covers saved, imported and deleted assets.
  const draftKey = JSON.stringify(openDocuments
    .filter((doc) => doc.ref.kind === "audio" || doc.ref.kind === "sound-attenuation")
    .map((doc) => [doc.id, doc.content]));
  // collectPlayAudio keeps its identity and reads the project's mixer when it
  // runs, so a Project Settings mixer change must reload the metadata itself.
  const audioMixerGuid = projectDocument?.settings.audio.audioMixerGuid ?? null;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void collectPlayAudio().then((result) => {
      if (!cancelled) setLibrary(result.library);
    }).catch((error: unknown) => {
      if (!cancelled) {
        setLibrary(undefined);
        console.error("[editor] Failed to load audio selection metadata", error);
      }
    });
    return () => { cancelled = true; };
  }, [audioMixerGuid, collectPlayAudio, draftKey, enabled, registryEpoch]);
  return enabled ? library : undefined;
}
