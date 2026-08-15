import { useMemo, useRef, useState } from "react";
import { NamePromptDialog } from "@babylonslate/editor-kit";
import type { PluginDescriptor } from "@babylonslate/assets";
import { isMobilePlatform, pickImportFiles } from "@babylonslate/vfs";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { documentKindForAssetType } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import {
  inboundRefsFromOtherRoots,
  isBabpluginFile,
  pluginDependencyStatus,
  pluginDownloadFileName,
  pluginEnableNeedsConfirm,
  pluginRootId,
} from "../lib/plugin-ui";
import { resolvePluginEnabled } from "@babylonslate/assets";

function maturityBadge(plugin: PluginDescriptor) {
  if (plugin.settings.experimental) return "Experimental";
  if (plugin.settings.beta) return "Beta";
  return null;
}

export function ProjectPluginsSettings() {
  const {
    projectDocument,
    pluginDescriptors,
    pluginDiagnostics,
    assetRegistry,
    updateProjectSettings,
    applyPluginOverrides,
    createProjectPlugin,
    deleteProjectPlugin,
    exportPlugin,
    importPlugin,
    openDocument,
  } = useDocuments();
  const [newOpen, setNewOpen] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState<PluginDescriptor | null>(
    null,
  );
  const [confirmDisable, setConfirmDisable] = useState<{
    plugin: PluginDescriptor;
    names: string[];
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PluginDescriptor | null>(
    null,
  );
  const [importConflict, setImportConflict] = useState<{
    displayName: string;
    bytes: Uint8Array;
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const overrides = projectDocument?.settings.pluginOverrides ?? {};

  const rows = useMemo(
    () =>
      pluginDescriptors.map((plugin) => {
        const enabled = resolvePluginEnabled(
          plugin.settings.enabledByDefault,
          overrides[plugin.pluginGuid]?.enabled,
        );
        return { plugin, enabled };
      }),
    [overrides, pluginDescriptors],
  );

  const setEnabled = async (plugin: PluginDescriptor, enabled: boolean) => {
    const next = {
      ...overrides,
      [plugin.pluginGuid]: { enabled },
    };
    updateProjectSettings({ pluginOverrides: next });
    await applyPluginOverrides(next);
  };

  const requestEnableChange = (plugin: PluginDescriptor, enabled: boolean) => {
    if (enabled && pluginEnableNeedsConfirm(plugin.settings)) {
      setConfirmEnable(plugin);
      return;
    }
    if (!enabled && assetRegistry) {
      const inbound = inboundRefsFromOtherRoots(
        assetRegistry.list(),
        (guid) => assetRegistry.showReferences(guid),
        pluginRootId(plugin.pluginGuid),
      );
      if (inbound.length > 0) {
        setConfirmDisable({
          plugin,
          names: inbound.map((entry) => entry.name),
        });
        return;
      }
    }
    void setEnabled(plugin, enabled);
  };

  const downloadPlugin = async (plugin: PluginDescriptor) => {
    const bytes = await exportPlugin(plugin.pluginGuid);
    const blob = new Blob([bytes.buffer as ArrayBuffer], {
      type: "application/zip",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = pluginDownloadFileName(plugin.settings.displayName);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const runImport = async (
    bytes: Uint8Array,
    decision?: "keep" | "replace",
  ) => {
    const result = await importPlugin(bytes, decision);
    if (result.status === "conflict") {
      setImportConflict({
        displayName: result.incoming.settings.displayName,
        bytes,
      });
      return;
    }
    setImportConflict(null);
  };

  const handleImportClick = async () => {
    if (isMobilePlatform()) {
      const files = await pickImportFiles({
        multiple: false,
        accept: ".babplugin",
      });
      const file =
        files.find((entry) => isBabpluginFile(entry.name)) ?? files[0];
      if (file) await runImport(file.bytes);
      return;
    }
    importInputRef.current?.click();
  };

  return (
    <FieldGroup data-testid="settings-plugins-panel">
      <FieldSet>
        <FieldLegend>Plugins</FieldLegend>
        <FieldDescription>
          Enable engine or project plugins. Disabled plugins unmount from the
          asset registry.
        </FieldDescription>
        {rows.map(({ plugin, enabled }) => {
          const maturity = maturityBadge(plugin);
          const status = pluginDependencyStatus(
            plugin.pluginGuid,
            pluginDiagnostics,
          );
          return (
            <Field
              key={plugin.pluginGuid}
              className="rounded-md border border-border p-3"
              data-testid={`settings-plugin-row-${plugin.pluginGuid}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {plugin.settings.displayName}
                    </span>
                    <Badge
                      variant="outline"
                      data-testid={`settings-plugin-source-${plugin.pluginGuid}`}
                    >
                      {plugin.source === "engine" ? "Engine" : "Project"}
                    </Badge>
                    {maturity ? (
                      <Badge variant="secondary">{maturity}</Badge>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    v{plugin.settings.version}
                    {status !== "ok" ? ` · ${status}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) =>
                      requestEnableChange(plugin, checked === true)
                    }
                    data-testid={`settings-plugin-enable-${plugin.pluginGuid}`}
                    aria-label={`Enable ${plugin.settings.displayName}`}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-[var(--touch-target,44px)]"
                    data-testid={`settings-plugin-open-${plugin.pluginGuid}`}
                    onClick={() => {
                      const kind = documentKindForAssetType("PluginSettings");
                      if (!kind) return;
                      void openDocument({
                        kind,
                        path: plugin.settingsPath,
                        label: plugin.settings.displayName,
                      });
                    }}
                  >
                    Open
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-[var(--touch-target,44px)]"
                    data-testid={`settings-plugin-export-${plugin.pluginGuid}`}
                    onClick={() => void downloadPlugin(plugin)}
                  >
                    Export
                  </Button>
                  {plugin.source === "project" ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="min-h-[var(--touch-target,44px)]"
                      data-testid={`settings-plugin-delete-${plugin.pluginGuid}`}
                      onClick={() => setConfirmDelete(plugin)}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
              </div>
            </Field>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--touch-target,44px)] w-fit"
            data-testid="settings-plugin-new"
            onClick={() => setNewOpen(true)}
          >
            New Plugin
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-[var(--touch-target,44px)] w-fit"
            data-testid="settings-plugin-import"
            onClick={() => void handleImportClick()}
          >
            Import Plugin
          </Button>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".babplugin,application/zip"
          className="hidden"
          data-testid="import-plugin-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void file.arrayBuffer().then((buffer) =>
              runImport(new Uint8Array(buffer)),
            );
          }}
        />
      </FieldSet>
      <NamePromptDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        title="New Plugin"
        label="Display Name"
        confirmLabel="Create"
        data-testid="settings-plugin-new-dialog"
        onSubmit={(name) => {
          void createProjectPlugin(name);
        }}
      />
      <AlertDialog
        open={Boolean(confirmEnable)}
        onOpenChange={(open) => {
          if (!open) setConfirmEnable(null);
        }}
      >
        <AlertDialogContent data-testid="settings-plugin-experimental-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Experimental Plugin</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmEnable?.settings.displayName} is marked experimental or
              beta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmEnable) void setEnabled(confirmEnable, true);
                setConfirmEnable(null);
              }}
            >
              Enable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(confirmDisable)}
        onOpenChange={(open) => {
          if (!open) setConfirmDisable(null);
        }}
      >
        <AlertDialogContent data-testid="settings-plugin-disable-refs-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Disable Plugin</AlertDialogTitle>
            <AlertDialogDescription>
              Other assets still reference this plugin:{" "}
              {confirmDisable?.names.join(", ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDisable) {
                  void setEnabled(confirmDisable.plugin, false);
                }
                setConfirmDisable(null);
              }}
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(confirmDelete)}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent data-testid="settings-plugin-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Plugin</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete {confirmDelete?.settings.displayName} from disk.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirmDelete) return;
                const guid = confirmDelete.pluginGuid;
                void deleteProjectPlugin(guid);
                const next = { ...overrides };
                delete next[guid];
                updateProjectSettings({ pluginOverrides: next });
                setConfirmDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(importConflict)}
        onOpenChange={(open) => {
          if (!open) setImportConflict(null);
        }}
      >
        <AlertDialogContent data-testid="settings-plugin-import-conflict">
          <AlertDialogHeader>
            <AlertDialogTitle>Plugin Already Installed</AlertDialogTitle>
            <AlertDialogDescription>
              {importConflict?.displayName} is already in this project at the same
              version. Keep the existing plugin or replace it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="settings-plugin-import-keep">
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="settings-plugin-import-replace"
              onClick={() => {
                if (!importConflict) return;
                void runImport(importConflict.bytes, "replace");
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldGroup>
  );
}
