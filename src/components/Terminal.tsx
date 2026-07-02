import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalCreateOptions } from "../types/connection";
import { LOCAL_SESSION_ID } from "../stores/localConsoleStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";
import {
  extractCwdFromOutput,
  TerminalInputTracker,
} from "../lib/terminalTracking";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  kind?: "ssh" | "local";
  terminalId?: string;
  sshSessionId?: string;
  initialCwd?: string;
  initialEnv?: Record<string, string>;
}

const SIZE_SYNC_DELAYS_MS = [0, 50, 150, 400, 800, 1500];

async function updateTerminalMeta(
  sessionId: string,
  terminalId: string,
  patch: {
    cwd?: string;
    env?: Record<string, string>;
    unsetEnv?: string[];
  },
) {
  await invoke("terminal_update_meta", {
    sessionId,
    terminalId,
    cwd: patch.cwd,
    env: patch.env,
    unsetEnv: patch.unsetEnv,
  });
}

async function syncPtySize(
  term: XTerm,
  fit: FitAddon,
  sessionId: string,
  terminalId: string,
  ptyReady: boolean,
) {
  fit.fit();
  const cols = term.cols;
  const rows = term.rows;
  if (!ptyReady || cols <= 0 || rows <= 0) return;
  await invoke("terminal_resize", { sessionId, cols, rows, terminalId });
}

export function Terminal({
  kind = "ssh",
  terminalId = "main",
  sshSessionId,
  initialCwd,
  initialEnv,
}: TerminalProps) {
  const isLocal = kind === "local";
  const { sessionId: activeSessionId, connected, homePath } = useSessionStore();
  const boundSessionId = isLocal ? LOCAL_SESSION_ID : (sshSessionId ?? activeSessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const initialCwdRef = useRef(initialCwd);
  const initialEnvRef = useRef(initialEnv);
  const cwdRef = useRef(initialCwdRef.current ?? homePath ?? "/");
  const homePathRef = useRef(homePath);
  const inputTrackerRef = useRef(new TerminalInputTracker());
  const ptyReadyRef = useRef(false);
  const setupGenerationRef = useRef(0);

  homePathRef.current = homePath;
  if (!cwdRef.current && homePath) {
    cwdRef.current = homePath;
  }

  const canInitialize = isLocal ? Boolean(boundSessionId) : Boolean(connected && boundSessionId);

  useEffect(() => {
    if (!containerRef.current || !canInitialize || !boundSessionId) return;

    const generation = ++setupGenerationRef.current;
    let disposed = false;
    const syncTimers: ReturnType<typeof setTimeout>[] = [];
    const isStale = () => disposed || setupGenerationRef.current !== generation;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#0a0a0f",
        foreground: "#e4e4e7",
        cursor: "#60a5fa",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    term.focus();
    fitRef.current = fit;
    termRef.current = term;

    const buffered = useTerminalOutputStore.getState().get(boundSessionId, terminalId);
    if (buffered) {
      term.write(buffered);
    }

    const handleOutput = (data: string) => {
      if (isStale()) return;

      const cwdFromOutput = extractCwdFromOutput(data);
      if (cwdFromOutput) {
        cwdRef.current = cwdFromOutput;
        useTerminalMetaStore.getState().setCwd(boundSessionId, terminalId, cwdFromOutput);
        void updateTerminalMeta(boundSessionId, terminalId, { cwd: cwdFromOutput });
      }

      term.write(data);
    };

    const unsubscribeOutput = useTerminalOutputStore
      .getState()
      .subscribe(boundSessionId, terminalId, handleOutput);

    let onDataDispose: (() => void) | null = null;
    let onResizeDispose: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;

    const scheduleSizeSync = () => {
      for (const delay of SIZE_SYNC_DELAYS_MS) {
        const timer = window.setTimeout(() => {
          if (isStale()) return;
          void syncPtySize(term, fit, boundSessionId, terminalId, ptyReadyRef.current).catch(
            console.error,
          );
        }, delay);
        syncTimers.push(timer);
      }
    };

    const handleLayoutResize = () => {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = window.setTimeout(() => {
        if (isStale()) return;
        void syncPtySize(term, fit, boundSessionId, terminalId, ptyReadyRef.current).catch(
          console.error,
        );
      }, 50);
    };

    const setup = async () => {
      const pendingInput: string[] = [];
      const resolvedHomePath = homePathRef.current;

      const flushPendingInput = () => {
        while (pendingInput.length > 0) {
          const data = pendingInput.shift();
          if (!data) continue;
          invoke("terminal_input", {
            sessionId: boundSessionId,
            data,
            terminalId,
          }).catch(console.error);
        }
      };

      onDataDispose = term.onData((data) => {
        if (isStale()) return;

        if (!ptyReadyRef.current) {
          pendingInput.push(data);
          return;
        }

        const patch = inputTrackerRef.current.consume(
          data,
          cwdRef.current,
          resolvedHomePath ?? cwdRef.current,
        );
        if (patch) {
          if (patch.cwd) {
            cwdRef.current = patch.cwd;
            useTerminalMetaStore.getState().setCwd(boundSessionId, terminalId, patch.cwd);
          }
          useTerminalMetaStore.getState().patchMeta(boundSessionId, terminalId, patch);
          void updateTerminalMeta(boundSessionId, terminalId, patch);
        }
        invoke("terminal_input", {
          sessionId: boundSessionId,
          data,
          terminalId,
        }).catch(console.error);
      }).dispose;

      try {
        if (isStale()) return;
        fit.fit();

        const createInitialCwd = initialCwdRef.current;
        const createInitialEnv = initialEnvRef.current;
        const hasCloneState =
          Boolean(createInitialCwd) ||
          Boolean(createInitialEnv && Object.keys(createInitialEnv).length > 0);

        const options: TerminalCreateOptions = {
          cols: term.cols,
          rows: term.rows,
          ...(hasCloneState ? { initialCwd: createInitialCwd, initialEnv: createInitialEnv } : {}),
        };

        await invoke("terminal_create", {
          sessionId: boundSessionId,
          terminalId,
          options,
        });
        if (isStale()) return;

        ptyReadyRef.current = true;
        flushPendingInput();
        await syncPtySize(term, fit, boundSessionId, terminalId, true);
        if (isStale()) return;
        scheduleSizeSync();

        if (hasCloneState && createInitialCwd) {
          cwdRef.current = createInitialCwd;
          useTerminalMetaStore.getState().setCwd(boundSessionId, terminalId, createInitialCwd);
        } else if (!isLocal) {
          const cwd = createInitialCwd ?? resolvedHomePath;
          if (cwd) {
            cwdRef.current = cwd;
            useTerminalMetaStore.getState().setCwd(boundSessionId, terminalId, cwd);
            if (!createInitialCwd) {
              await updateTerminalMeta(boundSessionId, terminalId, { cwd });
              if (isStale()) return;
            }
          }
        }

        if (isStale()) return;

        onResizeDispose = term.onResize(({ cols, rows }) => {
          if (!ptyReadyRef.current || cols <= 0 || rows <= 0) return;
          invoke("terminal_resize", {
            sessionId: boundSessionId,
            cols,
            rows,
            terminalId,
          }).catch(console.error);
        }).dispose;

        term.focus();
      } catch (e) {
        if (!isStale()) {
          term.writeln(`\r\n\x1b[31m终端初始化失败: ${e}\x1b[0m`);
        }
      }
    };

    void setup();

    resizeObserver = new ResizeObserver(handleLayoutResize);
    resizeObserver.observe(containerRef.current);
    window.addEventListener("resize", handleLayoutResize);

    return () => {
      disposed = true;
      ptyReadyRef.current = false;
      unsubscribeOutput();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      for (const timer of syncTimers) clearTimeout(timer);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleLayoutResize);
      onResizeDispose?.();
      onDataDispose?.();
      term.dispose();
      fitRef.current = null;
      termRef.current = null;
      // PTY 生命周期由「关闭终端标签」与「断开连接」管理，切换模式时仅卸载 xterm 视图。
    };
  }, [boundSessionId, canInitialize, isLocal, terminalId]);

  if (!canInitialize || !boundSessionId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-zinc-500 bg-zinc-950">
        {isLocal ? "正在启动本机终端…" : "连接后显示终端"}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="terminal-host h-full w-full min-h-0 overflow-hidden bg-zinc-950"
      onClick={() => termRef.current?.focus()}
    />
  );
}
