import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { TransferPhase, TransferTaskSnapshot } from "../types/transfer";

export type TransferDirection = "upload" | "download" | "remote-copy";
export type TransferStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export interface TransferRecord {
  id: string;
  direction: TransferDirection;
  connectionId: string;
  sessionId: string;
  remotePath: string;
  localPath?: string;
  destConnectionId?: string;
  destSessionId?: string;
  destRemotePath?: string;
  fileName: string;
  totalBytes?: number;
  loadedBytes: number;
  percent: number;
  phase?: TransferPhase;
  status: TransferStatus;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

interface StartTransferInput {
  id: string;
  direction: TransferDirection;
  connectionId: string;
  sessionId: string;
  remotePath: string;
  localPath?: string;
  destConnectionId?: string;
  destSessionId?: string;
  destRemotePath?: string;
  fileName: string;
  totalBytes?: number;
  phase?: TransferPhase;
}

interface TransferState {
  recordsById: Record<string, TransferRecord>;
  startTransfer: (input: StartTransferInput) => void;
  updateProgress: (id: string, loadedBytes: number, totalBytes?: number) => void;
  syncFromSnapshot: (id: string, snapshot: TransferTaskSnapshot) => void;
  requestCancel: (id: string) => Promise<void>;
  finishSuccess: (id: string) => void;
  finishFailed: (id: string, error: string) => void;
  finishCancelled: (id: string) => void;
  listByConnection: (connectionId: string) => TransferRecord[];
  listBySession: (sessionId: string) => TransferRecord[];
  clearByConnection: (connectionId: string) => void;
}

const MAX_HISTORY_PER_CONNECTION = 200;

function clampPercent(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function normalizeTotalBytes(value?: number | null) {
  if (value === undefined || value === null || value < 0) return undefined;
  return value;
}

function mapSnapshotStatus(status: TransferTaskSnapshot["status"]): TransferStatus {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

export const useTransferStore = create<TransferState>((set, get) => ({
  recordsById: {},

  startTransfer: (input) =>
    set((state) => {
      const now = Date.now();
      const recordsById = {
        ...state.recordsById,
        [input.id]: {
          ...input,
          loadedBytes: 0,
          percent: 0,
          phase: input.phase ?? "preparing",
          status: "running" as TransferStatus,
          startedAt: now,
        },
      };

      const sameConnection = Object.values(recordsById)
        .filter((item) => item.connectionId === input.connectionId)
        .sort((a, b) => b.startedAt - a.startedAt);

      for (const item of sameConnection.slice(MAX_HISTORY_PER_CONNECTION)) {
        delete recordsById[item.id];
      }

      return { recordsById };
    }),

  updateProgress: (id, loadedBytes, totalBytes) =>
    set((state) => {
      const current = state.recordsById[id];
      if (!current) return state;
      const total = normalizeTotalBytes(totalBytes ?? current.totalBytes);
      const percent = total && total > 0 ? clampPercent((loadedBytes / total) * 100) : 0;
      return {
        recordsById: {
          ...state.recordsById,
          [id]: {
            ...current,
            loadedBytes,
            totalBytes: total,
            percent,
            status: current.status === "pending" ? "running" : current.status,
          },
        },
      };
    }),

  syncFromSnapshot: (id, snapshot) =>
    set((state) => {
      const current = state.recordsById[id];
      if (!current) return state;

      const total = normalizeTotalBytes(snapshot.totalBytes);
      const status = mapSnapshotStatus(snapshot.status);
      const percent =
        total && total > 0 ? clampPercent((snapshot.loadedBytes / total) * 100) : 0;

      return {
        recordsById: {
          ...state.recordsById,
          [id]: {
            ...current,
            loadedBytes: snapshot.loadedBytes,
            totalBytes: total,
            percent: status === "success" ? 100 : percent,
            phase: snapshot.phase,
            status,
            error: snapshot.error ?? undefined,
            endedAt:
              status === "running"
                ? current.endedAt
                : snapshot.endedAt ?? Date.now(),
          },
        },
      };
    }),

  requestCancel: async (id) => {
    try {
      await invoke("transfer_cancel", { taskId: id });
      const snapshot = await invoke<TransferTaskSnapshot>("transfer_query", { taskId: id });
      get().syncFromSnapshot(id, snapshot);
    } catch {
      get().finishCancelled(id);
    }
  },

  finishSuccess: (id) =>
    set((state) => {
      const current = state.recordsById[id];
      if (!current) return state;
      const total = current.totalBytes ?? current.loadedBytes;
      return {
        recordsById: {
          ...state.recordsById,
          [id]: {
            ...current,
            loadedBytes: total,
            totalBytes: total,
            percent: 100,
            phase: "transferring",
            status: "success",
            endedAt: Date.now(),
            error: undefined,
          },
        },
      };
    }),

  finishFailed: (id, error) =>
    set((state) => {
      const current = state.recordsById[id];
      if (!current) return state;
      return {
        recordsById: {
          ...state.recordsById,
          [id]: {
            ...current,
            status: "failed",
            error,
            endedAt: Date.now(),
          },
        },
      };
    }),

  finishCancelled: (id) =>
    set((state) => {
      const current = state.recordsById[id];
      if (!current) return state;
      return {
        recordsById: {
          ...state.recordsById,
          [id]: {
            ...current,
            status: "cancelled",
            endedAt: Date.now(),
          },
        },
      };
    }),

  listByConnection: (connectionId) =>
    Object.values(get().recordsById)
      .filter(
        (item) =>
          item.connectionId === connectionId || item.destConnectionId === connectionId,
      )
      .sort((a, b) => b.startedAt - a.startedAt),

  listBySession: (sessionId) =>
    Object.values(get().recordsById)
      .filter((item) => item.sessionId === sessionId)
      .sort((a, b) => b.startedAt - a.startedAt),

  clearByConnection: (connectionId) =>
    set((state) => {
      const recordsById = Object.fromEntries(
        Object.entries(state.recordsById).filter(
          ([, item]) =>
            item.connectionId !== connectionId && item.destConnectionId !== connectionId,
        ),
      );
      return { recordsById };
    }),
}));
