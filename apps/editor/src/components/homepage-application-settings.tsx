import { useState } from "react";
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
import {
  readApplicationSettings,
  writeApplicationSettings,
  type ApplicationSettings,
} from "../lib/application-settings";

const CATEGORIES = [{ id: "updates", label: "Updates", count: 1 }];

export function HomepageApplicationSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [settings, setSettings] = useState(readApplicationSettings);
  const [search, setSearch] = useState("");
  const update = (patch: Partial<ApplicationSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeApplicationSettings(next);
  };
  const matches = "auto-update updates".includes(
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
                  Auto-Update
                </FieldLabel>
                <FieldDescription>
                  {settings.autoUpdate ? "On" : "Off"}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="application-auto-update"
                data-testid="application-auto-update"
                checked={settings.autoUpdate}
                onCheckedChange={(checked) =>
                  update({ autoUpdate: checked === true })
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
