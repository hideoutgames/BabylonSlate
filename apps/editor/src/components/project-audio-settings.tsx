import type { ProjectDocument } from "@haptic/core";
import {
  AssetPickerControl,
  NumberField,
  assetRowIdentity,
  selectedPickerIdentity,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@haptic/ui/components/field";
import { Slider } from "@haptic/ui/components/slider";
import { Switch } from "@haptic/ui/components/switch";
import type { DocumentActions, RegistryState } from "../context/document-context-types";

interface ProjectAudioSettingsProps {
  projectDocument: ProjectDocument;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  assetRegistry: RegistryState["assetRegistry"];
  setMixerPickerOpen: (open: boolean) => void;
}

/** Project Settings → Audio: Audio Mixer, Occlusion and reverb scales. The host renders the picker. */
export function ProjectAudioSettings({
  projectDocument,
  updateProjectSettings,
  assetRegistry,
  setMixerPickerOpen,
}: ProjectAudioSettingsProps) {
  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend>Audio</FieldLegend>
        <Field>
          <FieldLabel>Audio Mixer</FieldLabel>
          <AssetPickerControl
            value={projectDocument.settings.audio.audioMixerGuid}
          >
            <Button
              type="button"
              variant="outline"
                className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
              onClick={() => setMixerPickerOpen(true)}
              data-testid="settings-audio-mixer"
              id="settings-audio-mixer"
            >
              {selectedPickerIdentity(
                assetRowIdentity(
                  (() => {
                    const asset = assetRegistry
                      ?.list()
                      .find(
                        (entry) =>
                          entry.header.guid ===
                          projectDocument.settings.audio.audioMixerGuid,
                      );
                    return asset
                      ? {
                          name: asset.header.name,
                          type: asset.header.type,
                        }
                      : undefined;
                  })(),
                ),
              )}
            </Button>
          </AssetPickerControl>
          <FieldDescription>
              None bypasses channel and master volume controls.
          </FieldDescription>
        </Field>
          <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="settings-audio-occlusion">
            Occlusion
          </FieldLabel>
          <Switch
            id="settings-audio-occlusion"
            aria-describedby="settings-audio-occlusion-description"
            checked={projectDocument.settings.audio.occlusionEnabled}
            onCheckedChange={(checked) =>
              updateProjectSettings({
                audio: {
                  ...projectDocument.settings.audio,
                  occlusionEnabled: checked === true,
                },
              })
            }
            data-testid="settings-audio-occlusion"
          />
          <FieldDescription id="settings-audio-occlusion-description">
            Wall muffling for channels with Muffle Through Walls enabled.
          </FieldDescription>
        </Field>
        {(
          [
              [
                "settings-audio-reverb-wet-scale",
                "Reverb Wet Scale",
                "reverbWetScale",
              ],
              [
                "settings-audio-reverb-decay-scale",
                "Reverb Decay Scale",
                "reverbDecayScale",
              ],
            [
              "settings-audio-reverb-damping-scale",
              "Reverb Damping Scale",
              "reverbDampingScale",
            ],
          ] as const
        ).map(([id, label, key]) => (
          <Field key={id}>
            <FieldLabel id={`${id}-label`} htmlFor={id}>{label}</FieldLabel>
            <div className="flex min-w-0 items-center gap-2">
              <Slider
                aria-labelledby={`${id}-label`}
                className="min-w-0 flex-1"
                min={0}
                max={2}
                step={0.05}
                value={projectDocument.settings.audio[key]}
                onValueChange={(next) => {
                  const scale = Array.isArray(next) ? next[0] : next;
                  if (typeof scale !== "number") return;
                  updateProjectSettings({
                    audio: {
                      ...projectDocument.settings.audio,
                      [key]: scale,
                    },
                  });
                }}
                data-testid={`${id}-slider`}
              />
              <div className="w-20 shrink-0">
                <NumberField
                  id={id}
                  min={0}
                  max={2}
                  step={0.05}
                    className="min-h-[var(--chrome-row,28px)]"
                  value={projectDocument.settings.audio[key]}
                  onChange={(scale) =>
                    updateProjectSettings({
                      audio: {
                        ...projectDocument.settings.audio,
                        [key]: scale,
                      },
                    })
                  }
                  data-testid={id}
                />
              </div>
            </div>
          </Field>
        ))}
        <FieldDescription>
          Scales baked environment reverb. Sounds without a channel stay dry.
        </FieldDescription>
      </FieldSet>
    </FieldGroup>
  );
}
