import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Clock,
  Printer,
  Volume2,
  VolumeX,
  RotateCcw,
} from "lucide-react";
import type { Locale, Session } from "../../shared/domain";
import {
  ALLERGY_PATTERN,
  type KitchenFeed,
  type KitchenRound,
} from "../../shared/service";
import { api } from "../api";
import { strings, translateError, type Key } from "../i18n";
import { channelLabel } from "../labels";
import { Badge, Button, Empty, Modal } from "../components/ui";
import { usePoll, useStoredState } from "../serviceHooks";
import { PrintSettingsDialog, printDocument, usePrintSettings } from "../print";
import { KitchenTicketDocument, ticketFromKitchenRound } from "./KitchenTicket";
import { cancellationsFromKitchenRounds } from "./printing/cancellations";
import { printCancellations } from "./printing/KitchenCancellationDocument";
import {
  clearStaleCount,
  kdsChanges,
  type FullFeed,
  type KdsSeen,
} from "./kitchenFeed";

export type Station = "all" | "kitchen" | "bar";
const isStation = (v: unknown): v is Station =>
  v === "all" || v === "kitchen" || v === "bar";
const isSound = (v: unknown): v is "on" | "off" => v === "on" || v === "off";
const NEW_MS = 15000;
const STALE_MS = 10000;
const FULL_EVERY_MS = 30000;

/** Next kitchen action for a round, or null for states this screen does not drive. */
export function actionFor(r: Pick<KitchenRound, "state" | "seenAt">) {
  if (r.state === "active")
    return r.seenAt
      ? ({ state: "ready", label: "markReady" } as const)
      : ({ state: "seen", label: "ack" } as const);
  if (r.state === "ready")
    return { state: "completed", label: "serve" } as const;
  return null;
}

function beep(context: AudioContext | null, frequency: number, count: number) {
  if (!context || context.state !== "running") return;
  for (let i = 0; i < count; i++) {
    const start = context.currentTime + i * 0.25;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.25, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
    osc.connect(gain).connect(context.destination);
    osc.start(start);
    osc.stop(start + 0.15);
  }
}

/** Kitchen display (KDS): single-flight polling with a tenant feed version. */
export function Kitchen({
  session,
  locale,
  refreshKey,
  beforeTickets,
}: {
  session: Session;
  locale: Locale;
  refreshKey: number;
  /**
   * Slot rendered above the tickets (offline 026 passes its review lane). A
   * function receives the station on screen, so the lane shows only what this
   * screen shows (offline OFF-R23).
   */
  beforeTickets?: ReactNode | ((station: Station) => ReactNode);
}) {
  const t = (k: Key) => strings[locale][k];
  const role = session.role;
  const [station, setStation] = useStoredState<Station>(
    "gm-kds-station",
    "all",
    isStation,
  );
  const [sound, setSound] = useStoredState<"on" | "off">(
    "gm-kds-sound",
    "off",
    isSound,
  );
  const [feed, setFeed] = useState<FullFeed | null>(null);
  const [newIds, setNewIds] = useState<Map<string, number>>(new Map());
  /**
   * Tickets whose note changed after the cook saw them. The badge shows only
   * while the ticket is highlighted (newIds); a round id is fresh only once,
   * so an entry here never relabels a later new ticket.
   */
  const [notedIds, setNotedIds] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const [actionError, setActionError] = useState("");
  /** SVC-K5: tickets (and "clear") with a request in flight, one per ticket. */
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const [audioState, setAudioState] = useState<string>("none");
  const [recentOpen, setRecentOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [printSettings] = usePrintSettings();
  const version = useRef<number | null>(null);
  const lastFull = useRef(0);
  const offset = useRef(0);
  /** What this station's screen has shown (null until its first feed). */
  const seen = useRef<KdsSeen | null>(null);
  const loadedStation = useRef<Station | null>(null);
  const loadedRefresh = useRef(refreshKey);
  const generation = useRef(0);
  const audio = useRef<AudioContext | null>(null);
  const clearKey = useRef(crypto.randomUUID());
  const settingsRef = useRef(printSettings);
  settingsRef.current = printSettings;
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const zone = session.restaurant.timezone;

  async function load() {
    if (loadedStation.current !== station) {
      // A different station is a different feed: fetch it fully and silently.
      loadedStation.current = station;
      generation.current++;
      version.current = null;
      seen.current = null;
    }
    if (loadedRefresh.current !== refreshKey) {
      loadedRefresh.current = refreshKey;
      version.current = null;
    }
    const gen = generation.current;
    const full =
      version.current === null || Date.now() - lastFull.current > FULL_EVERY_MS;
    const r = await api<KitchenFeed>(
      `/service/kitchen?station=${station}` +
        (full ? "" : `&version=${version.current}`),
    );
    // A response for a station the screen no longer shows is ignored.
    if (gen !== generation.current) return;
    offset.current = Date.parse(r.serverTime) - Date.now();
    version.current = r.version;
    if (r.unchanged) return;
    lastFull.current = Date.now();
    detect(r);
    setFeed(r);
  }

  function detect(r: FullFeed) {
    // The first feed of a station is silent; a ticket that slides in from
    // the old end of a truncated feed is not new (FLK-R1, kitchenFeed.ts).
    // reports (029): newVoidIds are the voids first seen in this load, for
    // the cancellation chits.
    const {
      seen: shown,
      fresh,
      noted,
      voided,
      newVoidIds,
    } = kdsChanges(seen.current, r);
    seen.current = shown;
    const messages = [
      ...fresh.map((x) =>
        t("serviceKdsAnnounce")
          .replace("{n}", String(x.orderNumber))
          .replace("{r}", String(x.roundNumber)),
      ),
      ...noted.map((x) =>
        t("serviceKdsNoteAnnounce").replace("{n}", String(x.orderNumber)),
      ),
      ...voided.map((x) =>
        t("serviceKdsVoidAnnounce").replace("{n}", String(x.orderNumber)),
      ),
    ];
    if (messages.length) setAnnouncement(messages.join(". "));
    const alerted = [...fresh, ...noted];
    if (noted.length)
      setNotedIds((old) => new Set([...old, ...noted.map((x) => x.id)]));
    if (alerted.length) {
      const until = Date.now() + NEW_MS;
      setNewIds((old) => {
        const next = new Map(old);
        for (const x of alerted) next.set(x.id, until);
        return next;
      });
      if (soundRef.current === "on") beep(audio.current, 880, 2);
      if (settingsRef.current.kdsAutoPrint)
        void printDocument(
          alerted.map((x) => (
            <KitchenTicketDocument
              key={x.id}
              ticket={ticketFromKitchenRound(x)}
              locale={locale}
              timezone={zone}
            />
          )),
          settingsRef.current.paper,
        );
    } else if (voided.length && soundRef.current === "on")
      beep(audio.current, 440, 2);
    // reports (029): a cook working from paper gets a cancellation chit per round.
    if (settingsRef.current.kdsAutoPrint && voided.length)
      void printCancellations(
        cancellationsFromKitchenRounds(voided, newVoidIds),
        locale,
        zone,
        settingsRef.current.paper,
      ).then((ok) => {
        if (!ok) setActionError(t("reportsKitchenCancelPrintFailed"));
      });
  }

  const poll = usePoll(load, { intervalMs: 3000 }, [station, refreshKey]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      setNewIds((old) => {
        const live = [...old].filter(([, until]) => until > Date.now());
        return live.length === old.size ? old : new Map(live);
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Keep the screen awake on dedicated kitchen devices when supported.
    const wake = (
      navigator as Navigator & {
        wakeLock?: {
          request(type: "screen"): Promise<{ release(): Promise<void> }>;
        };
      }
    ).wakeLock;
    if (!wake) return;
    let sentinel: { release(): Promise<void> } | null = null;
    let alive = true;
    const acquire = () => {
      if (document.hidden) return;
      wake
        .request("screen")
        .then((s) => {
          if (alive) sentinel = s;
          else void s.release().catch(() => {});
        })
        .catch(() => {});
    };
    const visibility = () => {
      if (!document.hidden) acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", visibility);
      void sentinel?.release().catch(() => {});
    };
  }, []);

  useEffect(
    () => () => {
      void audio.current?.close().catch(() => {});
    },
    [],
  );

  useEffect(() => {
    // SVC-K8: the system can suspend or interrupt Web Audio (a call, a
    // notification, an app switch). Try to resume when the screen is shown
    // again; if that is refused, the live state shows "Activar sonido" again.
    const visibility = () => {
      const context = audio.current;
      if (document.hidden || !context || soundRef.current !== "on") return;
      if (context.state !== "running")
        void context
          .resume()
          .catch(() => {})
          .finally(() => setAudioState(context.state));
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  async function enableSound() {
    // Autoplay policy: the context is created or resumed inside the tap.
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      if (!audio.current) {
        const context = new Ctor();
        // SVC-K8: the label and the banner follow the live state.
        context.onstatechange = () => setAudioState(context.state);
        audio.current = context;
      }
      await audio.current.resume();
      setAudioState(audio.current.state);
      setSound("on");
      beep(audio.current, 880, 1);
    } catch {
      setAudioState("blocked");
    }
  }

  /**
   * SVC-K5: one request per ticket. A ticket stays disabled while its own
   * request is in flight (another ticket's request never re-enables it), and
   * on success it shows the result at once: a feed fetched before the change
   * is discarded, so the old action never reappears under the finger.
   */
  async function act(
    id: string,
    fn: () => Promise<unknown>,
    apply?: (rounds: KitchenRound[]) => KitchenRound[],
  ) {
    if (busyRef.current.has(id)) return;
    busyRef.current.add(id);
    setBusyIds(new Set(busyRef.current));
    try {
      await fn();
      if (apply) {
        generation.current++;
        setFeed((f) => (f ? { ...f, rounds: apply(f.rounds) } : f));
      }
      setActionError("");
    } catch (e) {
      setActionError(translateError((e as Error).message, locale));
    } finally {
      busyRef.current.delete(id);
      setBusyIds(new Set(busyRef.current));
      poll.refresh();
    }
  }
  const progressed =
    (id: string, state: "seen" | "ready" | "completed") =>
    (rounds: KitchenRound[]) =>
      state === "completed"
        ? rounds.filter((x) => x.id !== id)
        : rounds.map((x) =>
            x.id !== id
              ? x
              : state === "seen"
                ? { ...x, seenAt: x.seenAt ?? new Date().toISOString() }
                : { ...x, state: "ready" as const },
          );

  const rounds = feed?.rounds ?? [];
  const recent = feed?.recent ?? [];
  // Managers only; a truncated feed uses the server's count (LD-42, FLK-R5).
  const stale = clearStaleCount(feed, role);
  const lastSuccess = poll.lastSuccess;
  const staleFeed = lastSuccess ? now - lastSuccess > STALE_MS : poll.failing;
  const soundBlocked = sound === "on" && audioState !== "running";
  const canProgress = ["owner", "manager", "kitchen"].includes(role);
  const canServe = canProgress || role === "server";
  const canAckVoids = ["owner", "manager", "kitchen"].includes(role);
  const canRecall = canServe;
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString(locale, {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const stationName = (s: string) => (s === "bar" ? t("bar") : t("kitchen"));
  const print = (r: KitchenRound) =>
    void printDocument(
      <KitchenTicketDocument
        ticket={ticketFromKitchenRound(r)}
        locale={locale}
        timezone={zone}
      />,
      printSettings.paper,
    );

  return (
    <div className="kds">
      <div className="kds-toolbar">
        <fieldset className="kds-stations">
          <legend>{t("serviceKdsStation")}</legend>
          {(["all", "kitchen", "bar"] as const).map((s) => (
            <label key={s} className={station === s ? "selected" : ""}>
              <input
                type="radio"
                name="kds-station"
                value={s}
                checked={station === s}
                onChange={() => {
                  setStation(s);
                  setNewIds(new Map());
                  setNotedIds(new Set());
                }}
              />
              <span>{s === "all" ? t("serviceKdsAll") : stationName(s)}</span>
            </label>
          ))}
        </fieldset>
        <Button
          aria-pressed={sound === "on" && audioState === "running"}
          onClick={() =>
            sound === "on" && audioState === "running"
              ? setSound("off")
              : void enableSound()
          }
        >
          {sound === "on" && audioState === "running" ? (
            <Volume2 size={18} />
          ) : (
            <VolumeX size={18} />
          )}
          {t(
            sound === "on" && audioState === "running"
              ? "serviceKdsSoundOn"
              : "serviceKdsSoundEnable",
          )}
        </Button>
        <Button onClick={() => setRecentOpen(true)}>
          <RotateCcw size={18} />
          {t("serviceKdsRecent").replace("{n}", String(recent.length))}
        </Button>
        <Button onClick={() => setPrintOpen(true)}>
          <Printer size={18} />
          {t("servicePrintSettings")}
        </Button>
        {stale > 0 && (
          <Button variant="ghost" onClick={() => setClearOpen(true)}>
            {t("serviceKdsClearStale").replace("{n}", String(stale))}
          </Button>
        )}
        <span className="muted tiny">
          {lastSuccess
            ? t("serviceKdsUpdated").replace("{time}", clock(lastSuccess))
            : t("loading")}
        </span>
      </div>
      <div className="sr-only" aria-live="polite" role="status">
        {announcement}
      </div>
      {soundBlocked && (
        <p className="warning-panel" role="status">
          {t("serviceKdsSoundBlocked")}
        </p>
      )}
      {staleFeed && (
        <p className="kds-stale" role="alert">
          {t("serviceKdsStale").replace(
            "{time}",
            lastSuccess ? clock(lastSuccess) : "—",
          )}
        </p>
      )}
      {actionError && (
        <div className="error action-error" role="alert">
          <span>{actionError}</span>
          <Button variant="ghost" onClick={() => setActionError("")}>
            {t("serviceKdsDismiss")}
          </Button>
        </div>
      )}
      {feed?.truncated && (
        // SVC-K7 / LD-42: the newest tickets stay; older ones are hidden.
        <p className="warning-panel" role="alert">
          {t("serviceKdsTruncated")}
        </p>
      )}
      {typeof beforeTickets === "function"
        ? beforeTickets(station)
        : beforeTickets}
      <div className="kitchen-grid">
        {rounds.map((r) => {
          const age = Math.max(
            0,
            Math.floor(
              (now + offset.current - Date.parse(r.createdAt)) / 60000,
            ),
          );
          const tone = age >= 20 ? "red" : age >= 10 ? "amber" : "neutral";
          const isNew = newIds.has(r.id);
          const noteUpdated = isNew && notedIds.has(r.id);
          const action = actionFor(r);
          const allowed =
            action && (action.state === "completed" ? canServe : canProgress);
          // SVC-K6: a delivered ticket leaves the screen, and with it the
          // only place its void is acknowledged, so the void comes first.
          const serveBlocked =
            action?.state === "completed" && r.pendingVoids.length > 0;
          const orderAllergy = ALLERGY_PATTERN.test(r.orderNote);
          const roundAllergy = ALLERGY_PATTERN.test(r.roundNote);
          return (
            <article
              className={
                "kitchen-ticket" +
                (isNew ? " ticket-new" : "") +
                (tone !== "neutral" ? " age-" + tone : "")
              }
              key={r.id}
            >
              <header>
                <div>
                  <h2>
                    #{r.orderNumber} <span>{r.callName}</span>
                  </h2>
                  <span>
                    {t("round")} {r.roundNumber} · {t(r.mode as Key)}
                    {station === "all" && <> · {stationName(r.station)}</>}
                  </span>
                </div>
                <div className="ticket-badges">
                  {isNew && (
                    <Badge tone={noteUpdated ? "amber" : "green"}>
                      {t(
                        noteUpdated ? "serviceKdsNoteUpdated" : "serviceKdsNew",
                      )}
                    </Badge>
                  )}
                  {r.channel !== "pos" && (
                    <Badge tone="amber">
                      {channelLabel(r.channel, locale)}
                    </Badge>
                  )}
                  <Badge tone={tone}>
                    <Clock size={14} />
                    {t("serviceMinutes").replace("{n}", String(age))}
                  </Badge>
                </div>
              </header>
              <p>
                {r.tableName ?? t("noTable")} · {r.waiterName}
              </p>
              {r.serviceUpdated && <Badge>{t("serviceUpdated")}</Badge>}
              {r.orderNote && (
                <div
                  className={"ticket-note" + (orderAllergy ? " allergy" : "")}
                >
                  <strong>
                    {orderAllergy
                      ? t("serviceKdsAllergy")
                      : t("serviceKdsOrderNote")}
                  </strong>{" "}
                  {r.orderNote}
                </div>
              )}
              {r.roundNote && r.roundNote !== r.orderNote && (
                <div
                  className={"ticket-note" + (roundAllergy ? " allergy" : "")}
                >
                  <strong>
                    {roundAllergy
                      ? t("serviceKdsAllergy")
                      : t("serviceKdsRoundNote")}
                  </strong>{" "}
                  {r.roundNote}
                </div>
              )}
              <div className="ticket-lines">
                {r.lines.map((l) => {
                  const allergy = ALLERGY_PATTERN.test(l.note);
                  return (
                    <div
                      key={l.id}
                      className={l.voidedQuantity >= l.quantity ? "voided" : ""}
                    >
                      <strong>
                        {l.quantity - l.voidedQuantity} × {l.name[locale]}
                        {l.voidedQuantity > 0 && (
                          <s className="muted"> ({l.quantity})</s>
                        )}
                      </strong>
                      {l.optionNames.map((o, i) => (
                        <p className="ticket-option" key={i}>
                          + {o[locale]}
                        </p>
                      ))}
                      {l.note && (
                        <p
                          className={
                            "ticket-note line" + (allergy ? " allergy" : "")
                          }
                        >
                          {allergy && (
                            <strong>{t("serviceKdsAllergy")} </strong>
                          )}
                          {l.note}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {!!r.pendingVoids.length && (
                <div className="void-alert" role="alert">
                  <strong>{t("kitchenVoided")}</strong>
                  {r.pendingVoids.map((v) => (
                    <p key={v.id}>
                      {v.kind === "refund" &&
                        `${t("discountsKdsRefundCancel")} · `}
                      {v.quantity} × {v.name[locale]}
                      {v.reason && ` · ${v.reason}`}
                    </p>
                  ))}
                  {canAckVoids && (
                    <Button
                      className="full"
                      disabled={busyIds.has(r.id)}
                      onClick={() =>
                        void act(
                          r.id,
                          () =>
                            api("/kitchen/" + r.id + "/voids/ack", {
                              operationId: crypto.randomUUID(),
                            }),
                          (rounds) =>
                            rounds.map((x) =>
                              x.id === r.id ? { ...x, pendingVoids: [] } : x,
                            ),
                        )
                      }
                    >
                      {t("kitchenVoidAck")}
                    </Button>
                  )}
                </div>
              )}
              <p>
                {t(r.state === "ready" ? "ready" : r.seenAt ? "seen" : "sent")}
              </p>
              {serveBlocked && (
                <p className="muted tiny">{t("serviceKdsAckFirst")}</p>
              )}
              {action && allowed && !serveBlocked && (
                <Button
                  variant="primary"
                  className="full"
                  disabled={busyIds.has(r.id)}
                  onClick={() =>
                    void act(
                      r.id,
                      () =>
                        api("/kitchen/" + r.id, {
                          operationId: crypto.randomUUID(),
                          state: action.state,
                        }),
                      progressed(r.id, action.state),
                    )
                  }
                >
                  <Check size={20} />
                  {t(action.label)}
                </Button>
              )}
              <Button variant="ghost" className="full" onClick={() => print(r)}>
                <Printer size={16} />
                {t("serviceKdsPrint")}
              </Button>
            </article>
          );
        })}
      </div>
      {feed && !rounds.length && <Empty title={t("serviceKdsEmpty")} />}
      {recentOpen && (
        <Modal
          title={t("serviceKdsRecentTitle")}
          close={() => setRecentOpen(false)}
          closeLabel={t("close")}
        >
          {!recent.length ? (
            <p className="muted">{t("serviceKdsRecentEmpty")}</p>
          ) : (
            <ul className="plain-list">
              {recent.map((r) => (
                <li className="row between" key={r.id}>
                  <span>
                    {t("serviceKdsRecentLine")
                      .replace("{n}", String(r.orderNumber))
                      .replace("{name}", r.callName || t("serviceUnnamed"))
                      .replace("{r}", String(r.roundNumber))
                      .replace("{station}", stationName(r.station))
                      .replace("{time}", clock(Date.parse(r.completedAt)))}
                  </span>
                  {canRecall && (
                    <Button
                      disabled={busyIds.has(r.id)}
                      onClick={() =>
                        void act(r.id, async () => {
                          await api(`/service/kitchen/rounds/${r.id}/recall`, {
                            operationId: crypto.randomUUID(),
                          });
                          setRecentOpen(false);
                        })
                      }
                    >
                      {t("serviceKdsRecall")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
        </Modal>
      )}
      {clearOpen && (
        <Modal
          title={t("serviceKdsClearStale").replace("{n}", String(stale))}
          close={() => setClearOpen(false)}
          closeLabel={t("close")}
        >
          <p>
            {t("serviceKdsClearStaleConfirm").replace("{n}", String(stale))}
          </p>
          <div className="row">
            <Button
              variant="primary"
              disabled={busyIds.has("clear")}
              onClick={() =>
                void act("clear", async () => {
                  // SVC-K9: only the station on screen, matching the count.
                  await api("/service/kitchen/clear-stale", {
                    operationId: clearKey.current,
                    station,
                  });
                  clearKey.current = crypto.randomUUID();
                  setClearOpen(false);
                })
              }
            >
              {t("save")}
            </Button>
            <Button variant="ghost" onClick={() => setClearOpen(false)}>
              {t("serviceCancel")}
            </Button>
          </div>
        </Modal>
      )}
      {printOpen && (
        <PrintSettingsDialog
          locale={locale}
          scope="kitchen"
          close={() => setPrintOpen(false)}
        />
      )}
    </div>
  );
}
