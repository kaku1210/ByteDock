import { Observe } from "expo-observe";

/** Mobile crash report uploading is removed in T3 Code Plus. */
export const crashReportingAvailable = false;

export async function setCrashReportsEnabled(_enabled: boolean) {
  Observe.configure({ dispatchingEnabled: false });
}

Observe.configure({ dispatchingEnabled: false });
