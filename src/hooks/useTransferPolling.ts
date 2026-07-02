import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TransferTaskSnapshot } from "../types/transfer";
import { useTransferStore } from "../stores/transferStore";

const POLL_INTERVAL_MS = 220;

export function useTransferPolling() {
  const recordsById = useTransferStore((s) => s.recordsById);
  const syncFromSnapshot = useTransferStore((s) => s.syncFromSnapshot);

  useEffect(() => {
    const runningIds = Object.values(recordsById)
      .filter((item) => item.status === "running")
      .map((item) => item.id);
    if (runningIds.length === 0) return;

    let cancelled = false;

    const pollOnce = async () => {
      for (const taskId of runningIds) {
        if (cancelled) return;
        try {
          const snapshot = await invoke<TransferTaskSnapshot>("transfer_query", { taskId });
          syncFromSnapshot(taskId, snapshot);
        } catch {
          // task may have been cleared
        }
      }
    };

    void pollOnce();
    const timer = window.setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [recordsById, syncFromSnapshot]);
}
