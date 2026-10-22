import { useState } from "react";
import { pickImportFiles } from "@haptic/vfs";
import {
  ColorField,
  colorFromHex,
  colorToHex,
  DisclosureSection,
  NamePromptDialog,
} from "@haptic/editor-kit";
import { Alert, AlertDescription } from "@haptic/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@haptic/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { useAppSettings } from "../context/app-settings-context";
import { ThemePreview } from "./editor-theme-preview";
import { downloadBlob } from "../lib/download";
import {
  editorThemeFileName,
  listEditorThemes,
  newCustomThemeId,
  parseEditorThemeFile,
  resolveEditorTheme,
  serializeEditorTheme,
  setActiveThemeColor,
  themeColorOverrides,
  THEME_COLOR_GROUPS,
  uniqueThemeName,
  type ThemeColorKey,
} from "../lib/editor-themes";

type Notice = { tone: "info" | "error"; text: string };

/** Theme picker, read-only built-ins, custom theme Style editing, import and export. */
export function ThemeSettingsFields() {
  const { settings, hydrated, updateSettings } = useAppSettings();
  const themes = listEditorThemes(settings.customEditorThemes);
  const active = resolveEditorTheme(settings.editorTheme, settings.customEditorThemes);
  const builtIn = themes.filter((theme) => theme.builtIn);
  const custom = themes.filter((theme) => !theme.builtIn);
  const [styleOpen, setStyleOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ surfaces: true });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const otherNames = (id: string) => themes.filter((theme) => theme.id !== id).map((theme) => theme.name);

  const changeColor = (key: ThemeColorKey, value: string) => {
    void updateSettings((next) => {
      const { forkedName } = setActiveThemeColor(next, key, value);
      if (forkedName) {
        setNotice({
          tone: "info",
          text: `Created ${forkedName}. Built-in themes stay unchanged.`,
        });
      }
    });
  };

  const importTheme = async () => {
    const [file] = await pickImportFiles({ multiple: false, accept: ".json,application/json" });
    if (!file) return;
    const parsed = parseEditorThemeFile(new TextDecoder().decode(file.bytes));
    if (!parsed.ok) {
      setNotice({ tone: "error", text: `Couldn't import ${file.name}. ${parsed.error}` });
      return;
    }
    let importedName = parsed.name;
    await updateSettings((next) => {
      importedName = uniqueThemeName(
        parsed.name,
        listEditorThemes(next.customEditorThemes).map((theme) => theme.name),
      );
      const id = newCustomThemeId();
      next.customEditorThemes.push({ id, name: importedName, colors: themeColorOverrides(parsed.colors) });
      next.editorTheme = id;
    });
    setNotice({ tone: "info", text: `Imported ${importedName}.` });
  };

  return (
    <FieldSet data-testid="application-theme">
      <FieldLegend>Theme</FieldLegend>
      <ThemePreview colors={active.colors} />
      <Field>
        <FieldLabel htmlFor="application-theme-select" className="sr-only">
          Theme
        </FieldLabel>
        <Select
          value={active.id}
          disabled={!hydrated}
          onValueChange={(id) => {
            setNotice(null);
            void updateSettings((next) => {
              next.editorTheme = String(id);
            });
          }}
        >
          <SelectTrigger
            id="application-theme-select"
            data-testid="application-theme-select"
            className="min-h-[var(--chrome-row,28px)] w-full"
          >
            <SelectValue>{active.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Built-In</SelectLabel>
              {builtIn.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
            </SelectGroup>
            {custom.length ? (
              <SelectGroup>
                <SelectLabel>Custom</SelectLabel>
                {custom.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!hydrated}
            data-testid="application-theme-import"
            onClick={() =>
              void importTheme().catch(() =>
                setNotice({ tone: "error", text: "Couldn't import the theme." }),
              )
            }
          >
            Import Theme
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="application-theme-export"
            onClick={() =>
              downloadBlob(
                new Blob([serializeEditorTheme(active)], { type: "application/json" }),
                editorThemeFileName(active),
              )
            }
          >
            Export Theme
          </Button>
          {active.builtIn ? null : (
            <>
              <Button
                size="sm"
                variant="outline"
                data-testid="application-theme-rename"
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="application-theme-delete"
                onClick={() => setDeleting(true)}
              >
                Delete
              </Button>
            </>
          )}
        </div>
        <FieldDescription>
          {active.builtIn
            ? `${active.name} is built in and can't be changed. Changing a Style color creates a custom theme from it.`
            : `Custom theme based on your changes. Export it to share or back it up.`}
        </FieldDescription>
        {notice ? (
          <Alert
            variant={notice.tone === "error" ? "destructive" : "default"}
            data-testid="application-theme-notice"
          >
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        ) : null}
      </Field>
      <DisclosureSection
        title="Style"
        open={styleOpen}
        onOpenChange={setStyleOpen}
        data-testid="application-theme-style"
      >
        <FieldGroup className="gap-2">
          {THEME_COLOR_GROUPS.map((group) => (
            <DisclosureSection
              key={group.id}
              title={group.label}
              open={openGroups[group.id] ?? false}
              onOpenChange={(open) => setOpenGroups((current) => ({ ...current, [group.id]: open }))}
            >
              <div className="flex flex-col gap-1.5 pl-2">
                {group.colors.map(({ key, label }) => (
                  <Field key={key} orientation="horizontal" className="items-center gap-3">
                    <FieldLabel htmlFor={`application-theme-color-${key}`} className="min-w-0 flex-1">
                      {label}
                    </FieldLabel>
                    <div className="w-40 shrink-0">
                      <ColorField
                        id={`application-theme-color-${key}`}
                        aria-label={label}
                        data-testid={`application-theme-color-${key}`}
                        value={colorFromHex(active.colors[key])}
                        disabled={!hydrated}
                        onChange={(value) => changeColor(key, colorToHex(value))}
                      />
                    </div>
                  </Field>
                ))}
              </div>
            </DisclosureSection>
          ))}
        </FieldGroup>
      </DisclosureSection>
      <NamePromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename Theme"
        label="Name"
        confirmLabel="Rename"
        initialValue={active.name}
        validate={(name) =>
          otherNames(active.id).some((other) => other.toLocaleLowerCase() === name.toLocaleLowerCase())
            ? "A theme with this name already exists."
            : null
        }
        onSubmit={(name) => {
          const id = active.id;
          void updateSettings((next) => {
            const stored = next.customEditorThemes.find((theme) => theme.id === id);
            if (stored) stored.name = name;
          });
          setRenaming(false);
        }}
        data-testid="application-theme-rename-dialog"
      />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent variant="destructive">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Theme</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {active.name}? The editor switches to Haptic Dark. Export the theme first to keep a copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="application-theme-delete-confirm"
              onClick={() => {
                const id = active.id;
                setNotice(null);
                void updateSettings((next) => {
                  next.customEditorThemes = next.customEditorThemes.filter((theme) => theme.id !== id);
                  if (next.editorTheme === id) next.editorTheme = "default";
                });
                setDeleting(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldSet>
  );
}
