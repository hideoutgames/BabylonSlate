import {
  GPU_BACKENDS, isGpuBackend, normalizeRenderingPipeline,
  type GpuBackend, type RenderingPipelineSettings,
} from "@haptic/core";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@haptic/ui/components/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";

const backendLabels: Record<GpuBackend, string> = { auto: "Auto", webgl2: "WebGL2", webgpu: "WebGPU" };

type Props = {
  scope: "project";
  project?: Partial<RenderingPipelineSettings>;
  hideTitle?: boolean;
  onChange: (value: RenderingPipelineSettings) => void;
};

/** Project-wide rendering controls; only the project owns the Engine backend. */
export function RenderPipelineFields(props: Props) {
  const project = normalizeRenderingPipeline(props.project);
  return (
    <FieldSet data-testid={`${props.scope}-render-pipeline`}>
      <FieldLegend className={props.hideTitle ? "sr-only" : undefined}>Rendering</FieldLegend>
      <FieldGroup className="gap-2">
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
            Used by viewports, previews, Play, and exported games.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
