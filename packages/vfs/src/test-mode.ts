export const TEST_PROJECT_NAME = "TestProject";

type SlateImportMetaEnv = {
  DEV?: boolean;
  VITE_TEST_MODE?: string;
  VITE_TEST_QUERY?: string;
};

function slateImportMetaEnv(): SlateImportMetaEnv | undefined {
  if (typeof import.meta === "undefined") {
    return undefined;
  }

  return (import.meta as ImportMeta & { env?: SlateImportMetaEnv }).env;
}

function isViteTestModeEnabled(): boolean {
  return slateImportMetaEnv()?.VITE_TEST_MODE === "true";
}

// Query-string activation requires a bundle compiled for QA: the Vite dev
// server or a build opted in with VITE_TEST_QUERY. Production bundles cannot
// supply it, and distribution builds hard-fail on both flags in the editor's
// vite.config.ts.
function isTestQueryAllowed(): boolean {
  const env = slateImportMetaEnv();
  return env?.DEV === true || env?.VITE_TEST_QUERY === "true";
}

export function isTestModeEnabled(): boolean {
  if (isViteTestModeEnabled()) {
    return true;
  }

  if (typeof window === "undefined" || !isTestQueryAllowed()) {
    return false;
  }

  const value = new URLSearchParams(window.location.search).get("test");
  return value !== null && value !== "false";
}
