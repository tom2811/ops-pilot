export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const apiBase = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${apiBase}/api${cleanPath}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const base =
      typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status})`;
    const issues =
      typeof data === "object" && data !== null && "issues" in data && Array.isArray(data.issues)
        ? data.issues
        : [];
    const firstIssue = issues.find(
      (issue: unknown): issue is { message: string } =>
        typeof issue === "object" && issue !== null && "message" in issue && typeof issue.message === "string",
    );
    throw new ApiError(firstIssue ? `${base}: ${firstIssue.message}` : base, response.status);
  }
  return data as T;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function del(path: string): Promise<void> {
  return api<void>(path, { method: "DELETE" });
}

export function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export async function downloadFile(path: string, fallbackFilename: string): Promise<void> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
  });
  if (!response.ok) {
    let msg = `Download failed (${response.status})`;
    try {
      const json = (await response.json()) as { error?: string };
      if (json && typeof json.error === "string") msg = json.error;
    } catch {
      /* ignore non-json errors */
    }
    throw new ApiError(msg, response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition");
  let filename = fallbackFilename;
  if (disposition && disposition.includes("filename=")) {
    const match = disposition.match(/filename="?([^";]+)"?/);
    if (match && match[1]) filename = match[1];
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}

export function triggerDownload(content: string, filename: string, mimeType = "text/csv;charset=utf-8;"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
