import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Clock, Printer, Volume2, VolumeX, RotateCcw } from "lucide-react";
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

type Station = "all" | "kitchen" | "bar";
type FullFeed = Extract<KitchenFeed, { unchanged: false }>;
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
  if (r.state === "ready") return { state: "completed", label: "serve" } as const;
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
  /** Slot rendered above the tickets (offline 026 passes its review lane). */
  beforeTickets?: ReactNode;
}) {
  const t = (k: Key) => strings[locale][k];
  const role = session.role;
  const manager = ["owner", "manager"].includes(role);
  const [station, setStation] = useStoredState<Station>("gm-kds-station", "all", isStation);
  const [sound, setSound] = useStoredState<"on" | "off">("gm-kds-sound", "off", isSound);
  const [feed, setFeed] = useState<FullFeed | null>(null);
  const [newIds, setNewIds] = useState<Map<string, number>>(new Map());
  const [announcement, setAnnouncement] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [audioState, setAudioState] = useState<string>("none");
  const [recentOpen, setRecentOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [printSettings] = usePrintSettings();
  const version = useRef<number | null>(null);
  const lastFull = useRef(0);
  const offset = useRef(0);
  const seenRounds = useRef<Set<string> | null>(null);
  const seenVoids = useRef<Set<string>>(new Set());
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
      seenRounds.current = null;
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
    const voidIds = r.rounds.flatMap((x) => x.pendingVoids.map((v) => v.id));
    if (seenRounds.current === null) {
      // The first load of a station fills the seen sets silently.
      seenRounds.current = new Set(r.rounds.map((x) => x.id));
      seenVoids.current = new Set(voidIds);
      return;
    }
    const fresh = r.rounds.filter((x) => !seenRounds.current!.has(x.id));
    const voided = r.rounds.filter((x) =>
      x.pendingVoids.some((v) => !seenVoids.current.has(v.id)),
    );
    for (const x of fresh) seenRounds.current.add(x.id);
    for (const id of voidIds) seenVoids.current.add(id);
    const messages = [
      ...fresh.map((x) =>
        t("serviceKdsAnnounce")
          .replace("{n}", String(x.orderNumber))
          .replace("{r}", String(x.roundNumber)),
      ),
      ...voided.map((x) =>
        t("serviceKdsVoidAnnounce").replace("{n}", String(x.orderNumber)),
      ),
    ];
    if (messages.length) setAnnouncement(messages.join(". "));
    if (fresh.length) {
      const until = Date.now() + NEW_MS;
      setNewIds((old) => {
        const next = new Map(old);
        for (const x of fresh) next.set(x.id, until);
        return next;
      });
      if (soundRef.current === "on") beep(audio.current, 880, 2);
      if (settingsRef.current.kdsAutoPrint)
        void printDocument(
          fresh.map((x) => (
            <KitchenTicketDocument
              key={x.id}
              ticket={ticketFromKitchenRound(x)}
              locale={locale}
              timezone={zone}
            />
          )),
          settingsRef.current.paper,
        );
    } else if (voided.length && soundRef.current === "on") beep(audio.current, 440, 2);
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
    const wake = (navigator as Navigator & {
      wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
    }).wakeLock;
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

  async function enableSound() {
    // Autoplay policy: the context is created or resumed inside the tap.
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      audio.current ??= new Ctor();
      await audio.current.resume();
      setAudioState(audio.current.state);
      setSound("on");
      beep(audio.current, 880, 1);
    } catch {
      setAudioState("blocked");
    }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await fn();
      setActionError("");
    } catch (e) {
      setActionError(translateError((e as Error).message, locale));
    } finally {
      setBusyId(null);
      poll.refresh();
    }
  }

  const rounds = feed?.rounds ?? [];
  const recent = feed?.recent ?? [];
  const stale = rounds.filter(
    (r) => feed && r.businessDate < feed.currentBusinessDate,
  ).length;
  const lastSuccess = poll.lastSuccess;
  const staleFeed = lastSuccess ? now - lastSuccess > STALE_MS : poll.failing;
  const soundBlocked =
    sound === "on" && audioState !== "running";
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
        {manager && stale > 0 && (
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
      {feed?.truncated && <p className="muted">{t("serviceKdsTruncated")}</p>}
      {beforeTickets}
      <div className="kitchen-grid">
        {rounds.map((r) => {
          const age = Math.max(
            0,
            Math.floor((now + offset.current - Date.parse(r.createdAt)) / 60000),
          );
          const tone = age >= 20 ? "red" : age >= 10 ? "amber" : "neutral";
          const isNew = newIds.has(r.id);
          const action = actionFor(r);
          const allowed =
            action &&
            (action.state === "completed" ? canServe : canProgress);
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
                  {isNew && <Badge tone="green">{t("serviceKdsNew")}</Badge>}
                  {r.channel !== "pos" && (
                    <Badge tone="amber">{channelLabel(r.channel, locale)}</Badge>
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
                <div className={"ticket-note" + (orderAllergy ? " allergy" : "")}>
                  <strong>
                    {orderAllergy ? t("serviceKdsAllergy") : t("serviceKdsOrderNote")}
                  </strong>{" "}
                  {r.orderNote}
                </div>
              )}
              {r.roundNote && r.roundNote !== r.orderNote && (
                <div className={"ticket-note" + (roundAllergy ? " allergy" : "")}>
                  <strong>
                    {roundAllergy ? t("serviceKdsAllergy") : t("serviceKdsRoundNote")}
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
                        <p className={"ticket-note line" + (allergy ? " allergy" : "")}>
                          {allergy && <strong>{t("serviceKdsAllergy")} </strong>}
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
                      {v.quantity} × {v.name[locale]} · {v.reason}
                    </p>
                  ))}
                  {canAckVoids && (
                    <Button
                      className="full"
                      disabled={busyId === r.id}
                      onClick={() =>
                        void act(r.id, () =>
                          api("/kitchen/" + r.id + "/voids/ack", {
                            operationId: crypto.randomUUID(),
                          }),
                        )
                      }
                    >
                      {t("kitchenVoidAck")}
                    </Button>
                  )}
                </div>
              )}
              <p>{t(r.state === "ready" ? "ready" : r.seenAt ? "seen" : "sent")}</p>
              {action && allowed && (
                <Button
                  variant="primary"
                  className="full"
                  disabled={busyId === r.id}
                  onClick={() =>
                    void act(r.id, () =>
                      api("/kitchen/" + r.id, {
                        operationId: crypto.randomUUID(),
                        state: action.state,
                      }),
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
                      disabled={busyId === r.id}
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
          <p>{t("serviceKdsClearStaleConfirm").replace("{n}", String(stale))}</p>
          <div className="row">
            <Button
              variant="primary"
              disabled={busyId === "clear"}
              onClick={() =>
                void act("clear", async () => {
                  await api("/service/kitchen/clear-stale", {
                    operationId: clearKey.current,
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
