import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
import { ConsoleTerminalGroupActions } from "./ConsoleTerminalGroupActions";
import { EditableDockTab } from "./EditableDockTab";
import { dockComponents } from "../layout/panels";
import { getConsoleTerminalTabContextMenuItems } from "../layout/terminalDock";
import {
  createConsoleDefaultLayout,
  loadConsoleSavedLayout,
  saveConsoleLayout,
  setDockApi,
} from "../layout/dockApi";
import { getTerminalIdFromPanel, isTerminalPanel } from "../layout/terminalDock";
import { clearTerminalContextCache } from "../lib/terminalContextCache";
import { LOCAL_SESSION_ID, LOCAL_WORKSPACE_ID } from "../stores/localConsoleStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";
import { useTerminalTitleStore } from "../stores/terminalTitleStore";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(api: DockviewReadyEvent["api"]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveConsoleLayout(api);
    saveTimer = null;
  }, 400);
}

interface ConsoleDockLayoutProps {
  layoutKey: number;
}

export function ConsoleDockLayout({ layoutKey }: ConsoleDockLayoutProps) {
  const apiRef = useRef<DockviewReadyEvent["api"] | null>(null);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    setDockApi(event.api);

    if (!loadConsoleSavedLayout(event.api)) {
      createConsoleDefaultLayout(event.api);
    }

    event.api.onDidLayoutChange(() => scheduleSave(event.api));
    event.api.onDidRemovePanel((panel) => {
      if (!isTerminalPanel(panel)) return;

      const terminalId = getTerminalIdFromPanel(panel);
      useTerminalMetaStore.getState().clearTerminal(LOCAL_SESSION_ID, terminalId);
      useTerminalOutputStore.getState().clearTerminal(LOCAL_SESSION_ID, terminalId);
      clearTerminalContextCache(LOCAL_SESSION_ID, terminalId);
      useTerminalTitleStore.getState().removeTerminal(LOCAL_WORKSPACE_ID, terminalId);
      void invoke("terminal_destroy", {
        sessionId: LOCAL_SESSION_ID,
        terminalId,
      }).catch(() => {});
    });
  }, []);

  useEffect(() => {
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 350);
  }, [layoutKey]);

  useEffect(() => {
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      const api = apiRef.current;
      if (api) {
        saveConsoleLayout(api);
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
      leftHeaderActionsComponent={ConsoleTerminalGroupActions}
      defaultTabComponent={EditableDockTab}
      getTabContextMenuItems={getConsoleTerminalTabContextMenuItems}
    />
  );
}
