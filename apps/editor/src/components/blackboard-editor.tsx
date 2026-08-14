import { useMemo, useState } from "react";
import {
  createDefaultBlackboard,
  parseBlackboardDocument,
  type BlackboardDocument,
  type BlackboardKey,
} from "@babylonslate/behaviour-tree";
import {
  PanelFrame,
  PinTypePicker,
  PropertyGrid,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import type { PinType } from "@babylonslate/scripting";

function asBoard(payload: Record<string, unknown>): BlackboardDocument {
  return parseBlackboardDocument(payload) ?? createDefaultBlackboard();
}

function uniqueKeyName(keys: readonly BlackboardKey[]): string {
  const used = new Set(keys.map((key) => key.name));
  if (!used.has("key")) return "key";
  let index = 2;
  while (used.has(`key${index}`)) index += 1;
  return `key${index}`;
}

function defaultForKind(kind: PinType["kind"]): unknown {
  switch (kind) {
    case "bool":
      return false;
    case "int":
    case "float":
      return 0;
    case "string":
      return "";
    default:
      return undefined;
  }
}

export function BlackboardEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const doc = useMemo(() => asBoard(payload), [payload]);
  const [selected, setSelected] = useState(0);
  const commit = (next: BlackboardDocument) => {
    onChange(next as unknown as Record<string, unknown>);
  };
  const key = doc.keys[selected];
  const kind = key?.type.kind ?? "bool";
  const rows: PropertyRow[] = key
    ? [
        {
          id: "name",
          kind: "text",
          label: "Name",
          value: key.name,
          onChange: (name) =>
            commit({
              ...doc,
              keys: doc.keys.map((entry, index) =>
                index === selected ? { ...entry, name } : entry,
              ),
            }),
        },
        kind === "bool"
          ? {
              id: "default",
              kind: "boolean",
              label: "Default",
              value: Boolean(key.defaultValue),
              onChange: (value) =>
                commit({
                  ...doc,
                  keys: doc.keys.map((entry, index) =>
                    index === selected ? { ...entry, defaultValue: value } : entry,
                  ),
                }),
            }
          : kind === "int" || kind === "float"
            ? {
                id: "default",
                kind: "number",
                label: "Default",
                value: Number(key.defaultValue ?? 0),
                onChange: (value) =>
                  commit({
                    ...doc,
                    keys: doc.keys.map((entry, index) =>
                      index === selected ? { ...entry, defaultValue: value } : entry,
                    ),
                  }),
              }
            : {
                id: "default",
                kind: "text",
                label: "Default",
                value: key.defaultValue === undefined ? "" : String(key.defaultValue),
                onChange: (value) =>
                  commit({
                    ...doc,
                    keys: doc.keys.map((entry, index) =>
                      index === selected ? { ...entry, defaultValue: value } : entry,
                    ),
                  }),
              },
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1" data-testid="blackboard-editor">
      <PanelFrame className="w-72 shrink-0 border-r border-border" title="Keys">
        <div className="flex flex-col gap-1 p-2">
          {doc.keys.map((entry, index) => (
            <Button
              key={`${entry.name}-${index}`}
              type="button"
              variant="outline"
              className="min-h-11 w-full justify-start"
              aria-pressed={selected === index}
              data-testid={`blackboard-key-${entry.name}`}
              onClick={() => setSelected(index)}
            >
              {entry.name}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-fit"
            data-testid="blackboard-add-key"
            onClick={() => {
              const next: BlackboardKey = {
                name: uniqueKeyName(doc.keys),
                type: { kind: "bool" },
                defaultValue: false,
              };
              commit({ ...doc, keys: [...doc.keys, next] });
              setSelected(doc.keys.length);
            }}
          >
            Add Key
          </Button>
        </div>
      </PanelFrame>
      <PanelFrame className="flex-1" title="Details">
        {key ? (
          <div className="flex flex-col gap-3 p-2" data-testid="blackboard-details">
            <PropertyGrid rows={rows} />
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">Type</div>
              <PinTypePicker
                value={key.type.kind}
                onChange={(typeId) =>
                  commit({
                    ...doc,
                    keys: doc.keys.map((entry, index) =>
                      index === selected
                        ? {
                            ...entry,
                            type: { kind: typeId } as PinType,
                            defaultValue: defaultForKind(typeId as PinType["kind"]),
                          }
                        : entry,
                    ),
                  })
                }
                data-testid="blackboard-key-type"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-fit"
              data-testid="blackboard-delete-key"
              onClick={() => {
                const keys = doc.keys.filter((_, index) => index !== selected);
                commit({ ...doc, keys });
                setSelected(Math.max(0, selected - 1));
              }}
            >
              Delete Key
            </Button>
          </div>
        ) : (
          <p className="p-3 text-sm text-muted-foreground">Select a key</p>
        )}
      </PanelFrame>
    </div>
  );
}
