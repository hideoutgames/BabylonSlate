import {
  collisionResponseTo,
  setCollisionResponse,
  type CollisionResponse,
} from "@haptic/core";
import { cn } from "@haptic/ui/lib/utils";

export interface CollisionResponsesValue {
  /** Layers blocked. */
  mask: number;
  /** Layers overlapped. */
  overlapMask: number;
}

export interface CollisionResponsesFieldProps {
  /** Collision layer names, bit 0 first. */
  layers: readonly string[];
  value: CollisionResponsesValue;
  onChange: (next: CollisionResponsesValue) => void;
  disabled?: boolean;
  "data-testid"?: string;
}

const RESPONSES: readonly { value: CollisionResponse; label: string }[] = [
  { value: "ignore", label: "Ignore" },
  { value: "overlap", label: "Overlap" },
  { value: "block", label: "Block" },
];

/**
 * Ignore / Overlap / Block per collision layer (Unreal's Collision
 * Responses): one radio row per layer, a header row that sets every layer.
 */
export function CollisionResponsesField({
  layers,
  value,
  onChange,
  disabled,
  "data-testid": testId = "collision-responses",
}: CollisionResponsesFieldProps) {
  const setAll = (response: CollisionResponse) =>
    onChange(layers.reduce<CollisionResponsesValue>((next, _, index) => setCollisionResponse(next, index, response), value));
  return (
    <table className="w-full border-separate border-spacing-0 text-xs" data-testid={testId} aria-label="Collision Responses">
      <thead>
        <tr>
          <th scope="col" className="sr-only">Layer</th>
          {RESPONSES.map((response) => (
            <th key={response.value} scope="col" className="w-14 p-0 text-center font-normal">
              <button
                type="button"
                disabled={disabled}
                className="rounded px-1 text-muted-foreground hover:text-foreground disabled:pointer-events-none"
                aria-label={`Set All Layers To ${response.label}`}
                data-testid={`${testId}-all-${response.value}`}
                onClick={() => setAll(response.value)}
              >
                {response.label}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {layers.map((layer, index) => {
          const current = collisionResponseTo(value, (1 << index) >>> 0);
          return (
            <tr key={layer} role="radiogroup" aria-label={`${layer} Response`}>
              <th scope="row" className="max-w-0 truncate py-0.5 pr-2 text-left font-normal text-foreground">{layer}</th>
              {RESPONSES.map((response) => {
                const checked = current === response.value;
                return (
                  <td key={response.value} className="p-0 text-center">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-label={`${layer} ${response.label}`}
                      disabled={disabled}
                      data-testid={`${testId}-${index}-${response.value}`}
                      className="inline-flex size-6 items-center justify-center rounded-full disabled:opacity-50 pointer-coarse:size-9"
                      onClick={() => onChange(setCollisionResponse(value, index, response.value))}
                    >
                      <span
                        className={cn(
                          "size-3 rounded-full border border-input",
                          checked && "border-[4px] border-primary",
                        )}
                      />
                    </button>
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
