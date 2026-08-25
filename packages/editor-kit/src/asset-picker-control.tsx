import {
  Children,
  createContext,
  isValidElement,
  useContext,
  type ReactNode,
} from "react";
import { SquareArrowOutUpRightIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";

export type AssetOpenApi = {
  canOpen: (guid: string) => boolean;
  openAsset: (guid: string) => void;
};

const AssetOpenContext = createContext<AssetOpenApi | null>(null);

export function AssetOpenProvider({
  value,
  children,
}: {
  value: AssetOpenApi;
  children: ReactNode;
}) {
  return (
    <AssetOpenContext.Provider value={value}>
      {children}
    </AssetOpenContext.Provider>
  );
}

export function useAssetOpen(): AssetOpenApi | null {
  return useContext(AssetOpenContext);
}

function triggerTestId(children: ReactNode): string | undefined {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (!isValidElement(child)) return undefined;
  const testId = (child.props as { "data-testid"?: unknown })["data-testid"];
  return typeof testId === "string" && testId.length > 0 ? testId : undefined;
}

/** Closed AssetPicker trigger plus a square Open Asset control when the guid can open a tab. */
export function AssetPickerControl({
  value,
  children,
}: {
  value?: string | null;
  children: ReactNode;
}) {
  const api = useAssetOpen();
  const guid = value?.trim() ?? "";
  const showOpen = Boolean(api && guid && api.canOpen(guid));
  const testId = triggerTestId(children);

  return (
    <div className="flex min-w-0 items-stretch gap-1">
      <div className="min-w-0 flex-1">{children}</div>
      {showOpen && api ? (
        <div className="aspect-square h-auto shrink-0 self-stretch">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Open Asset"
                  className="size-full p-0"
                  data-testid={testId ? `${testId}-open` : "asset-picker-open"}
                  onClick={() => {
                    api.openAsset(guid);
                  }}
                />
              }
            >
              <SquareArrowOutUpRightIcon />
            </TooltipTrigger>
            <TooltipContent>Open Asset</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
