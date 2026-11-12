import { useEffect, useState } from "react";
import { CONFIRM_HEADER, CONFIRM_TOKEN } from "../../../shared/marketing";
import { Button } from "../../components/ui";
import "../loyalty/loyalty.css";

/**
 * The double opt-in page behind the confirmation message. The token stays in the URL
 * fragment and travels only in a header; confirming is an explicit tap, so a link
 * preview or scanner that merely opens the page confirms nothing.
 */
export default function ConfirmPage() {
  const [es, setEs] = useState(true),
    [token] = useState(() => location.hash.slice(1)),
    [state, setState] = useState<"ready" | "busy" | "done" | "invalid">(
      CONFIRM_TOKEN.test(token) ? "ready" : "invalid",
    ),
    [restaurant, setRestaurant] = useState("");
  useEffect(() => {
    document.title = es ? "Confirmar promociones" : "Confirm offers";
  }, [es]);
  const confirm = async () => {
    setState("busy");
    try {
      const r = await fetch("/api/club/marketing/confirm", {
        method: "POST",
        headers: {
          [CONFIRM_HEADER]: token,
          "Content-Type": "application/json",
        },
        body: "{}",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setRestaurant(data.restaurant);
      setState("done");
    } catch {
      setState("invalid");
    }
  };
  return (
    <main className="loyalty-join" lang={es ? "es" : "en"}>
      <Button variant="ghost" onClick={() => setEs(!es)}>
        {es ? "English" : "Español"}
      </Button>
      <h1>{es ? "Promociones del club" : "Club offers"}</h1>
      {state === "invalid" && (
        <p role="alert" className="error">
          {es
            ? "Este enlace no es válido o ya venció. Pide uno nuevo en el restaurante."
            : "This link is not valid or has expired. Ask the restaurant for a new one."}
        </p>
      )}
      {(state === "ready" || state === "busy") && (
        <>
          <p>
            {es
              ? "Confirma que este teléfono es tuyo y que quieres recibir promociones del restaurante. Puedes darte de baja cuando quieras respondiendo STOP."
              : "Confirm this phone is yours and that you want to receive the restaurant's offers. You can unsubscribe at any time by replying STOP."}
          </p>
          <Button
            variant="primary"
            disabled={state === "busy"}
            onClick={() => void confirm()}
          >
            {es ? "Sí, quiero recibir promociones" : "Yes, send me offers"}
          </Button>
        </>
      )}
      {state === "done" && (
        <p role="status">
          {es
            ? `Listo. Recibirás promociones de ${restaurant}.`
            : `Done. You will receive offers from ${restaurant}.`}
        </p>
      )}
    </main>
  );
}
