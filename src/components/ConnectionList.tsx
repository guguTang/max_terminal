import { useEffect, useState } from "react";
import {
  Plus,
  Server,
  Trash2,
  Pencil,
  Plug,
  PlugZap,
  Unplug,
  Loader2,
} from "lucide-react";
import type { Connection } from "../types/connection";
import { useConnectionStore } from "../stores/connectionStore";
import { useSessionStore } from "../stores/sessionStore";
import { ConnectionDialog } from "./ConnectionDialog";

export function ConnectionList() {
  const { connections, fetchConnections, saveConnection, deleteConnection, error: storeError } =
    useConnectionStore();
  const {
    connectionId,
    sessions,
    connecting,
    connectingId,
    connect,
    disconnect,
    activateSession,
    error: sessionError,
  } = useSessionStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const openNewDialog = () => {
    setEditing(null);
    setDialogOpen(true);
    setLocalError(null);
  };

  const openEditDialog = (conn: Connection) => {
    setEditing(conn);
    setDialogOpen(true);
  };

  const handleConnect = async (conn: Connection) => {
    setLocalError(null);
    try {
      const exists = sessions.some((s) => s.connectionId === conn.id);
      if (exists) {
        activateSession(conn.id);
      } else {
        await connect(conn.id);
      }
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const handleSave = async (conn: Connection) => {
    await saveConnection(conn);
    setEditing(null);
  };

  const displayError = localError || sessionError || storeError;
  const sshViewMode = useSessionStore((s) => s.sshViewMode);
  const isFullscreen = sshViewMode === "list";

  return (
    <>
      <div
        className={`flex flex-col h-full bg-zinc-950 ${
          isFullscreen ? "" : "border-r border-zinc-800"
        }`}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0">
          <span className="text-sm font-medium text-zinc-300">连接</span>
          <button
            type="button"
            onClick={openNewDialog}
            className="flex items-center gap-1 rounded-md bg-blue-600 hover:bg-blue-500 px-2 py-1 text-xs text-white"
          >
            <Plus size={14} />
            添加
          </button>
        </div>

        {displayError && (
          <p className="px-3 py-1.5 text-xs text-red-400 border-b border-zinc-900 shrink-0">
            {displayError}
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {connections.length === 0 && (
            <button
              type="button"
              onClick={openNewDialog}
              className="m-3 w-[calc(100%-1.5rem)] flex flex-col items-center gap-2 rounded-lg border border-dashed border-zinc-700 py-6 text-zinc-400 hover:border-blue-500 hover:text-blue-400 transition-colors"
            >
              <Plus size={24} />
              <span className="text-sm">添加第一个连接</span>
            </button>
          )}
          {connections.map((conn) => {
            const isActive = connectionId === conn.id;
            const isConnected = sessions.some((s) => s.connectionId === conn.id);
            const isConnecting = connectingId === conn.id && connecting;
            return (
              <div
                key={conn.id}
                className={`group flex items-center gap-2 px-3 py-2 border-b border-zinc-900 hover:bg-zinc-900 ${
                  isActive ? "bg-zinc-900 border-l-2 border-l-blue-500" : ""
                }`}
              >
                <Server size={14} className="text-zinc-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{conn.name}</div>
                  <div className="text-xs text-zinc-500 truncate">
                    {conn.username}@{conn.host}:{conn.port}
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                  {!isConnected && (
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await handleConnect(conn);
                      }}
                      className="p-1 rounded hover:bg-zinc-800 text-zinc-300"
                      title="连接"
                    >
                      <Plug size={12} />
                    </button>
                  )}
                  {isConnected && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        activateSession(conn.id);
                      }}
                      className="p-1 rounded hover:bg-zinc-800 text-emerald-400"
                      title="切换到此连接"
                    >
                      <PlugZap size={12} />
                    </button>
                  )}
                  {isConnected && (
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await disconnect(conn.id);
                      }}
                      className="p-1 rounded hover:bg-zinc-800 text-amber-300"
                      title="断开连接"
                    >
                      <Unplug size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditDialog(conn);
                    }}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (isConnected) await disconnect(conn.id);
                      await deleteConnection(conn.id);
                    }}
                    className="p-1 rounded hover:bg-zinc-800 text-red-400"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {isConnecting ? (
                  <Loader2 size={14} className="animate-spin text-blue-400 shrink-0" />
                ) : isActive ? (
                  <PlugZap size={14} className="text-green-400 shrink-0" />
                ) : isConnected ? (
                  <Plug size={14} className="text-emerald-500 shrink-0" />
                ) : (
                  <Plug size={14} className="text-zinc-500 shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <ConnectionDialog
        open={dialogOpen}
        initial={editing}
        onSave={handleSave}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />
    </>
  );
}
