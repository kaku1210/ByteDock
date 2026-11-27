import { T, useGT } from "gt-react";
import { DownloadIcon, PuzzleIcon, ShieldCheckIcon, XIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ByteDockControlCenterModal } from "./ByteDockControlCenterModal";
import { PluginNodeRenderer } from "./PluginNodeRenderer";
import {
  clearActivePluginDockPanel,
  openByteDockModal,
  usePluginSlotState,
} from "./PluginSlotStore";

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
 * Compact bottom status strip exposing Egress Guard shield, Plugins, and Legacy Import trigger.
 */
export function PluginStatusBarStrip({ threadId }: { readonly threadId: string }) {
  const { pendingApprovalCount } = usePluginSlotState();
  return (
    <div
      data-bytedock-slot="statusBarItem"
      data-bytedock-thread-id={threadId}
      className="mt-1.5 flex items-center justify-end gap-2 px-1 text-2xs text-muted-foreground"
    >
      <button
        type="button"
        onClick={() => openByteDockModal("plugins", "chat")}
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
        onClick={() => openByteDockModal("import", "chat")}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
      >
        <DownloadIcon className="size-3" />
        <span>
          <T>Import T3</T>
        </span>
      </button>
      <ByteDockControlCenterModal host="chat" />
    </div>
  );
}
