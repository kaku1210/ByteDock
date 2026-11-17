import { expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createTemporaryChatCleanup } from "./temporaryChatCleanup";

function fixture(afterRemove?: (ref: ScopedThreadRef) => Promise<void>) {
  const data = new Map<string, string>();
  const locks = new Set<string>();
  const removed: string[] = [];
  const cleared: string[] = [];
  let online = false;
  const storage = {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const create = (owner: string) =>
    createTemporaryChatCleanup({
      owner,
      storage,
      canRecoverActive: true,
      acquire: async (key) => {
        if (locks.has(key)) return null;
        locks.add(key);
        return () => {
          locks.delete(key);
        };
      },
      remove: async (ref) => {
        if (!online) return false;
        removed.push(scopedThreadKey(ref));
        await afterRemove?.(ref);
        return true;
      },
      clearLocal: (ref) => {
        cleared.push(scopedThreadKey(ref));
      },
    });
  return {
    create,
    data,
    locks,
    removed,
    cleared,
    connect: () => {
      online = true;
    },
  };
}

const ref = (environment = "env-a") =>
  scopeThreadRef(EnvironmentId.make(environment), ThreadId.make("temporary"));

it("does not let a slow environment block another cleanup or duplicate a pending close", async () => {
  let allowFirst!: () => void;
  let markSecondStarted!: () => void;
  const firstAllowed = new Promise<void>((resolve) => {
    allowFirst = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  const f = fixture(async (target) => {
    if (target.environmentId === "env-a") await firstAllowed;
    else markSecondStarted();
  });
  const app = f.create("owner");
  await app.register(ref());
  await app.register(ref("env-b"));
  f.connect();
  const closing = app.close();
  await secondStarted;
  expect(app.close()).toBe(closing);
  const recovery = app.recover();
  allowFirst();
  await Promise.all([closing, recovery]);
  expect(f.removed).toEqual([scopedThreadKey(ref()), scopedThreadKey(ref("env-b"))]);
  expect(f.data.size).toBe(0);
});

it("clears local content on offline exit, persists only IDs and retries after reconnect", async () => {
  const f = fixture();
  const app = f.create("window-a");
  await app.register(ref());
  await app.close();
  expect(f.cleared).toContain(scopedThreadKey(ref()));
  expect(f.removed).toEqual([]);
  expect([...f.data.values()].map((value) => JSON.parse(value))).toEqual([
    { refs: [scopedThreadKey(ref())], pending: true },
  ]);
  f.connect();
  await app.recover();
  expect(f.removed).toEqual([scopedThreadKey(ref())]);
  expect(f.data.size).toBe(0);
  expect(await app.register(ref("env-b"))).toBe(false);
});

it("recovers a crashed owner but skips another live window and scopes identical IDs by environment", async () => {
  const f = fixture();
  const crashed = f.create("crashed");
  const live = f.create("live");
  await crashed.register(ref());
  await live.register(ref("env-b"));
  f.locks.delete("t3code:temporary-chat-cleanup:v1:crashed");
  f.connect();
  const next = f.create("next");
  await next.register(ref("env-b"), true);
  await next.recover();
  await next.close();
  expect(f.removed).toEqual([scopedThreadKey(ref())]);
  expect(f.cleared).not.toContain(scopedThreadKey(ref("env-b")));
  await live.close();
  expect(f.removed).toEqual([scopedThreadKey(ref()), scopedThreadKey(ref("env-b"))]);
});

it("does not resurrect explicitly closed chats or interpret unrelated and damaged storage as cleanup work", async () => {
  const f = fixture();
  const app = f.create("owner");
  await app.register(ref());
  app.forget(ref());
  f.data.set("ordinary-thread", "private normal conversation");
  f.data.set("t3code:temporary-chat-cleanup:v1:bad", "{broken");
  f.connect();
  await app.recover();
  await app.close();
  expect(f.removed).toEqual([]);
  expect(f.cleared).toEqual([]);
  expect(f.data.get("ordinary-thread")).toBe("private normal conversation");
});
