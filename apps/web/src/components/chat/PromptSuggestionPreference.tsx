import type { RunId } from "@t3tools/contracts";

import { useUiLanguage } from "~/i18n/useUiLanguage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import { editPromptSuggestionPreference } from "./promptSuggestionPreferences";

export function PromptSuggestionPreference({
  threadKey,
  runId,
  value,
  onGenerate,
}: {
  threadKey: string;
  runId: RunId | null;
  value: string;
  onGenerate: (() => void) | null;
}) {
  const { t } = useUiLanguage();
  return (
    <div className="relative h-7 w-22 shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <textarea
              aria-label={t("composer.suggestionPreference")}
              placeholder={t("composer.suggestionPreference")}
              rows={1}
              maxLength={500}
              value={value}
              className="absolute bottom-0 left-0 z-10 h-7 w-22 resize-none overflow-hidden rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:z-20 focus:h-20 focus:w-[min(16rem,calc(100vw-5rem))] focus:overflow-auto focus:border-ring focus:ring-2 focus:ring-inset focus:ring-ring/24"
              onChange={(event) =>
                editPromptSuggestionPreference(threadKey, runId, event.target.value)
              }
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  onGenerate?.();
                  event.currentTarget.blur();
                }
              }}
            />
          }
        />
        <TooltipPopup {...composerFloatingLayerProps} side="top">
          {t("composer.suggestionPreferenceHelp")}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
