import { useState, type CSSProperties } from "react";
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
  themeCssVariables,
  THEME_COLOR_GROUPS,
  uniqueThemeName,
  type ThemeColorKey,
  type ThemeColors,
} from "../lib/editor-themes";

type Notice = { tone: "info" | "error"; text: string };

/** Non-interactive miniature of the editor drawn with a theme's colors. */
export function ThemePreview({ colors }: { colors: ThemeColors }) {
  return (
    <div
      aria-hidden="true"
      inert
      data-testid="application-theme-preview"
      className="pointer-events-none flex h-40 select-none flex-col overflow-hidden rounded-lg border border-border bg-background text-[10px] leading-none text-foreground"
      style={themeCssVariables(colors) as CSSProperties}
    >
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <span className="font-medium">Level</span>
        <span className="relative ml-1 flex h-full items-center px-1.5 text-foreground">
          Begin Play
          <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-brand-red" />
        </span>
        <span className="text-muted-foreground">Hero</span>
        <span className="ml-auto flex h-4 items-center rounded-sm bg-(--play) px-1.5 text-(--play-foreground)">
          Play
        </span>
        <span className="flex h-4 items-center rounded-sm bg-primary px-1.5 text-primary-foreground">
          Save
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-1/4 flex-col border-r border-border bg-sidebar">
          <div className="border-b border-border bg-panel-header px-1.5 py-1 text-muted-foreground">
            Outliner
          </div>
          {[
            { label: "Main Scene", dot: "var(--asset-scene)" },
            { label: "Hero", dot: "var(--asset-class)", selected: true },
            { label: "Rock", dot: "var(--asset-model)" },
            { label: "Grass", dot: "var(--asset-material)" },
          ].map((row) => (
            <div
              key={row.label}
              className={`flex items-center gap-1 px-1.5 py-1 ${row.selected ? "bg-accent text-foreground" : "text-muted-foreground"}`}
            >
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: row.dot }} />
              {row.label}
            </div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 bg-(--graph-canvas)">
          <PreviewNode
            className="left-[8%] top-[18%]"
            title="Event Begin Play"
            titleColor="var(--node-event)"
            pin="var(--pin-exec)"
          />
          <PreviewNode
            className="left-[46%] top-[42%] outline outline-1 outline-selection"
            title="Print String"
            titleColor="var(--node-function)"
            pin="var(--pin-string)"
          />
          <span className="absolute bottom-1 left-1.5 flex gap-1">
            {["var(--pin-bool)", "var(--pin-float)", "var(--pin-vector)", "var(--pin-object)"].map(
              (pin) => (
                <span key={pin} className="size-1.5 rounded-full" style={{ background: pin }} />
              ),
            )}
          </span>
        </div>
        <div className="flex w-1/3 flex-col gap-1 border-l border-border bg-card">
          <div className="border-b border-border bg-panel-header px-1.5 py-1 text-muted-foreground">
            Inspector
          </div>
          <div className="flex flex-col gap-1 px-1.5">
            <span className="text-muted-foreground">Name</span>
            <span className="rounded-sm border border-input bg-control px-1 py-0.5">Hero</span>
            <span className="text-muted-foreground">Speed</span>
            <span className="rounded-sm border border-ring bg-control px-1 py-0.5 outline outline-1 outline-ring/40">
              4.00
            </span>
            <span className="flex gap-1">
              <span className="rounded-sm bg-secondary px-1 py-0.5">Reset</span>
              <span className="rounded-sm bg-destructive px-1 py-0.5 text-destructive-foreground">Delete</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewNode({
  className,
  title,
  titleColor,
  pin,
}: {
  className: string;
  title: string;
  titleColor: string;
  pin: string;
}) {
  return (
    <div className={`absolute w-[44%] overflow-hidden rounded-sm bg-(--graph-node) ${className}`}>
      <div className="truncate px-1 py-0.5 text-(--node-title-foreground)" style={{ background: titleColor }}>
        {title}
      </div>
      <div className="flex items-center justify-between px-1 py-1">
        <span className="size-1.5 rounded-full" style={{ background: "var(--pin-exec)" }} />
        <span className="size-1.5 rounded-full" style={{ background: pin }} />
      </div>
    </div>
  );
}

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
              Delete {active.name}? The editor switches to Default. Export the theme first to keep a copy.
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
