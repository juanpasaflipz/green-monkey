import type { Session } from "../shared/domain";
export class ApiError extends Error {
  constructor(
    code: string,
    public status: number,
  ) {
    super(code);
  }
}
let csrf = "";
let tenantId = "",
  sessionId = "";
export function setSession(s: Session) {
  csrf = s.csrf;
  tenantId = s.tenantId;
  sessionId = s.id;
}
export function clearSessionScope() {
  csrf = "";
  tenantId = "";
  sessionId = "";
}
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      ...(tenantId
        ? { "x-tenant-id": tenantId, "x-session-id": sessionId }
        : {}),
    },
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.error === "session_changed")
      window.dispatchEvent(new Event("gm-session-changed"));
    throw new ApiError(data.error ?? "error", response.status);
  }
  return data;
}
