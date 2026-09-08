import { AppWindowIcon } from "lucide-react";
import { ToolbarStrip } from "@babylonslate/editor-kit";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import type { DockWindowDefinition } from "./window-catalog";

export function PhoneWindowSwitcher({
  windows,
  activeId,
  onSelect,
}: {
  windows: readonly DockWindowDefinition[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ToolbarStrip
      className="phone-window-bar shrink-0"
      data-testid="phone-window-bar"
    >
      <Select
        value={activeId}
        onValueChange={(value) => {
          if (value) onSelect(value);
        }}
        items={windows.map((entry) => ({
          value: entry.id,
          label: entry.title,
        }))}
      >
        <SelectTrigger
          aria-label="Window"
          data-testid="phone-window-switcher"
          className="phone-window-switcher w-full"
        >
          <AppWindowIcon aria-hidden="true" />
          <SelectValue placeholder="Choose Window" />
        </SelectTrigger>
        <SelectContent side="top" align="start" className="phone-window-menu">
          <SelectGroup>
            {windows.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.title}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </ToolbarStrip>
  );
}
