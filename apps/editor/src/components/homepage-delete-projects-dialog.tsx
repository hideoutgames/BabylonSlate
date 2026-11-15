import { useEffect, useId, useState } from "react";
import { Trash2Icon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Badge } from "@haptic/ui/components/badge";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import {
  removeDeletesProject,
  type ListedProject,
} from "../lib/listed-projects";
import { ProjectIdentityBadge } from "./homepage-project-identity";

/** Typed to confirm deleting the selected projects. */
const DELETE_PROJECTS_PHRASE = "delete my projects";

/** Case and surrounding spaces are ignored: touch keyboards capitalize the first letter. */
function confirmsDelete(value: string) {
  return value.trim().toLowerCase() === DELETE_PROJECTS_PHRASE;
}

function ProjectList({
  projects,
  testId,
}: {
  projects: readonly ListedProject[];
  testId: string;
}) {
  return (
    <ul className="flex flex-col divide-y rounded-md border" data-testid={testId}>
      {projects.map((project) => (
        <li
          key={project.id}
          className="flex min-h-[var(--chrome-row,28px)] min-w-0 items-center gap-2 px-2.5 py-1.5 text-sm"
        >
          <ProjectIdentityBadge appearance={project.appearance} />
          <span className="min-w-0 truncate font-medium">{project.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Confirms deleting the selected projects. Projects in the app's own storage
 * are listed for deletion; projects in a folder the user chose are listed as
 * kept, because the Project Browser never deletes a chosen folder.
 */
export function HomepageDeleteProjectsDialog({
  open,
  onOpenChange,
  projects,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selection when the dialog opened; it stays fixed while the dialog is open. */
  projects: readonly ListedProject[];
  /** Receives exactly the projects listed under Deleting. */
  onConfirm: (projects: ListedProject[]) => void;
}) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const deleting = projects.filter((project) =>
    removeDeletesProject(project.tier),
  );
  const kept = projects.filter(
    (project) => !removeDeletesProject(project.tier),
  );
  const confirmed = deleting.length > 0 && confirmsDelete(typed);
  const confirm = () => {
    if (!confirmed) return;
    onConfirm(deleting);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        variant="destructive"
        className="homepage-theme homepage-delete-projects editor-dialog-large editor-dialog-delete flex flex-col gap-0 overflow-hidden p-0 data-[size=default]:max-w-md"
        data-testid="homepage-delete-projects-dialog"
      >
        <AlertDialogHeader className="flex shrink-0 items-start gap-3 px-4 pt-4 pb-1">
          <AlertDialogMedia className="mb-0 size-8 shrink-0">
            <Trash2Icon className="size-4" />
          </AlertDialogMedia>
          <div className="flex min-w-0 flex-col gap-1">
            <AlertDialogTitle className="break-words">
              {deleting.length === 1
                ? `Delete ${deleting[0]!.label}?`
                : deleting.length > 1
                  ? `Delete ${deleting.length} Projects?`
                  : "Can't Delete Selected Projects"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting.length > 0
                ? "This permanently deletes the listed projects and their files. It can't be undone."
                : "Projects in a folder you chose can't be deleted from the Project Browser."}
            </AlertDialogDescription>
          </div>
        </AlertDialogHeader>
        <div
          className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-y-contain px-4 py-3 touch-pan-y"
          tabIndex={0}
          role="region"
          aria-label="Selected Projects"
          data-testid="homepage-delete-projects-body"
        >
          {deleting.length > 0 && (
            <section className="flex min-w-0 flex-col gap-1.5" aria-label="Deleting">
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                Deleting
                <Badge variant="secondary" className="tabular-nums">
                  {deleting.length}
                </Badge>
              </h3>
              <ProjectList
                projects={deleting}
                testId="homepage-delete-projects-list"
              />
            </section>
          )}
          {kept.length > 0 && (
            <section className="flex min-w-0 flex-col gap-1.5" aria-label="Can't Be Deleted">
              <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                Can't Be Deleted
                <Badge variant="secondary" className="tabular-nums">
                  {kept.length}
                </Badge>
              </h3>
              <ProjectList
                projects={kept}
                testId="homepage-delete-projects-kept"
              />
              <p className="text-xs text-muted-foreground">
                {kept.length === 1
                  ? "This project is in a folder you chose and stays as it is."
                  : "These projects are in folders you chose and stay as they are."}{" "}
                Use Remove From List in a project's actions to take it off the
                list.
              </p>
            </section>
          )}
          {deleting.length > 0 && (
            <Field>
              <FieldLabel htmlFor={inputId} className="block font-normal">
                Type{" "}
                <span className="font-mono font-medium">
                  {DELETE_PROJECTS_PHRASE}
                </span>{" "}
                to confirm.
              </FieldLabel>
              <Input
                id={inputId}
                data-testid="homepage-delete-projects-input"
                placeholder={DELETE_PROJECTS_PHRASE}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    confirm();
                  }
                }}
              />
            </Field>
          )}
        </div>
        <AlertDialogFooter className="m-0 shrink-0 pt-3">
          <AlertDialogCancel data-testid="homepage-delete-projects-cancel">
            {deleting.length > 0 ? "Cancel" : "Close"}
          </AlertDialogCancel>
          {deleting.length > 0 && (
            <AlertDialogAction
              variant="destructive"
              data-testid="homepage-delete-projects-confirm"
              disabled={!confirmed}
              onClick={confirm}
            >
              Delete
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
