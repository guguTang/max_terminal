export type AuthType = "password" | "private_key";

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  createdAt: number;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified?: number;
}

export interface ConnectResult {
  sessionId: string;
  connectionId: string;
  homePath: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  terminalId: string;
  data: string;
}

export interface TerminalMeta {
  cwd: string;
  env: Record<string, string>;
}

export interface TerminalCreateOptions {
  initialCwd?: string;
  initialEnv?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".sh",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".rs",
  ".toml",
  ".env",
  ".log",
  ".xml",
  ".html",
  ".css",
  ".sql",
  ".conf",
  ".cfg",
  ".ini",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
]);

export function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return true;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".py": "python",
    ".rs": "rust",
    ".sh": "shell",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".html": "html",
    ".css": "css",
    ".sql": "sql",
    ".xml": "xml",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".rb": "ruby",
    ".php": "php",
    ".vue": "html",
    ".env": "plaintext",
    ".log": "plaintext",
  };
  return map[ext] ?? "plaintext";
}
