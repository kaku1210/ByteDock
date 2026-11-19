import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2Actor, OrchestrationV2CreationSource } from "./orchestrationV2.ts";

export const WorktreeApprovalRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("WorktreeApprovalRequestId"),
);
export type WorktreeApprovalRequestId = typeof WorktreeApprovalRequestId.Type;

export const WorktreeApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type WorktreeApprovalStatus = typeof WorktreeApprovalStatus.Type;

export const WorktreeApprovalDecision = Schema.Literals(["approve", "deny"]);
export type WorktreeApprovalDecision = typeof WorktreeApprovalDecision.Type;

export const WorktreeApprovalRequest = Schema.Struct({
  requestId: WorktreeApprovalRequestId,
  commandId: CommandId,
  projectId: ProjectId,
  parentThreadId: Schema.NullOr(ThreadId),
  parentRunId: Schema.NullOr(RunId),
  parentTaskId: Schema.NullOr(NodeId),
  childThreadId: ThreadId,
  childRunId: Schema.NullOr(RunId),
  baseRef: TrimmedNonEmptyString,
  baseCommitSha: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  startFromOrigin: Schema.Boolean,
  requestedBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: WorktreeApprovalStatus,
  approvedWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  approvedBranch: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  resolvedBy: Schema.NullOr(OrchestrationV2Actor),
  resolutionReason: Schema.NullOr(Schema.String),
});
export type WorktreeApprovalRequest = typeof WorktreeApprovalRequest.Type;

export const WorktreeApprovalSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type WorktreeApprovalSubscribeInput = typeof WorktreeApprovalSubscribeInput.Type;

export const WorktreeApprovalStreamEvent = Schema.Struct({
  requests: Schema.Array(WorktreeApprovalRequest),
});
export type WorktreeApprovalStreamEvent = typeof WorktreeApprovalStreamEvent.Type;

export const WorktreeApprovalResolveInput = Schema.Struct({
  requestId: WorktreeApprovalRequestId,
  decision: WorktreeApprovalDecision,
  reason: Schema.optionalKey(Schema.String),
});
export type WorktreeApprovalResolveInput = typeof WorktreeApprovalResolveInput.Type;

export const WorktreeApprovalResolveResult = Schema.Struct({
  request: WorktreeApprovalRequest,
});
export type WorktreeApprovalResolveResult = typeof WorktreeApprovalResolveResult.Type;

const WORKTREE_APPROVAL_FAILURE_MESSAGES = {
  not_found: "This worktree approval request no longer exists.",
  already_resolved: "This worktree approval request was already resolved.",
  expired: "This worktree approval request has expired.",
  cancelled: "This worktree approval request was cancelled.",
  binding_mismatch: "Worktree approval request parameters do not match the original request.",
  persistence_failed: "Failed to persist worktree approval request state.",
} as const;

export const WorktreeApprovalFailureReason = Schema.Literals(
  Object.keys(WORKTREE_APPROVAL_FAILURE_MESSAGES) as Array<
    keyof typeof WORKTREE_APPROVAL_FAILURE_MESSAGES
  >,
);
export type WorktreeApprovalFailureReason = typeof WorktreeApprovalFailureReason.Type;

export class WorktreeApprovalError extends Schema.TaggedError<WorktreeApprovalError>()(
  "WorktreeApprovalError",
  {
    reason: WorktreeApprovalFailureReason,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? WORKTREE_APPROVAL_FAILURE_MESSAGES[this.reason];
  }
}
