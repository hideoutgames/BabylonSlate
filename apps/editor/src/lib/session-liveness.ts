export interface LivenessProject {
  guid: string;
  name: string;
}

export interface UncleanExit {
  project: LivenessProject | null;
  lastSeenAt: number;
  recentCount: number;
}

export interface SessionLiveness {
  readonly uncleanExit: UncleanExit | null;
  setProject(project: LivenessProject | null): void;
  stop(): void;
}

export const SESSION_LIVENESS_KEY = "babylonslate.session-liveness";
export const UNCLEAN_EXIT_WINDOW_MS = 10 * 60_000;
export const SESSION_HEARTBEAT_MS = 5_000;

interface LivenessRecord {
  v: 1;
  alive: boolean;
  lastSeen: number;
  project: LivenessProject | null;
  exits: number[];
}

function readRecord(storage: Pick<Storage, "getItem">): LivenessRecord | null {
  try {
    const raw = storage.getItem(SESSION_LIVENESS_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<LivenessRecord>;
    if (
      record.v !== 1 ||
      typeof record.alive !== "boolean" ||
      typeof record.lastSeen !== "number" ||
      !Array.isArray(record.exits) ||
      record.exits.some((t) => typeof t !== "number")
    ) {
      return null;
    }
    const project = record.project;
    return {
      v: 1,
      alive: record.alive,
      lastSeen: record.lastSeen,
      project:
        project && typeof project.guid === "string"
          ? {
              guid: project.guid,
              name: typeof project.name === "string" ? project.name : project.guid,
            }
          : null,
      exits: record.exits,
    };
  } catch {
    return null;
  }
}

/**
 * Tracks whether the current page instance exits cleanly. A record left
 * `alive` when the next instance starts means the previous page died without
 * `pagehide` (WebContent crash, jetsam, force-quit).
 */
export function startSessionLiveness(options: {
  storage: Pick<Storage, "getItem" | "setItem">;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  now?: () => number;
}): SessionLiveness {
  const { storage } = options;
  const target = options.target ?? window;
  const now = options.now ?? (() => Date.now());

  const previous = readRecord(storage);
  const exits = (previous?.exits ?? []).filter(
    (t) => t > now() - UNCLEAN_EXIT_WINDOW_MS,
  );
  let uncleanExit: UncleanExit | null = null;
  if (previous?.alive === true) {
    exits.push(now());
    uncleanExit = {
      project: previous.project,
      lastSeenAt: previous.lastSeen,
      recentCount: exits.length,
    };
  }

  let state: LivenessRecord = {
    v: 1,
    alive: true,
    lastSeen: now(),
    project: null,
    exits,
  };
  const write = () => {
    try {
      storage.setItem(SESSION_LIVENESS_KEY, JSON.stringify(state));
    } catch {
      // Quota or privacy-mode failures must never break the app.
    }
  };
  write();

  const onPageHide = () => {
    state = { ...state, alive: false, lastSeen: now() };
    write();
  };
  const onPageShow = () => {
    state = { ...state, alive: true, lastSeen: now() };
    write();
  };
  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);
  const heartbeat = setInterval(() => {
    state = { ...state, lastSeen: now() };
    write();
  }, SESSION_HEARTBEAT_MS);

  return {
    get uncleanExit() {
      return uncleanExit;
    },
    setProject(project) {
      state = { ...state, project };
      write();
    },
    stop() {
      clearInterval(heartbeat);
      target.removeEventListener("pagehide", onPageHide);
      target.removeEventListener("pageshow", onPageShow);
    },
  };
}

let active: SessionLiveness | null = null;

/** Starts the module-level liveness session once; safe to call repeatedly. */
export function initSessionLiveness(): SessionLiveness | null {
  if (active) return active;
  try {
    active = startSessionLiveness({ storage: window.localStorage });
  } catch {
    return null;
  }
  return active;
}

export function getSessionLiveness(): SessionLiveness | null {
  return active;
}
