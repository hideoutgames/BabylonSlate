import { useSyncExternalStore } from "react";

const key = "slate:launcher-scheme";
const changed = "slate-launcher-scheme";
type Scheme = "dark" | "light";
let memoryScheme: Scheme = "dark";

function read(): Scheme {
  try {
    const stored = localStorage.getItem(key);
    return stored === "light" || stored === "dark" ? stored : memoryScheme;
  } catch {
    return memoryScheme;
  }
}

function subscribe(update: () => void) {
  window.addEventListener(changed, update);
  window.addEventListener("storage", update);
  return () => {
    window.removeEventListener(changed, update);
    window.removeEventListener("storage", update);
  };
}

export function useHomepageScheme() {
  const scheme = useSyncExternalStore(subscribe, read, () => "dark" as const);
  const setScheme = (value: Scheme) => {
    memoryScheme = value;
    try {
      localStorage.setItem(key, value);
    } catch {
      // The launcher remains usable when storage is unavailable.
    }
    window.dispatchEvent(new Event(changed));
  };
  return [scheme, setScheme] as const;
}
