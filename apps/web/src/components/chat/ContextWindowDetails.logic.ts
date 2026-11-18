import type { ModelSelection } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { getDisplayModelName } from "./providerIconUtils";

// oxlint-disable-next-line t3code/no-em-dash-copy -- Numeric missing-data marker.
export const UNKNOWN_CONTEXT_VALUE = "—";

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  entries: readonly ProviderInstanceEntry[],
  settings: UnifiedSettings,
): string | null {
  if (!selection) {
    return null;
  }

  const entry = entries.find((provider) => provider.instanceId === selection.instanceId);
  if (!entry) return selection.model;
  const selectedModel = getAppModelOptionsForInstance(settings, entry, selection.model).find(
    (model) => model.slug === selection.model,
  );

  return selectedModel ? getDisplayModelName(selectedModel) : selection.model;
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}
