import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CatalogDialog,
  type CatalogCategory,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Textarea } from "@babylonslate/ui/components/textarea";
import { Separator } from "@babylonslate/ui/components/separator";
import {
  createAppSettingsStore,
  defaultEngineSettings,
  type EngineSettings,
} from "@babylonslate/vfs";
import { LogOutIcon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { EngineSettingsForm } from "./engine-settings-form";

type SettingsScope = "project" | "engine";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Initial scope when the modal opens. */
  initialScope?: SettingsScope;
  /** Include both Project and Engine category groups (editor chrome). */
  allowEngine?: boolean;
  onCloseProject?: () => void;
  onEngineSaved?: () => void | Promise<void>;
  "data-testid"?: string;
}

const PROJECT_CATEGORIES: Array<CatalogCategory & { keywords: string }> = [
  {
    id: "general",
    label: "General",
    keywords: "project name version touch target",
  },
  {
    id: "input",
    label: "Input",
    keywords: "actions axes bindings gamepad keyboard",
  },
  {
    id: "twoD",
    label: "2D",
    keywords: "pixels per unit pixel perfect integer zoom sorting layers",
  },
  {
    id: "textures",
    label: "Textures",
    keywords: "max dimension encoding retry compression",
  },
  {
    id: "export",
    label: "Export",
    keywords: "export project zip download",
  },
  {
    id: "project",
    label: "Close",
    keywords: "close project homepage dirty save",
  },
];

const ENGINE_CATEGORY: CatalogCategory & { keywords: string } = {
  id: "engine",
  label: "Engine",
  keywords:
    "undo history viewport frame cap thumbnails templates folder appearance",
};

export function SettingsModal({
  open,
  onOpenChange,
  initialScope = "project",
  allowEngine = true,
  onCloseProject,
  onEngineSaved,
  "data-testid": testId = "settings-modal",
}: SettingsModalProps) {
  const {
    projectDocument,
    exportProject,
    retryFailedTextureEncoding,
    updateProjectSettings,
  } = useDocuments();
  const [search, setSearch] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState(
    initialScope === "engine" ? "engine" : "general",
  );
  const store = useMemo(() => createAppSettingsStore(), []);
  const [engineSettings, setEngineSettings] = useState<EngineSettings>(
    defaultEngineSettings(),
  );

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setActiveCategoryId(initialScope === "engine" ? "engine" : "general");
    if (allowEngine || initialScope === "engine") {
      void store.load().then(setEngineSettings);
    }
  }, [open, initialScope, allowEngine, store]);

  const saveEngine = useCallback(
    async (patch: Partial<EngineSettings>) => {
      const next = { ...engineSettings, ...patch };
      setEngineSettings(next);
      await store.save(next);
      await onEngineSaved?.();
    },
    [engineSettings, onEngineSaved, store],
  );

  const categories = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (label: string, keywords: string) =>
      !needle || `${label} ${keywords}`.toLowerCase().includes(needle);

    const list: CatalogCategory[] = [];
    if (projectDocument) {
      for (const category of PROJECT_CATEGORIES) {
        if (matches(category.label, category.keywords)) {
          list.push({ id: category.id, label: category.label });
        }
      }
    }
    if (allowEngine || initialScope === "engine") {
      if (matches(ENGINE_CATEGORY.label, ENGINE_CATEGORY.keywords)) {
        list.push({ id: ENGINE_CATEGORY.id, label: ENGINE_CATEGORY.label });
      }
    }
    if (list.length === 0 && (allowEngine || initialScope === "engine")) {
      list.push({ id: ENGINE_CATEGORY.id, label: ENGINE_CATEGORY.label });
    }
    return list;
  }, [allowEngine, initialScope, projectDocument, search]);

  useEffect(() => {
    if (!categories.some((category) => category.id === activeCategoryId)) {
      setActiveCategoryId(categories[0]?.id ?? "general");
    }
  }, [activeCategoryId, categories]);

  const handleExport = async () => {
    if (!projectDocument) return;
    const bytes = await exportProject();
    const blob = new Blob([bytes.buffer as ArrayBuffer], {
      type: "application/zip",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${projectDocument.metadata.name.replace(/\s+/g, "_")}.babproject`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const showProjectBody =
    Boolean(projectDocument) && activeCategoryId !== "engine";
  const twoD = projectDocument?.settings.twoD;

  return (
    <CatalogDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        initialScope === "engine" && !projectDocument
          ? "Engine Settings"
          : "Settings"
      }
      description={
        projectDocument
          ? `Configuration for ${projectDocument.metadata.name}`
          : "Global editor preferences stored outside any project"
      }
      categories={categories}
      activeCategoryId={activeCategoryId}
      onCategoryChange={setActiveCategoryId}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search settings"
      data-testid={testId}
    >
      {activeCategoryId === "engine" ? (
        <EngineSettingsForm settings={engineSettings} onChange={saveEngine} />
      ) : null}

      {showProjectBody && projectDocument && twoD && activeCategoryId === "general" ? (
        <FieldGroup>
          <Field>
            <FieldLabel>Project name</FieldLabel>
            <p className="text-sm">{projectDocument.metadata.name}</p>
          </Field>
          <Field>
            <FieldLabel>Version</FieldLabel>
            <p className="text-sm">{projectDocument.metadata.version}</p>
          </Field>
          <Field>
            <FieldLabel>Touch target minimum</FieldLabel>
            <p className="text-sm">
              {projectDocument.settings.touchMinTargetPx}px
            </p>
            <FieldDescription>
              Matches shell <code>--touch-target</code> on this device.
            </FieldDescription>
          </Field>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "input" ? (
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel>Actions</FieldLabel>
            <FieldDescription>
              Named actions resolve through the input mapping model. Edit the
              JSON below; each binding needs a device and code.
            </FieldDescription>
            <Textarea
              className="min-h-32 font-mono text-xs"
              value={JSON.stringify(
                projectDocument.settings.input.actions,
                null,
                2,
              )}
              onChange={(event) => {
                try {
                  const actions = JSON.parse(event.target.value) as unknown;
                  if (!Array.isArray(actions)) return;
                  updateProjectSettings({
                    input: {
                      ...projectDocument.settings.input,
                      actions:
                        actions as typeof projectDocument.settings.input.actions,
                    },
                  });
                } catch {
                  // Keep typing until the JSON is valid again.
                }
              }}
              data-testid="settings-input-actions"
            />
          </Field>
          <Field>
            <FieldLabel>Axes</FieldLabel>
            <Textarea
              className="min-h-32 font-mono text-xs"
              value={JSON.stringify(
                projectDocument.settings.input.axes,
                null,
                2,
              )}
              onChange={(event) => {
                try {
                  const axes = JSON.parse(event.target.value) as unknown;
                  if (!Array.isArray(axes)) return;
                  updateProjectSettings({
                    input: {
                      ...projectDocument.settings.input,
                      axes: axes as typeof projectDocument.settings.input.axes,
                    },
                  });
                } catch {
                  // Keep typing until the JSON is valid again.
                }
              }}
              data-testid="settings-input-axes"
            />
          </Field>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && twoD && activeCategoryId === "twoD" ? (
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="pixels-per-unit">Pixels per unit</FieldLabel>
            <Input
              id="pixels-per-unit"
              type="number"
              min={1}
              step={1}
              className="min-h-11"
              value={twoD.pixelsPerUnit}
              onChange={(event) =>
                updateProjectSettings({
                  twoD: {
                    ...twoD,
                    pixelsPerUnit: Number(event.target.value) || 100,
                  },
                })
              }
              data-testid="settings-pixels-per-unit"
            />
            <FieldDescription>
              Texture pixels that span one world unit in 2D scenes.
            </FieldDescription>
          </Field>
          <Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={twoD.pixelPerfect}
                onChange={(event) =>
                  updateProjectSettings({
                    twoD: { ...twoD, pixelPerfect: event.target.checked },
                  })
                }
                data-testid="settings-pixel-perfect"
              />
              Pixel-perfect mode
            </label>
            <FieldDescription>
              Ortho bounds from canvas size, nearest sampling, camera snapped to
              the pixel grid.
            </FieldDescription>
          </Field>
          <Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={twoD.integerZoomSteps}
                onChange={(event) =>
                  updateProjectSettings({
                    twoD: {
                      ...twoD,
                      integerZoomSteps: event.target.checked,
                    },
                  })
                }
                data-testid="settings-integer-zoom"
              />
              Integer zoom steps
            </label>
          </Field>
          <Field>
            <FieldLabel htmlFor="sorting-layers">Sorting layers</FieldLabel>
            <Input
              id="sorting-layers"
              className="min-h-11"
              value={twoD.sortingLayers.join(", ")}
              onChange={(event) =>
                updateProjectSettings({
                  twoD: {
                    ...twoD,
                    sortingLayers: event.target.value
                      .split(",")
                      .map((layer) => layer.trim())
                      .filter(Boolean),
                  },
                })
              }
              data-testid="settings-sorting-layers"
            />
            <FieldDescription>
              Comma-separated, back to front. Compiles to one alphaIndex sort
              key per sprite.
            </FieldDescription>
          </Field>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "textures" ? (
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel>Texture policy</FieldLabel>
            <FieldDescription>
              Max dimension{" "}
              {projectDocument.settings.textures.maxTextureDimension}
              px. Auto re-queue uncompressed:{" "}
              {projectDocument.settings.textures.autoRequeueUncompressed
                ? "on"
                : "off"}
              .
            </FieldDescription>
          </Field>
          <Button
            variant="secondary"
            data-testid="retry-texture-encoding"
            onClick={() => void retryFailedTextureEncoding()}
          >
            Retry encoding
          </Button>
        </FieldGroup>
      ) : null}

      {showProjectBody && projectDocument && activeCategoryId === "export" ? (
        <FieldGroup className="gap-4">
          <Separator />
          <Field>
            <FieldLabel>Export Project</FieldLabel>
            <FieldDescription>
              Download a zip of the project directory layout.
            </FieldDescription>
          </Field>
          <Button data-testid="export-project" onClick={() => void handleExport()}>
            Export Project
          </Button>
        </FieldGroup>
      ) : null}

      {showProjectBody &&
      projectDocument &&
      activeCategoryId === "project" &&
      onCloseProject ? (
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel>Close Project</FieldLabel>
            <FieldDescription>
              Returns to the Homepage after a dirty-document check.
            </FieldDescription>
          </Field>
          <Button
            variant="destructive"
            data-testid="close-project"
            className="min-h-11"
            onClick={() => {
              onOpenChange(false);
              onCloseProject();
            }}
          >
            <LogOutIcon data-icon="inline-start" />
            Close Project
          </Button>
        </FieldGroup>
      ) : null}
    </CatalogDialog>
  );
}
