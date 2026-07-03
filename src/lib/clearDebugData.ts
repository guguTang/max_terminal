import { invoke } from "@tauri-apps/api/core";
import type { DockviewApi } from "dockview";
import {
  CONSOLE_LAYOUT_STORAGE_KEY,
  LAYOUT_STORAGE_KEY,
  resetConsoleLayout,
  resetLayout,
} from "../layout/dockApi";
import { destroyAllLocalTerminals } from "../stores/localConsoleStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";
import { useTerminalTitleStore, TERMINAL_TITLES_STORAGE_KEY } from "../stores/terminalTitleStore";
import { useWorkspaceStore, WORKSPACE_SNAPSHOTS_STORAGE_KEY } from "../stores/workspaceStore";

/** 清空除 SSH 连接配置外的所有持久化与运行时状态，便于调试。 */
export async function clearAllDebugData(options?: {
  dockApi?: DockviewApi | null;
  mode?: "ssh" | "console";
  onLayoutReset?: () => void;
}): Promise<void> {
  await useSessionStore.getState().disconnectAll();
  await destroyAllLocalTerminals();

  useWorkspaceStore.getState().clearAll();
  useTerminalTitleStore.getState().clearAll();
  useTerminalMetaStore.getState().clear();
  useTerminalOutputStore.getState().clearAll();

  localStorage.removeItem(LAYOUT_STORAGE_KEY);
  localStorage.removeItem(CONSOLE_LAYOUT_STORAGE_KEY);
  localStorage.removeItem(WORKSPACE_SNAPSHOTS_STORAGE_KEY);
  localStorage.removeItem(TERMINAL_TITLES_STORAGE_KEY);

  await invoke("clear_debug_data_cmd");

  useSessionStore.getState().showSshList();

  const api = options?.dockApi;
  if (api) {
    if (options?.mode === "console") {
      resetConsoleLayout(api);
    } else {
      resetLayout(api);
    }
  }
  options?.onLayoutReset?.();
}
