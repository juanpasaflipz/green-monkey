import type http from "node:http";
import { log } from "./logging.js";

/**
 * Graceful shutdown on SIGTERM/SIGINT (OPS-6): mark draining (/api/health
 * turns 503), stop accepting, keep closing idle keep-alive sockets, wait for
 * in-flight requests, run close(), exit 0. Forces exit 1 at drainSeconds - 2
 * so Railway's SIGKILL (after RAILWAY_DEPLOYMENT_DRAINING_SECONDS) never
 * lands first.
 */
export function drainOnSignal(
  server: http.Server | null,
  state: { draining: boolean },
  close: () => Promise<void>,
  o: {
    drainSeconds?: number;
    exit?: (code: number) => void;
    signals?: NodeJS.Signals[];
    emitter?: NodeJS.EventEmitter;
  } = {},
) {
  const drainSeconds = o.drainSeconds ?? 20;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const emitter = o.emitter ?? process;
  let started = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    state.draining = true;
    log.info("shutdown_draining", { signal, drainSeconds });
    const force = setTimeout(
      () => {
        log.error("shutdown_forced", { drainSeconds });
        exit(1);
      },
      Math.max(1, drainSeconds - 2) * 1000,
    );
    force.unref();
    const finish = async () => {
      try {
        await close();
        log.info("shutdown_complete", {});
        clearTimeout(force);
        exit(0);
      } catch (error) {
        log.error("shutdown_failed", {}, error);
        clearTimeout(force);
        exit(1);
      }
    };
    if (!server) {
      void finish();
      return;
    }
    // Keep-alive sockets that finish their last response after close() stay
    // open until the keep-alive timeout; sweep them so the drain completes as
    // soon as in-flight requests do.
    const sweep = setInterval(() => server.closeIdleConnections(), 250);
    sweep.unref();
    server.close(() => {
      clearInterval(sweep);
      void finish();
    });
    server.closeIdleConnections();
  };
  for (const signal of o.signals ?? (["SIGTERM", "SIGINT"] as const))
    emitter.on(signal, onSignal);
}

/** RAILWAY_DEPLOYMENT_DRAINING_SECONDS (default 20, minimum 3). */
export function drainSecondsFrom(env: NodeJS.ProcessEnv, fallback = 20) {
  const n = Number(env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS);
  return Number.isInteger(n) && n >= 3 ? n : fallback;
}
