import { useMemo, useState } from "react";
import { NamePromptDialog } from "@babylonslate/editor-kit";
import type { PluginDescriptor } from "@babylonslate/assets";
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
  pluginDependencyStatus,
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
                  {plugin.source === "project" ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
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
        <Button
          type="button"
          variant="outline"
          className="min-h-[var(--touch-target,44px)] w-fit"
          data-testid="settings-plugin-new"
          onClick={() => setNewOpen(true)}
        >
          New Plugin
        </Button>
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
    </FieldGroup>
  );
}
