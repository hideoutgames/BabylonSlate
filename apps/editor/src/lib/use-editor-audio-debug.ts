import { useEffect, useState } from "react";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import type { PlayAudioLibrary } from "./play-audio";
import { useOpenDocumentsOfKinds } from "./use-open-documents-of-kinds";

const AUDIO_DRAFT_KINDS = ["audio", "sound-attenuation"] as const;

/** Selection helpers need audio metadata only; source clips remain unloaded. */
export function useEditorAudioDebug(enabled: boolean): PlayAudioLibrary | undefined {
  const { collectPlayAudio } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { registryEpoch } = useRegistryState();
  // Only audio drafts reload the metadata (and re-render this hook's caller);
  // registryEpoch covers saved, imported and deleted assets.
  const audioDocuments = useOpenDocumentsOfKinds(AUDIO_DRAFT_KINDS);
  const [library, setLibrary] = useState<PlayAudioLibrary>();
  const draftKey = JSON.stringify(audioDocuments.map((doc) => [doc.id, doc.content]));
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
