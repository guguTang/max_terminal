import { useEffect, useRef, useState } from "react";
import {
  installAppClosePersistence,
  restoreAppState,
  schedulePersistAppState,
  type AppMode,
} from "../lib/appStatePersistence";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";

interface UseAppPersistenceOptions {
  mode: AppMode;
  transferOpen: boolean;
  setMode: (mode: AppMode) => void;
  setTransferOpen: (open: boolean) => void;
  setLocalConsoleReady: (ready: boolean) => void;
  saveCurrentDockLayout: () => void;
  onClose?: () => void;
}

export function useAppPersistence({
  mode,
  transferOpen,
  setMode,
  setTransferOpen,
  setLocalConsoleReady,
  saveCurrentDockLayout,
  onClose,
}: UseAppPersistenceOptions) {
  const [restored, setRestored] = useState(false);
  const latestRef = useRef({ mode, transferOpen, saveCurrentDockLayout });
  latestRef.current = { mode, transferOpen, saveCurrentDockLayout };

  useEffect(() => {
    void restoreAppState({ setMode, setTransferOpen, setLocalConsoleReady }).finally(() => {
      setRestored(true);
    });
  }, [setLocalConsoleReady, setMode, setTransferOpen]);

  useEffect(() => {
    installAppClosePersistence(() => latestRef.current, onClose);
  }, [onClose]);

  useEffect(() => {
    if (!restored) return;
    schedulePersistAppState({ mode, transferOpen });
  }, [mode, transferOpen, restored]);

  const sessions = useSessionStore((s) => s.sessions);
  const sshViewMode = useSessionStore((s) => s.sshViewMode);
  const connectionId = useSessionStore((s) => s.connectionId);

  useEffect(() => {
    if (!restored) return;
    schedulePersistAppState({ mode, transferOpen });
  }, [sessions, sshViewMode, connectionId, mode, transferOpen, restored]);

  useEffect(() => {
    if (!restored) return;
    return useTerminalOutputStore.subscribe(() => {
      schedulePersistAppState(latestRef.current);
    });
  }, [restored]);

  return { restored };
}
