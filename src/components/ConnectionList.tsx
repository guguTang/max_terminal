import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Server,
  Trash2,
  Pencil,
  Plug,
  PlugZap,
  Unplug,
  Loader2,
  ChevronDown,
  ChevronRight,
  Download,
  Upload,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Connection } from "../types/connection";
import { useConnectionStore } from "../stores/connectionStore";
import { useSessionStore } from "../stores/sessionStore";
import {
  buildConnectionBackup,
  parseConnectionBackup,
  utf8ToBase64,
} from "../lib/connectionBackup";
import { ConnectionDialog } from "./ConnectionDialog";

const UNGROUPED_KEY = "";
const UNGROUPED_LABEL = "未分组";
const COLLAPSED_GROUPS_STORAGE_KEY = "max-terminal-connection-groups-collapsed-v1";

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function persistCollapsedGroups(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // ignore
  }
}

function groupKeyOf(conn: Connection) {
  return conn.group?.trim() || UNGROUPED_KEY;
}

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
  const [notice, setNotice] = useState<string | null>(null);
  const [ioBusy, setIoBusy] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const existingGroups = useMemo(() => {
    const names = new Set<string>();
    for (const conn of connections) {
      const name = conn.group?.trim();
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [connections]);

  const groupedConnections = useMemo(() => {
    const map = new Map<string, Connection[]>();
    for (const conn of connections) {
      const key = groupKeyOf(conn);
      const list = map.get(key);
      if (list) list.push(conn);
      else map.set(key, [conn]);
    }
    const named = [...map.entries()]
      .filter(([key]) => key !== UNGROUPED_KEY)
      .sort(([a], [b]) => a.localeCompare(b, "zh-CN"));
    const ungrouped = map.get(UNGROUPED_KEY);
    if (ungrouped) named.push([UNGROUPED_KEY, ungrouped]);
    return named;
  }, [connections]);

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

  const handleExport = async () => {
    setLocalError(null);
    setNotice(null);
    if (connections.length === 0) {
      setLocalError("没有可导出的连接");
      return;
    }
    setIoBusy(true);
    try {
      const target = await save({
        title: "导出连接配置",
        defaultPath: `max-terminal-connections-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!target) return;
      const payload = buildConnectionBackup(connections);
      const text = JSON.stringify(payload, null, 2);
      await invoke("save_local_file_base64", {
        path: target,
        contentBase64: utf8ToBase64(text),
      });
      setNotice(`已导出 ${connections.length} 条连接`);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setIoBusy(false);
    }
  };

  const handleImport = async () => {
    setLocalError(null);
    setNotice(null);
    setIoBusy(true);
    try {
      const selected = await open({
        title: "导入连接配置",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected || Array.isArray(selected)) return;

      const text = await invoke<string>("read_local_text_file", { path: selected });
      const imported = parseConnectionBackup(text);
      if (imported.length === 0) {
        setLocalError("备份文件中没有连接");
        return;
      }

      const existingIds = new Set(connections.map((c) => c.id));
      let created = 0;
      let updated = 0;
      for (const item of imported) {
        if (item.id && existingIds.has(item.id)) {
          await saveConnection(item);
          updated += 1;
        } else {
          await saveConnection({ ...item, id: "" });
          created += 1;
        }
      }
      await fetchConnections();
      setNotice(`导入完成：新增 ${created}，更新 ${updated}`);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setIoBusy(false);
    }
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistCollapsedGroups(next);
      return next;
    });
  };

  const displayError = localError || sessionError || storeError;
  const sshViewMode = useSessionStore((s) => s.sshViewMode);
  const isFullscreen = sshViewMode === "list";

  const renderConnectionRow = (conn: Connection) => {
    const isActive = connectionId === conn.id;
    const isConnected = sessions.some((s) => s.connectionId === conn.id);
    const isConnecting = connectingId === conn.id && connecting;
    return (
      <div
        key={conn.id}
        role="button"
        tabIndex={0}
        title="双击连接并打开"
        onDoubleClick={() => {
          if (isConnecting) return;
          void handleConnect(conn);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || isConnecting) return;
          void handleConnect(conn);
        }}
        className={`group flex items-center gap-2 px-3 py-2 border-b border-zinc-900 cursor-pointer hover:bg-zinc-900 ${
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
  };

  return (
    <>
      <div
        className={`flex flex-col h-full bg-zinc-950 ${
          isFullscreen ? "" : "border-r border-zinc-800"
        }`}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0">
          <span className="text-sm font-medium text-zinc-300">连接</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={ioBusy}
              className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              title="从 JSON 导入连接（含密码/私钥）"
            >
              <Upload size={13} />
              导入
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={ioBusy || connections.length === 0}
              className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              title="导出全部连接到 JSON（含密码/私钥）"
            >
              <Download size={13} />
              导出
            </button>
            <button
              type="button"
              onClick={openNewDialog}
              className="flex items-center gap-1 rounded-md bg-blue-600 hover:bg-blue-500 px-2 py-1 text-xs text-white"
            >
              <Plus size={14} />
              添加
            </button>
          </div>
        </div>

        {notice && (
          <p className="px-3 py-1.5 text-xs text-emerald-400 border-b border-zinc-900 shrink-0">
            {notice}
          </p>
        )}

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
          {groupedConnections.map(([groupKey, items]) => {
            const label = groupKey === UNGROUPED_KEY ? UNGROUPED_LABEL : groupKey;
            const collapsed = collapsedGroups.has(groupKey);
            return (
              <div key={groupKey || "__ungrouped"} className="border-b border-zinc-900">
                <button
                  type="button"
                  onClick={() => toggleGroup(groupKey)}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                >
                  {collapsed ? (
                    <ChevronRight size={13} className="shrink-0" />
                  ) : (
                    <ChevronDown size={13} className="shrink-0" />
                  )}
                  <span className="truncate">{label}</span>
                  <span className="ml-auto tabular-nums text-zinc-600">{items.length}</span>
                </button>
                {!collapsed && items.map((conn) => renderConnectionRow(conn))}
              </div>
            );
          })}
        </div>
      </div>

      <ConnectionDialog
        open={dialogOpen}
        initial={editing}
        existingGroups={existingGroups}
        onSave={handleSave}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />
    </>
  );
}
