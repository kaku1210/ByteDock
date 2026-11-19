import type { ContextTransferId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import { CornerDownLeftIcon, XIcon } from "lucide-react";

import { useQuietThreadShell } from "../../state/entities";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function PendingMergeBackChip({
  environmentId,
  sourceThreadId,
  transferId,
  disabled,
  onRevoke,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly transferId: ContextTransferId;
  readonly disabled: boolean;
  readonly onRevoke: (transferId: ContextTransferId) => void;
}) {
  const sourceShell = useQuietThreadShell(scopeThreadRef(environmentId, sourceThreadId));
  const title = sourceShell?.title.trim() || "Attached thread";
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-2 py-0.5 text-xs text-foreground">
      <span className="max-w-48 truncate">{title}</span>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Remove ${title} from next message`}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onRevoke(transferId)}
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

/**
 * Shown when one or more child threads/side chats have been brought back and are waiting to attach
 * to the user's next normal parent message.
 */
export function pendingMergeBacksBannerItem(input: {
  readonly environmentId: EnvironmentId;
  readonly transfers: ReadonlyArray<ThreadStructure["contextTransfers"][number]>;
  readonly disabled: boolean;
  readonly onRevoke: (transferId: ContextTransferId) => void;
}): ComposerBannerStackItem {
  const count = input.transfers.length;
  return {
    id: "pending-merge-backs",
    variant: "info",
    icon: <CornerDownLeftIcon />,
    title:
      count === 1
        ? "1 thread conclusion will attach to your next message"
        : `${count} thread conclusions will attach to your next message`,
    description: "Waiting for your next normal message.",
    children: (
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {input.transfers.map((transfer) => (
          <PendingMergeBackChip
            key={transfer.id}
            environmentId={input.environmentId}
            sourceThreadId={transfer.sourceThreadId}
            transferId={transfer.id}
            disabled={input.disabled}
            onRevoke={input.onRevoke}
          />
        ))}
      </div>
    ),
  };
}
