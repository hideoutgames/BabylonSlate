import { useState } from "react";
import {
  CurveField,
  GradientField,
  ModuleCard,
  ModuleStack,
  ModuleStage,
  ValueModeField,
  VALUE_MODE_CONSTANT,
  VALUE_MODE_CURVE,
  VALUE_MODE_RANGE,
  PanelFrame,
  PropertyGrid,
  type CurveKey,
  type GradientStop,
  type PropertyRow,
} from "@haptic/editor-kit";
import {
  PARTICLE_VALUE_SPECS,
  convertScalarValueMode,
  type ParticleScalarValue,
} from "@haptic/assets";
import { basicParticleStageRole } from "@haptic/ui/lib/data-types";

const GALLERY_SCALAR_MODES = [VALUE_MODE_CONSTANT, VALUE_MODE_RANGE, VALUE_MODE_CURVE];

/** Lifetime row in whichever kind its value mode needs, as Basic emitter Details do. */
function galleryLifetimeRow(
  value: ParticleScalarValue,
  onChange: (value: ParticleScalarValue) => void,
): PropertyRow {
  const base = {
    id: "gallery-lifetime",
    label: "Lifetime",
    unit: "s",
    labelAccessory: (
      <ValueModeField
        label="Lifetime"
        value={value.mode}
        options={GALLERY_SCALAR_MODES}
        onChange={(mode) =>
          onChange(
            convertScalarValueMode(
              value,
              mode,
              PARTICLE_VALUE_SPECS["initialize.lifetime"],
            ),
          )
        }
        data-testid="value-mode-gallery-lifetime"
      />
    ),
  };
  if (value.mode === "range") {
    return {
      ...base,
      kind: "range",
      value: [value.min, value.max],
      min: 0.01,
      onChange: ([min, max]) => onChange({ mode: "range", min, max }),
    };
  }
  if (value.mode === "curve") {
    return {
      ...base,
      kind: "curve",
      value: value.keys,
      valueMin: 0.01,
      axisLabels: { start: "Start", end: "End" },
      onChange: (keys) => onChange({ mode: "curve", keys }),
    };
  }
  return {
    ...base,
    kind: "number",
    value: value.value,
    min: 0.01,
    onChange: (next) => onChange({ mode: "constant", value: next }),
  };
}

export function GalleryModuleStack() {
  const [openCards, setOpenCards] = useState(
    () => new Set(["spawnRate", "initialize", "size"]),
  );
  const [burstsEnabled, setBurstsEnabled] = useState(false);
  const [rate, setRate] = useState(20);
  const [lifetime, setLifetime] = useState<ParticleScalarValue>({
    mode: "range",
    min: 0.8,
    max: 1.2,
  });
  const [size, setSize] = useState<CurveKey[]>([
    { t: 0, value: 0.2 },
    { t: 1, value: 0.4 },
  ]);
  const cardOpen = (id: string) => ({
    open: openCards.has(id),
    onOpenChange: (open: boolean) =>
      setOpenCards((current) => {
        const next = new Set(current);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
  });

  return (
    <div
      className="h-96 max-w-sm overflow-hidden rounded-lg border border-border"
      data-testid="gallery-module-stack"
    >
      <PanelFrame title="Module stack">
        <ModuleStack>
          <ModuleStage id="spawn" title="Spawn" accentRole={basicParticleStageRole("spawn")}>
            <ModuleCard id="spawnRate" title="Spawn Rate" summary={`${rate} /s`} {...cardOpen("spawnRate")}>
              <PropertyGrid
                rows={[
                  {
                    kind: "number",
                    id: "gallery-rate",
                    label: "Rate",
                    unit: "/s",
                    value: rate,
                    defaultValue: 20,
                    min: 0,
                    onChange: setRate,
                  },
                ]}
              />
            </ModuleCard>
            <ModuleCard
              id="bursts"
              title="Bursts"
              summary="1 Burst"
              enabled={burstsEnabled}
              onEnabledChange={(enabled) => {
                setBurstsEnabled(enabled);
                if (enabled) cardOpen("bursts").onOpenChange(true);
              }}
              {...cardOpen("bursts")}
            >
              <PropertyGrid
                rows={[
                  {
                    kind: "number",
                    id: "gallery-burst-count",
                    label: "Count",
                    value: 10,
                    onChange: () => {},
                  },
                ]}
              />
            </ModuleCard>
          </ModuleStage>
          <ModuleStage
            id="initialize"
            title="Initialize"
            accentRole={basicParticleStageRole("initialize")}
          >
            <ModuleCard
              id="initialize"
              title="Initialize Particle"
              summary="Lifetime 1 s"
              {...cardOpen("initialize")}
            >
              <PropertyGrid rows={[galleryLifetimeRow(lifetime, setLifetime)]} />
            </ModuleCard>
          </ModuleStage>
          <ModuleStage id="overLife" title="Over Life" accentRole={basicParticleStageRole("overLife")}>
            <ModuleCard id="size" title="Size" summary="Curve" {...cardOpen("size")}>
              <PropertyGrid
                rows={[
                  {
                    kind: "curve",
                    id: "gallery-size",
                    label: "Size",
                    value: size,
                    valueMin: 0,
                    onChange: setSize,
                  },
                ]}
              />
            </ModuleCard>
          </ModuleStage>
        </ModuleStack>
      </PanelFrame>
    </div>
  );
}

export function GalleryParticleFields() {
  const [mode, setMode] = useState<"constant" | "range" | "curve">("constant");
  const [curve, setCurve] = useState<CurveKey[]>([
    { t: 0, value: 1 },
    { t: 0.35, value: 1.6 },
    { t: 1, value: 0 },
  ]);
  const [gradient, setGradient] = useState<GradientStop[]>([
    { t: 0, color: [1, 1, 1, 1] },
    { t: 0.4, color: [1, 0.54, 0, 0.8] },
    { t: 1, color: [1, 0.2, 0, 0] },
  ]);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div
        className="flex items-center gap-2 rounded-lg border border-border p-3"
        data-testid="gallery-value-mode"
      >
        <span className="text-sm">Size</span>
        <ValueModeField
          label="Size"
          value={mode}
          options={GALLERY_SCALAR_MODES}
          onChange={setMode}
          data-testid="gallery-value-mode-field"
        />
      </div>
      <div className="rounded-lg border border-border p-3">
        <CurveField
          aria-label="Speed Multiplier"
          value={curve}
          valueMin={0}
          onChange={setCurve}
          defaultExpanded
          data-testid="gallery-curve-field"
        />
      </div>
      <div className="rounded-lg border border-border p-3">
        <GradientField
          aria-label="Color"
          value={gradient}
          onChange={setGradient}
          defaultExpanded
          data-testid="gallery-gradient-field"
        />
      </div>
    </div>
  );
}
