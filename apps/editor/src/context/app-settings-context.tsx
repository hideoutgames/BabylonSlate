import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createAppSettingsStore,
  defaultEngineSettings,
  ENGINE_SETTINGS_CHANGED_EVENT,
  type AppSettingsStore,
  type EngineSettings,
} from "@babylonslate/vfs";

export type AppSettingsSnapshot = {
  settings: EngineSettings;
  version: number;
  hydrated: boolean;
};

type Listener = (snapshot: AppSettingsSnapshot) => void;

export class AppSettingsOwner {
  private readonly store: AppSettingsStore;
  private snapshot: AppSettingsSnapshot = {
    settings: defaultEngineSettings(),
    version: 0,
    hydrated: false,
  };
  private readonly listeners = new Set<Listener>();
  private generation = 0;

  constructor(store: AppSettingsStore) {
    this.store = store;
  }

  getSnapshot = (): AppSettingsSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  };

  hydrate = async (): Promise<void> => {
    const generation = this.generation;
    const settings = await this.store.load();
    if (generation !== this.generation) return;
    this.publish(settings, true);
  };

  receiveUpdate = (
    patch: Partial<EngineSettings> & {
      theme?: EngineSettings["appearance"]["theme"];
    },
  ): void => {
    this.generation += 1;
    const appearance = patch.theme
      ? { ...this.snapshot.settings.appearance, theme: patch.theme }
      : (patch.appearance ?? this.snapshot.settings.appearance);
    this.publish(
      { ...this.snapshot.settings, ...patch, appearance },
      this.snapshot.hydrated,
    );
  };

  update = async (
    mutate: (settings: EngineSettings) => void,
  ): Promise<void> => {
    const generation = this.generation;
    const settings = await this.store.update(mutate);
    // Browser stores publish the completed update. Keep non-browser/test stores
    // reactive without publishing the same logical update twice.
    if (generation === this.generation) this.receiveUpdate(settings);
  };

  private publish(settings: EngineSettings, hydrated: boolean): void {
    this.snapshot = {
      settings,
      version: this.snapshot.version + 1,
      hydrated,
    };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
}

const fallbackOwner = new AppSettingsOwner(createAppSettingsStore());
let activeOwner = fallbackOwner;

export function subscribeAppSettings(listener: Listener): () => void {
  return activeOwner.subscribe(listener);
}

function getActiveAppSettingsSnapshot(): AppSettingsSnapshot {
  return activeOwner.getSnapshot();
}

export function receiveActiveAppSettingsUpdate(
  patch: Partial<EngineSettings> & {
    theme?: EngineSettings["appearance"]["theme"];
  },
): void {
  activeOwner.receiveUpdate(patch);
}

export function updateActiveViewportPrefs(
  patch: Pick<Partial<EngineSettings>, "viewportFlySpeed" | "viewportGridSize">,
): Promise<void> {
  return activeOwner.update((settings) => Object.assign(settings, patch));
}

type AppSettingsContextValue = AppSettingsSnapshot & {
  updateSettings: AppSettingsOwner["update"];
  updateViewportPrefs: (
    patch: Pick<
      Partial<EngineSettings>,
      "viewportFlySpeed" | "viewportGridSize"
    >,
  ) => Promise<void>;
  updateDebuggerDefaults: (
    patch: Partial<EngineSettings["debuggerDefaults"]>,
  ) => Promise<void>;
};

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

export function AppSettingsProvider({
  children,
  store,
}: {
  children: ReactNode;
  store?: AppSettingsStore;
}) {
  const ownerRef = useRef<AppSettingsOwner | null>(null);
  if (!ownerRef.current)
    ownerRef.current = new AppSettingsOwner(store ?? createAppSettingsStore());
  const owner = ownerRef.current;
  const [snapshot, setSnapshot] = useState(owner.getSnapshot);

  useEffect(() => {
    activeOwner = owner;
    const unsubscribe = owner.subscribe(setSnapshot);
    const onSettings = (event: Event) => {
      const detail = (
        event as CustomEvent<
          Partial<EngineSettings> & {
            theme?: EngineSettings["appearance"]["theme"];
          }
        >
      ).detail;
      if (detail) owner.receiveUpdate(detail);
    };
    window.addEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
    void owner.hydrate();
    return () => {
      unsubscribe();
      window.removeEventListener(ENGINE_SETTINGS_CHANGED_EVENT, onSettings);
      if (activeOwner === owner) activeOwner = fallbackOwner;
    };
  }, [owner]);

  const updateSettings = useCallback(
    (mutate: (settings: EngineSettings) => void) => owner.update(mutate),
    [owner],
  );
  const updateViewportPrefs = useCallback(
    (
      patch: Pick<
        Partial<EngineSettings>,
        "viewportFlySpeed" | "viewportGridSize"
      >,
    ) => owner.update((settings) => Object.assign(settings, patch)),
    [owner],
  );
  const updateDebuggerDefaults = useCallback(
    (patch: Partial<EngineSettings["debuggerDefaults"]>) =>
      owner.update((settings) =>
        Object.assign(settings.debuggerDefaults, patch),
      ),
    [owner],
  );
  const value = useMemo(
    () => ({
      ...snapshot,
      updateSettings,
      updateViewportPrefs,
      updateDebuggerDefaults,
    }),
    [snapshot, updateSettings, updateViewportPrefs, updateDebuggerDefaults],
  );
  return (
    <AppSettingsContext.Provider value={value}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings(): AppSettingsContextValue {
  const value = useContext(AppSettingsContext);
  const snapshot = useSyncExternalStore(
    subscribeAppSettings,
    getActiveAppSettingsSnapshot,
    getActiveAppSettingsSnapshot,
  );
  return value ?? {
    ...snapshot,
    updateSettings: (mutate) => activeOwner.update(mutate),
    updateViewportPrefs: (patch) => updateActiveViewportPrefs(patch),
    updateDebuggerDefaults: (patch) =>
      activeOwner.update((settings) =>
        Object.assign(settings.debuggerDefaults, patch),
      ),
  };
}
