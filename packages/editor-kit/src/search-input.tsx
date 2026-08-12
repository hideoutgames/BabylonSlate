import { forwardRef, type ComponentProps } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { Input } from "@babylonslate/ui/components/input";
import { cn } from "@babylonslate/ui/lib/utils";

export interface SearchInputProps
  extends Omit<ComponentProps<"input">, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  "data-testid"?: string;
}

/** Text field with a trailing clear control when the query is non-empty. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    { value, onChange, className, "data-testid": testId, ...props },
    ref,
  ) {
    return (
      <div className="relative min-w-0 flex-1">
        <Input
          {...props}
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn("pr-8", className)}
          data-testid={testId}
        />
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            aria-label="Clear search"
            data-testid={testId ? `${testId}-clear` : "search-clear"}
            onClick={() => onChange("")}
          >
            <span aria-hidden="true">×</span>
          </Button>
        ) : null}
      </div>
    );
  },
);

