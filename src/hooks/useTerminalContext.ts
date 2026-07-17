import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getTerminalContextCache,
  setTerminalContextCache,
  stripPathScopedCache,
} from "../lib/terminalContextCache";
import { ctxLog } from "../lib/terminalContextDebug";
import { sanitizeVersionLabel } from "../lib/terminalSanitize";
import { trackedPathsEqual, normalizeTrackedCwdPath } from "../lib/terminalTracking";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import type { TerminalContextResult } from "../types/connection";

const FULL_PROVIDERS = ["git", "svn", "k8s", "pyenv", "node", "docker"] as const;
const GIT_DIRTY_PROVIDERS = ["git_dirty"] as const;
const GIT_DIRTY_POLL_MS = 15_000;
const GIT_DIRTY_DEBOUNCE_MS = 600;
const CONTEXT_FETCH_DEBOUNCE_MS = 200;

function metaKey(sessionId: string, terminalId: string) {
  return `${sessionId}:${terminalId}`;
}

function readCwd(
  sessionId: string,
  terminalId: string,
  liveCwd?: string,
): string | undefined {
  const trimmedLive = liveCwd?.trim();
  const raw = trimmedLive
    ? trimmedLive
    : useTerminalMetaStore.getState().metaByKey[metaKey(sessionId, terminalId)]?.cwd;
  if (!raw) return undefined;
  return normalizeTrackedCwdPath(raw);
}

function stripPathScopedFields(result: TerminalContextResult): TerminalContextResult {
  return {
    ...result,
    git: undefined,
    svn: undefined,
    pyenv: undefined,
    node: undefined,
  };
}

export function shortenCwd(cwd: string, homePath?: string | null): string {
  if (!cwd) return "~";
  if (homePath && cwd.startsWith(homePath)) {
    const rest = cwd.slice(homePath.length);
    return rest ? `~${rest}` : "~";
  }
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd.startsWith("/") ? `/${parts.join("/")}` : cwd;
  return `…/${parts.slice(-2).join("/")}`;
}

export function venvDisplayName(virtualEnv: string): string {
  const parts = virtualEnv.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? virtualEnv;
}

export function useTerminalContext(
  sessionId: string | null | undefined,
  terminalId: string,
  enabled: boolean,
  liveCwd?: string,
  kind: "local" | "ssh" = "ssh",
) {
  const meta = useTerminalMetaStore((s) =>
    sessionId ? s.metaByKey[metaKey(sessionId, terminalId)] : undefined,
  );
  const effectiveCwd = normalizeTrackedCwdPath(liveCwd?.trim() || meta?.cwd || "");
  const [remote, setRemote] = useState<TerminalContextResult>({});
  const [remoteCwd, setRemoteCwd] = useState<string | null>(null);
  const [gitSnapshot, setGitSnapshot] = useState<{ cwd: string; branch: string } | null>(null);
  const requestGenRef = useRef(0);
  const prevEffectiveCwdRef = useRef(effectiveCwd);
  const liveCwdRef = useRef(liveCwd);
  const gitDirtyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  liveCwdRef.current = liveCwd;

  useEffect(() => {
    if (!sessionId) {
      setRemote({});
      setRemoteCwd(null);
      setGitSnapshot(null);
      prevEffectiveCwdRef.current = "";
      return;
    }
    const cwdHint = liveCwdRef.current?.trim();
    const cached = getTerminalContextCache(sessionId, terminalId, cwdHint || undefined);
    if (cached?.result.git?.branch && trackedPathsEqual(cached.cwd, cwdHint ?? cached.cwd)) {
      setRemote(cached.result);
      setRemoteCwd(cached.cwd);
      setGitSnapshot({ cwd: cached.cwd, branch: cached.result.git.branch });
      ctxLog("cache", "restore with git", {
        terminalId,
        cwd: cached.cwd,
        branch: cached.result.git.branch,
      });
    } else if (cached) {
      setRemote(cached.result);
      setRemoteCwd(cached.cwd);
      setGitSnapshot(null);
      ctxLog("cache", "restore without git", { terminalId, cwd: cached.cwd });
    } else {
      setRemote({});
      setRemoteCwd(null);
      setGitSnapshot(null);
    }
    prevEffectiveCwdRef.current = "";
  }, [sessionId, terminalId]);

  useEffect(() => {
    if (!effectiveCwd) return;
    if (prevEffectiveCwdRef.current === effectiveCwd) return;
    const from = prevEffectiveCwdRef.current;
    prevEffectiveCwdRef.current = effectiveCwd;

    ctxLog("cwd", "effective cwd changed", {
      terminalId,
      from: from || "(empty)",
      to: effectiveCwd,
    });

    if (gitDirtyTimerRef.current) {
      clearTimeout(gitDirtyTimerRef.current);
      gitDirtyTimerRef.current = null;
    }
    requestGenRef.current += 1;

    setRemote((prev) => stripPathScopedFields(prev));
    setRemoteCwd(null);
    setGitSnapshot(null);
    if (sessionId) {
      stripPathScopedCache(sessionId, terminalId);
    }
  }, [effectiveCwd, sessionId, terminalId]);

  const scheduleGitDirty = useCallback(() => {
    if (gitDirtyTimerRef.current) clearTimeout(gitDirtyTimerRef.current);
    gitDirtyTimerRef.current = setTimeout(() => {
      gitDirtyTimerRef.current = null;
      void fetchRemoteRef.current?.(GIT_DIRTY_PROVIDERS);
    }, GIT_DIRTY_DEBOUNCE_MS);
  }, []);

  const fetchRemoteRef = useRef<
    ((providers?: readonly string[]) => Promise<void>) | null
  >(null);

  const fetchRemote = useCallback(
    async (providers: readonly string[] = FULL_PROVIDERS) => {
      if (!sessionId || !enabled) return;
      const cwd = readCwd(sessionId, terminalId, liveCwdRef.current);
      if (!cwd) return;

      const gen = ++requestGenRef.current;
      const cwdAtRequest = cwd;
      const providerLabel = providers.join(",");

      ctxLog("fetch", "start", {
        terminalId,
        gen,
        cwd: cwdAtRequest,
        providers: providerLabel,
      });

      try {
        const result = await invoke<TerminalContextResult>("terminal_query_context", {
          sessionId,
          cwd: cwdAtRequest,
          env:
            useTerminalMetaStore.getState().metaByKey[metaKey(sessionId, terminalId)]?.env ?? {},
          providers: [...providers],
        });

        const cwdNow = readCwd(sessionId, terminalId, liveCwdRef.current);
        const isGitDirtyOnly =
          providers.length === 1 && providers[0] === "git_dirty";

        if (gen !== requestGenRef.current) {
          ctxLog("fetch", "drop stale gen", {
            terminalId,
            gen,
            currentGen: requestGenRef.current,
            providers: providerLabel,
          });
          return;
        }
        if (cwdNow && !trackedPathsEqual(cwdNow, cwdAtRequest)) {
          ctxLog("fetch", "drop cwd moved", {
            terminalId,
            cwdAtRequest,
            cwdNow,
            providers: providerLabel,
          });
          return;
        }
        if (!cwdNow) return;

        setRemoteCwd(cwdAtRequest);
        setRemote((prev) => {
          if (isGitDirtyOnly) {
            const dirty = result.git?.dirtyCount ?? 0;
            if (!prev.git?.branch) return prev;
            // dirty 轮询必须绑定当前目录；cwd 未变时 prev 可能仍是上一仓库的快照
            if (!trackedPathsEqual(cwdAtRequest, cwdNow)) return prev;
            return {
              ...prev,
              git: { branch: prev.git.branch, dirtyCount: dirty },
            };
          }
          return result;
        });

        if (!isGitDirtyOnly) {
          const snapshotCwd = cwdAtRequest;
          const snapshotBranch = result.git?.branch;
          if (snapshotBranch) {
            setGitSnapshot({ cwd: snapshotCwd, branch: snapshotBranch });
            ctxLog("git", "snapshot set", {
              terminalId,
              cwd: snapshotCwd,
              branch: snapshotBranch,
              dirty: result.git?.dirtyCount,
            });
          } else {
            setGitSnapshot(null);
            ctxLog("git", "snapshot cleared (no repo)", {
              terminalId,
              cwd: snapshotCwd,
            });
          }
          setTerminalContextCache(sessionId, terminalId, cwdAtRequest, result);
          if (result.git?.branch) {
            scheduleGitDirty();
          }
        } else {
          ctxLog("git", "dirty updated", {
            terminalId,
            cwd: cwdAtRequest,
            dirty: result.git?.dirtyCount ?? 0,
          });
        }
      } catch (e) {
        ctxLog("fetch", "error", {
          terminalId,
          cwd: cwdAtRequest,
          error: String(e),
        });
        console.warn("terminal_query_context failed:", e, { sessionId, cwd: cwdAtRequest });
      }
    },
    [sessionId, terminalId, enabled, scheduleGitDirty],
  );

  fetchRemoteRef.current = fetchRemote;

  useEffect(() => {
    if (!sessionId || !enabled || !effectiveCwd) return;
    if (contextFetchTimerRef.current) clearTimeout(contextFetchTimerRef.current);
    contextFetchTimerRef.current = setTimeout(() => {
      contextFetchTimerRef.current = null;
      void fetchRemote(FULL_PROVIDERS);
    }, CONTEXT_FETCH_DEBOUNCE_MS);
    return () => {
      if (contextFetchTimerRef.current) {
        clearTimeout(contextFetchTimerRef.current);
        contextFetchTimerRef.current = null;
      }
    };
  }, [sessionId, terminalId, enabled, effectiveCwd, fetchRemote]);

  useEffect(
    () => () => {
      if (gitDirtyTimerRef.current) clearTimeout(gitDirtyTimerRef.current);
      if (contextFetchTimerRef.current) clearTimeout(contextFetchTimerRef.current);
    },
    [],
  );

  const gitBranch =
    gitSnapshot && trackedPathsEqual(gitSnapshot.cwd, effectiveCwd)
      ? gitSnapshot.branch
      : undefined;

  useEffect(() => {
    if (!sessionId || !enabled || !effectiveCwd || !gitBranch) return;

    const timer = window.setInterval(() => {
      scheduleGitDirty();
    }, GIT_DIRTY_POLL_MS);

    return () => clearInterval(timer);
  }, [sessionId, enabled, effectiveCwd, gitBranch, scheduleGitDirty]);

  const scopedRemote = useMemo((): TerminalContextResult => {
    if (remoteCwd && trackedPathsEqual(remoteCwd, effectiveCwd)) return remote;
    return stripPathScopedFields(remote);
  }, [remote, remoteCwd, effectiveCwd]);

  const env = meta?.env ?? {};
  const condaEnv = env.CONDA_DEFAULT_ENV?.trim() || null;
  const virtualEnv = env.VIRTUAL_ENV?.trim() || null;
  const pyenvFromEnv = env.PYENV_VERSION?.trim() || null;
  const dockerFromEnv = env.MX_DOCKER_CONTAINER?.trim() || null;
  const dockerIdFromEnv = env.MX_DOCKER_ID?.trim() || null;
  const nodeVersion =
    sanitizeVersionLabel(env.NVM_ACTIVE_VERSION) ??
    sanitizeVersionLabel(scopedRemote.node?.version) ??
    null;

  const docker =
    dockerFromEnv
      ? { name: dockerFromEnv, id: dockerIdFromEnv ?? undefined }
      : scopedRemote.docker;

  const git =
    gitBranch != null && gitBranch !== ""
      ? {
          branch: gitBranch,
          dirtyCount:
            remoteCwd && trackedPathsEqual(remoteCwd, effectiveCwd)
              ? (scopedRemote.git?.dirtyCount ?? 0)
              : 0,
        }
      : undefined;

  return {
    cwd: effectiveCwd,
    condaEnv,
    virtualEnv,
    pyenvFromEnv,
    nodeVersion,
    docker,
    remote: scopedRemote,
    git,
    refreshContext: () => fetchRemote(FULL_PROVIDERS),
    kind,
  };
}
