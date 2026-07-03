import { create } from "zustand";

const MAX_BUFFER_CHARS = 512_000;

type OutputListener = (data: string) => void;

function bufferKey(sessionId: string, terminalId: string) {
  return `${sessionId}:${terminalId}`;
}

const listeners: Record<string, Set<OutputListener>> = {};

/** 已写入 xterm 的缓冲偏移，避免切换/StrictMode 重挂载时整段回放导致提示符重复 */
const displayedLengthByKey: Record<string, number> = {};

function resetDisplayedLength(sessionId: string, terminalId?: string) {
  if (terminalId) {
    delete displayedLengthByKey[bufferKey(sessionId, terminalId)];
    return;
  }
  const prefix = `${sessionId}:`;
  for (const key of Object.keys(displayedLengthByKey)) {
    if (key.startsWith(prefix)) delete displayedLengthByKey[key];
  }
}

function resetAllDisplayedLengths() {
  for (const key of Object.keys(displayedLengthByKey)) {
    delete displayedLengthByKey[key];
  }
}

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
  /** 取尚未显示在 xterm 上的输出增量（切换连接后 remount 用） */
  takeUndisplayedOutput: (sessionId: string, terminalId: string) => string;
  /** 订阅流式输出写入 xterm 后推进显示偏移 */
  ackDisplayed: (sessionId: string, terminalId: string, charCount: number) => void;
  /** xterm 卸载后重置偏移，下次挂载向新实例回放完整缓冲 */
  resetDisplayedLength: (sessionId: string, terminalId: string) => void;
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
      delete displayedLengthByKey[key];
      const buffers = { ...state.buffers };
      delete buffers[key];
      return { buffers };
    }),

  clearSession: (sessionId) => {
    removeListenersForSession(sessionId);
    resetDisplayedLength(sessionId);
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
    resetAllDisplayedLengths();
    set({ buffers: {} });
  },

  exportBuffers: () => get().buffers,

  hydrate: (buffers: Record<string, string>) => {
    resetAllDisplayedLengths();
    set({
      buffers: { ...buffers },
    });
  },

  takeUndisplayedOutput: (sessionId, terminalId) => {
    const key = bufferKey(sessionId, terminalId);
    const full = get().buffers[key] ?? "";
    let displayed = displayedLengthByKey[key] ?? 0;
    if (full.length < displayed) {
      displayed = 0;
    }
    const delta = full.slice(displayed);
    displayedLengthByKey[key] = full.length;
    return delta;
  },

  ackDisplayed: (sessionId, terminalId, charCount) => {
    if (charCount <= 0) return;
    const key = bufferKey(sessionId, terminalId);
    const fullLen = get().buffers[key]?.length ?? 0;
    const next = (displayedLengthByKey[key] ?? 0) + charCount;
    displayedLengthByKey[key] = Math.min(fullLen, next);
  },

  resetDisplayedLength: (sessionId, terminalId) => {
    delete displayedLengthByKey[bufferKey(sessionId, terminalId)];
  },
}));
