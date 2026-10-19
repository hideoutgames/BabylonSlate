import { collisionMatrixAllows, setCollisionMatrixPair } from "@babylonslate/core";
import { Checkbox } from "@babylonslate/ui/components/checkbox";

export interface CollisionMatrixFieldProps {
  /** Collision layer names, bit 0 first. */
  labels: readonly string[];
  /** One row per layer (see `normalizeCollisionMatrix`). */
  value: readonly number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  "data-testid"?: string;
}

/**
 * Which collision layers collide, as one triangle of checkboxes (Unity's
 * Layer Collision Matrix): columns run last layer to first, so each pair
 * appears once and ticking it sets both layers' rows.
 */
export function CollisionMatrixField({
  labels,
  value,
  onChange,
  disabled,
  "data-testid": testId = "collision-matrix",
}: CollisionMatrixFieldProps) {
  const columns = labels.map((label, index) => ({ label, index })).reverse();
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="border-separate border-spacing-0 text-xs" role="grid" aria-label="Collision Matrix">
        <thead>
          <tr>
            <th />
            {columns.map((column) => (
              <th key={column.index} scope="col" className="h-20 w-6 p-0 align-bottom font-normal text-muted-foreground">
                <span className="mx-auto block max-h-20 truncate [writing-mode:vertical-rl] rotate-180 pb-1">
                  {column.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((rowLabel, row) => (
            <tr key={row}>
              <th scope="row" className="max-w-40 truncate pr-2 text-right font-normal text-muted-foreground">
                {rowLabel}
              </th>
              {columns.map((column) =>
                column.index < row ? (
                  <td key={column.index} className="size-6" />
                ) : (
                  <td key={column.index} className="size-6 text-center">
                    <Checkbox
                      className="size-3.5"
                      checked={collisionMatrixAllows(value, row, column.index)}
                      disabled={disabled}
                      aria-label={`${rowLabel} Collides With ${column.label}`}
                      data-testid={`${testId}-${row}-${column.index}`}
                      onCheckedChange={(checked) =>
                        onChange(setCollisionMatrixPair(value, row, column.index, checked === true))
                      }
                    />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
