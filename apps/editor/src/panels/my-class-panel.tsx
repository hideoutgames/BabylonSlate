import type { IDockviewPanelProps } from "dockview-react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Card } from "@babylonslate/ui/components/card";
import { Button } from "@babylonslate/ui/components/button";

export type MyClassMember = {
  kind: "variable" | "function" | "event" | "interface";
  name: string;
  detail?: string;
  inherited?: boolean;
  hasError?: boolean;
};

export type MyClassPanelProps = IDockviewPanelProps & {
  // Dockview does not pass custom props; members come from workspace later.
};

/** My Class panel — variables, functions, events, interfaces. */
export function MyClassPanel(_props: MyClassPanelProps) {
  void _props;
  // Placeholder members until class documents store full metadata.
  const members: MyClassMember[] = [
    { kind: "event", name: "Event Graph", detail: "BeginPlay / Tick" },
    { kind: "variable", name: "Health", detail: "float" },
    { kind: "function", name: "TakeDamage", detail: "(damage: float)" },
  ];

  return (
    <div className="flex h-full flex-col gap-2 p-2" data-testid="my-class-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">My Class</div>
        <Button type="button" size="sm" variant="outline" disabled>
          Add
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 pr-2">
          {members.map((m) => (
            <Card
              key={`${m.kind}-${m.name}`}
              className="flex min-h-11 flex-row items-center justify-between gap-2 p-3"
            >
              <div className="flex flex-col">
                <span className="text-sm">
                  {m.inherited ? `(inherited) ${m.name}` : m.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {m.kind}
                  {m.detail ? ` · ${m.detail}` : ""}
                </span>
              </div>
              {m.hasError ? (
                <span className="text-xs text-destructive">error</span>
              ) : null}
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
