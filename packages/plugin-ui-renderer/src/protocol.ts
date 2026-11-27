/**
 * Frozen v0.1 declarative UI protocol (ADR-09): strictly 12 primitives.
 * Layout/Display (6): Stack, Row, Card (with closed kpi block), Text (i18nKey only), Badge, Tabs
 * Low-frequency interaction (4): Button, Toggle, Select, Progress
 * Host-native streaming (2): StreamLog (ring buffer 4096 + 16ms rAF), TerminalView
 */
export const FROZEN_PRIMITIVE_NAMES = [
  "Stack",
  "Row",
  "Card",
  "Text",
  "Badge",
  "Tabs",
  "Button",
  "Toggle",
  "Select",
  "Progress",
  "StreamLog",
  "TerminalView",
] as const;

export type PrimitiveName = (typeof FROZEN_PRIMITIVE_NAMES)[number];

export type SemanticTone = "neutral" | "info" | "success" | "warning" | "error";
export type SemanticSize = "sm" | "md" | "lg";

export interface CardKpiItem {
  readonly labelI18n: string;
  readonly value?: string | number | undefined;
  readonly detailI18n?: string | undefined;
  readonly progressPct?: number | undefined;
  readonly tone?: SemanticTone | undefined;
}

/** Closed props: className and arbitrary style are forbidden so host Tailwind classes are 100% static. */
export interface PrimitiveProps {
  readonly gap?: SemanticSize | undefined;
  readonly justify?: "start" | "between" | "center" | undefined;
  readonly tone?: SemanticTone | undefined;
  readonly size?: SemanticSize | undefined;
  readonly titleI18n?: string | undefined;
  readonly kpi?: ReadonlyArray<CardKpiItem> | undefined;
  readonly kpiColumns?: 1 | 2 | 4 | undefined;
  readonly i18n?: string | undefined;
  readonly i18nArgs?: ReadonlyArray<unknown> | undefined;
  readonly labelI18n?: string | undefined;
  readonly value?: string | number | boolean | undefined;
  readonly options?:
    | ReadonlyArray<{ readonly value: string; readonly labelI18n: string }>
    | undefined;
  readonly sinkId?: string | undefined;
  readonly columns?: ReadonlyArray<string> | undefined;
  readonly capacityHint?: number | undefined;
  readonly terminalThreadId?: string | undefined;
  readonly openOnMount?: boolean | undefined;
  readonly on?: { readonly action: string; readonly ns?: string | undefined } | undefined;
}

export interface JsonNode {
  readonly k?: string | undefined;
  readonly t: PrimitiveName;
  readonly p: PrimitiveProps;
  readonly c?: ReadonlyArray<JsonNode> | undefined;
}

export interface StreamChunk {
  readonly ts: number;
  readonly text?: string | undefined;
  readonly record?: Readonly<Record<string, unknown>> | undefined;
}

export interface StreamChunkFrame {
  readonly sinkId: string;
  readonly seq: number;
  readonly chunks: ReadonlyArray<StreamChunk>;
  readonly droppedOldest?: number | undefined;
  readonly reset?: boolean | undefined;
}

export interface RingSpec {
  readonly capacity: 4096;
  readonly evict: "oldest";
  readonly coalesceMs: 16;
}

export const DEFAULT_STREAM_RING_SPEC: RingSpec = {
  capacity: 4096,
  evict: "oldest",
  coalesceMs: 16,
};

export interface AtomSpec {
  readonly key: string;
  readonly persist: "memory" | "storage";
  readonly schemaVersion: number;
}
