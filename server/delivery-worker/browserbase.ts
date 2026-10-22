import { chromium, type Browser, type Page } from "playwright-core";
import { DeliveryError } from "../delivery/parse.js";
import { validDeliveryLiveUrl } from "../../shared/delivery.js";

type RemoteSession = {
  id: string;
  connectUrl: string;
  expiresAt: string;
  status?: string;
};
/** Worker only. Never log raw HTTP bodies, CDP URLs, page content or credentials. */
export class BrowserbaseDriver {
  constructor(
    private key: string,
    private projectId: string,
  ) {}
  private async request(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) {
    const response = await fetch(`https://api.browserbase.com/v1${path}`, {
      method,
      redirect: "error",
      headers: {
        "X-BB-API-Key": this.key,
        "Content-Type": "application/json",
        Accept: /^\/downloads\/[^/?]+$/.test(path)
          ? "application/octet-stream"
          : "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok)
      throw new DeliveryError(
        response.status === 404
          ? "delivery_session_expired"
          : "delivery_browser_unavailable",
      );
    return response;
  }
  async createContext(signal: AbortSignal): Promise<string> {
    const r = (await (
      await this.request("/contexts", signal, { projectId: this.projectId })
    ).json()) as { id: string };
    return r.id;
  }
  async createSession(
    contextId: string,
    signal: AbortSignal,
  ): Promise<RemoteSession> {
    return (await (
      await this.request("/sessions", signal, {
        projectId: this.projectId,
        timeout: 900,
        keepAlive: true,
        browserSettings: {
          context: { id: contextId, persist: true },
          recordSession: false,
          logSession: false,
          solveCaptchas: false,
          viewport: { width: 1280, height: 800 },
        },
      })
    ).json()) as RemoteSession;
  }
  async session(id: string, signal: AbortSignal): Promise<RemoteSession> {
    return (await (
      await this.request(`/sessions/${encodeURIComponent(id)}`, signal)
    ).json()) as RemoteSession;
  }
  async live(id: string, signal: AbortSignal): Promise<string> {
    const r = (await (
      await this.request(`/sessions/${encodeURIComponent(id)}/debug`, signal)
    ).json()) as { debuggerFullscreenUrl: string };
    if (!validDeliveryLiveUrl(r.debuggerFullscreenUrl))
      throw new DeliveryError("delivery_browser_unavailable");
    return r.debuggerFullscreenUrl;
  }
  async release(id: string, signal: AbortSignal) {
    try {
      await this.request(`/sessions/${encodeURIComponent(id)}`, signal, {
        projectId: this.projectId,
        status: "REQUEST_RELEASE",
      });
    } catch (e) {
      if (!(
        e instanceof DeliveryError && e.code === "delivery_session_expired"
      ))
        throw e;
    }
  }
  async deleteContext(id: string, signal: AbortSignal) {
    try {
      await this.request(
        `/contexts/${encodeURIComponent(id)}`,
        signal,
        undefined,
        "DELETE",
      );
    } catch (e) {
      if (!(
        e instanceof DeliveryError && e.code === "delivery_session_expired"
      ))
        throw e;
    }
  }
  async page(
    session: RemoteSession,
    signal: AbortSignal,
  ): Promise<{ browser: Browser; page: Page; detach: () => Promise<void> }> {
    const url = new URL(session.connectUrl);
    if (
      url.protocol !== "wss:" ||
      !(
        url.hostname === "connect.browserbase.com" ||
        url.hostname.endsWith(".browserbase.com")
      )
    )
      throw new DeliveryError("delivery_browser_unavailable");
    const browser = await chromium.connectOverCDP(session.connectUrl, {
      timeout: 20000,
    });
    const abort = () => {
      void browser.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      throw new DeliveryError("delivery_interrupted");
    }
    const context = browser.contexts()[0],
      page = context?.pages()[0];
    if (!page) {
      await browser.close();
      throw new DeliveryError("delivery_browser_unavailable");
    }
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(20000);
    const client = await context.newCDPSession(page);
    await client.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: "downloads",
      eventsEnabled: true,
    });
    return {
      browser,
      page,
      detach: async () => {
        signal.removeEventListener("abort", abort);
        await browser.close();
      },
    };
  }
  async download(id: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const r = (await (
      await this.request(
        `/downloads?sessionId=${encodeURIComponent(id)}`,
        signal,
      )
    ).json()) as {
      downloads: { id: string; filename: string; size: number }[];
    };
    const files = r.downloads.filter((f) => f.filename.endsWith(".csv"));
    if (!files.length) return null;
    if (files.length !== 1 || files[0].size > 10_000_000)
      throw new DeliveryError("delivery_report_invalid");
    const response = await this.request(
      `/downloads/${encodeURIComponent(files[0].id)}`,
      signal,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new DeliveryError("delivery_report_invalid");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 10_000_000)
          throw new DeliveryError("delivery_report_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
}
