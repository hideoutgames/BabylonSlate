import { useState } from "react";
import { getHostPlatform } from "@babylonslate/vfs";
import { CatalogDialog } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Switch } from "@babylonslate/ui/components/switch";
import { useAppSettings } from "../context/app-settings-context";

const CATEGORIES = [{ id: "updates", label: "Updates", count: 1 }];

export function HomepageApplicationSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { settings, hydrated, updateSettings } = useAppSettings();
  const [search, setSearch] = useState("");
  const desktop = getHostPlatform() === "electron";
  const matches = "auto-update automatic updates".includes(
    search.trim().toLocaleLowerCase(),
  );
  return (
    <CatalogDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSearch("");
        onOpenChange(next);
      }}
      title="Application Settings"
      categories={CATEGORIES}
      activeCategoryId="updates"
      onCategoryChange={() => setSearch("")}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search Settings"
      className="settings-dialog homepage-application-settings"
      data-testid="application-settings-modal"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      }
    >
      {matches ? (
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Updates</FieldLegend>
            <Field orientation="horizontal" className="settings-field">
              <FieldContent>
                <FieldLabel htmlFor="application-auto-update">
                  Automatic Updates
                </FieldLabel>
                <FieldDescription>
                  {desktop
                    ? "Download new releases from GitHub and install them when you exit BabylonSlate. Also available in Engine Settings."
                    : "Automatic updates are managed here in the Windows desktop app."}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="application-auto-update"
                data-testid="application-auto-update"
                checked={settings.automaticUpdatesEnabled}
                disabled={!desktop || !hydrated}
                onCheckedChange={(checked) =>
                  void updateSettings(settings => {
                    settings.automaticUpdatesEnabled = checked;
                  })
                }
              />
            </Field>
          </FieldSet>
        </FieldGroup>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No Matching Settings</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </CatalogDialog>
  );
}
