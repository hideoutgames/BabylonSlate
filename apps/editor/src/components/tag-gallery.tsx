import { useState } from "react";
import { createTag, findTag, normalizeTagRegistry, type TagContainer } from "@babylonslate/core";
import { PanelFrame, PropertyGrid, TagProvider } from "@babylonslate/editor-kit";

function sampleRegistry() {
  return [
    "Ability.Movement.Dash", "Ability.Movement.Jump", "Ability.Combat.Melee",
    "Ability.Combat.Ranged", "State.Alive", "State.Combat.Attacking",
    "State.Combat.Blocking", "State.Movement.Grounded", "State.Movement.Airborne",
    "Team.Friendly", "Team.Hostile",
  ].reduce((registry, path) => createTag(registry, path).registry, normalizeTagRegistry(undefined));
}

/** Interactive examples of the same pickers used by Class variables and pins. */
export function TagGallery() {
  const [registry, setRegistry] = useState(sampleRegistry);
  const [tag, setTag] = useState(() => findTag(registry, "Ability.Movement.Dash"));
  const [container, setContainer] = useState<TagContainer>(() => ({
    Tags: [findTag(registry, "State.Alive"), findTag(registry, "State.Combat.Attacking")],
  }));
  return (
    <TagProvider entries={registry.tags} onCreate={(path) => {
      const created = createTag(registry, path);
      setRegistry(created.registry);
      return created.tag;
    }}>
      <section className="flex flex-col gap-3" data-testid="gallery-tags">
        <h2 className="text-lg font-medium">Tags</h2>
        <div className="overflow-hidden rounded-lg border">
          <PanelFrame title="Variable Defaults">
            <PropertyGrid rows={[
              { id: "gallery-tag", label: "Tag", kind: "tag", value: tag, onChange: setTag },
              { id: "gallery-tag-container", label: "TagContainer", kind: "tag-container", value: container, onChange: setContainer },
            ]} />
          </PanelFrame>
        </div>
      </section>
    </TagProvider>
  );
}
