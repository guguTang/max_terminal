import type { TerminalContextResult } from "../types/connection";

interface CachedEntry {
  cwd: string;
  result: TerminalContextResult;
}

const cache = new Map<string, CachedEntry>();

function cacheKey(sessionId: string, terminalId: string) {
  return `${sessionId}:${terminalId}`;
}

export function getTerminalContextCache(
  sessionId: string,
  terminalId: string,
  cwd?: string,
): CachedEntry | undefined {
  const entry = cache.get(cacheKey(sessionId, terminalId));
  if (!entry) return undefined;
  if (cwd !== undefined && entry.cwd !== cwd) return undefined;
  return entry;
}

export function setTerminalContextCache(
  sessionId: string,
  terminalId: string,
  cwd: string,
  result: TerminalContextResult,
) {
  cache.set(cacheKey(sessionId, terminalId), { cwd, result });
}

/** cwd 变化时清除缓存中的 git/svn 等路径相关字段，避免切目录后误恢复 */
export function stripPathScopedCache(sessionId: string, terminalId: string) {
  const key = cacheKey(sessionId, terminalId);
  const entry = cache.get(key);
  if (!entry) return;
  cache.set(key, { cwd: entry.cwd, result: stripPathScopedResult(entry.result) });
}

function stripPathScopedResult(result: TerminalContextResult): TerminalContextResult {
  return {
    ...result,
    git: undefined,
    svn: undefined,
    pyenv: undefined,
    node: undefined,
  };
}

export function clearTerminalContextCache(sessionId: string, terminalId: string) {
  cache.delete(cacheKey(sessionId, terminalId));
}

export function clearSessionContextCache(sessionId: string) {
  const prefix = `${sessionId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
