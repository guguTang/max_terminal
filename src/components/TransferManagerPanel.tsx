import { useMemo } from "react";
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowRightLeft,
  Loader2,
} from "lucide-react";
import { useSessionStore } from "../stores/sessionStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useTransferStore } from "../stores/transferStore";

function formatBytes(bytes?: number | null) {
  if (bytes === undefined || bytes === null || bytes < 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function statusMeta(status: string) {
  switch (status) {
    case "success":
      return { icon: <CheckCircle2 size={14} />, className: "text-emerald-400", label: "成功" };
    case "failed":
      return { icon: <AlertTriangle size={14} />, className: "text-red-400", label: "失败" };
    case "cancelled":
      return { icon: <Ban size={14} />, className: "text-zinc-500", label: "已取消" };
    default:
      return { icon: <CircleDashed size={14} />, className: "text-blue-400", label: "进行中" };
  }
}

function phaseLabel(phase?: string) {
  if (phase === "preparing") return "计算大小中…";
  if (phase === "compressing") return "压缩中…";
  if (phase === "extracting") return "解压中…";
  if (phase === "cleaning") return "清理临时文件…";
  if (phase === "transferring") return "传输中…";
  return "准备中…";
}

function isIndeterminatePhase(phase?: string) {
  return (
    phase === "preparing" ||
    phase === "compressing" ||
    phase === "extracting" ||
    phase === "cleaning"
  );
}

function directionLabel(direction: string) {
  switch (direction) {
    case "upload":
      return "上传";
    case "download":
      return "下载";
    case "remote-copy":
      return "跨远程复制";
    default:
      return direction;
  }
}

export function TransferManagerPanel() {
  const connectionId = useSessionStore((s) => s.connectionId);
  const connections = useConnectionStore((s) => s.connections);
  const recordsById = useTransferStore((s) => s.recordsById);
  const clearByConnection = useTransferStore((s) => s.clearByConnection);
  const requestCancel = useTransferStore((s) => s.requestCancel);

  const connectionNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of connections) {
      map.set(item.id, item.name);
    }
    return map;
  }, [connections]);

  const records = useMemo(
    () =>
      connectionId
        ? Object.values(recordsById)
            .filter(
              (item) =>
                item.connectionId === connectionId || item.destConnectionId === connectionId,
            )
            .sort((a, b) => b.startedAt - a.startedAt)
        : [],
    [connectionId, recordsById],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between shrink-0">
        <span className="text-xs text-zinc-400">
          {connectionId ? `连接 ${connectionId.slice(0, 8)} 的传输` : "未选择连接"}
        </span>
        <button
          type="button"
          disabled={!connectionId || records.length === 0}
          onClick={() => {
            if (connectionId) clearByConnection(connectionId);
          }}
          className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-40"
        >
          清空
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {records.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-zinc-500">
            暂无传输记录
          </div>
        ) : (
          records.map((record) => {
            const meta = statusMeta(record.status);
            const isDownload = record.direction === "download";
            const isRemoteCopy = record.direction === "remote-copy";
            const isRunning = record.status === "running";
            const isIndeterminate = isRunning && isIndeterminatePhase(record.phase);
            const hasTotal = record.totalBytes !== undefined && record.totalBytes > 0;
            const progress = hasTotal
              ? Math.max(0, Math.min(100, record.percent || 0))
              : 0;
            const destLabel = record.destConnectionId
              ? connectionNameById.get(record.destConnectionId) ??
                record.destConnectionId.slice(0, 8)
              : null;

            return (
              <div
                key={record.id}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {isRemoteCopy ? (
                      <ArrowRightLeft size={14} className="text-violet-400 shrink-0" />
                    ) : isDownload ? (
                      <ArrowDown size={14} className="text-sky-400 shrink-0" />
                    ) : (
                      <ArrowUp size={14} className="text-amber-400 shrink-0" />
                    )}
                    <span className="truncate text-sm text-zinc-200">{record.fileName}</span>
                  </div>
                  <div className={`flex items-center gap-1 text-xs ${meta.className}`}>
                    {meta.icon}
                    <span>{meta.label}</span>
                  </div>
                </div>

                <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-zinc-500">{directionLabel(record.direction)}</span>
                  {isRunning && (
                    <span className="flex items-center gap-1 text-blue-300">
                      {isIndeterminate && <Loader2 size={11} className="animate-spin" />}
                      {phaseLabel(record.phase)}
                    </span>
                  )}
                </div>

                <div className="mt-1 text-[11px] text-zinc-500 truncate" title={record.remotePath}>
                  {isRemoteCopy ? `源: ${record.remotePath}` : record.remotePath}
                </div>
                {isRemoteCopy && record.destRemotePath && (
                  <div
                    className="mt-0.5 text-[11px] text-zinc-500 truncate"
                    title={record.destRemotePath}
                  >
                    目标{destLabel ? ` (${destLabel})` : ""}: {record.destRemotePath}
                  </div>
                )}

                <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
                  {isIndeterminate || (isRunning && !hasTotal) ? (
                    <div className="h-full w-1/3 animate-pulse rounded bg-blue-500/80" />
                  ) : (
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  )}
                </div>

                <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-400">
                  <span>
                    {isIndeterminate
                      ? `已扫描 ${formatBytes(record.loadedBytes)}`
                      : hasTotal
                        ? `${formatBytes(record.loadedBytes)} / ${formatBytes(record.totalBytes)}`
                        : `已传输 ${formatBytes(record.loadedBytes)}`}
                  </span>
                  <span>{hasTotal ? `${progress.toFixed(0)}%` : "--"}</span>
                </div>

                {record.error && (
                  <div className="mt-1 text-[11px] text-red-400 break-all">{record.error}</div>
                )}

                {isRunning && (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void requestCancel(record.id)}
                      className="rounded px-2 py-1 text-xs text-red-300 hover:bg-red-950/40 hover:text-red-200"
                    >
                      中断传输
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
