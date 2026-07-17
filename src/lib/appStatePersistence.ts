import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useConnectionStore } from "../stores/connectionStore";
import { useSessionStore, type SshViewMode } from "../stores/sessionStore";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";

export type AppMode = "ssh" | "console";

export interface PersistedAppStateV1 {
  version: 1;
  mode: AppMode;
  sshViewMode: SshViewMode;
  activeConnectionId: string | null;
  openConnectionIds: string[];
  transferOpen: boolean;
  dockerOpen?: boolean;
  terminalOutputs: Record<string, string>;
}

const MAX_TOTAL_OUTPUT_CHARS = 1_024_000;
const PERSIST_DEBOUNCE_MS = 600;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let restoring = false;
let closeHookInstalled = false;

function trimTerminalOutputs(outputs: Record<string, string>): Record<string, string> {
  const entries = Object.entries(outputs);
  const next: Record<string, string> = {};
  let total = 0;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [key, value] = entries[i];
    if (total >= MAX_TOTAL_OUTPUT_CHARS) break;
    const allowed = Math.min(value.length, MAX_TOTAL_OUTPUT_CHARS - total);
    if (allowed <= 0) continue;
    next[key] = value.slice(value.length - allowed);
    total += allowed;
  }

  return next;
}

export function captureAppState(input: {
  mode: AppMode;
  transferOpen: boolean;
  dockerOpen: boolean;
}): PersistedAppStateV1 {
  const session = useSessionStore.getState();
  return {
    version: 1,
    mode: input.mode,
    sshViewMode: session.sshViewMode,
    activeConnectionId: session.connectionId,
    openConnectionIds: session.sessions.map((item) => item.connectionId),
    transferOpen: input.transferOpen,
    dockerOpen: input.dockerOpen,
    terminalOutputs: trimTerminalOutputs(useTerminalOutputStore.getState().exportBuffers()),
  };
}

export async function loadPersistedAppState(): Promise<PersistedAppStateV1 | null> {
  try {
    const raw = await invoke<string | null>("get_app_state");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedAppStateV1;
    if (parsed?.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function persistAppState(input: {
  mode: AppMode;
  transferOpen: boolean;
  dockerOpen: boolean;
}): Promise<void> {
  if (restoring) return;
  try {
    const payload = captureAppState(input);
    await invoke("save_app_state_cmd", { json: JSON.stringify(payload) });
  } catch {
    // ignore persistence failures
  }
}

export function schedulePersistAppState(input: {
  mode: AppMode;
  transferOpen: boolean;
  dockerOpen: boolean;
}) {
  if (restoring) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistAppState(input);
  }, PERSIST_DEBOUNCE_MS);
}

export async function clearPersistedAppState(): Promise<void> {
  try {
    await invoke("clear_app_state_cmd");
  } catch {
    // ignore
  }
}

export async function restoreAppState(options: {
  setMode: (mode: AppMode) => void;
  setTransferOpen: (open: boolean) => void;
  setDockerOpen: (open: boolean) => void;
  setLocalConsoleReady: (ready: boolean) => void;
}): Promise<void> {
  restoring = true;
  try {
    await useConnectionStore.getState().fetchConnections();
    const saved = await loadPersistedAppState();
    if (!saved) return;

    if (saved.terminalOutputs && Object.keys(saved.terminalOutputs).length > 0) {
      useTerminalOutputStore.getState().hydrate(saved.terminalOutputs);
    }

    options.setMode(saved.mode);
    const transferOpen = Boolean(saved.transferOpen);
    const dockerOpen = Boolean(saved.dockerOpen) && !transferOpen;
    options.setTransferOpen(transferOpen);
    options.setDockerOpen(dockerOpen);
    if (saved.mode === "console") {
      options.setLocalConsoleReady(true);
    }

    const validConnectionIds = new Set(
      useConnectionStore.getState().connections.map((item) => item.id),
    );
    const openIds = saved.openConnectionIds.filter((id) => validConnectionIds.has(id));

    const { connectBackground, activateSession, showSshList } = useSessionStore.getState();
    for (const connectionId of openIds) {
      try {
        await connectBackground(connectionId);
      } catch {
        // skip failed reconnect
      }
    }

    if (saved.mode === "ssh") {
      if (
        saved.sshViewMode === "session" &&
        saved.activeConnectionId &&
        validConnectionIds.has(saved.activeConnectionId)
      ) {
        const exists = useSessionStore
          .getState()
          .sessions.some((item) => item.connectionId === saved.activeConnectionId);
        if (exists) {
          activateSession(saved.activeConnectionId);
        } else {
          showSshList();
        }
      } else {
        showSshList();
      }
    }
  } finally {
    restoring = false;
  }
}

export function installAppClosePersistence(
  getInput: () => {
    mode: AppMode;
    transferOpen: boolean;
    dockerOpen: boolean;
    saveCurrentDockLayout: () => void;
    saveCurrentDockLayoutAsync?: () => Promise<void>;
  },
  onClose?: () => void | Promise<void>,
) {
  if (closeHookInstalled) return;
  closeHookInstalled = true;

  const flushOnClose = async () => {
    const input = getInput();
    try {
      if (input.saveCurrentDockLayoutAsync) {
        await input.saveCurrentDockLayoutAsync();
      } else {
        input.saveCurrentDockLayout();
      }
      await persistAppState({
        mode: input.mode,
        transferOpen: input.transferOpen,
        dockerOpen: input.dockerOpen,
      });
      await onClose?.();
    } catch (error) {
      console.error("flushOnClose failed:", error);
    }
  };

  const closeApp = async () => {
    await flushOnClose();
    try {
      await getCurrentWindow().destroy();
    } catch (error) {
      console.error("window destroy failed:", error);
    }
    try {
      await invoke("exit_app");
    } catch (error) {
      console.error("exit_app failed:", error);
    }
  };

  window.addEventListener("beforeunload", () => {
    void flushOnClose();
  });

  void getCurrentWindow()
    .onCloseRequested(async (event) => {
      event.preventDefault();
      await closeApp();
    })
    .catch(() => {
      // non-tauri environment
    });
}

export function isAppStateRestoring() {
  return restoring;
}
