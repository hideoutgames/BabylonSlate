import {
  GPU_BACKENDS, RENDER_PATHS, isGpuBackend, isRenderPath,
  normalizeRenderingPipeline, resolveRenderingPipeline,
  type GpuBackend, type RenderPath, type RenderingPipelineSettings, type ResolvedRenderingPipeline,
} from "@babylonslate/core";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@babylonslate/ui/components/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@babylonslate/ui/components/select";
import { useProjectRenderingStatus } from "../context/project-rendering-context";

const pathLabels: Record<RenderPath, string> = { auto: "Auto", forward: "Forward", clusteredForward: "Clustered Forward" };
const backendLabels: Record<GpuBackend, string> = { auto: "Auto", webgl2: "WebGL2", webgpu: "WebGPU" };

type Props = {
  scope: "project";
  project?: Partial<RenderingPipelineSettings>;
  hideTitle?: boolean;
  activePipeline?: ResolvedRenderingPipeline;
  onChange: (value: RenderingPipelineSettings) => void;
};

/** Project-wide rendering controls; only the project owns the render path and Engine backend. */
export function RenderPipelineFields(props: Props) {
  const project = normalizeRenderingPipeline(props.project);
  const status = useProjectRenderingStatus();
  const reason = status?.deferredUntilStop ? "Backend changes apply after Stop."
    : status && status.requestedBackend !== project.gpuBackend ? "Backend changes apply when settings close."
    : status?.fallbackReason;
  const resolved = resolveRenderingPipeline(project, undefined,
    status?.effectiveBackend ? { gpuBackend: status.effectiveBackend, reason } : undefined);
  const active = props.activePipeline;
  const effective = active?.effective ?? resolved.effective;
  const limits = active ? [...active.limits, ...(reason ? [reason] : [])] : resolved.limits;
  const pathId = `${props.scope}-render-path`;
  return (
    <FieldSet data-testid={`${props.scope}-render-pipeline`}>
      <FieldLegend className={props.hideTitle ? "sr-only" : undefined}>Rendering</FieldLegend>
      <FieldGroup className="gap-2">
        <Field className="settings-field">
          <FieldLabel htmlFor={pathId}>Render Path</FieldLabel>
          <Select value={resolved.requested.renderPath}
            onValueChange={(renderPath) => {
              if (!isRenderPath(renderPath)) return;
              props.onChange({ ...project, renderPath });
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
        <Field>
          <FieldLabel>Active Scene Selection</FieldLabel>
          <FieldDescription role="status" data-testid={`${props.scope}-render-pipeline-status`}>
            {pathLabels[effective.renderPath]} · {backendLabels[effective.gpuBackend]}
            {limits.length ? `. ${limits.join(" ")} Your preferences are retained.` : ""}
            {" Selection is resolved for the active scene."}
          </FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
