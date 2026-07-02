import { create } from "zustand";

const STORAGE_KEY = "max-terminal-terminal-titles-v1";

type TitlesByConnection = Record<string, Record<string, string>>;

interface TerminalTitleState {
  titlesByConnection: TitlesByConnection;
  getTitle: (connectionId: string, terminalId: string) => string | null;
  setTitle: (connectionId: string, terminalId: string, title: string) => void;
  removeTerminal: (connectionId: string, terminalId: string) => void;
  clearConnection: (connectionId: string) => void;
}

function loadInitialState(): TitlesByConnection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TitlesByConnection;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persist(state: TitlesByConnection) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore localStorage failures
  }
}

export const useTerminalTitleStore = create<TerminalTitleState>((set, get) => ({
  titlesByConnection: loadInitialState(),

  getTitle: (connectionId, terminalId) =>
    get().titlesByConnection[connectionId]?.[terminalId] ?? null,

  setTitle: (connectionId, terminalId, title) =>
    set((state) => {
      const trimmed = title.trim();
      const nextConnectionTitles = {
        ...(state.titlesByConnection[connectionId] ?? {}),
        [terminalId]: trimmed,
      };
      const next = {
        ...state.titlesByConnection,
        [connectionId]: nextConnectionTitles,
      };
      persist(next);
      return { titlesByConnection: next };
    }),

  removeTerminal: (connectionId, terminalId) =>
    set((state) => {
      const current = state.titlesByConnection[connectionId] ?? {};
      if (!(terminalId in current)) return state;
      const nextConnection = { ...current };
      delete nextConnection[terminalId];
      const next = {
        ...state.titlesByConnection,
        [connectionId]: nextConnection,
      };
      if (Object.keys(nextConnection).length === 0) {
        delete next[connectionId];
      }
      persist(next);
      return { titlesByConnection: next };
    }),

  clearConnection: (connectionId) =>
    set((state) => {
      const next = { ...state.titlesByConnection };
      delete next[connectionId];
      persist(next);
      return { titlesByConnection: next };
    }),
}));

