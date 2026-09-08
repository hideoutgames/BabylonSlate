import { readFile } from "node:fs/promises";
import { type Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import {
  createDefaultAudioPayload,
  createDefaultSoundAttenuationPayload,
} from "../packages/assets/src/audio-payload";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";

/** Playback proofs start with saved source bytes; import/author journeys remain separate. */
export async function openAudioTestProject(
  page: Page,
  spatial = false,
): Promise<void> {
  const files = await minimalProjectFiles();
  const migrations = createDefaultMigrationRegistry();
  const attenuationGuid = "00000000-0000-4000-8000-000000000004";
  if (spatial) {
    files.set(
      "assets/Near.atten.babasset",
      await encodeAssetDocument({
        guid: attenuationGuid,
        type: "SoundAttenuation",
        name: "Near",
        version: migrations.currentVersion("SoundAttenuation"),
        payload: { ...createDefaultSoundAttenuationPayload() },
      }),
    );
  }
  files.set(
    "assets/beep.babasset",
    await encodeAssetDocument(
      {
        guid: "00000000-0000-4000-8000-000000000003",
        type: "Audio",
        name: "beep",
        version: migrations.currentVersion("Audio"),
        payload: {
          ...createDefaultAudioPayload(),
          loop: true,
          soundAttenuationGuid: spatial ? attenuationGuid : null,
          clips: [{ chunkId: "source", name: "beep", weight: 1 }],
        },
      },
      {
        dependencies: spatial ? [attenuationGuid] : [],
        extraChunks: [
          {
            id: "source",
            kind: "audio",
            mime: "audio/wav",
            data: new Uint8Array(
              await readFile(new URL("./fixtures/beep.wav", import.meta.url)),
            ),
          },
        ],
      },
    ),
  );
  await openMinimalTestProject(page, files);
}
