import type { ProjectDocument } from "@haptic/core";
import {
  AssetPickerControl,
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
  FieldLegend,
  FieldSet,
} from "@haptic/ui/components/field";
import { Switch } from "@haptic/ui/components/switch";
import type { DocumentActions, RegistryState } from "../context/document-context-types";
import { gameInstanceClassEntries } from "../lib/component-property-rows";
import { classIdFromClassAsset } from "../lib/content-browser-helpers";

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
    <FieldGroup className="gap-4">
      <FieldSet>
        <FieldLegend>Game</FieldLegend>
        <Field>
          <FieldLabel>Startup Scene</FieldLabel>
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
          <FieldDescription>
            Exported games start here. Play and Preview use it when Play
            From Scene is off.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Game Instance</FieldLabel>
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
          <FieldDescription>
            GameInstance subclass created for Play, Preview and exported
            games.
          </FieldDescription>
        </Field>
      </FieldSet>
      <FieldSet>
        <FieldLegend>2D</FieldLegend>
          <Field className="settings-field">
            <FieldLabel htmlFor="pixels-per-unit">
              Pixels Per Unit
            </FieldLabel>
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
          <FieldDescription id="pixels-per-unit-description">
            Texture pixels per world unit. Sizes sprites, tilemaps and 2D
            text.
          </FieldDescription>
        </Field>
          <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="settings-pixel-perfect">
              Pixel-Perfect Mode
          </FieldLabel>
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
          <FieldDescription id="settings-pixel-perfect-description">
            Frames the 2D editor view 1:1 with nearest sampling. Play and
            exported games snap the game camera to the pixel grid.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Sorting Layers</FieldLabel>
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
            <FieldDescription>Ordered back to front.</FieldDescription>
        </Field>
      </FieldSet>
    </FieldGroup>
  );
}
