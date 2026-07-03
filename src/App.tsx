import { useState } from "react";
import { RotateCcw, Server, Laptop, X, Eraser } from "lucide-react";
import { ConsoleDockLayout } from "./components/ConsoleDockLayout";
import { DockLayout } from "./components/DockLayout";
import { TerminalOutputBridge } from "./components/TerminalOutputBridge";
import { ConnectionList } from "./components/ConnectionList";
import { TransferDrawer } from "./components/TransferDrawer";
import { TransferRail } from "./components/TransferRail";
import {
  CONSOLE_LAYOUT_STORAGE_KEY,
  captureWorkspaceBeforeClose,
  getDockApi,
  LAYOUT_STORAGE_KEY,
  resetConsoleLayout,
  resetLayout,
  saveConsoleLayout,
  saveLayout,
} from "./layout/dockApi";
import { useSessionStore } from "./stores/sessionStore";
import { useConnectionStore } from "./stores/connectionStore";
import { destroyAllLocalTerminals, useLocalConsoleStore } from "./stores/localConsoleStore";
import { useAppPersistence } from "./hooks/useAppPersistence";
import { clearAllDebugData } from "./lib/clearDebugData";

import { useTransferPolling } from "./hooks/useTransferPolling";

function App() {
  useTransferPolling();
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const {
    error,
    sessions,
    connectionId,
    sshViewMode,
    activateSession,
    showSshList,
    disconnect,
  } = useSessionStore();
  const connections = useConnectionStore((s) => s.connections);
  const [layoutKey, setLayoutKey] = useState(0);
  const [consoleLayoutKey, setConsoleLayoutKey] = useState(0);
  const [resetFeedback, setResetFeedback] = useState(false);
  const [debugClearFeedback, setDebugClearFeedback] = useState(false);
  const [mode, setMode] = useState<"ssh" | "console">("ssh");
  const [transferOpen, setTransferOpen] = useState(false);
  const setLocalConsoleReady = useLocalConsoleStore((s) => s.setReady);

  const saveCurrentDockLayout = () => {
    void saveCurrentDockLayoutAsync();
  };

  const saveCurrentDockLayoutAsync = async () => {
    const api = getDockApi();
    if (!api) return;
    await captureWorkspaceBeforeClose();
    if (mode === "console") {
      saveConsoleLayout(api);
    } else {
      saveLayout(api);
    }
  };

  useAppPersistence({
    mode,
    transferOpen,
    setMode,
    setTransferOpen,
    setLocalConsoleReady,
    saveCurrentDockLayout,
    saveCurrentDockLayoutAsync,
    onClose: async () => {
      await useSessionStore.getState().disconnectAll();
      await destroyAllLocalTerminals();
    },
  });

  const handleResetLayout = () => {
    const api = getDockApi();
    if (api) {
      if (mode === "console") {
        resetConsoleLayout(api);
      } else {
        resetLayout(api);
      }
    } else if (mode === "console") {
      localStorage.removeItem(CONSOLE_LAYOUT_STORAGE_KEY);
      setConsoleLayoutKey((k) => k + 1);
    } else {
      localStorage.removeItem(LAYOUT_STORAGE_KEY);
      setLayoutKey((k) => k + 1);
    }
    setResetFeedback(true);
    window.setTimeout(() => setResetFeedback(false), 1500);
  };

  const handleClearDebugData = async () => {
    await clearAllDebugData({
      dockApi: getDockApi(),
      mode,
      onLayoutReset: () => {
        if (mode === "console") {
          setConsoleLayoutKey((k) => k + 1);
        } else {
          setLayoutKey((k) => k + 1);
        }
      },
    });
    setDebugClearFeedback(true);
    window.setTimeout(() => setDebugClearFeedback(false), 1500);
  };

  const handleSwitchToSsh = () => {
    saveCurrentDockLayout();
    setLocalConsoleReady(false);
    setMode("ssh");
    showSshList();
  };

  const handleSwitchToConsole = () => {
    saveCurrentDockLayout();
    setLocalConsoleReady(true);
    setMode("console");
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <TerminalOutputBridge />
      <header className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-950 shrink-0">
        {isMac && <div className="-ml-4 w-20 shrink-0 app-no-drag" aria-hidden />}
        <nav className="flex items-center gap-1 shrink-0 app-no-drag">
          <button
            type="button"
            onClick={handleSwitchToSsh}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
              mode === "ssh" && sshViewMode === "list"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            <Server size={13} />
            SSH
          </button>
          <button
            type="button"
            onClick={handleSwitchToConsole}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
              mode === "console"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            <Laptop size={13} />
            Console
          </button>
        </nav>
        <div className="h-4 w-px bg-zinc-800 shrink-0" />
        {mode === "ssh" && (
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto pr-2 app-no-drag">
            {sessions.map((s) => {
              const conn = connections.find((c) => c.id === s.connectionId);
              const title = conn ? conn.name : s.connectionId;
              const active = s.connectionId === connectionId;
              return (
                <div
                  key={s.sessionId}
                  className={`inline-flex items-center rounded-md text-xs whitespace-nowrap ${
                    active && sshViewMode === "session"
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                  }`}
                  title={title}
                >
                  <button
                    type="button"
                    onClick={() => activateSession(s.connectionId)}
                    className="px-2.5 py-1"
                  >
                    {title}
                  </button>
                  <button
                    type="button"
                    className={`mr-1 rounded p-0.5 ${
                      active && sshViewMode === "session"
                        ? "text-white/85 hover:bg-white/20"
                        : "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                    }`}
                    title="断开连接"
                    onClick={(event) => {
                      event.stopPropagation();
                      void disconnect(s.connectionId);
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex-1 min-w-0 self-stretch" data-tauri-drag-region />
        <div className="ml-auto flex items-center gap-2 app-no-drag">
          {error && (
            <span className="text-xs text-red-400 truncate max-w-[40vw]">{error}</span>
          )}
          {debugClearFeedback && (
            <span className="text-xs text-emerald-400">调试数据已清空（SSH 连接已保留）</span>
          )}
          {resetFeedback && (
            <span className="text-xs text-emerald-400">布局已重置</span>
          )}
          <button
            type="button"
            onClick={() => void handleClearDebugData()}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            title="清空除 SSH 连接（IP/账号/密码）外的所有 DB 与本地状态，便于调试"
          >
            <Eraser size={14} />
            清空调试数据
          </button>
          <button
            type="button"
            onClick={handleResetLayout}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            title="重置为默认布局"
          >
            <RotateCcw size={14} />
            重置布局
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <div className="h-full w-full flex min-h-0">
          <div className="flex-1 min-h-0">
            {mode === "console" ? (
              <ConsoleDockLayout layoutKey={consoleLayoutKey} />
            ) : mode === "ssh" && sshViewMode === "list" ? (
              <ConnectionList />
            ) : (
              <DockLayout layoutKey={layoutKey} />
            )}
          </div>
          {mode === "ssh" && sshViewMode === "session" && (
            <>
              <TransferDrawer open={transferOpen} onClose={() => setTransferOpen(false)} />
              <TransferRail open={transferOpen} onToggle={() => setTransferOpen((v) => !v)} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
