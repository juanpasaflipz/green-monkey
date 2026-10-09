import type { Locale } from "../../../shared/domain";
import type {
  CorteDocument,
  DayCorteDocument as DayCorte,
  ExceptionKind,
} from "../../../shared/reports";
import { strings } from "../../i18n";
import { tenderMethodLabel } from "../../labels";
import { platformLabel } from "../../../shared/payments";
import {
  DocFooter,
  DocHeader,
  DocRow,
  DocRule,
  DocSection,
  DocSignature,
} from "../printing/layout";
import {
  dateLabel,
  dateTimeLabel,
  differenceLabel,
  fill,
  folioText,
  money,
  pct,
} from "./format";
import { summarySections } from "./summary-rows";
import { CfdiCorteCoverage, corteCoverageOf } from "../cfdi/CfdiCorteCoverage";
import "./reports.css";

/** A deduction printed with a leading minus ("−$90.00"); zero prints plain. */
const minus = (m: (n: number) => string, n: number) =>
  n === 0 ? m(0) : "−" + m(Math.abs(n));

/**
 * Corte X (open drawer, partial reading), corte Z (closed drawer, as of close) or the blind count
 * slip, in the device's UI language (an internal document, spec §2.6). Every row is a DocRow, so
 * acceptance binds the label cell exactly (§5.8). The blind variant renders what the server sent:
 * no expected cash, cash sales, refunds, paid-outs or difference.
 */
export function DrawerCorteDocument({
  doc,
  locale,
}: {
  doc: CorteDocument;
  locale: Locale;
}) {
  const t = strings[locale];
  const m = money(doc.restaurant.currency, locale);
  const zone = doc.restaurant.timezone;
  const z = doc.kind === "z";
  const blind = doc.visibility === "blind";
  const title = !z
    ? t.reportsDocCorteX
    : blind
      ? t.reportsDocCountSlip
      : t.reportsDocCorteZ;
  const d = doc.drawer;
  const lines = [
    ...(z && doc.zNumber !== null
      ? [fill(t.reportsDocZNumber, { n: doc.zNumber })]
      : []),
    fill(t.reportsDocDrawer, { device: d.deviceName }),
    fill(t.reportsDocOpened, {
      name: d.openedByName,
      time: dateTimeLabel(d.openedAt, zone, locale),
    }),
    ...(d.closedAt
      ? [
          fill(t.reportsDocClosed, {
            name: d.closedByName ?? "—",
            time: dateTimeLabel(d.closedAt, zone, locale),
          }),
        ]
      : []),
    fill(t.reportsDocBusinessDay, { date: dateLabel(d.businessDate, locale) }),
    ...(z && d.countMode
      ? [
          fill(t.reportsDocCountMode, {
            mode:
              d.countMode === "blind"
                ? t.reportsDocCountBlind
                : t.reportsDocCountVisible,
          }),
        ]
      : []),
    fill(t.reportsDocPrinted, {
      time: dateTimeLabel(doc.printedAt, zone, locale),
      name: doc.printedByName,
    }),
  ];
  const cash = doc.cash;
  const differenceKey =
    cash?.difference === null || cash?.difference === undefined
      ? null
      : cash.difference < 0
        ? t.reportsDocDifferenceShort
        : cash.difference > 0
          ? t.reportsDocDifferenceOver
          : t.reportsDocDifferenceExact;
  return (
    <div className={"report-doc corte-doc" + (blind ? " blind" : "")}>
      <DocHeader
        name={doc.restaurant.name}
        title={title}
        flag={
          // A corte Z or count slip describes a closed drawer, so its second print is a copy
          // (spec §2.6.2). Every corte X is a new partial reading with new figures, never a
          // reprint, even though its prints are numbered too (RPT-R20).
          z && doc.printNumber !== null && doc.printNumber > 1
            ? fill(t.reportsDocReprint, { n: doc.printNumber })
            : undefined
        }
        lines={lines}
      />
      <DocRule />
      {cash ? (
        <DocSection title={t.reportsDocCash}>
          <DocRow label={t.reportsDocOpening} value={m(cash.opening)} />
          <DocRow label={t.reportsDocCashSales} value={m(cash.sales)} />
          <DocRow label={t.reportsDocCashTips} value={m(cash.tips)} />
          <DocRow
            label={t.reportsDocCashRefunds}
            value={minus(m, cash.refunds)}
          />
          <DocRow
            label={t.reportsDocPaidOuts}
            value={minus(m, cash.paidOuts)}
          />
          {cash.payIns !== 0 && (
            <DocRow label={t.reportsDocPayIns} value={m(cash.payIns)} />
          )}
          <DocRow
            label={t.reportsDocExpected}
            value={m(cash.expected)}
            strong
          />
          {z && cash.counted !== null && (
            <DocRow
              label={t.reportsDocCounted}
              value={m(cash.counted)}
              strong
            />
          )}
          {z && differenceKey && cash.difference !== null && (
            <DocRow label={differenceKey} value={m(cash.difference)} strong />
          )}
          {z && cash.reason && (
            <p className="doc-meta">
              {fill(t.reportsDocExplanation, { text: cash.reason })}
            </p>
          )}
          {z && doc.review && (
            <p className="doc-meta">
              {fill(t.reportsDocReview, {
                name: doc.review.reviewerName,
                text: doc.review.note,
              })}
            </p>
          )}
        </DocSection>
      ) : (
        <DocSection title={t.reportsDocCash}>
          <DocRow
            label={t.reportsDocCounted}
            value={doc.counted === null ? "—" : m(doc.counted)}
            strong
          />
        </DocSection>
      )}
      <DocRule />
      <DocSection title={t.reportsDocTerminal}>
        <DocRow
          label={fill(t.reportsDocTerminalSales, { n: doc.terminal.count })}
          value={m(doc.terminal.sales)}
        />
        <DocRow label={t.reportsDocTerminalTips} value={m(doc.terminal.tips)} />
        <DocRow
          label={t.reportsDocTerminalRefunds}
          value={minus(m, doc.terminal.refunds)}
        />
        <DocRow
          label={t.reportsDocTerminalNet}
          value={m(doc.terminal.net)}
          strong
        />
        {doc.terminal.reported !== null && (
          <DocRow
            label={t.reportsDocTerminalReported}
            value={m(doc.terminal.reported)}
          />
        )}
        {doc.terminal.difference !== null && (
          <DocRow
            label={`${t.reportsDocTerminalDifference} (${differenceLabel(doc.terminal.difference, locale).toLowerCase()})`}
            value={m(doc.terminal.difference)}
          />
        )}
        {/* payments (037): by terminal once a named terminal took money in this drawer. */}
        {(doc.terminals ?? []).some((x) => x.terminalId) &&
          (doc.terminals ?? []).map((x) => (
            <div key={x.terminalId ?? "other"}>
              <DocRow
                label={`${x.label ?? t.payOtherTerminal} (${x.count})`}
                value={m(x.net)}
              />
              {x.reported !== null && (
                <DocRow label={`· ${t.cashBatchTotal}`} value={m(x.reported)} />
              )}
              {x.difference !== null && x.difference !== 0 && (
                <DocRow
                  label={`· ${t.cashBatchDifference}`}
                  value={m(x.difference)}
                />
              )}
              {x.kioskCount > 0 && (
                <DocRow
                  label={`· ${fill(t.cashKioskSales, { count: x.kioskCount, amount: m(x.kioskAmount) })}`}
                  value=""
                />
              )}
              {x.fees !== undefined && x.fees > 0 && (
                <DocRow label={`· ${t.cashTerminalFees}`} value={m(x.fees)} />
              )}
            </div>
          ))}
      </DocSection>
      {(doc.platforms ?? []).length > 0 && (
        <>
          <DocRule />
          <DocSection title={t.cashPlatforms}>
            {(doc.platforms ?? []).map((x) => (
              <div key={`${x.platform}:${x.label ?? ""}`}>
                <DocRow
                  label={`${platformLabel(x.platform, x.label, locale)} (${x.count})`}
                  value={m(x.net)}
                />
                {x.commission !== undefined && x.commission > 0 && (
                  <DocRow
                    label={`· ${t.payReportsCommission}`}
                    value={m(x.commission)}
                  />
                )}
              </div>
            ))}
          </DocSection>
        </>
      )}
      <DocRule />
      <DocSection title={t.reportsDocPayments}>
        <DocRow
          label={t.reportsDocPaymentsCount}
          value={String(doc.payments)}
        />
      </DocSection>
      {doc.controls && (
        <>
          <DocRule />
          <DocSection title={t.reportsDocControls}>
            {(
              [
                ["reportsDocControlDiscounts", doc.controls.discounts],
                ["reportsDocControlRefunds", doc.controls.refunds],
                ["reportsDocControlPaidOuts", doc.controls.paidOuts],
              ] as const
            ).map(([key, c]) => (
              <p className="doc-meta" key={key}>
                {fill(t.reportsDocControlLine, {
                  label: t[key],
                  n: c.count,
                  amount: m(c.amount),
                })}
              </p>
            ))}
            {doc.folios.length ? (
              doc.folios.map((f) => (
                <p className="doc-meta" key={f.series + ":" + f.first}>
                  {folioText(f, locale)}
                </p>
              ))
            ) : (
              <p className="doc-meta">{t.reportsDocNoFolios}</p>
            )}
          </DocSection>
        </>
      )}
      {z && doc.lateCash > 0 && (
        <p className="doc-meta">
          {fill(t.reportsDocLateCash, { amount: m(doc.lateCash) })}
        </p>
      )}
      {z && doc.lateTerminal > 0 && (
        <p className="doc-meta">
          {fill(t.reportsDocLateTerminal, { amount: m(doc.lateTerminal) })}
        </p>
      )}
      {!z && <p className="doc-meta">{t.reportsDocPartialNote}</p>}
      {blind && <p className="doc-meta">{t.reportsDocBlindNote}</p>}
      {z && (
        <>
          <DocSignature label={t.reportsDocSignatureHandsOver} />
          <DocSignature label={t.reportsDocSignatureReceives} />
        </>
      )}
      <DocFooter>{t.reportsDocNotFiscal}</DocFooter>
    </div>
  );
}

const CONTROL_KINDS: [
  ExceptionKind,
  (
    | "reportsDocControlVoids"
    | "reportsDocControlDiscounts"
    | "reportsDocControlRefunds"
    | "reportsDocControlPaidOuts"
  ),
][] = [
  ["void", "reportsDocControlVoids"],
  ["discount", "reportsDocControlDiscounts"],
  ["refund", "reportsDocControlRefunds"],
  ["paid_out", "reportsDocControlPaidOuts"],
];

/**
 * The corte del día: the Resumen rows of one business date (the same §5.7 keys, so a label
 * bound for one binds for both), plus the drawers, the controls and the cost line.
 */
export function DayCorteDocument({
  doc,
  locale,
}: {
  doc: DayCorte;
  locale: Locale;
}) {
  const t = strings[locale];
  const m = money(doc.restaurant.currency, locale);
  const zone = doc.restaurant.timezone;
  const summary = doc.summary;
  const sections = summarySections(summary, locale);
  const section = (id: string) => sections.find((s) => s.id === id)!;
  const c = summary.collections;
  const exception = (kind: ExceptionKind) =>
    doc.exceptions.find((e) => e.kind === kind) ?? { count: 0, amount: 0 };
  const cfdiCoverage = corteCoverageOf(doc.extra);
  const negative = new Set([
    "discounts",
    "courtesies",
    "refunds",
    "refunds.cash",
    "refunds.external",
    "taxRefundedBase",
    "taxRefunded",
  ]);
  return (
    <div className="report-doc day-doc">
      <DocHeader
        name={doc.restaurant.name}
        title={fill(t.reportsDocDay, { date: dateLabel(doc.date, locale) })}
        flag={
          doc.printNumber !== null && doc.printNumber > 1
            ? fill(t.reportsDocReprint, { n: doc.printNumber })
            : undefined
        }
        lines={[
          fill(t.reportsDocPrinted, {
            time: dateTimeLabel(doc.printedAt, zone, locale),
            name: doc.printedByName,
          }),
          ...(doc.drawersOpen > 0 ? [t.reportsDrawersOpenWarning] : []),
        ]}
      />
      <DocRule />
      <DocSection title={t.reportsDocSales}>
        {section("sales").lines.map((line) => (
          <DocRow
            key={line.id}
            label={line.label}
            value={
              line.id === "refunds"
                ? minus(m, summary.refunds.total)
                : line.display !== undefined && line.amount === null
                  ? line.display
                  : line.amount === null
                    ? ""
                    : negative.has(line.id)
                      ? minus(m, -line.amount)
                      : m(line.amount)
            }
            strong={line.strong}
            indent={line.indent}
          />
        ))}
      </DocSection>
      <DocRule />
      <DocSection title={t.reportsDocTax}>
        {section("tax").lines.map((line) =>
          line.amount === null ? (
            <p className="doc-meta" key={line.id}>
              {line.label}
            </p>
          ) : (
            <DocRow
              key={line.id}
              label={line.label}
              value={
                negative.has(line.id) ? minus(m, -line.amount) : m(line.amount)
              }
              strong={line.strong}
            />
          ),
        )}
      </DocSection>
      <DocRule />
      <DocSection title={t.reportsDocPayments}>
        {c.byMethod.map((row) => (
          <div key={row.method}>
            <DocRow
              label={fill(t.reportsDocMethodLine, {
                method: tenderMethodLabel(row.method, undefined, locale),
                n: row.count,
              })}
              value={m(row.amount)}
            />
            <DocRow label={t.reportsTips} value={m(row.tips)} indent />
            <DocRow
              label={t.reportsRefunds}
              value={minus(m, row.refunds)}
              indent
            />
          </div>
        ))}
        <DocRow label={t.reportsPaidOuts} value={minus(m, c.paidOuts)} />
        <DocRow label={t.reportsCollected} value={m(c.collected)} strong />
        {c.late.count > 0 && (
          <p className="doc-meta">
            {fill(t.reportsLateSynced, {
              n: c.late.count,
              amount: m(c.late.amount),
            })}
          </p>
        )}
        {doc.otherDayDrawerCollections !== 0 && (
          <p className="doc-meta">
            {fill(t.reportsDocOtherDayDrawers, {
              amount: m(doc.otherDayDrawerCollections),
            })}
          </p>
        )}
      </DocSection>
      <DocRule />
      <DocSection title={t.reportsDocPending}>
        <p className="doc-meta">
          {fill(t.reportsDocPendingLine, {
            n: summary.sales.openChecks,
            amount: m(summary.sales.outstanding),
          })}
        </p>
      </DocSection>
      <DocRule />
      <DocSection title={t.reportsDocDrawers}>
        {doc.drawers.map((d) => (
          <p className="doc-meta" key={d.id}>
            {d.status === "open"
              ? fill(t.reportsDocDrawerOpenLine, { device: d.deviceName })
              : fill(t.reportsDocDrawerLine, {
                  device: d.deviceName,
                  z: d.zNumber ?? "—",
                  amount: m(d.difference ?? 0),
                  label: differenceLabel(
                    d.difference ?? 0,
                    locale,
                  ).toLowerCase(),
                })}
          </p>
        ))}
      </DocSection>
      <DocRule />
      <DocSection title={t.reportsDocControls}>
        {CONTROL_KINDS.map(([kind, key]) => (
          <p className="doc-meta" key={kind}>
            {fill(t.reportsDocControlLine, {
              label: t[key],
              n: exception(kind).count,
              amount: m(exception(kind).amount),
            })}
          </p>
        ))}
      </DocSection>
      <DocRule />
      <DocSection title={t.reportsDocCost}>
        <p className="doc-meta">
          {fill(t.reportsDocCostLine, {
            amount: m(summary.sales.cogs),
            pct: pct(summary.sales.costCoverageBps, locale),
          })}
        </p>
      </DocSection>
      {/* cfdi (030): the day's CFDI coverage (doc.extra.cfdi) when CFDI is on. */}
      {cfdiCoverage && (
        <>
          <DocRule />
          <CfdiCorteCoverage coverage={cfdiCoverage} locale={locale} />
        </>
      )}
      <DocFooter>{t.reportsDocNotFiscal}</DocFooter>
    </div>
  );
}
