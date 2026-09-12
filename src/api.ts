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
export function setSession(s: Session) {
  csrf = s.csrf;
}
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? "error", response.status);
  return data;
}
