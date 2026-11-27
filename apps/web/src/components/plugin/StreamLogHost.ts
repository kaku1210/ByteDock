import {
  DEFAULT_STREAM_RING_SPEC,
  type RingSpec,
  type StreamChunk,
  type StreamChunkFrame,
} from "@bytedock/plugin-ui-renderer/protocol";

export interface StreamLogEntry extends StreamChunk {
  readonly id: number;
}

export interface StreamLogSnapshot {
  readonly sinkId: string;
  readonly items: ReadonlyArray<StreamLogEntry>;
  readonly droppedOldest: number;
  readonly lastSeq: number;
}

/**
 * Host-owned 4096-row ring buffer and 16ms frame coalescer for `StreamLog` (ADR-09).
 * Caches immutable snapshots so React `useSyncExternalStore` observes referential stability.
 */
export class StreamLogHost {
  readonly sinkId: string;
  readonly spec: RingSpec;

  private buffer: Array<StreamLogEntry> = [];
  private nextEntryId = 1;
  private droppedOldest = 0;
  private lastSeq = 0;
  private cachedSnapshot: StreamLogSnapshot;
  private listeners = new Set<() => void>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sinkId: string, spec: RingSpec = DEFAULT_STREAM_RING_SPEC) {
    this.sinkId = sinkId;
    this.spec = spec;
    this.cachedSnapshot = {
      sinkId,
      items: [],
      droppedOldest: 0,
      lastSeq: 0,
    };
  }

  pushFrame(frame: StreamChunkFrame): void {
    if (frame.sinkId !== this.sinkId) return;

    if (frame.reset) {
      this.buffer = [];
      this.droppedOldest = 0;
    }

    if (frame.droppedOldest && frame.droppedOldest > 0) {
      this.droppedOldest += frame.droppedOldest;
    }

    for (const chunk of frame.chunks) {
      this.buffer.push({ ...chunk, id: this.nextEntryId++ });
    }

    if (this.buffer.length > this.spec.capacity) {
      const overflow = this.buffer.length - this.spec.capacity;
      this.buffer.splice(0, overflow);
      this.droppedOldest += overflow;
    }

    this.lastSeq = Math.max(this.lastSeq, frame.seq);
    this.cachedSnapshot = {
      sinkId: this.sinkId,
      items: this.buffer.slice(),
      droppedOldest: this.droppedOldest,
      lastSeq: this.lastSeq,
    };
    this.scheduleFlush();
  }

  getSnapshot = (): StreamLogSnapshot => this.cachedSnapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    };
  };

  flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }

  dispose(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.listeners.clear();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.listeners.size === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      for (const listener of this.listeners) {
        listener();
      }
    }, this.spec.coalesceMs);
  }
}
