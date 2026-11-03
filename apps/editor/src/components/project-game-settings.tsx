import { nearestTextureFiltering, type ProjectDocument } from "@haptic/core";
import {
  AssetPickerControl,
  LabelHint,
  NamedListEditor,
  NumberField,
  assetRowIdentity,
  classRowIdentity,
  selectedPickerIdentity,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Switch } from "@haptic/ui/components/switch";
import type { DocumentActions, RegistryState } from "../context/document-context-types";
import { gameInstanceClassEntries } from "../lib/component-property-rows";
import { classIdFromClassAsset } from "../lib/content-browser-helpers";
import { SettingsSection } from "./settings-section";

// Label tooltips that also stay their control's screen-reader description.
const PIXELS_PER_UNIT_HINT = "Texture pixels per world unit. Sizes sprites, tilemaps and 2D text.";
const PIXEL_PERFECT_HINT = "Frames the 2D editor view 1:1. Play and exported games snap the game camera to the pixel grid.";
const NEAREST_TEXTURES_HINT = "Samples every Material texture with nearest-neighbour filtering, in 3D too.";

interface ProjectGameSettingsProps {
  projectDocument: ProjectDocument;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  assetRegistry: RegistryState["assetRegistry"];
  setScenePickerOpen: (open: boolean) => void;
  setGameInstancePickerOpen: (open: boolean) => void;
}

/** Project Settings → Game: Startup Scene, Game Instance and 2D. The host renders the pickers. */
export function ProjectGameSettings({
  projectDocument,
  updateProjectSettings,
  assetRegistry,
  setScenePickerOpen,
  setGameInstancePickerOpen,
}: ProjectGameSettingsProps) {
  const twoD = projectDocument.settings.twoD;
  return (
    <FieldGroup>
      <SettingsSection id="startup" title="Startup">
        <Field className="settings-field">
          <LabelHint hint="Exported games start here. Play and Preview use it when Play From Scene is off.">
            <FieldLabel>Startup Scene</FieldLabel>
          </LabelHint>
          <AssetPickerControl
            value={projectDocument.settings.startupSceneGuid}
          >
            <Button
              type="button"
              variant="outline"
              className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
              onClick={() => setScenePickerOpen(true)}
              data-testid="settings-startup-scene"
              id="settings-startup-scene"
            >
              {selectedPickerIdentity(
                assetRowIdentity(
                  (() => {
                    const asset = assetRegistry
                      ?.list()
                      .find(
                        (entry) =>
                          entry.header.guid ===
                          projectDocument.settings.startupSceneGuid,
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
        </Field>
        <Field className="settings-field">
          <LabelHint hint="GameInstance subclass created for Play, Preview and exported games.">
            <FieldLabel>Game Instance</FieldLabel>
          </LabelHint>
          <AssetPickerControl
            value={
              assetRegistry
                ?.list()
                .find(
                  (asset) =>
                    asset.header.type === "Class" &&
                    classIdFromClassAsset(asset) ===
                      projectDocument.settings.gameInstanceClass,
                )?.header.guid
            }
          >
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
            onClick={() => setGameInstancePickerOpen(true)}
            data-testid="settings-game-instance"
            id="settings-game-instance"
          >
            {selectedPickerIdentity(
              classRowIdentity(
                gameInstanceClassEntries(
                  assetRegistry?.list() ?? [],
                ).find(
                  (entry) =>
                    entry.id ===
                    projectDocument.settings.gameInstanceClass,
                ),
                projectDocument.settings.gameInstanceClass,
              ),
            )}
          </Button>
          </AssetPickerControl>
        </Field>
      </SettingsSection>
      <SettingsSection id="twoD" title="2D">
          <Field className="settings-field">
            <LabelHint hint={PIXELS_PER_UNIT_HINT}>
              <FieldLabel htmlFor="pixels-per-unit">
                Pixels Per Unit
              </FieldLabel>
            </LabelHint>
          <NumberField
            id="pixels-per-unit"
            aria-describedby="pixels-per-unit-description"
            min={1}
            step={1}
              className="min-h-[var(--chrome-row,28px)]"
            value={twoD.pixelsPerUnit}
            onChange={(pixelsPerUnit) =>
              updateProjectSettings({
                twoD: {
                  ...twoD,
                  pixelsPerUnit,
                },
              })
            }
            data-testid="settings-pixels-per-unit"
          />
          <FieldDescription id="pixels-per-unit-description" className="sr-only">
            {PIXELS_PER_UNIT_HINT}
          </FieldDescription>
        </Field>
          <Field orientation="horizontal" className="settings-field">
          <LabelHint hint={PIXEL_PERFECT_HINT}>
            <FieldLabel htmlFor="settings-pixel-perfect">
              Pixel-Perfect Mode
            </FieldLabel>
          </LabelHint>
          <Switch
            id="settings-pixel-perfect"
            aria-describedby="settings-pixel-perfect-description"
            checked={twoD.pixelPerfect}
            onCheckedChange={(checked) =>
              updateProjectSettings({
                twoD: { ...twoD, pixelPerfect: checked === true },
              })
            }
            data-testid="settings-pixel-perfect"
          />
          <FieldDescription id="settings-pixel-perfect-description" className="sr-only">
            {PIXEL_PERFECT_HINT}
          </FieldDescription>
        </Field>
          <Field orientation="horizontal" className="settings-field settings-field-dependent" data-disabled={!twoD.pixelPerfect}>
          <LabelHint hint={NEAREST_TEXTURES_HINT}>
            <FieldLabel htmlFor="settings-nearest-textures">
              Nearest Texture Filtering
            </FieldLabel>
          </LabelHint>
          <Switch
            id="settings-nearest-textures"
            aria-describedby={twoD.pixelPerfect ? "settings-nearest-textures-description" : "settings-nearest-textures-description settings-nearest-textures-status"}
            disabled={!twoD.pixelPerfect}
            checked={nearestTextureFiltering(twoD)}
            onCheckedChange={(checked) =>
              updateProjectSettings({
                twoD: { ...twoD, nearestTextures: checked === true },
              })
            }
            data-testid="settings-nearest-textures"
          />
          <FieldDescription id="settings-nearest-textures-description" className="sr-only">
            {NEAREST_TEXTURES_HINT}
          </FieldDescription>
          {twoD.pixelPerfect ? null : (
            <FieldDescription id="settings-nearest-textures-status">Needs Pixel-Perfect Mode.</FieldDescription>
          )}
        </Field>
      </SettingsSection>
      <SettingsSection id="sortingLayers" title="Sorting Layers">
        <Field className="settings-row">
          <FieldLabel className="sr-only">Sorting Layers</FieldLabel>
          <NamedListEditor
            values={twoD.sortingLayers}
            onChange={(sortingLayers) =>
              updateProjectSettings({
                twoD: { ...twoD, sortingLayers },
              })
            }
            itemLabel="Sorting Layer"
            addPlaceholder="New Layer"
            addLabel="Add Layer"
            data-testid="settings-sorting-layers"
          />
        </Field>
      </SettingsSection>
    </FieldGroup>
  );
}
