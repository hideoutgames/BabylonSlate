import { ChevronDownIcon } from "lucide-react";
import { SearchDropdown } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import type { CreateEventCandidate } from "../lib/create-event-members";

const CREATE_EVENT = "__create-event__";
const CREATE_FUNCTION = "__create-function__";

/**
 * Create Event's member picker, drawn in its node body as in Unreal: the
 * custom events and functions its delegate can run, then Create Matching
 * Event and Create Matching Function.
 */
export function CreateEventMemberPicker({
  nodeId,
  memberName,
  candidates,
  canCreate,
  disabled = false,
  onPick,
  onCreate,
}: {
  nodeId: string;
  memberName: string;
  candidates: readonly CreateEventCandidate[];
  /** The delegate it feeds is known, so a matching member can be made. */
  canCreate: boolean;
  disabled?: boolean;
  onPick: (candidate: CreateEventCandidate) => void;
  onCreate: (kind: "event" | "function") => void;
}) {
  return (
    <div className="nodrag nopan border-t px-3 py-2">
      <SearchDropdown
        title="Create Event"
        placeholder="Search events and functions"
        emptyLabel="No matching events or functions"
        items={[
          ...(canCreate
            ? [
                { id: CREATE_EVENT, label: "Create Matching Event", pinned: true },
                { id: CREATE_FUNCTION, label: "Create Matching Function", pinned: true },
              ]
            : []),
          ...candidates.map((candidate) => ({
            id: candidate.id,
            label: candidate.name,
            description: `${candidate.kind === "event" ? "Custom Event" : "Function"} · ${candidate.classId}`,
          })),
        ]}
        onSelect={(id) => {
          if (id === CREATE_EVENT) onCreate("event");
          else if (id === CREATE_FUNCTION) onCreate("function");
          else {
            const candidate = candidates.find((entry) => entry.id === id);
            if (candidate) onPick(candidate);
          }
        }}
        data-testid={`create-event-picker-${nodeId}`}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="w-full min-w-48 justify-between font-normal"
          data-testid={`create-event-member-${nodeId}`}
        >
          <span className={memberName ? undefined : "text-muted-foreground"}>
            {memberName || "Choose Event or Function"}
          </span>
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </SearchDropdown>
    </div>
  );
}
