import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export const LOCAL_SESSION_ID = "__local__";
export const LOCAL_WORKSPACE_ID = "__local__";

interface LocalConsoleState {
  ready: boolean;
  setReady: (ready: boolean) => void;
}

export const useLocalConsoleStore = create<LocalConsoleState>((set) => ({
  ready: false,
  setReady: (ready) => set({ ready }),
}));

export async function destroyAllLocalTerminals() {
  await invoke("terminal_destroy_all_local");
}
