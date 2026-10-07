import { Homepage } from "../components/homepage";
import { HomepageMobileAccountGate } from "../components/homepage-mobile-account-gate";
import { useDocumentActions, useEditorShellState } from "../context/document-context";

export default function HomeRoute() {
  const {
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
  } = useDocumentActions();
  const {
    listedProjects,
    needsReconnect,
    recoveryAvailable,
    templates,
    homepageReady,
  } = useEditorShellState();
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
        onSettingsChanged={refreshTemplates}
      />
    </HomepageMobileAccountGate>
  );
}
