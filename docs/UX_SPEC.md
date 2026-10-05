# Green Monkey UX specification

This is the proposed design, not a measured evaluation of the existing screens. Validate the workflows with representative tasks and compare with source baselines where those can be run safely.

## Design system

| Token | Starting value / behavior |
| --- | --- |
| Canvas | `#F6F7F2` |
| Surface | `#FFFFFF` |
| Primary text | `#17251D` |
| Secondary text | `#536258` |
| Border | `#DCE3DA` |
| Primary action | `#166534`, white text |
| Selected background | `#E7F3E8`, dark green text |
| Warning | `#92400E` on `#FFF3D6` |
| Danger | `#B42318` on `#FEECE9` |
| Information | `#1D4ED8` on `#EFF6FF` |
| Type | Locally served Inter or a system sans fallback; tabular numerals for money/timers |
| Sizes | 14px secondary, 16px operational body, 20–24px section titles, 28–36px payment total |
| Spacing | 4/8/12/16/24/32px scale |
| Controls | Primary operational targets ≥48px; rounded corners around 8–12px |
| Motion | Short, functional transitions; reduced-motion alternative; no delayed success effects |

Verify contrast for actual combinations, disabled states, focus rings, and tenant branding. Never recolor paid/failed/warning semantics from a restaurant's brand color. Dark KDS mode is useful but must be designed and tested independently.

Accessibility target: keyboard-operable flows, focus containment/restoration for dialogs, visible unobscured focus, status text beyond color, accessible authentication, and labeled validation under [WCAG 2.2](https://www.w3.org/TR/WCAG22/). The 48px primary touch target is a product target; do not confuse it with the standard's minimum criterion.

## Workspace structure

| Role | Landing view | Primary navigation | Important scope cue |
| --- | --- | --- | --- |
| Cashier | Vender | Vender / Órdenes / Mesas / Caja | Restaurant, device, employee, drawer, connection |
| Server | Mesas or Vender, configurable | Mesas / Vender / Órdenes | Active table and waiter |
| Kitchen/bar | Station queue | En preparación / Listos / Recientes | Station and connection/last update |
| Manager | Operación | Operational controls plus allowed management | Restaurant and shift |
| Owner | Hoy | Hoy / Operación / Menú e inventario / Finanzas / Equipo / Configuración | Restaurant selector or explicit organization scope |

Avoid showing administrative navigation while a cashier takes payment. Offer a visible workspace switch for people with multiple roles. Do not make role detection rely solely on screen width.

Access screens (built; [ACCESS.md](ACCESS.md)):
- **Unpaired browser:** "Vincular este dispositivo" takes a pairing code; the owner's Google entry appears only where allowed (never on a terminal).
- **PIN pad:** a paired device shows the restaurant and device name, then "¿Quién entra?" with the active staff list; the employee taps their name and enters their PIN on an on-screen keypad (no system keyboard).
- **Lock screen** ("Pantalla bloqueada"): shown after the auto-lock, from "Bloquear pantalla" in the header, or when the server ends the session. The workspace stays mounted behind it; the same employee's PIN resumes the cart and open dialogs, another employee's PIN starts their own session. Offline, the locked employee may "Continuar como {name}" while the device's offline window is valid.
- **Step-up** ("Confirma con tu PIN"): one shared dialog before sensitive commands on terminals; the command is retried unchanged after the PIN.
- **Manager approval:** a void needing approval asks for "Gerente que autoriza" and "PIN del gerente" in the same dialog.
- **Equipo** and **Dispositivos** (Configuración): staff with PIN reset, deactivation and unlock; devices with kind, last activity, auto-lock, end session and unpair, plus the pairing-code dialog.

## Selling layout

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Green Monkey   Sucursal Centro   Ana · Caja abierta    Conectado     │
├────────┬──────────────────────────────────┬──────────────────────────┤
│ Vender │ Buscar producto…             /  │ Para llevar       #128  │
│ Órdenes│ Todos  Tacos  Bebidas  Favoritos │ Cliente / nombre         │
│ Mesas  ├──────────────────────────────────┤──────────────────────────┤
│ Caja   │ Product cards: name, price,     │ 2 Tacos de asada   $90.00│
│        │ concise availability, optional  │   Sin cebolla      Editar│
│        │ image. Required choices appear  │ 1 Agua fresca     $35.00│
│        │ only after selection.           │                          │
│        │                                  │ Nota · Descuento · Más  │
│        │                                  │ Total            $125.00│
│        │                                  │ [Enviar] [Cobrar $125]  │
└────────┴──────────────────────────────────┴──────────────────────────┘
```

In counter-service mode, `Cobrar` can include dispatch after payment according to the restaurant's service policy. In table-service mode, `Enviar a cocina` and `Cobrar` are separate. Label the action's effect clearly. Draft, sent, additional round, paid, and synchronization state remain visible on each ticket.

At widths below roughly 1100px, compact the rail and catalog grid. Use available space and content constraints rather than user-agent guessing. At mobile width, provide catalog/cart switching, a sticky `Ver orden · 3 productos · $125.00`, and a large payment action in the cart. Do not squeeze three desktop columns onto a phone.

## Interaction contracts

| Task | Contract | Product target |
| --- | --- | --- |
| Add ordinary product | Tap card → quantity appears in persistent cart | One activation, local feedback within 100ms on reference hardware |
| Required modifiers | Drawer shows required groups, price delta, confirm | One drawer; no nested modal chain |
| Edit line | Tap line → quantity/modifiers/notes in one place | Preserve all unsaved choices on validation failure |
| Park/resume | Name/table optional; persistent draft list | At most two activations each from selling |
| Exact-cash sale | After item selection: Cobrar → Efectivo/exacto → Confirmar | At most three primary activations, receipt optional |
| Payment pending | Amount/method/terminal state/recovery visible | No second charge button until reconciliation permits it |
| Partial split | Show paid allocations and remaining balance | Restart/reload preserves successful allocations |
| Table round | Add items to existing table; send only changes | No duplicated earlier kitchen items |
| Refund | Select original items/amount, reason, disposition, approval | One guided sequence with clear financial result |
| Mark kitchen ticket ready | One deliberate action | Immediate pending feedback; server-acknowledged result |
| Close drawer | Count → explain discrepancy → confirm → summary | Four clear steps; draft survives interruptions |
| Review owner anomaly | Alert → evidence → corrective action | At most two navigations to underlying records |

Measure targets under the test conditions in ACCEPTANCE.md. Provider waiting time and numeric entry are reported separately from navigation steps. Never remove required controls merely to improve a tap count.

## Payment workspace

Display amount due, order identification, paid-to-date, and balance above the method selector. Cash shows exact amount shortcut, common denomination buttons, numeric input, and change. External-terminal mode says `Confirma que la terminal externa aprobó el pago` and records the selected terminal/operator. Integrated terminal mode shows terminal name, submitted amount, waiting/result, and a safe status-check action.

For a timeout, use `Estamos verificando el pago. No vuelvas a cobrar todavía.` Preserve the pending attempt and recover after reload. Failed/cancelled attempts can retry only when the previous attempt's state is resolved. Refunds may remain pending when the provider response is uncertain.

Split mode supports amount and item quantities, deterministic remainder handling, tips, and mixed methods. Show each successful allocation separately. A payer failure does not undo earlier successful payments. Grouped settlement retains the original order and kitchen identities.

## Tables and kitchen

Tables use a clear list/grid with name, party/order count if recorded, waiter, elapsed time, amount due, and status text. A graphical floor plan is optional; keyboard access and a list view are required. Moving/merging tables preserves order lineage and permissions.

Kitchen tickets emphasize item quantities, modifiers, notes, table/call name, round, age, and source. Payment status is a separate badge. Filter by station; don't hide active orders just because another payment method created them. Changed/voided lines show a visible delta and acknowledgement. Deduplicate sounds and dispatch. Show a stale-data banner when the feed stops. Cancellation after preparation is an explicit exception, not an invisible deletion.

## Inventory and owner screens

Inventory has task tabs: Existencias, Recibir, Preparación, Conteo, Mermas. A stock row shows unit, available/prepared quantity, threshold, recent movement, and action. Count entry keeps focus in a rapid-entry sequence, supports partial saved counts, and previews variance reasons before posting adjustments.

Menu editing combines product price, recipe cost, modifiers, availability, and channel visibility with clear subsections. Duplicate products and unresolved ingredient matches require review. Show cost coverage before presenting margin as complete.

`Hoy` begins with a short operational summary and the few metrics needed today: net sales, order count/average ticket, estimated contribution or margin with coverage, and cash discrepancy when applicable. Follow with actionable exceptions and sales trends. Selecting a number opens filtered underlying records. Financial views share the same date/source/restaurant filters and metric definitions.

Forecasts show actuals distinctly from projections, editable sales/cost assumptions, missing-data messaging, and profit derived from the displayed inputs. Avoid unsupported confidence percentages or guaranteed dates.

## States and copy

Design every main screen for initial loading, empty data, partial data, validation errors, authorization failure, lost connection, stale data, retry, and success. Keep destructive actions apart from frequent ones. Preserve useful input after errors.

| Situation | Suggested Spanish copy |
| --- | --- |
| Offline cash saved | `Venta guardada en este dispositivo. Pendiente de sincronizar.` |
| Offline order has not reached kitchen | `Cocina aún no recibió esta orden.` |
| Failed print | `La venta está cobrada. No se pudo imprimir el ticket.` |
| Out of stock | `Sin existencias de asada. Elige una sustitución o solicita autorización.` |
| Incomplete costs | `Margen estimado: faltan costos en 3 productos.` |
| No forecast history | `Aún no hay suficientes semanas completas para proyectar.` |
| Unsynced tenant switch | `Hay ventas pendientes de esta sucursal. Se conservarán para su conciliación.` |

Provide equally complete English translations. Do not expose internal exception strings, database table names, or provider implementation details to operators.
