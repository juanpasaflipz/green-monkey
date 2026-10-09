/**
 * Vender's club state (038 §2.5), kept out of Selling's money paths: the member chosen for the
 * cart (an id and a summary, never more personal data), the once-per-cart-cycle prompt, the
 * link once the order exists (fire-and-forget, 3 s), and the after-payment link, reconcile and
 * toast (hung on payments' onPaymentSettled exit, R18). Nothing here can block "Cobrar": every
 * call is online-only and its failure is a notice.
 */
import { useEffect, useRef, useState } from "react";
import type { Locale, Order, Session } from "../../../shared/domain";
import type { MemberSummary, OrderLoyaltyView } from "../../../shared/loyalty";
import { isServerOrder } from "../../offline-records";
import {
  forgetLoyaltyReceipt,
  loyaltyApi,
  prefetchLoyaltyReceipt,
  trackLoyaltyReceiptWork,
  useLoyaltyClub,
} from "./loyaltyApi";
import { fill, tr } from "./format";

const LINK_BUDGET_MS = 3000;

/**
 * The member of each unsent cart, by its draft's operationId (§2.5: a parked draft keeps its
 * member). In memory only: after a reload a restored cart starts without one.
 */
const draftMembers = new Map<string, MemberSummary>();

export function useLoyaltyCheckout({
  session,
  locale,
  online,
  lines,
  current,
  context,
  draftId,
}: {
  session: Session;
  locale: Locale;
  online: boolean;
  /** Lines in the cart (unsent). */
  lines: number;
  current: Order | null;
  /** Selling's replaceContext count: the cart moved to another order or a new cart. */
  context: number;
  /** The cart's draft (its operationId). */
  draftId: string;
}) {
  const t = tr(locale);
  const club = useLoyaltyClub(session, online);
  const [member, setMember] = useState<MemberSummary | null>(null);
  const [prompt, setPrompt] = useState(false);
  const [notice, setNotice] = useState("");
  /** The cart cycle already prompted (or the cashier chose "Sin club"). */
  const prompted = useRef(false);
  /** Orders this cart linked to its member (id → member id). */
  const linked = useRef(new Map<string, string>());
  const currentId = current && isServerOrder(current) ? current.id : null;
  const previous = useRef<{ id: string | null; context: number }>({
    id: currentId,
    context,
  });
  // A new cart (no order, no lines) starts a new cycle; a resumed order shows its member. The
  // cart's member stays when its first send creates the order; any other move (a resumed check,
  // Borradores, Nueva orden, a table, send as new) starts without it, or with the member the
  // restored draft was parked with (LOYALTY-UX-2).
  useEffect(() => {
    const before = previous.current;
    previous.current = { id: currentId, context };
    if (before.context !== context) {
      const parked = currentId ? null : (draftMembers.get(draftId) ?? null);
      setMember(parked);
      // A restored cart with lines was prompted when it was rung.
      prompted.current = lines > 0;
    } else if (before.id && before.id !== currentId) setMember(null);
    if (!currentId) {
      if (lines === 0) {
        prompted.current = false;
        setMember(null);
      }
      return;
    }
    if (!club || !online) return;
    let live = true;
    loyaltyApi
      .order(currentId)
      .then((v) => {
        if (!live) return;
        if (v.member) {
          linked.current.set(currentId, v.member.id);
          setMember(v.member.deleted ? null : v.member);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [currentId, context, club?.enabled, online, lines === 0]);
  // The automatic prompt: once per cart cycle, at the first line of a new cart with no member.
  useEffect(() => {
    if (
      club?.promptAtCheckout &&
      online &&
      !currentId &&
      lines > 0 &&
      !member &&
      !prompted.current
    ) {
      prompted.current = true;
      setPrompt(true);
    }
  }, [lines, currentId, member, club?.promptAtCheckout, online]);

  async function link(orderId: string, m: MemberSummary, budget?: number) {
    if (linked.current.get(orderId) === m.id) return true;
    try {
      await loyaltyApi.link(orderId, m.id, budget);
      linked.current.set(orderId, m.id);
      forgetLoyaltyReceipt(orderId);
      return true;
    } catch {
      setNotice(t("loyaltyLinkFailed"));
      return false;
    }
  }

  return {
    club,
    member,
    prompt,
    notice,
    clearNotice: () => setNotice(""),
    openPrompt: () => {
      prompted.current = true;
      setPrompt(true);
    },
    closePrompt: () => setPrompt(false),
    /** "Usar" / "Registrar": the cart's member. A sent order is linked now. */
    use(m: MemberSummary) {
      setMember(m);
      setPrompt(false);
      setNotice("");
      if (currentId) void link(currentId, m, LINK_BUDGET_MS);
      else draftMembers.set(draftId, m);
    },
    /** "Quitar cliente": before sending, just the cart; on an open check, the link too. */
    remove() {
      const was = member;
      setMember(null);
      draftMembers.delete(draftId);
      if (currentId && was && linked.current.get(currentId) === was.id)
        void loyaltyApi
          .change(currentId, null, was.id)
          .then(() => linked.current.delete(currentId))
          .catch(() => setNotice(t("loyaltyLinkFailed")));
    },
    /** After a send created or reached the order (fire-and-forget, 3 s). */
    afterOrderExists(o: Order) {
      if (member && club && online && isServerOrder(o))
        void link(o.id, member, LINK_BUDGET_MS);
    },
    /**
     * payments' onPaymentSettled exit (R18): link if the order is not linked yet (a create-and-pay
     * collect), then reconcile and return the toast. Never throws.
     */
    async afterPayment(o: Order): Promise<string> {
      if (!club || !online || !isServerOrder(o)) return "";
      // A walk-in's receipt reads its own block (the join QR); a member's receipt waits for the
      // link and the reconcile, then reads the counts they left (LOYALTY-OPS-1/UX-1).
      if (!member && !linked.current.has(o.id)) return "";
      let view: OrderLoyaltyView;
      const work = (async () => {
        if (member && !(await link(o.id, member))) return null;
        const v = await loyaltyApi.reconcile(o.id);
        forgetLoyaltyReceipt(o.id);
        void prefetchLoyaltyReceipt(o.id);
        return v;
      })();
      trackLoyaltyReceiptWork(o.id, work);
      try {
        const v = await work;
        if (!v) return t("loyaltyLinkFailed");
        view = v;
      } catch {
        return "";
      }
      const m = view.member;
      if (!m || !view.settled) return "";
      if (view.completed > 0)
        return fill(t("loyaltyCardCompleted"), { name: m.firstName, rewards: m.rewards });
      if (view.earned <= 0) return t("loyaltyNoStamps");
      return fill(t(view.earned === 1 ? "loyaltyStampAddedOne" : "loyaltyStampAddedMany"), {
        name: m.firstName,
        n: view.earned,
        stamps: m.stamps,
        required: m.required,
      });
    },
  };
}
