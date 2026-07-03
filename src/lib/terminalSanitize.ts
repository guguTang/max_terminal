/** 去掉 PTY 输入/输出中的 ANSI、bracketed paste（如 [200~）等控制序列 */
export function stripTerminalEscapes(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*[~a-zA-Z]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
}

/** 规范化 node/python 等版本号显示 */
export function sanitizeVersionLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = stripTerminalEscapes(raw).trim();
  // bracketed paste 残留，如 [200~v22.21.1
  v = v.replace(/^\[+[0-9]*~/, "").replace(/\]+$/g, "");
  v = v.replace(/^v/i, "").trim();
  return v || null;
}
