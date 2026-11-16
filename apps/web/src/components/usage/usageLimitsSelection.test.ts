import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectConnectedUsageLimitPresentations } from "./usageLimitsSelection";

const localId = EnvironmentId.make("local-env");
const remoteId = EnvironmentId.make("remote-env");

function makeProvider(
  driver: string,
  usedPercent: number,
  checkedAt = "2026-11-16T08:00:00.000Z",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [{ id: "gemini-weekly", label: "Gemini · Weekly", kind: "weekly", usedPercent }],
    },
  };
}

function makePresentation(
  label: string,
  phase: "connected" | "connecting" | "disconnected",
  providers: readonly ServerProvider[],
  error: string | null = null,
) {
  return {
    entry: { target: { label } },
    connection: { phase, error, traceId: null },
    serverConfig: { providers, usageLimitSources: [] },
  };
}

describe("selectConnectedUsageLimitPresentations", () => {
  it("excludes disconnected remote environments even when cached serverConfig is present, and includes them once reconnected", () => {
    const staleRemote = makePresentation(
      "Remote",
      "disconnected",
      [makeProvider("antigravity", 99, "2026-11-12T08:00:00.000Z")],
      "Transport error",
    );
    const connectedLocal = makePresentation("Local", "connected", [
      makeProvider("codex", 65, "2026-11-16T08:00:00.000Z"),
    ]);

    const offlineResult = selectConnectedUsageLimitPresentations({
      presentations: new Map([
        [localId, connectedLocal],
        [remoteId, staleRemote],
      ]) as never,
      selectedEnvironmentIds: null,
      hiddenProviders: new Set(),
    });
    expect([...offlineResult.selected.keys()]).toEqual([localId]);
    expect(offlineResult.disconnectedEntries.map(([id]) => id)).toEqual([remoteId]);

    const reconnectedRemote = makePresentation("Remote", "connected", [
      makeProvider("antigravity", 60, "2026-11-16T09:00:00.000Z"),
    ]);
    const reconnectedResult = selectConnectedUsageLimitPresentations({
      presentations: new Map([
        [localId, connectedLocal],
        [remoteId, reconnectedRemote],
      ]) as never,
      selectedEnvironmentIds: null,
      hiddenProviders: new Set(),
    });
    expect([...reconnectedResult.selected.keys()]).toEqual([localId, remoteId]);
    expect(reconnectedResult.disconnectedEntries).toEqual([]);
    expect(
      reconnectedResult.selected.get(remoteId)?.serverConfig?.providers[0]?.usageLimits?.windows[0]
        ?.usedPercent,
    ).toBe(60);
  });

  it("filters hidden providers on connected environments and surfaces disconnected selection when none are connected", () => {
    const offlineRemote = makePresentation(
      "Remote",
      "disconnected",
      [makeProvider("antigravity", 99)],
      "Transport error",
    );
    const connectedLocal = makePresentation("Local", "connected", [makeProvider("codex", 65)]);

    const onlyOffline = selectConnectedUsageLimitPresentations({
      presentations: new Map([
        [localId, connectedLocal],
        [remoteId, offlineRemote],
      ]) as never,
      selectedEnvironmentIds: new Set([remoteId]),
      hiddenProviders: new Set(),
    });
    expect(onlyOffline.selected.size).toBe(0);
    expect(onlyOffline.disconnectedEntries.map(([id]) => id)).toEqual([remoteId]);

    const hiddenCodex = selectConnectedUsageLimitPresentations({
      presentations: new Map([[localId, connectedLocal]]) as never,
      selectedEnvironmentIds: null,
      hiddenProviders: new Set(["codex"]),
    });
    expect(hiddenCodex.selected.get(localId)?.serverConfig?.providers).toEqual([]);
  });
});
