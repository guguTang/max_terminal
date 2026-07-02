import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
import { TerminalGroupActions } from "./TerminalGroupActions";
import { EditableDockTab } from "./EditableDockTab";
import { dockComponents } from "../layout/panels";
import { getTerminalTabContextMenuItems } from "../layout/terminalDock";
import {
  captureConnectionWorkspace,
  createDefaultLayout,
  dockTerminalFullWidthAfterConnect,
  loadSavedLayout,
  saveLayout,
  setDockApi,
  switchConnectionWorkspace,
  syncWorkspaceWithSession,
} from "../layout/dockApi";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";
import { useTerminalTitleStore } from "../stores/terminalTitleStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(api: DockviewReadyEvent["api"]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { connected, connectionId } = useSessionStore.getState();
    if (connected && connectionId) {
      captureConnectionWorkspace(api, connectionId);
    }
    saveLayout(api);
    saveTimer = null;
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

    if (!loadSavedLayout(event.api)) {
      createDefaultLayout(event.api);
    }

    const activeConnectionId = useSessionStore.getState().connectionId;
    prevConnectionIdRef.current = activeConnectionId;
    syncWorkspaceWithSession(event.api);
    event.api.onDidLayoutChange(() => scheduleSave(event.api));
    event.api.onDidRemovePanel((panel) => {
      if (!panel.id.startsWith("terminal")) return;
      const terminalId =
        ((panel.params as { terminalId?: string } | undefined)?.terminalId ?? "main");
      const { sessionId, connectionId } = useSessionStore.getState();
      if (!sessionId || !connectionId) return;
      useTerminalMetaStore.getState().clearTerminal(sessionId, terminalId);
      useTerminalOutputStore.getState().clearTerminal(sessionId, terminalId);
      useTerminalTitleStore.getState().removeTerminal(connectionId, terminalId);
      useWorkspaceStore.getState().removeTerminalRuntime(connectionId, terminalId);
      void invoke("terminal_destroy", { sessionId, terminalId }).catch(() => {});
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
      switchConnectionWorkspace(api, prevConnectionId, connectionId);
      prevConnectionIdRef.current = connectionId;
    }

    window.setTimeout(() => dockTerminalFullWidthAfterConnect(api), 80);
    window.setTimeout(() => dockTerminalFullWidthAfterConnect(api), 240);
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 350);
  }, [connected, connectionId, layoutKey]);

  useEffect(() => {
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
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
