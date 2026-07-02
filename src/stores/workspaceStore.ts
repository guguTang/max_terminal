import type { DockviewApi } from "dockview";
import { create } from "zustand";
import { useSessionStore } from "./sessionStore";
import type { TerminalMeta } from "../types/connection";

const STORAGE_KEY = "max-terminal-workspace-snapshots-v1";

export interface ConnectionWorkspaceSnapshot {
  dockJson: unknown;
  fileTreePath: string | null;
  selectedFile: string | null;
  terminalRuntimeById: Record<string, TerminalMeta>;
}

interface WorkspaceState {
  snapshots: Record<string, ConnectionWorkspaceSnapshot>;
  setFileTreePath: (connectionId: string, path: string) => void;
  getFileTreePath: (connectionId: string) => string | null;
  setSelectedFile: (connectionId: string, path: string | null) => void;
  updateDockJson: (connectionId: string, dockJson: unknown) => void;
  setTerminalRuntimeById: (
    connectionId: string,
    terminalRuntimeById: Record<string, TerminalMeta>,
  ) => void;
  removeTerminalRuntime: (connectionId: string, terminalId: string) => void;
  capture: (api: DockviewApi, connectionId: string) => void;
  getSnapshot: (connectionId: string) => ConnectionWorkspaceSnapshot | undefined;
  remove: (connectionId: string) => void;
}

function loadInitialSnapshots(): Record<string, ConnectionWorkspaceSnapshot> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ConnectionWorkspaceSnapshot>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistSnapshots(snapshots: Record<string, ConnectionWorkspaceSnapshot>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // ignore localStorage failures
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  snapshots: loadInitialSnapshots(),

  setFileTreePath: (connectionId, path) =>
    set((state) => {
      const snapshots = {
        ...state.snapshots,
        [connectionId]: {
          dockJson: state.snapshots[connectionId]?.dockJson ?? null,
          fileTreePath: path,
          selectedFile: state.snapshots[connectionId]?.selectedFile ?? null,
          terminalRuntimeById: state.snapshots[connectionId]?.terminalRuntimeById ?? {},
        },
      };
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  getFileTreePath: (connectionId) => get().snapshots[connectionId]?.fileTreePath ?? null,

  setSelectedFile: (connectionId, path) =>
    set((state) => {
      const snapshots = {
        ...state.snapshots,
        [connectionId]: {
          dockJson: state.snapshots[connectionId]?.dockJson ?? null,
          fileTreePath: state.snapshots[connectionId]?.fileTreePath ?? null,
          selectedFile: path,
          terminalRuntimeById: state.snapshots[connectionId]?.terminalRuntimeById ?? {},
        },
      };
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  updateDockJson: (connectionId, dockJson) =>
    set((state) => {
      const snapshots = {
        ...state.snapshots,
        [connectionId]: {
          dockJson,
          fileTreePath: state.snapshots[connectionId]?.fileTreePath ?? null,
          selectedFile: state.snapshots[connectionId]?.selectedFile ?? null,
          terminalRuntimeById: state.snapshots[connectionId]?.terminalRuntimeById ?? {},
        },
      };
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  setTerminalRuntimeById: (connectionId, terminalRuntimeById) =>
    set((state) => {
      const snapshots = {
        ...state.snapshots,
        [connectionId]: {
          dockJson: state.snapshots[connectionId]?.dockJson ?? null,
          fileTreePath: state.snapshots[connectionId]?.fileTreePath ?? null,
          selectedFile: state.snapshots[connectionId]?.selectedFile ?? null,
          terminalRuntimeById,
        },
      };
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  removeTerminalRuntime: (connectionId, terminalId) =>
    set((state) => {
      const current = state.snapshots[connectionId];
      if (!current) return state;
      const terminalRuntimeById = { ...current.terminalRuntimeById };
      delete terminalRuntimeById[terminalId];
      const snapshots = {
        ...state.snapshots,
        [connectionId]: {
          ...current,
          terminalRuntimeById,
        },
      };
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  capture: (api, connectionId) => {
    const current = get().snapshots[connectionId];
    const fileTreePath = get().getFileTreePath(connectionId) ?? current?.fileTreePath ?? null;
    const selectedFile = useSessionStore.getState().connectionId === connectionId
      ? useSessionStore.getState().selectedFile
      : current?.selectedFile ?? null;

    set((state) => ({
      snapshots: (() => {
        const snapshots = {
        ...state.snapshots,
        [connectionId]: {
          dockJson: api.toJSON(),
          fileTreePath,
          selectedFile,
          terminalRuntimeById: current?.terminalRuntimeById ?? {},
        },
      };
        persistSnapshots(snapshots);
        return snapshots;
      })(),
    }));
  },

  getSnapshot: (connectionId) => get().snapshots[connectionId],

  remove: (connectionId) =>
    set((state) => {
      const snapshots = { ...state.snapshots };
      delete snapshots[connectionId];
      persistSnapshots(snapshots);
      return { snapshots };
    }),
}));
