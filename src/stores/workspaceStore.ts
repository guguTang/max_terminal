import type { DockviewApi } from "dockview";
import { create } from "zustand";
import { useSessionStore } from "./sessionStore";
import type { TerminalMeta } from "../types/connection";

const STORAGE_KEY = "max-terminal-workspace-snapshots-v1";

export const WORKSPACE_SNAPSHOTS_STORAGE_KEY = STORAGE_KEY;

export interface ConnectionWorkspaceSnapshot {
  dockJson: unknown;
  fileTreePath: string | null;
  selectedFile: string | null;
  terminalRuntimeById: Record<string, TerminalMeta>;
  /** 远程文件树已展开的目录路径（按连接持久化，切换 SSH 后恢复） */
  fileTreeExpandedPaths: string[];
  /** 远程文件树滚动位置 */
  fileTreeScrollTop: number;
}

interface WorkspaceState {
  snapshots: Record<string, ConnectionWorkspaceSnapshot>;
  setFileTreePath: (connectionId: string, path: string) => void;
  getFileTreePath: (connectionId: string) => string | null;
  getFileTreeExpandedPaths: (connectionId: string) => string[];
  setFileTreeExpanded: (connectionId: string, path: string, expanded: boolean) => void;
  getFileTreeScrollTop: (connectionId: string) => number;
  setFileTreeScrollTop: (connectionId: string, scrollTop: number) => void;
  setSelectedFile: (connectionId: string, path: string | null) => void;
  updateDockJson: (connectionId: string, dockJson: unknown) => void;
  setTerminalRuntimeById: (
    connectionId: string,
    terminalRuntimeById: Record<string, TerminalMeta>,
  ) => void;
  removeTerminalRuntime: (connectionId: string, terminalId: string) => void;
  capture: (api: DockviewApi, connectionId: string) => void;
  captureForced: (api: DockviewApi, connectionId: string) => void;
  writeSnapshot: (api: DockviewApi, connectionId: string) => void;
  getSnapshot: (connectionId: string) => ConnectionWorkspaceSnapshot | undefined;
  clearAll: () => void;
  remove: (connectionId: string) => void;
}

function normalizeSnapshot(
  raw: Partial<ConnectionWorkspaceSnapshot> | undefined,
): ConnectionWorkspaceSnapshot {
  return {
    dockJson: raw?.dockJson ?? null,
    fileTreePath: raw?.fileTreePath ?? null,
    selectedFile: raw?.selectedFile ?? null,
    terminalRuntimeById: raw?.terminalRuntimeById ?? {},
    fileTreeExpandedPaths: Array.isArray(raw?.fileTreeExpandedPaths)
      ? raw.fileTreeExpandedPaths.filter((p): p is string => typeof p === "string")
      : [],
    fileTreeScrollTop:
      typeof raw?.fileTreeScrollTop === "number" && Number.isFinite(raw.fileTreeScrollTop)
        ? Math.max(0, raw.fileTreeScrollTop)
        : 0,
  };
}

function loadInitialSnapshots(): Record<string, ConnectionWorkspaceSnapshot> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<ConnectionWorkspaceSnapshot>>;
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<string, ConnectionWorkspaceSnapshot> = {};
    for (const [id, snap] of Object.entries(parsed)) {
      next[id] = normalizeSnapshot(snap);
    }
    return next;
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

function patchSnapshot(
  snapshots: Record<string, ConnectionWorkspaceSnapshot>,
  connectionId: string,
  patch: Partial<ConnectionWorkspaceSnapshot>,
): Record<string, ConnectionWorkspaceSnapshot> {
  return {
    ...snapshots,
    [connectionId]: {
      ...normalizeSnapshot(snapshots[connectionId]),
      ...patch,
    },
  };
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  snapshots: loadInitialSnapshots(),

  setFileTreePath: (connectionId, path) =>
    set((state) => {
      const snapshots = patchSnapshot(state.snapshots, connectionId, { fileTreePath: path });
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  getFileTreePath: (connectionId) => get().snapshots[connectionId]?.fileTreePath ?? null,

  getFileTreeExpandedPaths: (connectionId) =>
    get().snapshots[connectionId]?.fileTreeExpandedPaths ?? [],

  setFileTreeExpanded: (connectionId, path, expanded) =>
    set((state) => {
      const current = state.snapshots[connectionId]?.fileTreeExpandedPaths ?? [];
      const has = current.includes(path);
      if (expanded && has) return state;
      if (!expanded && !has) return state;
      const fileTreeExpandedPaths = expanded
        ? [...current, path]
        : current.filter((item) => item !== path && !item.startsWith(`${path}/`));
      const snapshots = patchSnapshot(state.snapshots, connectionId, {
        fileTreeExpandedPaths,
      });
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  getFileTreeScrollTop: (connectionId) =>
    get().snapshots[connectionId]?.fileTreeScrollTop ?? 0,

  setFileTreeScrollTop: (connectionId, scrollTop) =>
    set((state) => {
      const next = Math.max(0, Math.round(scrollTop));
      if ((state.snapshots[connectionId]?.fileTreeScrollTop ?? 0) === next) return state;
      const snapshots = patchSnapshot(state.snapshots, connectionId, {
        fileTreeScrollTop: next,
      });
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  setSelectedFile: (connectionId, path) =>
    set((state) => {
      const snapshots = patchSnapshot(state.snapshots, connectionId, { selectedFile: path });
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  updateDockJson: (connectionId, dockJson) =>
    set((state) => {
      const snapshots = patchSnapshot(state.snapshots, connectionId, { dockJson });
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  setTerminalRuntimeById: (connectionId, terminalRuntimeById) =>
    set((state) => {
      const snapshots = patchSnapshot(state.snapshots, connectionId, { terminalRuntimeById });
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  removeTerminalRuntime: (connectionId, terminalId) =>
    set((state) => {
      const current = state.snapshots[connectionId];
      if (!current) return state;
      const terminalRuntimeById = { ...current.terminalRuntimeById };
      delete terminalRuntimeById[terminalId];
      const snapshots = patchSnapshot(state.snapshots, connectionId, { terminalRuntimeById });
      persistSnapshots(snapshots);
      return { snapshots };
    }),

  capture: (api, connectionId) => {
    const activeConnectionId = useSessionStore.getState().connectionId;
    // 仅当该连接为当前 UI 激活连接时捕获布局，避免切换竞态写错快照
    if (activeConnectionId !== connectionId) return;

    get().writeSnapshot(api, connectionId);
  },

  /** 切换工作区时强制写入（此时 sessionStore 可能已是目标连接，但 api 仍显示来源连接布局） */
  captureForced: (api, connectionId) => {
    get().writeSnapshot(api, connectionId);
  },

  writeSnapshot: (api, connectionId) => {
    const current = normalizeSnapshot(get().snapshots[connectionId]);
    const fileTreePath = get().getFileTreePath(connectionId) ?? current.fileTreePath ?? null;
    const selectedFile =
      useSessionStore.getState().connectionId === connectionId
        ? useSessionStore.getState().selectedFile
        : (current.selectedFile ?? null);

    set((state) => {
      const snapshots = patchSnapshot(state.snapshots, connectionId, {
        dockJson: api.toJSON(),
        fileTreePath,
        selectedFile,
        // 保留展开状态、滚动位置与终端 runtime，避免布局捕获时被冲掉
        terminalRuntimeById: current.terminalRuntimeById,
        fileTreeExpandedPaths: current.fileTreeExpandedPaths,
        fileTreeScrollTop: current.fileTreeScrollTop,
      });
      persistSnapshots(snapshots);
      return { snapshots };
    });
  },

  getSnapshot: (connectionId) => get().snapshots[connectionId],

  clearAll: () => {
    persistSnapshots({});
    set({ snapshots: {} });
  },

  remove: (connectionId) =>
    set((state) => {
      const snapshots = { ...state.snapshots };
      delete snapshots[connectionId];
      persistSnapshots(snapshots);
      return { snapshots };
    }),
}));
