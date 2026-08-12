import { cn } from "@babylonslate/ui/lib/utils";
import { BRAND_NAME, brandLogoSrc } from "../lib/branding";

export function BrandLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center", className)}>
      <img
        src={brandLogoSrc("light")}
        alt={BRAND_NAME}
        className="h-8 w-auto dark:hidden"
        data-testid="brand-logo"
      />
      <img
        src={brandLogoSrc("dark")}
        alt=""
        aria-hidden="true"
        className="hidden h-8 w-auto dark:block"
        data-testid="brand-logo-dark"
      />
    </span>
  );
}
