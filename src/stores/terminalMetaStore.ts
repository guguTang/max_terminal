import { create } from "zustand";
import type { TerminalMeta } from "../types/connection";
import { shouldAcceptCwdUpdate } from "../lib/terminalTracking";

function metaKey(sessionId: string, terminalId: string) {
  return `${sessionId}:${terminalId}`;
}

interface TerminalMetaState {
  metaByKey: Record<string, TerminalMeta>;
  setCwd: (sessionId: string, terminalId: string, cwd: string) => void;
  patchMeta: (
    sessionId: string,
    terminalId: string,
    patch: {
      cwd?: string;
      env?: Record<string, string>;
      unsetEnv?: string[];
      precmdGitBranch?: string | null;
      precmdCwd?: string;
    },
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
      const current = state.metaByKey[key]?.cwd;
      if (!shouldAcceptCwdUpdate(cwd, current)) return state;
      return {
        metaByKey: {
          ...state.metaByKey,
          [key]: {
            cwd,
            env: state.metaByKey[key]?.env ?? {},
            precmdGitBranch: undefined,
            precmdCwd: undefined,
          },
        },
      };
    }),

  patchMeta: (sessionId, terminalId, patch) =>
    set((state) => {
      const key = metaKey(sessionId, terminalId);
      const current = state.metaByKey[key] ?? { cwd: "", env: {} };
      const cwdRejected = Boolean(patch.cwd && !shouldAcceptCwdUpdate(patch.cwd, current.cwd));
      if (
        cwdRejected &&
        !patch.env &&
        !patch.unsetEnv?.length &&
        patch.precmdGitBranch === undefined &&
        patch.precmdCwd === undefined
      ) {
        return state;
      }

      const env = { ...current.env };
      if (patch.env) {
        for (const [k, v] of Object.entries(patch.env)) {
          env[k] = v;
        }
      }
      if (patch.unsetEnv) {
        for (const k of patch.unsetEnv) {
          delete env[k];
        }
      }

      let precmdGitBranch = current.precmdGitBranch;
      let precmdCwd = current.precmdCwd;
      if (patch.precmdGitBranch !== undefined) {
        precmdGitBranch = patch.precmdGitBranch;
      }
      if (patch.precmdCwd !== undefined) {
        precmdCwd = patch.precmdCwd;
      }
      if (patch.cwd && !cwdRejected) {
        precmdGitBranch = undefined;
        precmdCwd = undefined;
      }

      return {
        metaByKey: {
          ...state.metaByKey,
          [key]: {
            cwd: cwdRejected ? current.cwd : (patch.cwd ?? current.cwd),
            env,
            precmdGitBranch,
            precmdCwd,
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
