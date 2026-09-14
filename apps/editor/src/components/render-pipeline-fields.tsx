import {
  GPU_BACKENDS, RENDER_PATHS, isGpuBackend, isRenderPath,
  normalizeRenderingPipeline, resolveRenderingPipeline,
  type GpuBackend, type RenderPath, type RenderPathOverrides, type RenderingPipelineSettings, type ResolvedRenderingPipeline,
} from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@babylonslate/ui/components/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@babylonslate/ui/components/select";
import { useProjectRenderingStatus } from "../context/project-rendering-context";

const pathLabels: Record<RenderPath, string> = { auto: "Auto", forward: "Forward", clusteredForward: "Clustered Forward" };
const backendLabels: Record<GpuBackend, string> = { auto: "Auto", webgl2: "WebGL2", webgpu: "WebGPU" };

type Props = {
  project?: Partial<RenderingPipelineSettings>;
  hideTitle?: boolean;
  activePipeline?: ResolvedRenderingPipeline;
} & (
  | { scope: "project"; onChange: (value: RenderingPipelineSettings) => void }
  | { scope: "scene"; overrides: RenderPathOverrides; onChange: (value: RenderPathOverrides) => void }
);

/** Shared authoring controls; only the project owns the Engine backend. */
export function RenderPipelineFields(props: Props) {
  const project = normalizeRenderingPipeline(props.project);
  const scene = props.scope === "scene";
  const status = useProjectRenderingStatus();
  const reason = status?.deferredUntilStop ? "Backend changes apply after Stop."
    : status && status.requestedBackend !== project.gpuBackend ? "Backend changes apply when settings close."
    : status?.fallbackReason;
  const resolved = resolveRenderingPipeline(project, scene ? props.overrides : undefined, undefined, undefined,
    status?.effectiveBackend ? { gpuBackend: status.effectiveBackend, reason } : undefined);
  const active = props.activePipeline;
  const effective = active?.effective ?? resolved.effective;
  const limits = active ? [...active.limits, ...(reason ? [reason] : [])] : resolved.limits;
  const overridden = scene && props.overrides.renderPath !== undefined;
  const pathId = `${props.scope}-render-path`;
  return (
    <FieldSet data-testid={`${props.scope}-render-pipeline`}>
      <FieldLegend className={props.hideTitle ? "sr-only" : undefined}>Rendering</FieldLegend>
      <FieldGroup className="gap-2">
        <Field className="settings-field">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor={pathId}>Render Path</FieldLabel>
            {scene ? (
              <Button type="button" variant="ghost" size="sm"
                aria-label={overridden ? "Reset Render Path To Project Settings" : "Override Render Path"}
                onClick={() => props.onChange(overridden ? {} : { renderPath: resolved.requested.renderPath })}>
                {overridden ? "Reset To Project" : "Override"}
              </Button>
            ) : null}
          </div>
          <Select value={resolved.requested.renderPath} disabled={scene && !overridden}
            onValueChange={(renderPath) => {
              if (!isRenderPath(renderPath)) return;
              if (props.scope === "scene") props.onChange({ renderPath });
              else props.onChange({ ...project, renderPath });
            }}>
            <SelectTrigger id={pathId} data-testid={pathId} aria-describedby={`${pathId}-description`}>
              <SelectValue>{pathLabels[resolved.requested.renderPath]}</SelectValue>
            </SelectTrigger>
            <SelectContent><SelectGroup>
              {RENDER_PATHS.map((path) => <SelectItem key={path} value={path}>{pathLabels[path]}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
          <FieldDescription id={`${pathId}-description`}>
            Choose how lights are processed. PBR and CEL are independent of this preference.
          </FieldDescription>
        </Field>
        {props.scope === "project" ? (
          <Field className="settings-field">
            <FieldLabel htmlFor="project-gpu-backend">GPU Backend</FieldLabel>
            <Select value={project.gpuBackend} onValueChange={(gpuBackend) => {
              if (isGpuBackend(gpuBackend)) props.onChange({ ...project, gpuBackend });
            }}>
              <SelectTrigger id="project-gpu-backend" data-testid="project-gpu-backend" aria-describedby="project-gpu-backend-description">
                <SelectValue>{backendLabels[project.gpuBackend]}</SelectValue>
              </SelectTrigger>
              <SelectContent><SelectGroup>
                {GPU_BACKENDS.map((backend) => <SelectItem key={backend} value={backend}>{backendLabels[backend]}</SelectItem>)}
              </SelectGroup></SelectContent>
            </Select>
            <FieldDescription id="project-gpu-backend-description">
              Shared by the project's viewports, previews, Play, and exported games.
            </FieldDescription>
          </Field>
        ) : null}
        <Field>
          <FieldLabel>{scene ? "Effective Selection" : "Active Scene Selection"}</FieldLabel>
          <FieldDescription role="status" data-testid={`${props.scope}-render-pipeline-status`}>
            {pathLabels[resolved.effective.renderPath]} · {backendLabels[resolved.effective.gpuBackend]}
            {limits.length ? `. ${limits.join(" ")} Your preferences are retained.` : ""}
            {active && scene && active.requested.renderPath !== resolved.requested.renderPath ? " Render path changes apply after scene loading completes." : ""}
            {!scene ? " Selection is resolved for the active scene; scene overrides can choose another path." : ""}
          </FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
