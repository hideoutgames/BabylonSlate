import { useState } from "react";
import { LabelHint } from "@haptic/editor-kit";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@haptic/ui/components/field";
import { Switch } from "@haptic/ui/components/switch";
import { useProjectTrust } from "./use-project-trust";

/**
 * The one Workspace Trust switch, **Trust This Project**: whether the open
 * project's Extensions, Editor Utilities and Execute JavaScript may run code on this computer.
 * `held` names what is not running now (live state, shown under the label).
 */
export function ProjectTrustField({ id, held = [], className = "settings-field" }: { id: string; held?: readonly string[]; className?: string }) {
  const { ready, trusted, setTrusted } = useProjectTrust();
  const [busy, setBusy] = useState(false);
  return (
    <Field orientation="horizontal" className={className} data-testid={`${id}-field`}>
      <FieldContent>
        <LabelHint hint="Lets this project's Extensions, Editor Utilities and Execute JavaScript run code on this computer.">
          <FieldLabel htmlFor={id}>Trust This Project</FieldLabel>
        </LabelHint>
        {!trusted && held.length > 0 ? <FieldDescription>Not running: {held.join(", ")}</FieldDescription> : null}
      </FieldContent>
      <Switch
        id={id}
        aria-label="Trust This Project"
        checked={trusted}
        disabled={!ready || busy}
        onCheckedChange={(checked) => {
          setBusy(true);
          void setTrusted(checked).finally(() => setBusy(false));
        }}
      />
    </Field>
  );
}
