import type { IDockviewPanelProps } from "dockview";

export function PlaceholderPanel({
  title,
}: IDockviewPanelProps & { title: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
      {title} panel
    </div>
  );
}
