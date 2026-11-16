import type { EnvironmentId, ServerProvider, UsageProviderKind } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { PROVIDER_PRESENTATION } from "./usageProviders";

type PresentationMap = Atom.Type<typeof environmentPresentations.presentationsWithProvidersAtom>;

export function selectConnectedUsageLimitPresentations(input: {
  readonly presentations: PresentationMap;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}) {
  const hiddenDrivers = new Set<ServerProvider["driver"]>(
    [...input.hiddenProviders].map((provider) => PROVIDER_PRESENTATION[provider].driverKind),
  );
  const isVisible = (driver: ServerProvider["driver"]) => !hiddenDrivers.has(driver);
  const selectedEntries = [...input.presentations].filter(
    ([id]) => input.selectedEnvironmentIds === null || input.selectedEnvironmentIds.has(id),
  );
  const disconnectedEntries = selectedEntries.filter(
    ([, presentation]) => presentation.connection.phase !== "connected",
  );
  const selected = new Map(
    selectedEntries.flatMap(([id, presentation]) => {
      if (presentation.connection.phase !== "connected") return [];
      const config = presentation.serverConfig;
      if (hiddenDrivers.size === 0 || config === null) return [[id, presentation] as const];
      return [
        [
          id,
          {
            ...presentation,
            serverConfig: {
              ...config,
              providers: config.providers.filter((provider) => isVisible(provider.driver)),
              usageLimitSources: config.usageLimitSources?.flatMap((source) => {
                const accounts = source.accounts.filter((account) => isVisible(account.driver));
                return accounts.length === 0 && source.accounts.length > 0
                  ? []
                  : [{ ...source, accounts }];
              }),
            },
          },
        ] as const,
      ];
    }),
  );
  return { selected, disconnectedEntries };
}
