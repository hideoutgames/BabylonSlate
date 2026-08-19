import { cn } from "@babylonslate/ui/lib/utils";
import { BRAND_NAME, brandIconSrc } from "../lib/branding";

export function BrandIcon({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center", className)}>
      <img
        src={brandIconSrc("light")}
        alt={BRAND_NAME}
        className="h-full w-auto dark:hidden"
        data-testid="brand-icon"
      />
      <img
        src={brandIconSrc("dark")}
        alt=""
        aria-hidden="true"
        className="hidden h-full w-auto dark:block"
        data-testid="brand-icon-dark"
      />
    </span>
  );
}
