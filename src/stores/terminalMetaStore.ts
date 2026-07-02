import { create } from "zustand";
import type { TerminalMeta } from "../types/connection";

function metaKey(sessionId: string, terminalId: string) {
  return `${sessionId}:${terminalId}`;
}

interface TerminalMetaState {
  metaByKey: Record<string, TerminalMeta>;
  setCwd: (sessionId: string, terminalId: string, cwd: string) => void;
  patchMeta: (
    sessionId: string,
    terminalId: string,
    patch: Partial<TerminalMeta>,
  ) => void;
  getMeta: (sessionId: string, terminalId: string) => TerminalMeta | undefined;
  clearTerminal: (sessionId: string, terminalId: string) => void;
  clearSession: (sessionId: string) => void;
  clear: () => void;
}

export const useTerminalMetaStore = create<TerminalMetaState>((set, get) => ({
  metaByKey: {},

  setCwd: (sessionId, terminalId, cwd) =>
    set((state) => {
      const key = metaKey(sessionId, terminalId);
      return {
        metaByKey: {
          ...state.metaByKey,
          [key]: {
            cwd,
            env: state.metaByKey[key]?.env ?? {},
          },
        },
      };
    }),

  patchMeta: (sessionId, terminalId, patch) =>
    set((state) => {
      const key = metaKey(sessionId, terminalId);
      const current = state.metaByKey[key] ?? { cwd: "", env: {} };
      return {
        metaByKey: {
          ...state.metaByKey,
          [key]: {
            cwd: patch.cwd ?? current.cwd,
            env: patch.env ? { ...current.env, ...patch.env } : current.env,
          },
        },
      };
    }),

  getMeta: (sessionId, terminalId) => get().metaByKey[metaKey(sessionId, terminalId)],

  clearTerminal: (sessionId, terminalId) =>
    set((state) => {
      const key = metaKey(sessionId, terminalId);
      const metaByKey = { ...state.metaByKey };
      delete metaByKey[key];
      return { metaByKey };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const prefix = `${sessionId}:`;
      const metaByKey = Object.fromEntries(
        Object.entries(state.metaByKey).filter(([key]) => !key.startsWith(prefix)),
      );
      return { metaByKey };
    }),

  clear: () => set({ metaByKey: {} }),
}));
