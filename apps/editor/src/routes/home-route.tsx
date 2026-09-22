import { useState } from "react";
import { Homepage } from "../components/homepage";
import { getSessionLiveness } from "../lib/session-liveness";
import { HomepageMobileAccountGate } from "../components/homepage-mobile-account-gate";
import { useDocuments } from "../context/document-context";

export default function HomeRoute() {
  const {
    listedProjects,
    needsReconnect,
    recoveryAvailable,
    templates,
    homepageReady,
    refreshTemplates,
    createEmptyProject,
    createFromTemplate,
    openProject,
    openListedProject,
    updateListedProject,
    removeListedProject,
    reconnectProject,
    keepRecovery,
    dismissRecovery,
  } = useDocuments();
  const [uncleanExit, setUncleanExit] = useState(
    () => getSessionLiveness()?.uncleanExit ?? null,
  );
  return (
    <HomepageMobileAccountGate>
      <Homepage
        projects={listedProjects}
        dataReady={homepageReady}
        templates={templates.map((template) => ({
          id: template.id,
          name: template.name,
        }))}
        needsReconnect={needsReconnect}
        recoveryAvailable={recoveryAvailable}
        onCreateEmpty={createEmptyProject}
        onCreateFromTemplate={createFromTemplate}
        onOpenExternal={openProject}
        onOpenProject={openListedProject}
        onUpdateProject={updateListedProject}
        onRemoveFromList={removeListedProject}
        onReconnect={reconnectProject}
        onRecover={keepRecovery}
        onDismissRecovery={() => void dismissRecovery()}
        uncleanExit={uncleanExit}
        onDismissUncleanExit={() => setUncleanExit(null)}
        onSettingsChanged={refreshTemplates}
      />
    </HomepageMobileAccountGate>
  );
}
