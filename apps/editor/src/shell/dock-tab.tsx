import { useEffect, useState } from "react";
import type { DockviewPanelApi, IDockviewPanelHeaderProps } from "dockview-react";
import { SquareFunctionIcon } from "lucide-react";
import { isFunctionGraphPanelId } from "./function-graph-panels";

/** Dockview's close glyph (`createCloseButton` in dockview-core). */
const CLOSE_GLYPH_PATH =
  "M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z";

function usePanelTitle(api: DockviewPanelApi): string | undefined {
  const [title, setTitle] = useState(api.title);
  useEffect(() => {
    setTitle(api.title);
    const subscription = api.onDidTitleChange((event) => setTitle(event.title));
    return () => subscription.dispose();
  }, [api]);
  return title;
}

/**
 * Every DockView tab. It mirrors dockview-core's own `DefaultTab` (markup,
 * a `role="button"` close action named "Close <title>" from the dock's message
 * catalog, close on click), led by a kind icon chosen from the panel id, so
 * restored tabs get it too: Class function graphs show the Function icon, as
 * in My Class, to stand apart from the Event Graph and windows.
 */
export function HapticDockTab({ api, containerApi }: IDockviewPanelHeaderProps) {
  const title = usePanelTitle(api);
  const messages = containerApi.messages;
  return (
    <>
      {isFunctionGraphPanelId(api.id) ? (
        <SquareFunctionIcon className="dock-tab-icon" aria-hidden="true" data-tab-icon="function" />
      ) : null}
      <div className="dv-default-tab">
        <div className="dv-default-tab-content">{title ?? ""}</div>
        <div
          className="dv-default-tab-action"
          role="button"
          tabIndex={-1}
          aria-label={title ? messages.closeTab(title) : messages.closeTabPlain()}
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            api.close();
          }}
        >
          <svg className="dv-svg" width="11" height="11" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
            <path d={CLOSE_GLYPH_PATH} />
          </svg>
        </div>
      </div>
    </>
  );
}
