import { create } from "zustand";

const MAX_BUFFER_CHARS = 512_000;

type OutputListener = (data: string) => void;

function bufferKey(sessionId: string, terminalId: string) {
  return `${sessionId}:${terminalId}`;
}

const listeners: Record<string, Set<OutputListener>> = {};

function notifyListeners(sessionId: string, terminalId: string, data: string) {
  const key = bufferKey(sessionId, terminalId);
  for (const listener of listeners[key] ?? []) {
    listener(data);
  }
}

function removeListenersForSession(sessionId: string) {
  const prefix = `${sessionId}:`;
  for (const key of Object.keys(listeners)) {
    if (key.startsWith(prefix)) {
      delete listeners[key];
    }
  }
}

interface TerminalOutputState {
  buffers: Record<string, string>;
  append: (sessionId: string, terminalId: string, data: string) => void;
  get: (sessionId: string, terminalId: string) => string;
  subscribe: (
    sessionId: string,
    terminalId: string,
    listener: OutputListener,
  ) => () => void;
  clearTerminal: (sessionId: string, terminalId: string) => void;
  clearSession: (sessionId: string) => void;
  clearAll: () => void;
  exportBuffers: () => Record<string, string>;
  hydrate: (buffers: Record<string, string>) => void;
}

export const useTerminalOutputStore = create<TerminalOutputState>((set, get) => ({
  buffers: {},

  append: (sessionId, terminalId, data) => {
    if (!data) return;
    const key = bufferKey(sessionId, terminalId);
    const prev = get().buffers[key] ?? "";
    let next = prev + data;
    if (next.length > MAX_BUFFER_CHARS) {
      next = next.slice(next.length - MAX_BUFFER_CHARS);
    }
    set((state) => ({
      buffers: { ...state.buffers, [key]: next },
    }));
    notifyListeners(sessionId, terminalId, data);
  },

  get: (sessionId, terminalId) => get().buffers[bufferKey(sessionId, terminalId)] ?? "",

  subscribe: (sessionId, terminalId, listener) => {
    const key = bufferKey(sessionId, terminalId);
    if (!listeners[key]) listeners[key] = new Set();
    listeners[key].add(listener);
    return () => {
      listeners[key]?.delete(listener);
      if (listeners[key]?.size === 0) delete listeners[key];
    };
  },

  clearTerminal: (sessionId, terminalId) =>
    set((state) => {
      const key = bufferKey(sessionId, terminalId);
      delete listeners[key];
      const buffers = { ...state.buffers };
      delete buffers[key];
      return { buffers };
    }),

  clearSession: (sessionId) => {
    removeListenersForSession(sessionId);
    set((state) => {
      const prefix = `${sessionId}:`;
      const buffers = Object.fromEntries(
        Object.entries(state.buffers).filter(([key]) => !key.startsWith(prefix)),
      );
      return { buffers };
    });
  },

  clearAll: () => {
    for (const key of Object.keys(listeners)) {
      delete listeners[key];
    }
    set({ buffers: {} });
  },

  exportBuffers: () => get().buffers,

  hydrate: (buffers: Record<string, string>) =>
    set({
      buffers: { ...buffers },
    }),
}));
