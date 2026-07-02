import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Connection } from "../types/connection";

interface ConnectionState {
  connections: Connection[];
  loading: boolean;
  error: string | null;
  fetchConnections: () => Promise<void>;
  saveConnection: (connection: Connection) => Promise<Connection>;
  deleteConnection: (id: string) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  loading: false,
  error: null,

  fetchConnections: async () => {
    set({ loading: true, error: null });
    try {
      const connections = await invoke<Connection[]>("list_connections_cmd");
      set({ connections, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  saveConnection: async (connection) => {
    const saved = await invoke<Connection>("save_connection_cmd", { connection });
    const existing = get().connections;
    const idx = existing.findIndex((c) => c.id === saved.id);
    const connections =
      idx >= 0
        ? existing.map((c) => (c.id === saved.id ? saved : c))
        : [saved, ...existing];
    set({ connections });
    return saved;
  },

  deleteConnection: async (id) => {
    await invoke("delete_connection_cmd", { id });
    set({ connections: get().connections.filter((c) => c.id !== id) });
  },
}));
