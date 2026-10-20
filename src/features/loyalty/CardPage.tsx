import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  CARD_HEADER,
  CARD_TOKEN,
  type CardView,
} from "../../../shared/loyalty-engagement";
import { Button, Field } from "../../components/ui";
import "./loyalty.css";

export default function CardPage() {
  const [es, setEs] = useState(true),
    [token] = useState(() => location.hash.slice(1)),
    [view, setView] = useState<CardView | null>(null),
    [wallet, setWallet] = useState<{ apple: boolean; google: string | null }>({
      apple: false,
      google: null,
    }),
    [error, setError] = useState(""),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const call = async <T,>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`/api/club/card${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { [CARD_HEADER]: token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  const load = async () => {
    setView(await call<CardView>(""));
    setWallet(await call("/wallet"));
  };
  useEffect(() => {
    if (!CARD_TOKEN.test(token)) {
      setError("unauthorized");
      return;
    }
    void load().catch((e) => setError(e.message));
    const timer = setInterval(
      () => void load().catch((e) => setError(e.message)),
      30000,
    );
    return () => clearInterval(timer);
  }, [token]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apple = async () => {
    const r = await fetch("/api/club/card/apple", {
      headers: { [CARD_HEADER]: token },
      referrerPolicy: "no-referrer",
    });
    if (!r.ok) throw Error("loyalty_wallet_pending");
    const url = URL.createObjectURL(await r.blob()),
      a = document.createElement("a");
    a.href = url;
    a.download = "club.pkpass";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const errors: Record<string, [string, string]> = {
    unauthorized: [
      "Esta tarjeta ya no está disponible. Pide una nueva en caja.",
      "This card is no longer available. Ask for a new one at checkout.",
    ],
    loyalty_referral_invalid: [
      "Revisa el código de recomendación.",
      "Check the referral code.",
    ],
    loyalty_referral_used: [
      "Ya se aplicó una recomendación a tu cuenta.",
      "A referral has already been applied to your account.",
    ],
    loyalty_referral_expired: [
      "El plazo de 7 días para recomendaciones terminó.",
      "The 7-day referral window has ended.",
    ],
    loyalty_referrals_disabled: [
      "Las recomendaciones no están activas.",
      "Referrals are not enabled.",
    ],
  };
  return (
    <main className="loyalty-join" lang={es ? "es" : "en"}>
      <Button onClick={() => setEs(!es)}>{es ? "English" : "Español"}</Button>
      {error && (
        <p role="alert" className="error">
          {errors[error]?.[es ? 0 : 1] ??
            (es
              ? "No se pudo completar. Inténtalo de nuevo."
              : "Could not complete. Please try again.")}
        </p>
      )}
      {view && error !== "unauthorized" ? (
        <>
          <h1>{view.programName}</h1>
          <p>{view.restaurantName}</p>
          <section className="loyalty-card">
            <strong>
              {Math.max(0, view.stamps)} / {view.required}{" "}
              {es ? "sellos" : "stamps"}
            </strong>
            <p>
              {view.rewards} {es ? "premios disponibles" : "rewards available"}
            </p>
            <p>{view.rewardDescription}</p>
            <QRCodeSVG
              aria-label={es ? "Código QR de tu tarjeta" : "Your card QR code"}
              value={view.scanCode}
              size={220}
            />
            <p>
              {es ? "Muestra este QR al pagar." : "Show this QR at checkout."}
            </p>
          </section>
          {view.walletEnabled && (
            <div className="loyalty-wallet-actions">
              {wallet.apple && (
                <Button disabled={busy} onClick={() => void action(apple)}>
                  Add to Apple Wallet
                </Button>
              )}
              {wallet.google && (
                <a
                  href={wallet.google}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Add to Google Wallet
                </a>
              )}
              {!wallet.apple && !wallet.google && (
                <p>
                  {es
                    ? "Wallet aún no está disponible. Puedes usar el QR de esta tarjeta."
                    : "Wallet is not available yet. You can use this card’s QR."}
                </p>
              )}
            </div>
          )}
          {view.referralCode && (
            <section>
              <h2>{es ? "Recomienda el club" : "Refer a friend"}</h2>
              <p>
                {es ? "Comparte tu código:" : "Share your code:"}{" "}
                <strong>{view.referralCode}</strong>
              </p>
              <Field
                label={
                  es
                    ? "¿Quién te recomendó? Ingresa su código durante tus primeros 7 días."
                    : "Who referred you? Enter their code within your first 7 days."
                }
              >
                <input
                  value={code}
                  maxLength={16}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
              </Field>
              <Button
                disabled={busy || code.length !== 16}
                onClick={() =>
                  void action(async () => {
                    const r = await call<{ awarded: boolean }>("/referral", {
                      code,
                    });
                    setNotice(
                      r.awarded
                        ? es
                          ? "¡Ambos recibieron sellos!"
                          : "You both received stamps!"
                        : es
                          ? "Esta recomendación ya fue aplicada."
                          : "This referral was already applied.",
                    );
                    setCode("");
                  })
                }
              >
                {es ? "Aplicar código" : "Apply code"}
              </Button>
            </section>
          )}
          {notice && <p role="status">{notice}</p>}
          <label className="check">
            <input
              type="checkbox"
              checked={view.marketingOptIn}
              disabled={busy}
              onChange={(e) => {
                const marketingOptIn = e.currentTarget.checked;
                const previous = view.marketingOptIn;
                setView({ ...view, marketingOptIn });
                void action(async () => {
                  try {
                    await call("/preferences", { marketingOptIn });
                  } catch (error) {
                    setView((v) =>
                      v ? { ...v, marketingOptIn: previous } : v,
                    );
                    throw error;
                  }
                });
              }}
            />
            {es
              ? "Recibir mensajes y recordatorios del club"
              : "Receive club messages and reminders"}
          </label>
          {view.reviewUrl && (
            <p>
              <a
                href={view.reviewUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {es
                  ? "Cuéntanos tu experiencia"
                  : "Tell us about your experience"}
              </a>
            </p>
          )}
          <Button disabled={busy} onClick={() => void action(load)}>
            {es ? "Actualizar saldo" : "Refresh balance"}
          </Button>
        </>
      ) : (
        !error && <p role="status">…</p>
      )}
    </main>
  );
}
