export const TEST_PROJECT_NAME = "TestProject.babylonslate";

function isViteTestModeEnabled(): boolean {
  if (typeof import.meta === "undefined") {
    return false;
  }

  const env = (import.meta as ImportMeta & { env?: { VITE_TEST_MODE?: string } }).env;
  return env?.VITE_TEST_MODE === "true";
}

export function isTestModeEnabled(): boolean {
  if (isViteTestModeEnabled()) {
    return true;
  }

  if (typeof window !== "undefined") {
    return new URLSearchParams(window.location.search).has("test");
  }

  return false;
}
