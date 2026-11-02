import { useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { DisclosureSection } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  SettingsSectionsContext,
  type SettingsSectionsHost,
  type SettingsSectionsValue,
} from "./use-settings-sections";

export function SettingsSectionsProvider({ value, children }: { value: SettingsSectionsValue; children: ReactNode }) {
  return <SettingsSectionsContext.Provider value={value}>{children}</SettingsSectionsContext.Provider>;
}

/**
 * One collapsible sub-category of a Settings category. Every setting in
 * Project and Engine Settings sits inside one. `id` is stable: it keys the
 * remembered open state and the search index (`settings-search.ts`).
 */
export function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const host = useContext(SettingsSectionsContext);
  const [localOpen, setLocalOpen] = useState(true);
  const register = host?.register;
  useLayoutEffect(() => register?.(id), [register, id]);
  return (
    <DisclosureSection
      title={title}
      open={host ? host.isOpen(id) : localOpen}
      onOpenChange={(open) => (host ? host.setOpen([id], open) : setLocalOpen(open))}
      data-testid={`settings-section-${id}`}
    >
      {children}
    </DisclosureSection>
  );
}

/** Category title with Expand All / Collapse All for its sub-categories. */
export function SettingsCategoryHeader({ title, host }: { title: string; host: SettingsSectionsHost }) {
  return (
    <div className="flex min-h-7 max-w-[64rem] items-center justify-between gap-2">
      <h3 className="text-base font-medium">{title}</h3>
      {host.sectionIds.length > 1 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="settings-sections-toggle-all"
          onClick={() => host.setAllOpen(!host.allOpen)}
        >
          {host.allOpen ? "Collapse All" : "Expand All"}
        </Button>
      ) : null}
    </div>
  );
}
