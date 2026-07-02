export interface TerminalMeta {
  cwd: string;
  env: Record<string, string>;
}

const OSC7_RE = /\x1b\]7;file:\/\/[^/\]]*([^\x1b\x07]+)(?:\x1b\\|\x07)/g;

export function extractCwdFromOutput(data: string): string | null {
  let latest: string | null = null;
  for (const match of data.matchAll(OSC7_RE)) {
    const raw = match[1];
    if (!raw) continue;
    try {
      latest = decodeURIComponent(raw);
    } catch {
      latest = raw;
    }
  }
  return latest;
}

function normalizePath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return `/${parts.join("/")}` || "/";
}

export function resolveCdTarget(currentCwd: string, homePath: string, raw: string) {
  const target = raw.trim().replace(/;+\s*$/, "");
  if (!target || target === "~") return homePath;
  if (target === "-") return currentCwd;
  if (target.startsWith("~/")) return normalizePath(`${homePath}/${target.slice(2)}`);
  if (target.startsWith("/")) return normalizePath(target);
  return normalizePath(`${currentCwd.replace(/\/$/, "")}/${target}`);
}

function mergePatch(
  base: { cwd?: string; env?: Record<string, string>; unsetEnv?: string[] },
  next: { cwd?: string; env?: Record<string, string>; unsetEnv?: string[] },
) {
  const env = { ...(base.env ?? {}) };
  if (next.env) {
    for (const [key, value] of Object.entries(next.env)) {
      env[key] = value;
    }
  }

  return {
    cwd: next.cwd ?? base.cwd,
    env: Object.keys(env).length > 0 ? env : undefined,
    unsetEnv: next.unsetEnv ? [...(base.unsetEnv ?? []), ...next.unsetEnv] : base.unsetEnv,
  };
}

export class TerminalInputTracker {
  private line = "";

  consume(
    data: string,
    currentCwd: string,
    homePath: string,
  ): { cwd?: string; env?: Record<string, string>; unsetEnv?: string[] } | null {
    let patch: { cwd?: string; env?: Record<string, string>; unsetEnv?: string[] } | null =
      null;

    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const result = this.parseLine(this.line, currentCwd, homePath);
        if (result) {
          patch = patch ? mergePatch(patch, result) : result;
        }
        this.line = "";
        continue;
      }

      if (ch === "\u007f") {
        this.line = this.line.slice(0, -1);
        continue;
      }

      if (ch === "\u0003") {
        this.line = "";
        continue;
      }

      if (ch >= " " || ch === "\t") {
        this.line += ch;
      }
    }

    return patch;
  }

  private parseLine(
    line: string,
    currentCwd: string,
    homePath: string,
  ): { cwd?: string; env?: Record<string, string>; unsetEnv?: string[] } | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const cdMatch = trimmed.match(/^cd(?:\s+--)?(?:\s+(.*))?$/);
    if (cdMatch) {
      const arg = (cdMatch[1] ?? "").trim();
      const unquoted = arg.replace(/^['"](.*)['"]$/, "$1");
      return { cwd: resolveCdTarget(currentCwd, homePath, unquoted) };
    }

    const exportMatch = trimmed.match(
      /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/,
    );
    if (exportMatch) {
      const [, key, rawValue] = exportMatch;
      const value = rawValue.replace(/^['"](.*)['"]$/, "$1");
      return { env: { [key]: value } };
    }

    const unsetMatch = trimmed.match(/^unset\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    if (unsetMatch) {
      return { unsetEnv: [unsetMatch[1]] };
    }

    return null;
  }
}
