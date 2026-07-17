import { invoke } from "@tauri-apps/api/core";
import { sanitizeVersionLabel, stripTerminalEscapes } from "./terminalSanitize";

const OSC7_COMPLETE_RE =
  /\x1b\]7;file:\/\/[^/\]]*([^\x1b\x07]+)(?:\x1b\\|\x07)/g;

/** Warp 风格 precmd 元数据：conda/venv/py/node/git 来自 PTY 真实环境 */
const OSC7799_COMPLETE_RE =
  /\x1b\]7799;([^\x1b\x07]*)(?:\x1b\\|\x07)/g;

export interface PrecmdMetaPatch {
  env?: Record<string, string>;
  unsetEnv?: string[];
  precmdGitBranch?: string | null;
  precmdCwd?: string;
}

/** 从 xterm 显示数据中剥离 OSC7799（解析后调用） */
export function stripOsc7799(data: string): string {
  return data.replace(OSC7799_COMPLETE_RE, "");
}

/** Printed on its own line after `docker exec` returns; clears sticky docker chip. */
export const MX_DOCKER_LEAVE_MARKER = "__MX_DOCKER_LEAVE__";

/**
 * Detect leave marker as a standalone output line (not mid-line command echo).
 * Returns display data with the marker line removed.
 */
export function consumeDockerLeaveMarker(data: string): {
  cleaned: string;
  left: boolean;
} {
  let left = false;
  const cleaned = data.replace(
    /(^|\r?\n)([ \t]*__MX_DOCKER_LEAVE__[ \t]*)(?=\r?\n|$)/g,
    (_match, lead: string) => {
      left = true;
      return lead;
    },
  );
  return { cleaned, left };
}

function parsePrecmdMetaBody(body: string): PrecmdMetaPatch {
  const env: Record<string, string> = {};
  const unsetEnv: string[] = [];
  let precmdGitBranch: string | null | undefined;

  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    switch (key) {
      case "conda":
        if (value) env.CONDA_DEFAULT_ENV = value;
        else unsetEnv.push("CONDA_DEFAULT_ENV", "CONDA_PREFIX");
        break;
      case "venv":
        if (value) env.VIRTUAL_ENV = value;
        else unsetEnv.push("VIRTUAL_ENV");
        break;
      case "py":
        if (value) env.PYENV_VERSION = value;
        else unsetEnv.push("PYENV_VERSION");
        break;
      case "node": {
        const node = sanitizeVersionLabel(value);
        if (node) env.NVM_ACTIVE_VERSION = node;
        else unsetEnv.push("NVM_ACTIVE_VERSION");
        break;
      }
      case "git":
        precmdGitBranch = value || null;
        break;
      case "docker":
        // Enter via panel sets MX_DOCKER_*; leave emits docker= to clear the chip.
        if (value) {
          const [name, id] = value.split(",", 2);
          if (name) env.MX_DOCKER_CONTAINER = name;
          if (id) env.MX_DOCKER_ID = id;
        } else {
          unsetEnv.push("MX_DOCKER_CONTAINER", "MX_DOCKER_ID");
        }
        break;
      default:
        break;
    }
  }

  const patch: PrecmdMetaPatch = {};
  if (Object.keys(env).length > 0) patch.env = env;
  if (unsetEnv.length > 0) patch.unsetEnv = unsetEnv;
  if (precmdGitBranch !== undefined) patch.precmdGitBranch = precmdGitBranch;
  return patch;
}

/** 跨 PTY 输出块累积 OSC7799 precmd 元数据 */
export class PrecmdMetaParser {
  private buffer = "";

  feed(data: string): PrecmdMetaPatch | null {
    this.buffer += data;

    let latest: PrecmdMetaPatch | null = null;
    let consumedThrough = 0;

    for (const match of this.buffer.matchAll(OSC7799_COMPLETE_RE)) {
      const body = match[1];
      if (body === undefined) continue;
      latest = parsePrecmdMetaBody(body);
      consumedThrough = (match.index ?? 0) + match[0].length;
    }

    if (consumedThrough > 0) {
      this.buffer = this.buffer.slice(consumedThrough);
    } else if (this.buffer.length > 8192) {
      const lastEsc = this.buffer.lastIndexOf("\x1b");
      this.buffer = lastEsc >= 0 ? this.buffer.slice(lastEsc) : "";
    }

    return latest;
  }

  reset() {
    this.buffer = "";
  }
}

export function isValidTrackedCwdPath(path?: string) {
  if (!path) return false;
  const trimmed = path.trim();
  if (
    !trimmed ||
    trimmed.includes("$") ||
    trimmed.includes('"') ||
    trimmed.includes("`") ||
    /\s/.test(trimmed)
  ) {
    return false;
  }
  if (!trimmed.startsWith("/") && !trimmed.startsWith("~")) return false;
  return true;
}

/** 远程目录是否可访问（用于恢复/持久化前校验） */
export async function verifyRemotePathExists(sessionId: string, path: string) {
  if (!isValidTrackedCwdPath(path)) return false;
  try {
    await invoke("sftp_list_dir", { sessionId, path });
    return true;
  } catch {
    return false;
  }
}

/** 新路径是否为旧路径的目录祖先（cd .. / cd ../.. 等合法上移） */
function isDirectoryAncestor(ancestor: string, descendant: string) {
  const a = normalizeTrackedCwdPath(ancestor);
  const d = normalizeTrackedCwdPath(descendant);
  if (a === d) return false;
  if (a === "/") return d.startsWith("/") && d !== "/";
  return d === a || d.startsWith(`${a}/`);
}

/**
 * 拒绝流式 OSC7 / 输入截断产生的「假短路径」（如 enigma → …/en），
 * 但允许 cd .. 等进入真实父目录。
 */
export function shouldAcceptCwdUpdate(next: string, previous: string | null | undefined) {
  const normalized = normalizeTrackedCwdPath(next);
  if (!isValidTrackedCwdPath(normalized)) return false;
  if (!previous || trackedPathsEqual(normalized, previous)) {
    return !previous || !trackedPathsEqual(normalized, previous);
  }
  const prev = normalizeTrackedCwdPath(previous);
  if (prev.startsWith(normalized) && prev.length > normalized.length) {
    return isDirectoryAncestor(normalized, prev);
  }
  return true;
}

function canonicalizeTrackedCwdPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";

  const absolute = trimmed.startsWith("/");
  const stack: string[] = [];

  for (const part of trimmed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }

  if (absolute) {
    const joined = stack.join("/");
    if (!joined) return "/";
    return `/${joined}`;
  }
  return stack.join("/") || ".";
}

/** 折叠 . / .. 后的规范绝对路径，供 cwd 跟踪与 git 查询使用 */
export function normalizeTrackedCwdPath(path: string): string {
  const canonical = canonicalizeTrackedCwdPath(path);
  if (!canonical.startsWith("/")) return canonical;
  const trimmed = canonical.replace(/\/+$/, "");
  return trimmed || "/";
}

function normalizeTrackedCwd(path: string) {
  return normalizeTrackedCwdPath(path);
}

/** 比较路径（忽略末尾斜杠、macOS /private 前缀） */
export function trackedPathsEqual(a: string, b: string) {
  const na = normalizeTrackedCwd(a);
  const nb = normalizeTrackedCwd(b);
  if (na === nb) return true;
  const stripPrivate = (p: string) => p.replace(/^\/private(?=\/)/, "");
  return stripPrivate(na) === stripPrivate(nb);
}

/**
 * 用户通过 `cd` 输入已预判目标目录时，拒绝 precmd 推送的旧 OSC7 cwd。
 * 若 OSC 与 pending 或当前 cwd 等价则接受。
 */
export function shouldAcceptOsc7CwdUpdate(
  oscCwd: string,
  currentCwd: string | null | undefined,
  pendingCdTarget?: string | null,
): boolean {
  if (!shouldAcceptCwdUpdate(oscCwd, currentCwd)) return false;
  if (!pendingCdTarget) return true;

  const osc = normalizeTrackedCwd(oscCwd);
  const pending = normalizeTrackedCwd(pendingCdTarget);
  const current = currentCwd ? normalizeTrackedCwd(currentCwd) : null;

  if (trackedPathsEqual(osc, pending)) return true;
  if (current && trackedPathsEqual(osc, current)) return true;

  // pending 已生效且当前目录就是目标：拒绝无关的旧 OSC7
  if (current && trackedPathsEqual(current, pending)) {
    return false;
  }

  return !current;
}

function decodeOsc7Path(raw: string) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 跨 PTY 输出块累积 OSC7，仅在序列完整时解析 cwd */
export class Osc7CwdParser {
  private buffer = "";

  feed(data: string): string | null {
    this.buffer += data;

    let latest: string | null = null;
    let consumedThrough = 0;

    for (const match of this.buffer.matchAll(OSC7_COMPLETE_RE)) {
      const raw = match[1];
      if (!raw) continue;
      latest = normalizeTrackedCwdPath(decodeOsc7Path(raw));
      consumedThrough = (match.index ?? 0) + match[0].length;
    }

    if (consumedThrough > 0) {
      this.buffer = this.buffer.slice(consumedThrough);
    } else if (this.buffer.length > 8192) {
      const lastEsc = this.buffer.lastIndexOf("\x1b");
      this.buffer = lastEsc >= 0 ? this.buffer.slice(lastEsc) : "";
    }

    return latest;
  }

  reset() {
    this.buffer = "";
  }
}

/** @deprecated 使用 Osc7CwdParser */
export function extractCwdFromOutput(data: string): string | null {
  return new Osc7CwdParser().feed(data);
}

/**
 * @deprecated cwd 仅走 OSC7，保留函数供测试/工具使用
 */
export function resolveCdTarget(currentCwd: string, homePath: string, raw: string) {
  const target = raw.trim().replace(/;+\s*$/, "");
  if (!target || target === "~") return normalizeTrackedCwdPath(homePath);
  if (target === "-") return normalizeTrackedCwdPath(currentCwd);
  if (target.startsWith("~/")) {
    return normalizeTrackedCwdPath(`${homePath}/${target.slice(2)}`);
  }
  if (target.startsWith("/")) return normalizeTrackedCwdPath(target);
  return normalizeTrackedCwdPath(`${currentCwd.replace(/\/$/, "")}/${target}`);
}

function parseCondaOrMambaActivate(trimmed: string): Record<string, string> | null {
  const cmd = trimmed.replace(/^[^\w]*(?=(?:conda|mamba|micromamba)\b)/, "").trim();
  if (/^(?:conda|mamba|micromamba)\s+activate$/.test(cmd)) {
    return { CONDA_DEFAULT_ENV: "base" };
  }
  const pathActivate = cmd.match(
    /^(?:conda|mamba|micromamba)\s+activate\s+-p\s+(['"]?)(.+?)\1(?:\s|$)/,
  );
  if (pathActivate?.[2]) {
    const raw = pathActivate[2].trim();
    const envName = raw.includes("/") ? raw.split("/").filter(Boolean).pop() ?? raw : raw;
    return { CONDA_DEFAULT_ENV: envName };
  }
  const named = cmd.match(
    /^(?:conda|mamba|micromamba)\s+activate(?:\s+-n\s+|\s+)(['"]?)([\w./-]+)\1(?:\s|$)/,
  );
  if (named?.[2]) {
    const raw = named[2];
    const envName = raw.includes("/") ? raw.split("/").filter(Boolean).pop() ?? raw : raw;
    return { CONDA_DEFAULT_ENV: envName };
  }
  return null;
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

    // 统一换行：避免 `\r` 与后续字符分包时把 `cd /data/ser` 提前提交
    const normalized = stripTerminalEscapes(data.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));

    for (const ch of normalized) {
      if (ch === "\n") {
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
    _currentCwd: string,
    _homePath: string,
  ): { cwd?: string; env?: Record<string, string>; unsetEnv?: string[] } | null {
    const trimmed = stripTerminalEscapes(line).trim();
    if (!trimmed) return null;

    // cwd 仅由 OSC7 更新，禁止输入猜测（避免 en/Wo/ls 等碎片路径）
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

    const condaEnv = parseCondaOrMambaActivate(trimmed);
    if (condaEnv) {
      return { env: condaEnv };
    }

    if (/^(?:conda|mamba|micromamba)\s+deactivate$/.test(trimmed)) {
      return { env: { CONDA_DEFAULT_ENV: "" }, unsetEnv: ["CONDA_PREFIX"] };
    }

    const venvActivateMatch = trimmed.match(
      /^(?:source\s+)?(.+\/bin\/activate)$/,
    );
    if (venvActivateMatch) {
      const activatePath = venvActivateMatch[1].replace(/^['"](.*)['"]$/, "$1");
      const venvRoot = activatePath.replace(/\/bin\/activate$/, "");
      if (venvRoot) {
        return { env: { VIRTUAL_ENV: venvRoot } };
      }
    }

    if (/^deactivate$/.test(trimmed)) {
      return { unsetEnv: ["VIRTUAL_ENV"] };
    }

    const nvmUseMatch = trimmed.match(/^nvm\s+use(?:\s+(.+))?$/);
    if (nvmUseMatch) {
      const raw = (nvmUseMatch[1] ?? "").trim().replace(/^['"](.*)['"]$/, "$1");
      const version = sanitizeVersionLabel(raw);
      if (version) {
        return { env: { NVM_ACTIVE_VERSION: version }, unsetEnv: ["NVM_RC_VERSION"] };
      }
    }

    return null;
  }
}
