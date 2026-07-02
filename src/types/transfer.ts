export type TransferPhase =
  | "preparing"
  | "compressing"
  | "extracting"
  | "cleaning"
  | "transferring";
export type TransferSnapshotStatus = "running" | "success" | "failed" | "cancelled";

export interface TransferTaskSnapshot {
  taskId: string;
  sessionId: string;
  direction: "upload" | "download" | "remote-copy";
  remotePath: string;
  localPath: string;
  destSessionId?: string;
  destRemotePath?: string;
  loadedBytes: number;
  totalBytes?: number | null;
  phase: TransferPhase;
  status: TransferSnapshotStatus;
  error?: string;
  startedAt: number;
  endedAt?: number;
}
