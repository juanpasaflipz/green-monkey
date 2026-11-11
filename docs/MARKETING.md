# Guest marketing on the club

Status on November 11, 2026: implemented on `track/marketing` (migration 047) and
verified locally with `npm test` (`tests/marketing.test.ts`),
`npm run test:db:marketing` and `tests/browser/marketing.spec.ts`. Not staged. No
provider was used: every send in the tests goes to a fake, and **no real message has
been sent**. Bundled here because marketing writes to club members; read
[LOYALTY.md](LOYALTY.md) first.

Campaigns and daily automated messages for club members, by SMS or WhatsApp. There is
one customer list (the club's members); marketing adds no second one. Promo codes and
scheduled offers are not part of this area (DISCOUNTS.md "Limitations").

## Who can be reached

A member receives marketing only when **all** of these hold, checked when the message
is queued and again under the row lock when it is sent:

- the club is on, the restaurant is on Pro and marketing is switched on
  (**Configuración › Club de lealtad › Marketing**);
- the member is not deleted and `marketing_opt_in` is true;
- the member **confirmed the current phone** (double opt-in, LOYALTY-PRIVACY-7).

Double opt-in: once a day, members who opted in and have no confirmation get one SMS
with a link to `/club/confirm#<token>`. The token lives in the URL fragment, travels in
the `x-gm-marketing-token` header, is stored only as a SHA-256 digest and expires after
30 days. Confirming is an explicit tap on the page, so a link preview confirms nothing.
The confirmation is bound to the phone's digest: a changed phone, a withdrawn opt-in or
an ARCO/retention deletion removes it (trigger `marketing_confirmation_void`, the only
writer allowed to delete). Every SMS ends with the STOP instruction; Twilio's Messaging
Service must have STOP handling configured, as for the club's own messages.

## Campaigns

Name, ordered channels, a message with `{{name}}` (first name) and `{{restaurant}}`,
and an optional segment: visits, spend, recency, joined, order channel. Visit figures
come from orders linked to the member plus the imported POS Lite figures. Each member
gets one message on the first selected channel that is enabled. Send now or schedule;
cancelling stops anything still queued. Launching needs a recent sign-in (step-up).

## Daily automations

Evaluated once per restaurant per local day after the configured hour (job
`marketing_daily`, fenced by `marketing_runs`), over the window since the previous run,
capped at 72 hours. In priority order: big spender, repeat guest (every N visits), miss
you (N days), drive QR orders, drive dine-in, visit follow-up. A member qualifies only
by an event inside the window, so switching one on never writes about old visits, and
receives at most one automated message per frequency period (default 30 days).

Deliberately absent: a welcome (the club sends its own), "invite to the club"
(non-members have no contact) and review requests conditioned on a rating (LOYALTY.md
"Reviews").

## Delivery

`marketing_message` runs only on the jobs login, where provider keys live
(`server/marketing-worker`). Rows and jobs carry opaque ids: no phone, name or text is
stored. An explicit provider rejection is `failed`; a lost answer or HTTP 5xx is
`unknown` and is never sent again. SMS delivery status is polled like the club's.

| Channel | Web and worker | Worker only |
| --- | --- | --- |
| SMS | `MARKETING_SMS_SEND=1` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` |
| WhatsApp | `MARKETING_WHATSAPP_SEND=1` | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `WHATSAPP_MARKETING_TEMPLATE` |

The switches are not secrets and must match on both processes; with a switch on and a
key missing the job blocks (`marketing_<channel>_not_configured`). The confirmation
link needs an HTTPS `APP_URL` on the worker. The WhatsApp template must be approved by
Meta with three body parameters: first name, restaurant, message. Confirmations are
SMS only.

## Results

An estimate, labelled as one: an order linked to a member counts for the last message
sent to that member within the attribution window (default 7 days) before the order;
each order counts once.

## Data model (047)

`marketing_settings`, `marketing_confirmations`, `marketing_campaigns` (one-off
campaigns and one row per automation), `marketing_messages`, `marketing_runs`. RLS and
FORCE on all; no DELETE grant to any login. The runtime role cannot change a message's
provider fields; the jobs login cannot create campaigns, confirm a phone or change
settings. Operations appear in Bitácora under the club.

## Limitations (deferred)

- No inbound webhook: an SMS STOP is honoured by Twilio but is not written back to
  `marketing_opt_in`; WhatsApp opt-outs and delivery receipts are not read.
- No email (members have no address), no promo codes, no month-plan assistant.
- Strings in the panel are inline Spanish/English like the engagement panel, not keys.
- Not run: Neon, staging, the full qualification, WebKit, or any real provider.
- Counsel has not reviewed the confirmation wording or REPEP obligations.
