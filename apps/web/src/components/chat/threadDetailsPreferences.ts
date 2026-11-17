import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { resolveStorage } from "../../lib/storage";

export const useThreadDetailsPreferences = create<{
  pinned: boolean;
  open: boolean;
  width: number;
  detailsCollapsed: boolean;
  tasksCollapsed: boolean;
  usageCollapsed: boolean;
  setDetailsCollapsed: (collapsed: boolean) => void;
  setTasksCollapsed: (collapsed: boolean) => void;
  setUsageCollapsed: (collapsed: boolean) => void;
  setPinned: (pinned: boolean) => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
}>()(
  persist(
    (set) => ({
      pinned: false,
      open: true,
      width: 360,
      detailsCollapsed: false,
      tasksCollapsed: false,
      usageCollapsed: false,
      setDetailsCollapsed: (detailsCollapsed) => set({ detailsCollapsed }),
      setTasksCollapsed: (tasksCollapsed) => set({ tasksCollapsed }),
      setUsageCollapsed: (usageCollapsed) => set({ usageCollapsed }),
      setPinned: (pinned) => set({ pinned, open: true }),
      setOpen: (open) => set({ open }),
      setWidth: (width) => set({ width: Math.max(280, Math.min(640, width)) }),
    }),
    {
      name: "t3code:thread-details-preferences",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ pinned, open, width, detailsCollapsed, tasksCollapsed, usageCollapsed }) => ({
        pinned,
        open,
        width,
        detailsCollapsed,
        tasksCollapsed,
        usageCollapsed,
      }),
    },
  ),
);
