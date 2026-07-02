import { useEffect, useState } from "react";
import { RotateCcw, Server, Laptop, X, Eraser } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DockLayout } from "./components/DockLayout";
import { TerminalOutputBridge } from "./components/TerminalOutputBridge";
import { ConnectionList } from "./components/ConnectionList";
import { TransferDrawer } from "./components/TransferDrawer";
import { TransferRail } from "./components/TransferRail";
import { getDockApi, LAYOUT_STORAGE_KEY, resetLayout } from "./layout/dockApi";
import { useSessionStore } from "./stores/sessionStore";
import { useConnectionStore } from "./stores/connectionStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useTerminalTitleStore } from "./stores/terminalTitleStore";

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
    disconnectAll,
  } = useSessionStore();
  const connections = useConnectionStore((s) => s.connections);
  const [layoutKey, setLayoutKey] = useState(0);
  const [resetFeedback, setResetFeedback] = useState(false);
  const [mode, setMode] = useState<"ssh" | "console">("ssh");
  const [transferOpen, setTransferOpen] = useState(false);

  useEffect(() => {
    const handleBeforeUnload = () => {
      void useSessionStore.getState().disconnectAll();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    return () => {
      void disconnectAll();
    };
  }, [disconnectAll]);

  const handleResetLayout = () => {
    const api = getDockApi();
    if (api) {
      resetLayout(api);
    } else {
      localStorage.removeItem(LAYOUT_STORAGE_KEY);
      setLayoutKey((k) => k + 1);
    }
    setResetFeedback(true);
    window.setTimeout(() => setResetFeedback(false), 1500);
  };

  const handleClearSshState = async () => {
    await disconnectAll();
    useWorkspaceStore.setState({ snapshots: {} });
    useTerminalTitleStore.setState({ titlesByConnection: {} });
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    const api = getDockApi();
    if (api) {
      resetLayout(api);
    } else {
      setLayoutKey((k) => k + 1);
    }
    setResetFeedback(true);
    window.setTimeout(() => setResetFeedback(false), 1500);
  };

  const handleDragMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (!isMac || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        ".app-no-drag,button,a,input,textarea,select,[role='button'],[data-no-drag='true']",
      )
    ) {
      return;
    }
    event.preventDefault();
    void getCurrentWindow().startDragging().catch((err) => {
      console.error("startDragging failed:", err);
    });
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <TerminalOutputBridge />
      <header
        className={`flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-950 shrink-0 ${
          isMac ? "pl-20" : ""
        }`}
        onMouseDown={handleDragMouseDown}
      >
        <nav className="flex items-center gap-1 shrink-0 app-no-drag">
          <button
            type="button"
            onClick={() => {
              setMode("ssh");
              showSshList();
            }}
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
            onClick={() => setMode("console")}
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
        <div className="flex-1 min-w-0" />
        <div className="ml-auto flex items-center gap-2 app-no-drag">
          {error && (
            <span className="text-xs text-red-400 truncate max-w-[40vw]">{error}</span>
          )}
          {resetFeedback && (
            <span className="text-xs text-emerald-400">布局已重置</span>
          )}
          <button
            type="button"
            onClick={() => void handleClearSshState()}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            title="清空所有 SSH 状态（调试用）"
          >
            <Eraser size={14} />
            清空SSH状态
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
            {mode === "ssh" && sshViewMode === "list" ? (
              <ConnectionList />
            ) : mode === "ssh" ? (
              <DockLayout layoutKey={layoutKey} />
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-zinc-500">
                本机 Console 即将支持
              </div>
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
