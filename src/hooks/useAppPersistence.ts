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
  dockerOpen: boolean;
  setMode: (mode: AppMode) => void;
  setTransferOpen: (open: boolean) => void;
  setDockerOpen: (open: boolean) => void;
  setLocalConsoleReady: (ready: boolean) => void;
  saveCurrentDockLayout: () => void;
  saveCurrentDockLayoutAsync?: () => Promise<void>;
  onClose?: () => void | Promise<void>;
}

export function useAppPersistence({
  mode,
  transferOpen,
  dockerOpen,
  setMode,
  setTransferOpen,
  setDockerOpen,
  setLocalConsoleReady,
  saveCurrentDockLayout,
  saveCurrentDockLayoutAsync,
  onClose,
}: UseAppPersistenceOptions) {
  const [restored, setRestored] = useState(false);
  const latestRef = useRef({
    mode,
    transferOpen,
    dockerOpen,
    saveCurrentDockLayout,
    saveCurrentDockLayoutAsync,
  });
  latestRef.current = {
    mode,
    transferOpen,
    dockerOpen,
    saveCurrentDockLayout,
    saveCurrentDockLayoutAsync,
  };

  useEffect(() => {
    void restoreAppState({
      setMode,
      setTransferOpen,
      setDockerOpen,
      setLocalConsoleReady,
    }).finally(() => {
      setRestored(true);
    });
  }, [setDockerOpen, setLocalConsoleReady, setMode, setTransferOpen]);

  useEffect(() => {
    installAppClosePersistence(() => latestRef.current, onClose);
  }, [onClose]);

  useEffect(() => {
    if (!restored) return;
    schedulePersistAppState({ mode, transferOpen, dockerOpen });
  }, [mode, transferOpen, dockerOpen, restored]);

  const sessions = useSessionStore((s) => s.sessions);
  const sshViewMode = useSessionStore((s) => s.sshViewMode);
  const connectionId = useSessionStore((s) => s.connectionId);

  useEffect(() => {
    if (!restored) return;
    schedulePersistAppState({ mode, transferOpen, dockerOpen });
  }, [sessions, sshViewMode, connectionId, mode, transferOpen, dockerOpen, restored]);

  useEffect(() => {
    if (!restored) return;
    return useTerminalOutputStore.subscribe(() => {
      schedulePersistAppState(latestRef.current);
    });
  }, [restored]);

  return { restored };
}
