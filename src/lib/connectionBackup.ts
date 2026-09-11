import type { AuthType, Connection } from "../types/connection";

export const CONNECTION_BACKUP_VERSION = 1 as const;

export interface ConnectionBackupFile {
  version: typeof CONNECTION_BACKUP_VERSION;
  exportedAt: number;
  connections: Connection[];
}

function isAuthType(value: unknown): value is AuthType {
  return value === "password" || value === "private_key";
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

function normalizeConnection(raw: unknown, index: number): Connection {
  if (!raw || typeof raw !== "object") {
    throw new Error(`第 ${index + 1} 条连接不是对象`);
  }
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const host = typeof item.host === "string" ? item.host.trim() : "";
  const username = typeof item.username === "string" ? item.username.trim() : "";
  const authType = item.authType;
  const portRaw = item.port;
  const port =
    typeof portRaw === "number"
      ? portRaw
      : typeof portRaw === "string"
        ? Number(portRaw)
        : NaN;

  if (!name) throw new Error(`第 ${index + 1} 条连接缺少 name`);
  if (!host) throw new Error(`第 ${index + 1} 条连接缺少 host`);
  if (!username) throw new Error(`第 ${index + 1} 条连接缺少 username`);
  if (!isAuthType(authType)) {
    throw new Error(`第 ${index + 1} 条连接 authType 无效（需 password 或 private_key）`);
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`第 ${index + 1} 条连接 port 无效`);
  }

  const group = asOptionalString(item.group)?.trim() || undefined;
  const password = asOptionalString(item.password);
  const privateKey = asOptionalString(item.privateKey);
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const createdAt =
    typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
      ? item.createdAt
      : Math.floor(Date.now() / 1000);

  return {
    id,
    name,
    host,
    port: Math.trunc(port),
    username,
    authType,
    password,
    privateKey,
    group,
    createdAt,
  };
}

/** Accepts `{ version, connections }` or a bare connection array. */
export function parseConnectionBackup(text: string): Connection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("不是有效的 JSON 文件");
  }

  if (Array.isArray(parsed)) {
    return parsed.map((item, index) => normalizeConnection(item, index));
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("备份文件格式不正确");
  }

  const file = parsed as Record<string, unknown>;
  const list = file.connections;
  if (!Array.isArray(list)) {
    throw new Error("备份文件缺少 connections 数组");
  }
  if (file.version !== undefined && file.version !== CONNECTION_BACKUP_VERSION) {
    throw new Error(`不支持的备份版本: ${String(file.version)}`);
  }
  return list.map((item, index) => normalizeConnection(item, index));
}

export function buildConnectionBackup(connections: Connection[]): ConnectionBackupFile {
  return {
    version: CONNECTION_BACKUP_VERSION,
    exportedAt: Math.floor(Date.now() / 1000),
    connections: connections.map((conn) => ({
      ...conn,
      group: conn.group?.trim() || undefined,
    })),
  };
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
