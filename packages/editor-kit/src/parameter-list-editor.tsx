import { useState, type ChangeEvent } from "react";

export type ParameterRow = {
  id: string;
  name: string;
  typeLabel: string;
};

export type ParameterListEditorProps = {
  rows: ParameterRow[];
  onChange: (rows: ParameterRow[]) => void;
  title?: string;
};

/** Shared typed named reorderable row list (ExecuteJavaScript, My Class, interfaces). */
export function ParameterListEditor({
  rows,
  onChange,
  title = "Parameters",
}: ParameterListEditorProps) {
  const [draftName, setDraftName] = useState("");

  return (
    <div className="flex flex-col gap-2" data-testid="parameter-list-editor">
      <div className="text-sm font-medium">{title}</div>
      {rows.map((row, index) => (
        <div
          key={row.id}
          className="flex min-h-11 items-center gap-2 rounded-md border border-border px-2"
        >
          <input
            className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
            value={row.name}
            aria-label={`Parameter ${index + 1} name`}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const next = rows.map((r) =>
                r.id === row.id ? { ...r, name: e.target.value } : r,
              );
              onChange(next);
            }}
          />
          <span className="text-xs text-muted-foreground">{row.typeLabel}</span>
          <button
            type="button"
            className="min-h-11 rounded-md px-2 text-sm hover:bg-muted"
            aria-label={`Remove ${row.name}`}
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Add parameter</label>
        <div className="flex gap-2">
          <input
            className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
            value={draftName}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setDraftName(e.target.value)
            }
            placeholder="name"
          />
          <button
            type="button"
            className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted"
            onClick={() => {
              const name = draftName.trim();
              if (!name) return;
              onChange([
                ...rows,
                {
                  id: `p_${Date.now()}`,
                  name,
                  typeLabel: "float",
                },
              ]);
              setDraftName("");
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
