import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { OrchestrationV2Actor } from "./orchestrationV2.ts";

export const SharedWorktreeReservationId = TrimmedNonEmptyString.pipe(
  Schema.brand("SharedWorktreeReservationId"),
);
export type SharedWorktreeReservationId = typeof SharedWorktreeReservationId.Type;

export const SharedWorktreePathLayer = Schema.Literals([
  "planned",
  "confirmed_write",
  "observed_unverified",
]);
export type SharedWorktreePathLayer = typeof SharedWorktreePathLayer.Type;

export const SharedWorktreeSerializationMode = Schema.Literals([
  "parallel",
  "serialize_checkout_writes",
]);
export type SharedWorktreeSerializationMode = typeof SharedWorktreeSerializationMode.Type;

export const SharedWorktreeOverlapKind = Schema.Literals([
  "exact",
  "directory_containment",
  "rename_pair",
]);
export type SharedWorktreeOverlapKind = typeof SharedWorktreeOverlapKind.Type;

export const SharedWorktreeOverlapSeverity = Schema.Literals(["warning", "blocking"]);
export type SharedWorktreeOverlapSeverity = typeof SharedWorktreeOverlapSeverity.Type;

export const SharedWorktreePlannedPathEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  normalizedPath: TrimmedNonEmptyString,
  runId: Schema.NullOr(RunId),
  note: Schema.NullOr(Schema.String),
  declaredAt: IsoDateTime,
});
export type SharedWorktreePlannedPathEntry = typeof SharedWorktreePlannedPathEntry.Type;

export const SharedWorktreeConfirmedWriteEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  normalizedPath: TrimmedNonEmptyString,
  oldPath: Schema.NullOr(TrimmedNonEmptyString),
  oldNormalizedPath: Schema.NullOr(TrimmedNonEmptyString),
  operation: TrimmedNonEmptyString,
  runId: Schema.NullOr(RunId),
  turnItemId: Schema.NullOr(TurnItemId),
  source: Schema.Literals(["turn_item", "controlled_write"]),
  updatedAt: IsoDateTime,
});
export type SharedWorktreeConfirmedWriteEntry = typeof SharedWorktreeConfirmedWriteEntry.Type;

export const SharedWorktreeReservationStatus = Schema.Literals(["active", "waiting"]);
export type SharedWorktreeReservationStatus = typeof SharedWorktreeReservationStatus.Type;

export const SharedWorktreeWriteReservation = Schema.Struct({
  reservationId: SharedWorktreeReservationId,
  checkoutKey: TrimmedNonEmptyString,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  paths: Schema.Array(TrimmedNonEmptyString),
  canonicalPaths: Schema.Array(TrimmedNonEmptyString),
  status: SharedWorktreeReservationStatus,
  waitingOnReservationIds: Schema.Array(SharedWorktreeReservationId),
  acquiredAt: IsoDateTime,
});
export type SharedWorktreeWriteReservation = typeof SharedWorktreeWriteReservation.Type;

export const SharedWorktreePathOverlapParticipantLayer = Schema.Literals([
  "planned",
  "confirmed_write",
  "reserved",
]);
export type SharedWorktreePathOverlapParticipantLayer =
  typeof SharedWorktreePathOverlapParticipantLayer.Type;

export const SharedWorktreePathOverlapParticipant = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  runId: Schema.NullOr(RunId),
  layers: Schema.Array(SharedWorktreePathOverlapParticipantLayer),
  rawPaths: Schema.Array(TrimmedNonEmptyString),
});
export type SharedWorktreePathOverlapParticipant = typeof SharedWorktreePathOverlapParticipant.Type;

export const SharedWorktreePathOverlap = Schema.Struct({
  normalizedPath: TrimmedNonEmptyString,
  kind: SharedWorktreeOverlapKind,
  severity: SharedWorktreeOverlapSeverity,
  participants: Schema.Array(SharedWorktreePathOverlapParticipant),
  recommendedAction: Schema.String,
});
export type SharedWorktreePathOverlap = typeof SharedWorktreePathOverlap.Type;

export const SharedWorktreeObservedPath = Schema.Struct({
  path: TrimmedNonEmptyString,
  normalizedPath: TrimmedNonEmptyString,
  attribution: Schema.Literal("observed_unverified"),
  reason: Schema.Literal("external_or_unattributed"),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type SharedWorktreeObservedPath = typeof SharedWorktreeObservedPath.Type;

export const SharedWorktreeShellConstraintCoverage = Schema.Struct({
  serverEnforcedWorktreeGate: Schema.Boolean,
  serverEnforcedWriteReservation: Schema.Boolean,
  checkoutWriteSerializationEnabled: Schema.Boolean,
  shellGitWorktreeConstraint: Schema.Literal("provider_tool_permission"),
  summary: Schema.String,
});
export type SharedWorktreeShellConstraintCoverage =
  typeof SharedWorktreeShellConstraintCoverage.Type;

export const SharedWorktreeCheckoutPolicy = Schema.Struct({
  checkoutKey: TrimmedNonEmptyString,
  checkoutPath: TrimmedNonEmptyString,
  serializationMode: SharedWorktreeSerializationMode,
  shellConstraintCoverage: SharedWorktreeShellConstraintCoverage,
  updatedAt: IsoDateTime,
  updatedBy: Schema.NullOr(OrchestrationV2Actor),
});
export type SharedWorktreeCheckoutPolicy = typeof SharedWorktreeCheckoutPolicy.Type;

export const SharedWorktreeThreadAttribution = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  depth: NonNegativeInt,
  activeRunId: Schema.NullOr(RunId),
  status: Schema.String,
  inFamily: Schema.Boolean,
  plannedPaths: Schema.Array(SharedWorktreePlannedPathEntry),
  confirmedWritePaths: Schema.Array(SharedWorktreeConfirmedWriteEntry),
  activeReservations: Schema.Array(SharedWorktreeWriteReservation),
});
export type SharedWorktreeThreadAttribution = typeof SharedWorktreeThreadAttribution.Type;

export const SharedWorktreeSerializedRunEntry = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  enqueuedAt: IsoDateTime,
  acquiredAt: Schema.NullOr(IsoDateTime),
});
export type SharedWorktreeSerializedRunEntry = typeof SharedWorktreeSerializedRunEntry.Type;

export const SharedWorktreeCoordinationSnapshot = Schema.Struct({
  rootThreadId: ThreadId,
  checkoutPath: TrimmedNonEmptyString,
  checkoutKey: TrimmedNonEmptyString,
  policy: SharedWorktreeCheckoutPolicy,
  sharedThreadCount: NonNegativeInt,
  threads: Schema.Array(SharedWorktreeThreadAttribution),
  overlaps: Schema.Array(SharedWorktreePathOverlap),
  observedUnverifiedPaths: Schema.Array(SharedWorktreeObservedPath),
  activeReservations: Schema.Array(SharedWorktreeWriteReservation),
  waitingReservations: Schema.Array(SharedWorktreeWriteReservation),
  activeSerializedRun: Schema.NullOr(SharedWorktreeSerializedRunEntry),
  waitingSerializedRuns: Schema.Array(SharedWorktreeSerializedRunEntry),
  restoreSafetyProtected: Schema.Boolean,
  generatedAt: IsoDateTime,
});
export type SharedWorktreeCoordinationSnapshot = typeof SharedWorktreeCoordinationSnapshot.Type;

export const SharedWorktreeFileRevision = Schema.Struct({
  path: TrimmedNonEmptyString,
  normalizedPath: TrimmedNonEmptyString,
  exists: Schema.Boolean,
  sha256: Schema.NullOr(TrimmedNonEmptyString),
  byteLength: NonNegativeInt,
  contents: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
});
export type SharedWorktreeFileRevision = typeof SharedWorktreeFileRevision.Type;

export const SharedWorktreeGetSnapshotInput = Schema.Struct({
  threadId: ThreadId,
});
export type SharedWorktreeGetSnapshotInput = typeof SharedWorktreeGetSnapshotInput.Type;

export const SharedWorktreeSetPolicyInput = Schema.Struct({
  threadId: ThreadId,
  serializationMode: SharedWorktreeSerializationMode,
});
export type SharedWorktreeSetPolicyInput = typeof SharedWorktreeSetPolicyInput.Type;

export const SharedWorktreeSetPlannedPathsInput = Schema.Struct({
  threadId: ThreadId,
  paths: Schema.Array(TrimmedNonEmptyString),
  runId: Schema.optionalKey(RunId),
  note: Schema.optionalKey(Schema.String),
});
export type SharedWorktreeSetPlannedPathsInput = typeof SharedWorktreeSetPlannedPathsInput.Type;

export const SharedWorktreeSetPlannedPathsResult = Schema.Struct({
  threadId: ThreadId,
  plannedPaths: Schema.Array(SharedWorktreePlannedPathEntry),
  overlaps: Schema.Array(SharedWorktreePathOverlap),
});
export type SharedWorktreeSetPlannedPathsResult = typeof SharedWorktreeSetPlannedPathsResult.Type;

const SHARED_WORKTREE_COORDINATION_FAILURE_MESSAGES = {
  thread_not_found: "Thread was not found or has been deleted.",
  project_not_found: "Project workspace for this thread could not be found.",
  invalid_path: "Path must stay inside the shared checkout and cannot target Git metadata.",
  reservation_not_found: "Write-path reservation was not found or has already been released.",
  reservation_owner_mismatch: "Write-path reservation belongs to a different thread or run.",
  stale_revision: "Target file changed since the expected sha256; re-read before writing.",
  persistence_failed: "Failed to persist shared worktree coordination state.",
  write_failed: "Failed to write file inside the shared worktree.",
} as const;

export const SharedWorktreeCoordinationFailureReason = Schema.Literals(
  Object.keys(SHARED_WORKTREE_COORDINATION_FAILURE_MESSAGES) as Array<
    keyof typeof SHARED_WORKTREE_COORDINATION_FAILURE_MESSAGES
  >,
);
export type SharedWorktreeCoordinationFailureReason =
  typeof SharedWorktreeCoordinationFailureReason.Type;

export class SharedWorktreeCoordinationError extends Schema.TaggedError<SharedWorktreeCoordinationError>()(
  "SharedWorktreeCoordinationError",
  {
    reason: SharedWorktreeCoordinationFailureReason,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? SHARED_WORKTREE_COORDINATION_FAILURE_MESSAGES[this.reason];
  }
}
