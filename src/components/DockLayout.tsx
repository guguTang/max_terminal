import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
import { TerminalGroupActions } from "./TerminalGroupActions";
import { EditableDockTab } from "./EditableDockTab";
import { dockComponents } from "../layout/panels";
import { getTerminalTabContextMenuItems } from "../layout/terminalDock";
import {
  captureConnectionWorkspace,
  captureTerminalRuntimeForConnection,
  createDefaultLayout,
  dockTerminalFullWidthAfterConnect,
  isWorkspaceSwitching,
  loadSavedLayout,
  saveLayout,
  setDockApi,
  setWorkspaceSwitching,
  switchConnectionWorkspace,
  syncWorkspaceWithSession,
} from "../layout/dockApi";
import { getTerminalIdFromPanel, isTerminalPanel } from "../layout/terminalDock";
import { clearTerminalContextCache } from "../lib/terminalContextCache";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";
import { useTerminalTitleStore } from "../stores/terminalTitleStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingWorkspaceSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function scheduleSave(api: DockviewReadyEvent["api"]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (isWorkspaceSwitching()) {
      scheduleSave(api);
      return;
    }
    void (async () => {
      const { connected, connectionId, sessionId } = useSessionStore.getState();
      if (connected && connectionId && sessionId && !isWorkspaceSwitching()) {
        await captureTerminalRuntimeForConnection(api, connectionId, sessionId);
        captureConnectionWorkspace(api, connectionId);
      } else if (!connected) {
        saveLayout(api);
      }
    })();
  }, 400);
}

interface DockLayoutProps {
  layoutKey: number;
}

export function DockLayout({ layoutKey }: DockLayoutProps) {
  const apiRef = useRef<DockviewReadyEvent["api"] | null>(null);
  const prevConnectionIdRef = useRef<string | null>(null);
  const connected = useSessionStore((s) => s.connected);
  const connectionId = useSessionStore((s) => s.connectionId);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    setDockApi(event.api);

    const initiallyConnected = useSessionStore.getState().connected;
    if (!initiallyConnected) {
      if (!loadSavedLayout(event.api)) {
        createDefaultLayout(event.api);
      }
    }
    // 已连接时由 syncWorkspaceWithSession → restoreConnectionWorkspace 搭建布局，
    // 勿先 createDefaultLayout（会在 grid 中残留空 group，切换后表现为顶部空白面板）

    const activeConnectionId = useSessionStore.getState().connectionId;
    prevConnectionIdRef.current = activeConnectionId;
    syncWorkspaceWithSession(event.api);
    event.api.onDidLayoutChange(() => scheduleSave(event.api));
    event.api.onDidRemovePanel((panel) => {
      if (!isTerminalPanel(panel)) return;
      // 切换 SSH 工作区时 fromJSON 会临时移除面板，不能销毁后台 PTY。
      if (isWorkspaceSwitching()) return;

      const terminalId = getTerminalIdFromPanel(panel);
      const panelParams = panel.params as { connectionId?: string } | undefined;
      const panelConnectionId =
        panelParams?.connectionId ?? useSessionStore.getState().connectionId;
      if (!panelConnectionId) return;
      const session = useSessionStore
        .getState()
        .sessions.find((item) => item.connectionId === panelConnectionId);
      if (!session) return;

      useTerminalMetaStore.getState().clearTerminal(session.sessionId, terminalId);
      useTerminalOutputStore.getState().clearTerminal(session.sessionId, terminalId);
      clearTerminalContextCache(session.sessionId, terminalId);
      useTerminalTitleStore.getState().removeTerminal(panelConnectionId, terminalId);
      useWorkspaceStore.getState().removeTerminalRuntime(panelConnectionId, terminalId);
      void invoke("terminal_destroy", { sessionId: session.sessionId, terminalId }).catch(
        () => {},
      );
    });
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    if (!connected || !connectionId) {
      prevConnectionIdRef.current = null;
      syncWorkspaceWithSession(api);
      window.setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
      return;
    }

    const prevConnectionId = prevConnectionIdRef.current;
    if (prevConnectionId !== connectionId) {
      cancelPendingWorkspaceSave();
      void switchConnectionWorkspace(api, prevConnectionId, connectionId).catch(() => {
        setWorkspaceSwitching(false);
      });
      prevConnectionIdRef.current = connectionId;
      return;
    }

    window.setTimeout(() => dockTerminalFullWidthAfterConnect(api), 80);
    window.setTimeout(() => dockTerminalFullWidthAfterConnect(api), 240);
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 350);
  }, [connected, connectionId, layoutKey]);

  useEffect(() => {
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      const api = apiRef.current;
      if (!api) {
        setDockApi(null);
        return;
      }
      const { connected, connectionId, sessionId } = useSessionStore.getState();
      if (connected && connectionId && sessionId) {
        captureConnectionWorkspace(api, connectionId);
      } else {
        saveLayout(api);
      }
      setDockApi(null);
    };
  }, []);

  return (
    <DockviewReact
      key={layoutKey}
      onReady={onReady}
      components={dockComponents}
      className="dockview-theme-dark max-terminal-dockview h-full w-full"
      dndStrategy="pointer"
      singleTabMode="default"
      dndEdges={{
        size: { type: "percentage", value: 18 },
        activationSize: { type: "pixels", value: 48 },
      }}
      prefixHeaderActionsComponent={TerminalGroupActions}
      defaultTabComponent={EditableDockTab}
      getTabContextMenuItems={getTerminalTabContextMenuItems}
    />
  );
}
