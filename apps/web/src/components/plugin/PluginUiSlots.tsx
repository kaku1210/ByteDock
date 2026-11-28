import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import { followStreamInEnvironment } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type PluginsStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";
import { T, useGT } from "gt-react";
import { DownloadIcon, PuzzleIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { cn } from "../../lib/utils";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ByteDockControlCenterModal } from "./ByteDockControlCenterModal";
import { PluginNodeRenderer } from "./PluginNodeRenderer";
import {
  clearActivePluginDockPanel,
  clearUiNotification,
  handleControlPlaneStreamPayload,
  openByteDockModal,
  registerUiNavigateHandler,
  usePluginSlotState,
} from "./PluginSlotStore";
import {
  TokenOptimizerMetricsPill,
  TokenOptimizerWatchdogBanner,
  useTokenOptimizerObservability,
} from "./TokenOptimizerStatusBar";

type SubscribePluginEventsFn = (
  tag: typeof WS_METHODS.pluginsSubscribe,
  input: { readonly pluginId: string; readonly topic: string },
) => Stream.Stream<PluginsStreamEvent, unknown, EnvironmentSupervisor.EnvironmentSupervisor>;

const subscribePluginEvents = subscribe as unknown as SubscribePluginEventsFn;

const controlPlaneEventsAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(
      followStreamInEnvironment(
        environmentId,
        subscribePluginEvents(WS_METHODS.pluginsSubscribe, {
          pluginId: "builtin.control-plane",
          topic: "events",
        }).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              handleControlPlaneStreamPayload(event.payload);
            }),
          ),
          Stream.catch(() => Stream.empty),
        ),
      ),
    )
    .pipe(Atom.withLabel(`bytedock-control-plane-events:${environmentId}`)),
);

const idleControlPlaneAtom = Atom.make<null>(null).pipe(
  Atom.withLabel("bytedock-control-plane-events:idle"),
);

function PluginControlBusBridge() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const router = useRouter();

  // Keep a single deduplicated control-plane stream subscription per connected environment.
  useAtomValue(environmentId ? controlPlaneEventsAtom(environmentId) : idleControlPlaneAtom);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers TanStack Router navigation sink for real-time MCP UI control commands
  useEffect(() => {
    return registerUiNavigateHandler((safePath) => {
      void router.navigate({ href: safePath });
    });
  }, [router]);

  return null;
}

/**
 * Seam 11a (`dockPanel` slot in RightPanelSurfaceContent):
 * Stable v0.1 right-dock container interface so v0.2 Dockview swaps without rewriting plugins.
 */
export function PluginDockPanelHost({ visible }: { readonly visible: boolean }) {
  const gt = useGT();
  const { activeDockPluginId, activeDockTree } = usePluginSlotState();
  if (!visible || !activeDockPluginId || !activeDockTree) return null;

  return (
    <div
      data-bytedock-slot="dockPanel"
      data-bytedock-plugin-id={activeDockPluginId}
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3"
    >
      <div className="flex items-center justify-between border-b border-border pb-2">
        <span className="text-xs font-semibold text-foreground">{activeDockPluginId}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Close plugin panel")}
          onClick={clearActivePluginDockPanel}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <PluginNodeRenderer node={activeDockTree} />
    </div>
  );
}

/**
 * Seam 11b (`settingsSection` slot in SettingsSidebarNav):
 * Adds ByteDock Plugins & Security and T3 Code / T3 Code Plus Read-Only Import entries.
 */
export function PluginSettingsSidebarGroup({
  compactSearchOpen,
}: {
  readonly compactSearchOpen: boolean;
}) {
  const { pendingApprovalCount } = usePluginSlotState();
  return (
    <div
      data-bytedock-slot="settingsSection"
      className="flex flex-col gap-1 border-t border-sidebar-border pt-4"
    >
      <PluginControlBusBridge />
      <h3
        className={cn(
          "px-2 text-xs font-medium text-sidebar-muted-foreground/80",
          !compactSearchOpen && "max-md:sr-only",
        )}
      >
        <T>ByteDock</T>
      </h3>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            data-settings-section="/settings/plugins"
            onClick={() => openByteDockModal("plugins", "settings")}
          >
            <PuzzleIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
            <span className={cn("truncate", !compactSearchOpen && "max-md:sr-only")}>
              <T>Plugins &amp; Guard</T>
            </span>
            {pendingApprovalCount > 0 ? (
              <span className="ml-auto rounded-full bg-warning/20 px-1.5 py-0.5 font-mono text-3xs font-medium text-warning">
                {pendingApprovalCount}
              </span>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            data-settings-section="/settings/import"
            onClick={() => openByteDockModal("import", "settings")}
          >
            <DownloadIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
            <span className={cn("truncate", !compactSearchOpen && "max-md:sr-only")}>
              <T>Import T3 Data</T>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <ByteDockControlCenterModal host="settings" />
    </div>
  );
}

/**
 * Seam 11c (`timelineRenderer` slot in MessagesTimeline):
 * Renders registered `"plugin-card"` timeline items safely via the 12-primitive renderer.
 */
export function PluginTimelineCardHost({ rowId }: { readonly rowId: string }) {
  const { timelineCards } = usePluginSlotState();
  const entry = timelineCards[rowId];
  if (!entry) return null;

  return (
    <div
      data-bytedock-slot="timelineRenderer"
      data-bytedock-plugin-id={entry.pluginId}
      className="my-2"
    >
      <PluginNodeRenderer node={entry.node} />
    </div>
  );
}

/**
 * Seam 11d (`statusBarItem` slot in ChatView):
 * Compact bottom status strip exposing live TTFT/TPS/Cache metrics, anti-stall Watchdog,
 * Egress Guard shield, Plugins, Legacy Import trigger, and AI UI notifications.
 */
export function PluginStatusBarStrip({ threadId }: { readonly threadId: string }) {
  const gt = useGT();
  const { pendingApprovalCount, activeNotification } = usePluginSlotState();
  const { environmentId, summary, config } = useTokenOptimizerObservability(threadId);
  return (
    <div
      data-bytedock-slot="statusBarItem"
      data-bytedock-thread-id={threadId}
      className="mt-1.5 flex flex-col gap-1 px-1 text-2xs text-muted-foreground"
    >
      <PluginControlBusBridge />
      <TokenOptimizerWatchdogBanner
        threadId={threadId}
        environmentId={environmentId}
        summary={summary}
      />
      {activeNotification ? (
        <div
          data-bytedock-ui-notification="true"
          data-bytedock-notification-level={activeNotification.level}
          className={cn(
            "flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-2xs",
            activeNotification.level === "error"
              ? "border-error/40 bg-error-surface text-error"
              : activeNotification.level === "warning"
                ? "border-warning/40 bg-warning/10 text-warning"
                : activeNotification.level === "success"
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-border bg-muted/40 text-foreground",
          )}
        >
          <span className="truncate">{activeNotification.message}</span>
          <button
            type="button"
            aria-label={gt("Dismiss notification")}
            onClick={clearUiNotification}
            className="shrink-0 rounded p-0.5 hover:bg-background/60"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">
          <TokenOptimizerMetricsPill threadId={threadId} summary={summary} config={config} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => openByteDockModal("plugins", "chat", threadId)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          >
            <ShieldCheckIcon className="size-3 text-success" />
            <span>
              <T>ByteDock Guard</T>
            </span>
            {pendingApprovalCount > 0 ? (
              <span
                data-bytedock-pending-approvals={pendingApprovalCount}
                className="rounded-full bg-warning/20 px-1.5 py-0.5 font-mono text-3xs font-medium text-warning"
              >
                {pendingApprovalCount}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => openByteDockModal("import", "chat", threadId)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          >
            <DownloadIcon className="size-3" />
            <span>
              <T>Import T3</T>
            </span>
          </button>
        </div>
      </div>
      <ByteDockControlCenterModal host="chat" />
    </div>
  );
}
