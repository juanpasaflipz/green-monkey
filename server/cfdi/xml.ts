/**
 * Reads the amounts of a stamped CFDI 4.0 (cfdi 030, spec §4.8.4 amount check). Pure, no
 * dependency: a small tag tokenizer that ignores attribute order and quote style and resolves
 * namespace prefixes, so it does not assume the conventional `cfdi:` / `tfd:` prefixes.
 *
 * Structure (Anexo 20, CFDI 4.0): Comprobante@SubTotal/@Descuento/@Total; Comprobante/Conceptos/
 * Concepto@Importe/@NoIdentificacion with Impuestos/Traslados/Traslado@Base/@Importe; the
 * comprobante-level Impuestos@TotalImpuestosTrasladados is the Impuestos element that is a DIRECT
 * child of Comprobante (concept-level Impuestos are not), with @TotalImpuestosRetenidos and the
 * Retenciones/Retencion of the RESICO ISR retention (LD-16 L9); the TimbreFiscalDigital@UUID.
 *
 * Amounts are decimal strings (up to 6 decimals) converted exactly to integer centavos, rounding
 * half up at the third decimal. Not shared/domain.ts minor(): that caps at MXN 1,000,000 and a
 * monthly global can be larger.
 */

export const CFDI_NAMESPACE = "http://www.sat.gob.mx/cfd/4";
export const TFD_NAMESPACE = "http://www.sat.gob.mx/TimbreFiscalDigital";

export type CfdiTraslado = {
  impuesto: string | null;
  factor: string | null;
  rate: string | null;
  /** Centavos. */
  base: number;
  /** Centavos; null for TipoFactor Exento (no Importe attribute). */
  importe: number | null;
};
/** A retention (Retencion@Impuesto/@Importe; concept-level ones also carry Base and TasaOCuota). */
export type CfdiRetencion = {
  impuesto: string | null;
  rate: string | null;
  /** Centavos; 0 at the comprobante level (no Base attribute there). */
  base: number;
  /** Centavos. */
  importe: number;
};
export type CfdiConceptTotals = {
  noIdentificacion: string | null;
  importe: number;
  descuento: number;
  traslados: CfdiTraslado[];
  retenciones: CfdiRetencion[];
};
export type CfdiTotals = {
  version: string | null;
  type: string | null;
  series: string | null;
  folio: string | null;
  currency: string | null;
  subtotal: number;
  discount: number;
  total: number;
  /** Comprobante-level TotalImpuestosTrasladados; 0 when absent (only exempt concepts). */
  taxTraslados: number;
  /** Comprobante-level traslados (per tax and rate). */
  traslados: CfdiTraslado[];
  /** Comprobante-level TotalImpuestosRetenidos; 0 when absent. Total = SubTotal − Descuento + traslados − this. */
  taxRetenidos: number;
  /** Comprobante-level retenciones (per tax). */
  retenciones: CfdiRetencion[];
  concepts: CfdiConceptTotals[];
  /** TimbreFiscalDigital UUID, upper-cased; null if the document has no stamp. */
  uuid: string | null;
};

export class CfdiXmlError extends Error {
  readonly code = "cfdi_xml_invalid";
  constructor(public reason: string) {
    super(`cfdi_xml_invalid: ${reason}`);
    this.name = "CfdiXmlError";
  }
}

const AMOUNT = /^(\d{1,18})(?:\.(\d{1,6}))?$/;

/** "107.755" → 10776 centavos (half up at the third decimal). */
export function decimalToCentavos(value: string, what = "amount"): number {
  const m = AMOUNT.exec(value.trim());
  if (!m) throw new CfdiXmlError(`invalid ${what}`);
  const fraction = (m[2] ?? "").padEnd(6, "0");
  let centavos = BigInt(m[1]) * 100n + BigInt(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) centavos += 1n;
  const n = Number(centavos);
  if (!Number.isSafeInteger(n)) throw new CfdiXmlError(`${what} out of range`);
  return n;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Every "&" must start a reference: a known named entity or a valid character reference. */
function decodeEntities(value: string): string {
  return value.replace(/&([^;&\s]{0,12});?/g, (whole, name: string) => {
    if (!whole.endsWith(";")) throw new CfdiXmlError("malformed entity");
    if (/^#x[0-9a-fA-F]{1,6}$/.test(name) || /^#\d{1,7}$/.test(name)) {
      const code =
        name[1] === "x"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      if (code > 0x10ffff) throw new CfdiXmlError("malformed entity");
      return String.fromCodePoint(code);
    }
    const named = Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : undefined;
    if (named === undefined) throw new CfdiXmlError("unknown entity");
    return named;
  });
}

/** XML names, Unicode letters included (InformacionGlobal has the attribute "Año"). */
const NAME = /^[\p{L}_][\p{L}\p{N}_.-]*(?::[\p{L}_][\p{L}\p{N}_.-]*)?$/u;
/** One attribute, preceded by the whitespace XML requires; double or single quotes. */
const ATTRIBUTE = /\s+([^\s=/>]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

type Tag = { name: string; attrs: Map<string, string>; selfClosing: boolean };

function parseStartTag(source: string): Tag {
  const nameMatch = /^[^\s/>]+/.exec(source);
  if (!nameMatch || !NAME.test(nameMatch[0]))
    throw new CfdiXmlError("invalid element name");
  const name = nameMatch[0];
  let rest = source.slice(name.length);
  let selfClosing = false;
  if (/\/\s*$/.test(rest)) {
    selfClosing = true;
    rest = rest.replace(/\/\s*$/, "");
  }
  const attrs = new Map<string, string>();
  let position = 0;
  while (position < rest.length && !/^\s*$/.test(rest.slice(position))) {
    ATTRIBUTE.lastIndex = position;
    const m = ATTRIBUTE.exec(rest);
    if (!m) throw new CfdiXmlError("malformed attribute");
    if (!NAME.test(m[1])) throw new CfdiXmlError("invalid attribute name");
    if (attrs.has(m[1])) throw new CfdiXmlError("duplicate attribute");
    attrs.set(m[1], decodeEntities(m[2] ?? m[3] ?? ""));
    position = ATTRIBUTE.lastIndex;
  }
  return { name, attrs, selfClosing };
}

type Element = {
  uri: string | null;
  local: string;
  scope: Map<string, string>;
};

/** Splits "pfx:Local" and resolves the prefix in the element's in-scope declarations. */
function resolve(
  name: string,
  scope: Map<string, string>,
): { uri: string | null; local: string } {
  const colon = name.indexOf(":");
  const prefix = colon === -1 ? "" : name.slice(0, colon);
  const local = colon === -1 ? name : name.slice(colon + 1);
  const uri = scope.get(prefix);
  if (uri === undefined && prefix)
    throw new CfdiXmlError("undeclared namespace prefix");
  return { uri: uri ?? null, local };
}

function optional(attrs: Map<string, string>, name: string): string | null {
  const v = attrs.get(name);
  return v === undefined ? null : v;
}

function amount(
  attrs: Map<string, string>,
  name: string,
  required: boolean,
): number {
  const v = attrs.get(name);
  if (v === undefined) {
    if (required) throw new CfdiXmlError(`missing ${name}`);
    return 0;
  }
  return decimalToCentavos(v, name);
}

function retencion(attrs: Map<string, string>): CfdiRetencion {
  return {
    impuesto: optional(attrs, "Impuesto"),
    rate: optional(attrs, "TasaOCuota"),
    base: amount(attrs, "Base", false),
    importe: amount(attrs, "Importe", true),
  };
}

function traslado(attrs: Map<string, string>): CfdiTraslado {
  const importe = attrs.get("Importe");
  return {
    impuesto: optional(attrs, "Impuesto"),
    factor: optional(attrs, "TipoFactor"),
    rate: optional(attrs, "TasaOCuota"),
    base: amount(attrs, "Base", true),
    importe:
      importe === undefined ? null : decimalToCentavos(importe, "Importe"),
  };
}

/** Parses the totals of a CFDI 4.0 XML document. Throws CfdiXmlError on malformed input. */
export function parseCfdiTotals(xml: string | Uint8Array): CfdiTotals {
  let text: string;
  try {
    text =
      typeof xml === "string"
        ? xml
        : new TextDecoder("utf-8", { fatal: true }).decode(xml);
  } catch {
    throw new CfdiXmlError("not UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const stack: Element[] = [];
  let result: CfdiTotals | null = null;
  let comprobanteClosed = false;
  let concept: CfdiConceptTotals | null = null;
  let position = 0;

  const isCfdi = (e: Element | undefined, local: string) =>
    !!e && e.uri === CFDI_NAMESPACE && e.local === local;

  while (position < text.length) {
    const open = text.indexOf("<", position);
    if (open === -1) break;
    if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      if (end === -1)
        throw new CfdiXmlError("unterminated processing instruction");
      position = end + 2;
      continue;
    }
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end === -1) throw new CfdiXmlError("unterminated comment");
      position = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", open)) {
      if (!stack.length) throw new CfdiXmlError("CDATA outside the document");
      const end = text.indexOf("]]>", open + 9);
      if (end === -1) throw new CfdiXmlError("unterminated CDATA");
      position = end + 3;
      continue;
    }
    if (text.startsWith("<!", open))
      throw new CfdiXmlError("DTDs are not allowed");

    // Find the end of the tag, skipping quoted attribute values (which may contain ">").
    let end = open + 1;
    let quote: string | null = null;
    for (; end < text.length; end++) {
      const c = text[end];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      else if (c === "<") throw new CfdiXmlError("unexpected <");
    }
    if (end >= text.length) throw new CfdiXmlError("unterminated tag");
    const body = text.slice(open + 1, end);
    position = end + 1;

    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const top = stack.pop();
      if (!top) throw new CfdiXmlError("unbalanced end tag");
      const { uri, local } = resolve(name, top.scope);
      if (uri !== top.uri || local !== top.local)
        throw new CfdiXmlError("mismatched end tag");
      if (isCfdi(top, "Concepto")) concept = null;
      if (isCfdi(top, "Comprobante") && !stack.length) comprobanteClosed = true;
      continue;
    }

    const tag = parseStartTag(body);
    const parentScope = stack.length
      ? stack[stack.length - 1].scope
      : new Map<string, string>();
    let scope = parentScope;
    for (const [attr, value] of tag.attrs)
      if (attr === "xmlns" || attr.startsWith("xmlns:")) {
        if (scope === parentScope) scope = new Map(parentScope);
        scope.set(attr === "xmlns" ? "" : attr.slice(6), value);
      }
    const { uri, local } = resolve(tag.name, scope);
    const element: Element = { uri, local, scope };
    const parent = stack[stack.length - 1];

    if (!stack.length) {
      if (result || comprobanteClosed)
        throw new CfdiXmlError("more than one root element");
      if (!isCfdi(element, "Comprobante"))
        throw new CfdiXmlError("root is not cfdi:Comprobante");
      result = {
        version: optional(tag.attrs, "Version"),
        type: optional(tag.attrs, "TipoDeComprobante"),
        series: optional(tag.attrs, "Serie"),
        folio: optional(tag.attrs, "Folio"),
        currency: optional(tag.attrs, "Moneda"),
        subtotal: amount(tag.attrs, "SubTotal", true),
        discount: amount(tag.attrs, "Descuento", false),
        total: amount(tag.attrs, "Total", true),
        taxTraslados: 0,
        traslados: [],
        taxRetenidos: 0,
        retenciones: [],
        concepts: [],
        uuid: null,
      };
    } else if (result) {
      if (isCfdi(element, "Concepto") && isCfdi(parent, "Conceptos")) {
        if (concept) throw new CfdiXmlError("nested concepto");
        concept = {
          noIdentificacion: optional(tag.attrs, "NoIdentificacion"),
          importe: amount(tag.attrs, "Importe", true),
          descuento: amount(tag.attrs, "Descuento", false),
          traslados: [],
          retenciones: [],
        };
        result.concepts.push(concept);
      } else if (
        isCfdi(element, "Impuestos") &&
        isCfdi(parent, "Comprobante") &&
        stack.length === 1
      ) {
        result.taxTraslados = amount(
          tag.attrs,
          "TotalImpuestosTrasladados",
          false,
        );
        result.taxRetenidos = amount(
          tag.attrs,
          "TotalImpuestosRetenidos",
          false,
        );
      } else if (isCfdi(element, "Traslado") && isCfdi(parent, "Traslados")) {
        const impuestos = stack[stack.length - 2];
        const owner = stack[stack.length - 3];
        if (
          concept &&
          isCfdi(impuestos, "Impuestos") &&
          isCfdi(owner, "Concepto")
        )
          concept.traslados.push(traslado(tag.attrs));
        else if (
          isCfdi(impuestos, "Impuestos") &&
          isCfdi(owner, "Comprobante") &&
          stack.length === 3
        )
          result.traslados.push(traslado(tag.attrs));
      } else if (
        isCfdi(element, "Retencion") &&
        isCfdi(parent, "Retenciones")
      ) {
        const impuestos = stack[stack.length - 2];
        const owner = stack[stack.length - 3];
        if (
          concept &&
          isCfdi(impuestos, "Impuestos") &&
          isCfdi(owner, "Concepto")
        )
          concept.retenciones.push(retencion(tag.attrs));
        else if (
          isCfdi(impuestos, "Impuestos") &&
          isCfdi(owner, "Comprobante") &&
          stack.length === 3
        )
          result.retenciones.push(retencion(tag.attrs));
      } else if (
        element.uri === TFD_NAMESPACE &&
        element.local === "TimbreFiscalDigital"
      ) {
        const uuid = tag.attrs.get("UUID");
        if (
          uuid &&
          /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(uuid)
        )
          result.uuid = uuid.toUpperCase();
      }
    }
    if (!tag.selfClosing) stack.push(element);
    else if (isCfdi(element, "Concepto")) concept = null;
    else if (isCfdi(element, "Comprobante") && !stack.length)
      comprobanteClosed = true;
  }

  if (!result) throw new CfdiXmlError("no cfdi:Comprobante");
  if (stack.length || !comprobanteClosed)
    throw new CfdiXmlError("unterminated document");
  return result;
}
