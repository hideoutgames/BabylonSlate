import { useEffect, useState } from "react";
import { useDocuments } from "../context/document-context";
import type { PlayAudioLibrary } from "./play-audio";

/** Selection helpers need audio metadata only; source clips remain unloaded. */
export function useEditorAudioDebug(enabled: boolean): PlayAudioLibrary | undefined {
  const { collectPlayAudio, openDocuments, registryVersion } = useDocuments();
  const [library, setLibrary] = useState<PlayAudioLibrary>();
  // Scene/gizmo changes also replace openDocuments. Only audio drafts should
  // reload the metadata; registryVersion covers saved, imported and deleted assets.
  const draftKey = JSON.stringify(openDocuments
    .filter((doc) => doc.ref.kind === "audio" || doc.ref.kind === "sound-attenuation")
    .map((doc) => [doc.id, doc.content]));
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
  }, [collectPlayAudio, draftKey, enabled, registryVersion]);
  return enabled ? library : undefined;
}
