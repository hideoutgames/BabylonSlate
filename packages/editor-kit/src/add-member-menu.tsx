import type { ReactElement } from "react";
import { PlusIcon } from "lucide-react";
import { SearchDropdown } from "./search-dropdown";

export type AddMemberMenuItem = {
  id: string;
  name: string;
  description: string;
  overwritten: boolean;
  kind: string;
};

export const ADD_MEMBER_EMPTY_ID = "__new__";

export interface AddMemberMenuProps {
  items: AddMemberMenuItem[];
  onCreateEmpty: () => void;
  onPick: (id: string) => void;
  children: ReactElement;
  title?: string;
  emptyLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  "data-testid"?: string;
}

/** Compact searchable Add popup: a pinned New row, then overridable members grouped by source. Already-overridden rows are omitted. */
export function AddMemberMenu({
  items,
  onCreateEmpty,
  onPick,
  children,
  title = "Add Function",
  emptyLabel = "New Function",
  open,
  onOpenChange,
  "data-testid": testId = "add-function-menu",
}: AddMemberMenuProps) {
  return (
    <SearchDropdown
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      items={[
        {
          id: ADD_MEMBER_EMPTY_ID,
          label: emptyLabel,
          pinned: true,
          leading: <PlusIcon className="size-3.5 text-muted-foreground" />,
        },
        ...items
          .filter((item) => !item.overwritten)
          .map((item) => ({ id: item.id, label: item.name, group: item.description })),
      ]}
      onSelect={(id) => {
        if (id === ADD_MEMBER_EMPTY_ID) onCreateEmpty();
        else onPick(id);
      }}
      placeholder="Search"
      data-testid={testId}
    >
      {children}
    </SearchDropdown>
  );
}
