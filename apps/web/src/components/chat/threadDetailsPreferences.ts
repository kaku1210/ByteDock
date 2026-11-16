import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { resolveStorage } from "../../lib/storage";

export const useThreadDetailsPreferences = create<{
  pinned: boolean;
  open: boolean;
  width: number;
  setPinned: (pinned: boolean) => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
}>()(
  persist(
    (set) => ({
      pinned: false,
      open: true,
      width: 360,
      setPinned: (pinned) => set({ pinned, open: true }),
      setOpen: (open) => set({ open }),
      setWidth: (width) => set({ width: Math.max(280, Math.min(640, width)) }),
    }),
    {
      name: "t3code:thread-details-preferences",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ pinned, open, width }) => ({ pinned, open, width }),
    },
  ),
);
