import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Eye, EyeOff, FlaskConical, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AuthType, Connection } from "../types/connection";

const emptyConnection = (): Connection => ({
  id: "",
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "password",
  password: "",
  privateKey: "",
  group: "",
  createdAt: 0,
});

interface ConnectionDialogProps {
  open: boolean;
  initial?: Connection | null;
  existingGroups?: string[];
  onSave: (conn: Connection) => Promise<void>;
  onClose: () => void;
}

export function ConnectionDialog({
  open,
  initial,
  existingGroups = [],
  onSave,
  onClose,
}: ConnectionDialogProps) {
  const [form, setForm] = useState<Connection>(emptyConnection());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const groupFieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setForm(initial?.id ? { ...initial } : emptyConnection());
      setError(null);
      setTestMessage(null);
      setShowPassword(false);
      setGroupMenuOpen(false);
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (groupMenuOpen) {
        e.stopPropagation();
        setGroupMenuOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, groupMenuOpen]);

  useEffect(() => {
    if (!groupMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!groupFieldRef.current?.contains(e.target as Node)) {
        setGroupMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [groupMenuOpen]);

  const filteredGroups = useMemo(() => {
    const q = (form.group ?? "").trim().toLowerCase();
    if (!q) return existingGroups;
    return existingGroups.filter((name) => name.toLowerCase().includes(q));
  }, [existingGroups, form.group]);

  const update = <K extends keyof Connection>(key: K, value: Connection[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const group = form.group?.trim();
      await onSave({
        ...form,
        group: group ? group : undefined,
      });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setError(null);
    setTestMessage(null);
    try {
      await invoke("test_connection_cmd", { connection: form });
      setTestMessage("连接测试成功");
    } catch (err) {
      setTestMessage(`连接测试失败: ${String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  const handleImportPrivateKey = async (file: File) => {
    try {
      const text = await file.text();
      update("privateKey", text);
      setTestMessage(`已导入私钥文件: ${file.name}`);
    } catch (err) {
      setError(`读取私钥文件失败: ${String(err)}`);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-dialog-title"
        className="relative w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h2 id="connection-dialog-title" className="text-base font-semibold text-zinc-100">
            {initial?.id ? "编辑 SSH 连接" : "新建 SSH 连接"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 px-5 py-4">
          {error && (
            <p className="rounded-md bg-red-950/50 border border-red-900 px-3 py-2 text-sm text-red-400">
              {error}
            </p>
          )}
          {testMessage && (
            <p
              className={`rounded-md border px-3 py-2 text-sm ${
                testMessage.startsWith("连接测试成功")
                  ? "bg-emerald-950/40 border-emerald-800 text-emerald-300"
                  : testMessage.startsWith("已导入私钥文件")
                    ? "bg-blue-950/40 border-blue-800 text-blue-300"
                    : "bg-amber-950/40 border-amber-800 text-amber-300"
              }`}
            >
              {testMessage}
            </p>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-zinc-400">名称</span>
            <input
              className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder="我的服务器"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              required
              autoFocus
            />
          </label>

          <div className="block space-y-1" ref={groupFieldRef}>
            <span className="text-xs text-zinc-400">分组</span>
            <div className="relative">
              <input
                className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 pr-9 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="可选，如 生产 / 测试"
                value={form.group ?? ""}
                onChange={(e) => {
                  update("group", e.target.value);
                  setGroupMenuOpen(true);
                }}
                onFocus={() => setGroupMenuOpen(true)}
                autoComplete="off"
              />
              <button
                type="button"
                tabIndex={-1}
                className="absolute inset-y-0 right-0 flex items-center px-2.5 text-zinc-500 hover:text-zinc-300"
                onClick={() => setGroupMenuOpen((v) => !v)}
                title="选择已有分组"
              >
                <ChevronDown size={15} />
              </button>
              {groupMenuOpen && (
                <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-40 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 py-1 shadow-xl">
                  {filteredGroups.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-zinc-500">
                      {existingGroups.length === 0
                        ? "暂无已有分组，直接输入即可新建"
                        : "无匹配分组，可继续输入新建"}
                    </div>
                  ) : (
                    filteredGroups.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-zinc-800 ${
                          form.group === name ? "bg-zinc-800 text-blue-300" : "text-zinc-200"
                        }`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          update("group", name);
                          setGroupMenuOpen(false);
                        }}
                      >
                        {name}
                      </button>
                    ))
                  )}
                  {(form.group ?? "").trim() && (
                    <button
                      type="button"
                      className="block w-full border-t border-zinc-800 px-3 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        update("group", "");
                        setGroupMenuOpen(false);
                      }}
                    >
                      清除分组（未分组）
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <label className="block space-y-1">
            <span className="text-xs text-zinc-400">主机</span>
            <input
              className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder="192.168.1.1"
              value={form.host}
              onChange={(e) => update("host", e.target.value)}
              required
            />
          </label>

          <div className="flex gap-3">
            <label className="block flex-1 space-y-1">
              <span className="text-xs text-zinc-400">用户名</span>
              <input
                className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="root"
                value={form.username}
                onChange={(e) => update("username", e.target.value)}
                required
              />
            </label>
            <label className="block w-24 space-y-1">
              <span className="text-xs text-zinc-400">端口</span>
              <input
                className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                type="number"
                value={form.port}
                onChange={(e) => update("port", Number(e.target.value))}
                required
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-xs text-zinc-400">认证方式</span>
            <select
              className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              value={form.authType}
              onChange={(e) => update("authType", e.target.value as AuthType)}
            >
              <option value="password">密码</option>
              <option value="private_key">私钥</option>
            </select>
          </label>

          {form.authType === "password" ? (
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">密码</span>
              <div className="relative">
                <input
                  className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none"
                  type={showPassword ? "text" : "password"}
                  value={form.password ?? ""}
                  onChange={(e) => update("password", e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-zinc-400 hover:text-zinc-200"
                  title={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>
          ) : (
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">PEM 私钥</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pem,.key,.txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void handleImportPrivateKey(file);
                  }
                  e.currentTarget.value = "";
                }}
              />
              <textarea
                className="w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 py-2 text-xs font-mono h-28 focus:border-blue-500 focus:outline-none"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                value={form.privateKey ?? ""}
                onChange={(e) => update("privateKey", e.target.value)}
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md px-2.5 py-1 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700"
                >
                  选择私钥文件
                </button>
              </div>
            </label>
          )}

          <div className="flex justify-between gap-2 pt-2">
            <button
              type="button"
              disabled={saving || testing}
              onClick={() => void handleTestConnection()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              <FlaskConical size={14} />
              {testing ? "测试中..." : "测试连接"}
            </button>
            <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving || testing}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存"}
            </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
