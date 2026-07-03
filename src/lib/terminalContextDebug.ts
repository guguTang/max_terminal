/** 开发环境默认开启；生产环境在控制台执行 localStorage.setItem('mx-terminal.debugContext','1') */
function isEnabled() {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem("mx-terminal.debugContext") === "1";
  } catch {
    return false;
  }
}

export function ctxLog(
  scope: string,
  message: string,
  data?: Record<string, unknown>,
) {
  if (!isEnabled()) return;
  if (data) {
    console.debug(`[mx-context:${scope}] ${message}`, data);
  } else {
    console.debug(`[mx-context:${scope}] ${message}`);
  }
}
