import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DisclosureSection } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { useAppSettings } from "../context/app-settings-context";

interface SettingsSectionsValue {
  isOpen: (id: string) => boolean;
  setOpen: (ids: readonly string[], open: boolean) => void;
  register: (id: string) => () => void;
}

const SettingsSectionsContext = createContext<SettingsSectionsValue | null>(null);

export interface SettingsSectionsHost {
  /** Provide to the active category's body. */
  value: SettingsSectionsValue;
  /** Sub-categories the active category currently renders, in mount order. */
  sectionIds: readonly string[];
  allOpen: boolean;
  setAllOpen: (open: boolean) => void;
  /** Opens one sub-category of any category, e.g. for a search result. */
  openSection: (categoryId: string, sectionId: string) => void;
}

/**
 * Open state for the sub-categories of a Settings dialog. Every sub-category
 * starts open; collapsing one is remembered on this device per dialog
 * (`scope`), category and sub-category.
 */
export function useSettingsSectionsHost(scope: string, categoryId: string): SettingsSectionsHost {
  const { settings, updateSettings } = useAppSettings();
  const collapsed = settings.collapsedSettingsSections;
  // Applied at once; the persisted list catches up when the store saves.
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [sectionIds, setSectionIds] = useState<readonly string[]>([]);

  const keyOf = useCallback((category: string, id: string) => `${scope}:${category}:${id}`, [scope]);
  const setKeysOpen = useCallback((keys: readonly string[], open: boolean) => {
    if (keys.length === 0) return;
    setOverrides((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, open])) }));
    void updateSettings((next) => {
      const rest = next.collapsedSettingsSections.filter((key) => !keys.includes(key));
      next.collapsedSettingsSections = open ? rest : [...rest, ...keys];
    }).catch((error) => console.warn("Could not remember the Settings section:", error));
  }, [updateSettings]);

  const isOpen = useCallback((id: string) => {
    const key = keyOf(categoryId, id);
    return overrides[key] ?? !collapsed.includes(key);
  }, [categoryId, collapsed, keyOf, overrides]);
  const setOpen = useCallback(
    (ids: readonly string[], open: boolean) => setKeysOpen(ids.map((id) => keyOf(categoryId, id)), open),
    [categoryId, keyOf, setKeysOpen],
  );
  const register = useCallback((id: string) => {
    setSectionIds((current) => (current.includes(id) ? current : [...current, id]));
    return () => setSectionIds((current) => current.filter((entry) => entry !== id));
  }, []);
  const value = useMemo(() => ({ isOpen, setOpen, register }), [isOpen, setOpen, register]);

  return {
    value,
    sectionIds,
    allOpen: sectionIds.every(isOpen),
    setAllOpen: (open) => setOpen(sectionIds, open),
    openSection: (category, id) => setKeysOpen([keyOf(category, id)], true),
  };
}

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
