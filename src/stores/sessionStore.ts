import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectResult } from "../types/connection";
import { useTerminalMetaStore } from "./terminalMetaStore";
import { useTerminalOutputStore } from "./terminalOutputStore";
import { useWorkspaceStore } from "./workspaceStore";

export interface SshSessionItem {
  sessionId: string;
  connectionId: string;
  homePath: string;
}

export type SshViewMode = "list" | "session";

interface SessionState {
  sessions: SshSessionItem[];
  sshViewMode: SshViewMode;
  activeSessionId: string | null;
  sessionId: string | null;
  connectionId: string | null;
  homePath: string | null;
  connecting: boolean;
  connected: boolean;
  error: string | null;
  selectedFile: string | null;
  connectingId: string | null;
  connect: (connectionId: string) => Promise<void>;
  connectBackground: (connectionId: string) => Promise<SshSessionItem>;
  activateSession: (connectionId: string) => Promise<void>;
  showSshList: () => void;
  disconnect: (connectionId?: string) => Promise<void>;
  disconnectAll: () => Promise<void>;
  setSelectedFile: (path: string | null) => void;
}

function pickActiveSession(
  sessions: SshSessionItem[],
  activeSessionId: string | null,
) {
  return (
    sessions.find((s) => s.sessionId === activeSessionId) ??
    sessions[0] ??
    null
  );
}

function selectedFileForConnection(connectionId: string) {
  return useWorkspaceStore.getState().getSnapshot(connectionId)?.selectedFile ?? null;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  sshViewMode: "list",
  activeSessionId: null,
  sessionId: null,
  connectionId: null,
  homePath: null,
  connecting: false,
  connectingId: null,
  connected: false,
  error: null,
  selectedFile: null,

  connect: async (connectionId) => {
    const existing = get().sessions.find((s) => s.connectionId === connectionId);
    if (existing) {
      await get().activateSession(connectionId);
      return;
    }

    set({ connecting: true, connectingId: connectionId, error: null });
    try {
      const prevConnectionId = get().connectionId;
      const prevSessionId = get().sessionId;
      const result = await invoke<ConnectResult>("connect_ssh", { connectionId });
      const sessions = [
        ...get().sessions.filter((s) => s.connectionId !== result.connectionId),
        {
          sessionId: result.sessionId,
          connectionId: result.connectionId,
          homePath: result.homePath,
        },
      ];
      if (
        prevConnectionId &&
        prevSessionId &&
        prevConnectionId !== result.connectionId
      ) {
        const { captureConnectionWorkspaceSnapshot, setWorkspaceSwitching } =
          await import("../layout/dockApi");
        setWorkspaceSwitching(true);
        await captureConnectionWorkspaceSnapshot(prevConnectionId, prevSessionId);
      }
      set({
        sessions,
        activeSessionId: result.sessionId,
        sessionId: result.sessionId,
        connectionId: result.connectionId,
        homePath: result.homePath,
        connecting: false,
        connectingId: null,
        connected: true,
        selectedFile: selectedFileForConnection(result.connectionId),
        sshViewMode: "session",
      });
    } catch (e) {
      set({
        connecting: false,
        connectingId: null,
        error: String(e),
      });
      throw e;
    }
  },

  connectBackground: async (connectionId) => {
    const existing = get().sessions.find((s) => s.connectionId === connectionId);
    if (existing) return existing;

    const result = await invoke<ConnectResult>("connect_ssh", { connectionId });
    const item: SshSessionItem = {
      sessionId: result.sessionId,
      connectionId: result.connectionId,
      homePath: result.homePath,
    };
    set({
      sessions: [
        ...get().sessions.filter((s) => s.connectionId !== result.connectionId),
        item,
      ],
    });
    return item;
  },

  activateSession: async (connectionId) => {
    const target = get().sessions.find((s) => s.connectionId === connectionId);
    if (!target) return;

    const prevConnectionId = get().connectionId;
    const prevSessionId = get().sessionId;
    if (prevConnectionId === connectionId) {
      set({
        activeSessionId: target.sessionId,
        sessionId: target.sessionId,
        connectionId: target.connectionId,
        homePath: target.homePath,
        connected: true,
        selectedFile: selectedFileForConnection(connectionId),
        sshViewMode: "session",
        error: null,
      });
      return;
    }

    const { captureConnectionWorkspaceSnapshot, setWorkspaceSwitching } =
      await import("../layout/dockApi");
    if (prevConnectionId && prevSessionId) {
      setWorkspaceSwitching(true);
      await captureConnectionWorkspaceSnapshot(prevConnectionId, prevSessionId);
    }

    let ensureError: string | null = null;
    try {
      await invoke("session_ensure_alive", { sessionId: target.sessionId });
    } catch (e) {
      ensureError = String(e);
    }

    set({
      activeSessionId: target.sessionId,
      sessionId: target.sessionId,
      connectionId: target.connectionId,
      homePath: target.homePath,
      connected: true,
      connecting: false,
      connectingId: null,
      error: ensureError,
      selectedFile: selectedFileForConnection(connectionId),
      sshViewMode: "session",
    });
  },

  showSshList: () => {
    const currentConnectionId = get().connectionId;
    const currentSessionId = get().sessionId;
    if (currentConnectionId && currentSessionId) {
      void (async () => {
        try {
          const { getDockApi, captureConnectionWorkspace, captureTerminalRuntimeForConnection } =
            await import("../layout/dockApi");
          const api = getDockApi();
          if (!api) return;
          await captureTerminalRuntimeForConnection(api, currentConnectionId, currentSessionId);
          captureConnectionWorkspace(api, currentConnectionId);
        } catch {
          // ignore snapshot capture errors when switching to list
        }
      })();
    }
    set({ sshViewMode: "list" });
  },

  disconnect: async (connectionId) => {
    const state = get();
    const target = connectionId
      ? state.sessions.find((s) => s.connectionId === connectionId)
      : state.sessions.find((s) => s.sessionId === state.activeSessionId);
    if (!target) return;

    if (target.connectionId === get().connectionId) {
      try {
        const { getDockApi, captureConnectionWorkspace, captureTerminalRuntimeForConnection } =
          await import("../layout/dockApi");
        const api = getDockApi();
        if (api) {
          await captureTerminalRuntimeForConnection(api, target.connectionId, target.sessionId);
          captureConnectionWorkspace(api, target.connectionId);
        }
      } catch {
        // ignore snapshot capture errors during disconnect
      }
    }

    try {
      await invoke("terminal_destroy", { sessionId: target.sessionId });
    } catch {
      // terminal may not exist
    }

    await invoke("disconnect_ssh", { sessionId: target.sessionId });

    useTerminalMetaStore.getState().clearSession(target.sessionId);
    useTerminalOutputStore.getState().clearSession(target.sessionId);

    const sessions = get().sessions.filter((s) => s.sessionId !== target.sessionId);
    const active = pickActiveSession(
      sessions,
      get().activeSessionId === target.sessionId ? null : get().activeSessionId,
    );
    set({
      sessions,
      activeSessionId: active?.sessionId ?? null,
      sessionId: active?.sessionId ?? null,
      connectionId: active?.connectionId ?? null,
      homePath: active?.homePath ?? null,
      connectingId: null,
      connected: Boolean(active),
      selectedFile: active ? selectedFileForConnection(active.connectionId) : null,
      sshViewMode: active ? "session" : "list",
      error: null,
    });
  },

  disconnectAll: async () => {
    const sessions = get().sessions;
    for (const session of sessions) {
      try {
        await invoke("terminal_destroy", { sessionId: session.sessionId });
      } catch {
        // terminal may not exist
      }
      await invoke("disconnect_ssh", { sessionId: session.sessionId });
    }
    useTerminalMetaStore.getState().clear();
    useTerminalOutputStore.getState().clearAll();
    set({
      sessions: [],
      activeSessionId: null,
      sessionId: null,
      connectionId: null,
      homePath: null,
      connectingId: null,
      connected: false,
      selectedFile: null,
      sshViewMode: "list",
      error: null,
    });
  },

  setSelectedFile: (path) => set({ selectedFile: path }),
}));
