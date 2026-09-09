import { useState } from "react";
import { PlusIcon } from "lucide-react";
import { pickImportFiles } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import {
  FieldDescription,
  FieldError,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { useDocuments } from "../context/document-context";
import { importTemplateArchive } from "../services/template-service";

/** The launcher and Engine Settings edit the same installed template library. */
export function TemplateLibrarySettings() {
  const { templates, refreshTemplates } = useDocuments();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importTemplate = async () => {
    setBusy(true);
    setError(null);
    try {
      const files = await pickImportFiles({
        accept: ".zip,.babproject",
        multiple: false,
        maxTotalBytes: 50 * 1024 * 1024,
      });
      if (!files[0]) return;
      await importTemplateArchive(files[0].name, files[0].bytes);
      await refreshTemplates();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FieldSet>
      <FieldLegend>Templates</FieldLegend>
      <FieldDescription>
        Available in the project creator. Import an exported Slate project to
        add a template.
      </FieldDescription>
      <div className="divide-y rounded-lg border px-3">
        {["Blank", "Basic 3D", "Basic 2D"].map((name) => (
          <div
            key={name}
            className="flex min-h-11 items-center justify-between gap-3 text-sm"
          >
            <span>{name}</span>
            <span className="text-xs text-muted-foreground">Built-in</span>
          </div>
        ))}
        {templates.map((template) => (
          <div key={template.id} className="flex min-h-11 items-center text-sm">
            {template.name}
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        className="self-start"
        disabled={busy}
        onClick={() => void importTemplate()}
      >
        <PlusIcon />
        Add Template
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </FieldSet>
  );
}
