import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalCreateOptions } from "../types/connection";
import { LOCAL_SESSION_ID } from "../stores/localConsoleStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";
import { ctxLog } from "../lib/terminalContextDebug";
import {
  Osc7CwdParser,
  PrecmdMetaParser,
  shouldAcceptCwdUpdate,
  stripOsc7799,
  TerminalInputTracker,
  normalizeTrackedCwdPath,
  verifyRemotePathExists,
} from "../lib/terminalTracking";
import { WARP_DARK_THEME } from "../lib/terminalTheme";
import { TerminalContextBar } from "./TerminalContextBar";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  kind?: "ssh" | "local";
  terminalId?: string;
  sshSessionId?: string;
  /** 该终端所属连接的远程 home，禁止用全局 activeSession 的 homePath */
  connectionHomePath?: string | null;
  initialCwd?: string;
  initialEnv?: Record<string, string>;
  /** 来自工作区快照的路径，恢复时跳过 SFTP 存在性校验（避免刚连上时误丢弃） */
  trustInitialCwd?: boolean;
}

const SIZE_SYNC_DELAYS_MS = [150];

const lastPtySizeByKey: Record<string, { cols: number; rows: number }> = {};

function sendPtyResize(
  sessionId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (cols <= 0 || rows <= 0) return Promise.resolve();
  const key = `${sessionId}:${terminalId}`;
  const last = lastPtySizeByKey[key];
  if (last?.cols === cols && last?.rows === rows) return Promise.resolve();
  lastPtySizeByKey[key] = { cols, rows };
  return invoke("terminal_resize", { sessionId, cols, rows, terminalId });
}

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
  await sendPtyResize(sessionId, terminalId, cols, rows);
}

export function Terminal({
  kind = "ssh",
  terminalId = "main",
  sshSessionId,
  connectionHomePath,
  initialCwd,
  initialEnv,
  trustInitialCwd = false,
}: TerminalProps) {
  const isLocal = kind === "local";
  const { connected } = useSessionStore();
  const boundSessionId = isLocal ? LOCAL_SESSION_ID : (sshSessionId ?? null);
  const resolvedHomePath = isLocal ? null : (connectionHomePath ?? null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const initialCwdRef = useRef(initialCwd);
  const initialEnvRef = useRef(initialEnv);
  const cwdRef = useRef(initialCwdRef.current ?? resolvedHomePath ?? "/");
  const homePathRef = useRef(resolvedHomePath);
  const inputTrackerRef = useRef(new TerminalInputTracker());
  const oscParserRef = useRef(new Osc7CwdParser());
  const precmdParserRef = useRef(new PrecmdMetaParser());
  const ptyReadyRef = useRef(false);
  const setupGenerationRef = useRef(0);
  const [liveCwd, setLiveCwd] = useState(
    () => initialCwd ?? resolvedHomePath ?? "",
  );

  homePathRef.current = resolvedHomePath;
  initialCwdRef.current = initialCwd ?? initialCwdRef.current;
  initialEnvRef.current = initialEnv ?? initialEnvRef.current;
  if (!cwdRef.current && resolvedHomePath) {
    cwdRef.current = resolvedHomePath;
  }

  const canInitialize = isLocal
    ? Boolean(boundSessionId)
    : Boolean(connected && boundSessionId && sshSessionId);

  useEffect(() => {
    const seed = initialCwd ?? resolvedHomePath ?? "";
    cwdRef.current = seed || cwdRef.current;
    setLiveCwd(seed);
  }, [boundSessionId, terminalId, initialCwd, resolvedHomePath]);

  useEffect(() => {
    if (!containerRef.current || !canInitialize || !boundSessionId) return;

    const generation = ++setupGenerationRef.current;
    let disposed = false;
    const syncTimers: ReturnType<typeof setTimeout>[] = [];
    const isStale = () => disposed || setupGenerationRef.current !== generation;

    inputTrackerRef.current = new TerminalInputTracker();
    oscParserRef.current.reset();
    precmdParserRef.current.reset();

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: WARP_DARK_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    term.focus();
    fitRef.current = fit;
    termRef.current = term;

    const outputStore = useTerminalOutputStore.getState();
    let metaSyncTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleEnvSync = (patch: {
      env?: Record<string, string>;
      unsetEnv?: string[];
    }) => {
      if (metaSyncTimer) clearTimeout(metaSyncTimer);
      metaSyncTimer = setTimeout(() => {
        void updateTerminalMeta(boundSessionId, terminalId, patch);
      }, 2000);
    };

    const applyCwd = (cwd: string, source: "osc7" | "input" | "init", syncMeta = true) => {
      const normalized = normalizeTrackedCwdPath(cwd);
      if (!shouldAcceptCwdUpdate(normalized, cwdRef.current)) {
        ctxLog("cwd", "apply rejected (truncation)", {
          terminalId,
          source,
          next: normalized,
          previous: cwdRef.current,
          raw: cwd,
        });
        return;
      }
      const previous = cwdRef.current;
      cwdRef.current = normalized;
      setLiveCwd(normalized);
      ctxLog("cwd", "apply", {
        terminalId,
        source,
        from: previous,
        to: normalized,
        raw: cwd !== normalized ? cwd : undefined,
      });
      if (!syncMeta) return;
      useTerminalMetaStore.getState().setCwd(boundSessionId, terminalId, normalized);
      void updateTerminalMeta(boundSessionId, terminalId, { cwd: normalized });
    };

    const applyOsc7Cwd = (cwd: string) => {
      applyCwd(cwd, "osc7");
    };

    const applyEnvPatch = (patch: {
      env?: Record<string, string>;
      unsetEnv?: string[];
    }) => {
      if (!patch.env && !patch.unsetEnv?.length) return;
      const key = `${boundSessionId}:${terminalId}`;
      const current = useTerminalMetaStore.getState().metaByKey[key];
      if (patch.env) {
        const envUnchanged = Object.entries(patch.env).every(
          ([k, v]) => current?.env?.[k] === v,
        );
        const unsetRedundant =
          !patch.unsetEnv?.length ||
          patch.unsetEnv.every((k) => current?.env?.[k] === undefined);
        if (envUnchanged && unsetRedundant) return;
      }
      useTerminalMetaStore.getState().patchMeta(boundSessionId, terminalId, patch);
      scheduleEnvSync(patch);
      void updateTerminalMeta(boundSessionId, terminalId, patch);
    };

    const handleOutput = (data: string) => {
      if (isStale()) return;

      const cwdFromOutput = oscParserRef.current.feed(data);
      if (cwdFromOutput) {
        applyOsc7Cwd(cwdFromOutput);
      }

      const precmdMeta = precmdParserRef.current.feed(data);
      if (precmdMeta?.env || precmdMeta?.unsetEnv?.length) {
        applyEnvPatch(precmdMeta);
      }

      term.write(stripOsc7799(data));
      outputStore.ackDisplayed(boundSessionId, terminalId, data.length);
    };

    const unsubscribeOutput = outputStore.subscribe(
      boundSessionId,
      terminalId,
      handleOutput,
    );

    const undisplayed = outputStore.takeUndisplayedOutput(boundSessionId, terminalId);
    if (undisplayed) {
      const cwdFromReplay = oscParserRef.current.feed(undisplayed);
      if (cwdFromReplay) {
        applyOsc7Cwd(cwdFromReplay);
      }
      const precmdFromReplay = precmdParserRef.current.feed(undisplayed);
      if (precmdFromReplay?.env || precmdFromReplay?.unsetEnv?.length) {
        applyEnvPatch(precmdFromReplay);
      }
      term.write(stripOsc7799(undisplayed));
    }

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
        const homeForTracking = resolvedHomePath ?? cwdRef.current;
        while (pendingInput.length > 0) {
          const data = pendingInput.shift();
          if (!data) continue;
          const patch = inputTrackerRef.current.consume(
            data,
            cwdRef.current,
            homeForTracking,
          );
          if (patch) {
            applyEnvPatch(patch);
          }
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
          applyEnvPatch(patch);
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

        const createInitialCwdRaw =
          initialCwdRef.current &&
          (!resolvedHomePath || initialCwdRef.current !== resolvedHomePath)
            ? initialCwdRef.current
            : undefined;
        let createInitialCwd = createInitialCwdRaw;
        if (createInitialCwd && !isLocal && !trustInitialCwd) {
          const exists = await verifyRemotePathExists(boundSessionId, createInitialCwd);
          if (!exists) {
            createInitialCwd = undefined;
          }
        }
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

        try {
          const meta = await invoke<{ cwd: string; env: Record<string, string> }>(
            "terminal_get_meta",
            { sessionId: boundSessionId, terminalId },
          );
          if (meta.cwd) {
            cwdRef.current = meta.cwd;
            setLiveCwd(meta.cwd);
            useTerminalMetaStore.getState().setCwd(boundSessionId, terminalId, meta.cwd);
          }
          if (meta.env && Object.keys(meta.env).length > 0) {
            useTerminalMetaStore.getState().patchMeta(boundSessionId, terminalId, {
              env: meta.env,
            });
          }
        } catch {
          // meta sync optional
        }

        ptyReadyRef.current = true;
        flushPendingInput();
        await syncPtySize(term, fit, boundSessionId, terminalId, true);
        if (isStale()) return;
        scheduleSizeSync();

        if (hasCloneState && createInitialCwd) {
          cwdRef.current = createInitialCwd;
          setLiveCwd(createInitialCwd);
          useTerminalMetaStore.getState().setCwd(boundSessionId, terminalId, createInitialCwd);
        } else if (!isLocal && createInitialCwd) {
          cwdRef.current = createInitialCwd;
          setLiveCwd(createInitialCwd);
          useTerminalMetaStore.getState().setCwd(boundSessionId, terminalId, createInitialCwd);
          await updateTerminalMeta(boundSessionId, terminalId, { cwd: createInitialCwd });
          if (isStale()) return;
        }

        if (isStale()) return;

        onResizeDispose = term.onResize(({ cols, rows }) => {
          if (!ptyReadyRef.current) return;
          sendPtyResize(boundSessionId, terminalId, cols, rows).catch(console.error);
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
      oscParserRef.current.reset();
      precmdParserRef.current.reset();
      outputStore.resetDisplayedLength(boundSessionId, terminalId);
      unsubscribeOutput();
      if (resizeDebounce) clearTimeout(resizeDebounce);
      if (metaSyncTimer) clearTimeout(metaSyncTimer);
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
  }, [boundSessionId, canInitialize, isLocal, terminalId, trustInitialCwd]);

  if (!canInitialize || !boundSessionId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-zinc-500 bg-zinc-950">
        {isLocal ? "正在启动本机终端…" : "连接后显示终端"}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950">
      <TerminalContextBar
        sessionId={boundSessionId}
        terminalId={terminalId}
        kind={isLocal ? "local" : "ssh"}
        homePath={resolvedHomePath}
        liveCwd={liveCwd}
      />
      <div
        ref={containerRef}
        className="terminal-host min-h-0 flex-1 w-full overflow-hidden"
        onClick={() => termRef.current?.focus()}
      />
    </div>
  );
}
