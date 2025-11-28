import { createPrimaryMap, parseTenc } from "./parser.js";
import { validateAst } from "./validator.js";
import * as parse5 from "parse5";

const VOID_TAGS = new Set([
  "area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"
]);

function isIdent(s: unknown) {
  if (typeof s !== "string" || s.length === 0) return false;
  const first = s[0];
  if (!/[A-Za-z0-9]/.test(first)) return false;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (!/[A-Za-z0-9-]/.test(ch)) return false;
  }
  return true;
}

function isVoidTag(tag: string) {
  const t = String(tag || "").toLowerCase();
  return VOID_TAGS.has(t);
}

function shouldQuoteValue(s: unknown) {
  if (s == null) return true;
  const v = String(s);
  if (v.length === 0) return true;
  if (/\s/.test(v)) return true;
  if (v.includes(")")) return true;
  if (/[()#@\\%<>]/.test(v)) return true; // include < >
  return false;
}

function normalizeNbsp(input: string) {
  return String(input).replace(/\u00A0/g, " ");
}

function escapeTencValue(s: string, quoted: boolean) {
  const v = normalizeNbsp(s);
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === "<" || ch === ">" || ch === "(" || ch === ")" || ch === "#" || ch === "@" || ch === "\\" || ch === "%") {
      out += "\\" + ch;
      continue;
    }
    if (quoted && ch === "\"") {
      out += "\\\"";
      continue;
    }
    out += ch;
  }
  return out;
}

function escapeTencText(s: string) {
  const v = normalizeNbsp(s);
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === "<" || ch === ">" || ch === "(" || ch === ")" || ch === "#" || ch === "@" || ch === "\\" || ch === "%") {
      out += "\\" + ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function attrPairsToString(attrsObj: Record<string, any>) {
  const keys = Object.keys(attrsObj);
  if (keys.length === 0) return "";
  keys.sort();
  const parts: string[] = [];
  for (const k of keys) {
    const raw = (attrsObj as any)[k];
    if (raw && typeof raw === "object" && (raw as any).__ref === true) {
      parts.push(`${k}=${(raw as any).t}`);
      continue;
    }
    if (Array.isArray(raw)) {
      let assembled = "";
      for (const token of raw) {
        if (token && typeof token === "object" && (token as any).__ref === true) {
          assembled += (token as any).t;
        } else if (token && typeof token === "object" && (token as any).__lit === true) {
          assembled += escapeTencValue(String((token as any).v ?? ""), true);
        } else {
          assembled += escapeTencValue(String(token ?? ""), true);
        }
      }
      parts.push(`${k}="${assembled}"`);
      continue;
    }
    const val = raw == null ? "" : String(raw);
    const quoted = shouldQuoteValue(val);
    const esc = escapeTencValue(val, quoted);
    if (quoted) {
      parts.push(`${k}="${esc}"`);
    } else {
      parts.push(`${k}=${esc}`);
    }
  }
  return `(${parts.join(" ")})`;
}

export function htmlToTenc(input: string | Element | Document | DocumentFragment, opts: {
  primaryMap?: Record<string, string>;
  validateRoundTrip?: boolean;
  booleanAttrEncoding?: "empty" | "key";
  dictName?: string;
  dictMap?: Record<string, string>;
} = {}) {
  const pm = createPrimaryMap(opts?.primaryMap || {});
  const booleanEncoding = opts?.booleanAttrEncoding === "key" ? "key" : "empty";

  function collectAttributes(el: Element) {
    const out: Record<string, string> = {};
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i] as Attr;
      out[a.name] = a.value;
    }
    return out;
  }

  function elementToTenc(el: Element): string {
    const tag = String(el.tagName || "").toLowerCase();
    // Handle script/style: include external scripts (src), ignore inline; ignore style
    if (tag === "style") return "";
    const voidTag = isVoidTag(tag);
    const allAttrs = collectAttributes(el);
    if (tag === "script") {
      // Include only external scripts (src present); ignore inline content
      if (!allAttrs.src) return "";
    }

    const classAttrRaw = allAttrs.class;
    const classes = Array.from((el as any).classList || []);
    const classesAllIdent = classes.length > 0 && classes.every(isIdent);
    const useClassSegments = classes.length > 0 && classesAllIdent;

    const idRaw = (el as any).id || allAttrs.id || "";
    const useIdSegment = !!idRaw && isIdent(idRaw);

    const primaryName = pm[tag] || "data-primary";
    const primaryRaw = (el as Element).getAttribute(primaryName);
    const hasPrimary = primaryRaw != null;

    const attrs: Record<string, any> = {};
    for (const [name, value] of Object.entries(allAttrs)) {
      if (name === "class" && useClassSegments) continue;
      if (name === "id" && useIdSegment) continue;
      if (hasPrimary && name === primaryName) continue;
      if (!isIdent(name)) continue;
      const v = value === "" ? (booleanEncoding === "key" ? name : "") : value;
      attrs[name] = v;
    }

    if (!useClassSegments && classAttrRaw != null && classAttrRaw !== "") {
      attrs.class = classAttrRaw;
    }
    if (!useIdSegment && idRaw) {
      attrs.id = idRaw;
    }

    let head = "<" + tag;
    if (useClassSegments) {
      for (const cls of classes) head += "." + cls;
    }
    if (useIdSegment) head += "#" + idRaw;
    if (hasPrimary) {
      const pVal = String(primaryRaw);
      const quoted = shouldQuoteValue(pVal);
      const esc = escapeTencValue(pVal, quoted);
      head += quoted ? `@"${esc}"` : `@${esc}`;
    }

    const attrsString = attrPairsToString(attrs);
    if (attrsString) head += attrsString;

    const children = (tag === "script")
      ? [] // do not serialize inline code
      : Array.from((el as Element).childNodes || []);
    const contentParts: string[] = [];
    let firstPartIsText: boolean | null = null;
    for (let i = 0; i < children.length; i++) {
      const n = children[i] as any;
      if (n.nodeType === (window as any).Node.TEXT_NODE) {
        const text = n.nodeValue || "";
        if (text.length > 0) {
          if (firstPartIsText === null) firstPartIsText = true;
          const esc = escapeTencText(text);
          contentParts.push(esc);
        }
      } else if (n.nodeType === (window as any).Node.ELEMENT_NODE) {
        const childStr = elementToTenc(n as Element);
        if (childStr) {
          if (firstPartIsText === null) firstPartIsText = false;
          contentParts.push(childStr);
        }
      }
    }

    if (contentParts.length === 0 || voidTag) {
      return head + ">";
    }
    if (firstPartIsText === true) {
      return head + " " + contentParts.join("") + ">";
    }
    return head + contentParts.join("") + ">";
  }

  // -------- parse5-based (Node) ----------
  function collectAttributesP5(el: any) {
    const out: Record<string, string> = {};
    const attrs = Array.isArray(el.attrs) ? el.attrs : [];
    for (const a of attrs) {
      if (a && typeof a.name === "string") out[a.name] = String(a.value ?? "");
    }
    return out;
  }
  function elementToTencP5(el: any): string {
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "style") return "";
    const voidTag = isVoidTag(tag);
    const allAttrs = collectAttributesP5(el);
    if (tag === "script") {
      if (!allAttrs.src) return "";
    }

    const classAttrRaw = allAttrs.class;
    const classes = (classAttrRaw ? String(classAttrRaw).trim().split(/\s+/).filter(Boolean) : []);
    const classesAllIdent = classes.length > 0 && classes.every(isIdent);
    const useClassSegments = classes.length > 0 && classesAllIdent;

    const idRaw = allAttrs.id || "";
    const useIdSegment = !!idRaw && isIdent(idRaw);

    const primaryName = pm[tag] || "data-primary";
    const primaryRaw = allAttrs[primaryName];
    const hasPrimary = primaryRaw != null;

    const attrs: Record<string, any> = {};
    for (const [name, valueRaw] of Object.entries(allAttrs)) {
      if (name === "class" && useClassSegments) continue;
      if (name === "id" && useIdSegment) continue;
      if (hasPrimary && name === primaryName) continue;
      if (!isIdent(name)) continue;
      const v = valueRaw === "" ? (booleanEncoding === "key" ? name : "") : String(valueRaw);
      attrs[name] = v;
    }

    if (!useClassSegments && classAttrRaw != null && classAttrRaw !== "") {
      attrs.class = classAttrRaw;
    }
    if (!useIdSegment && idRaw) {
      attrs.id = idRaw;
    }

    let head = "<" + tag;
    if (useClassSegments) {
      for (const cls of classes) head += "." + cls;
    }
    if (useIdSegment) head += "#" + idRaw;
    if (hasPrimary) {
      const pVal = String(primaryRaw);
      const quoted = shouldQuoteValue(pVal);
      const esc = escapeTencValue(pVal, quoted);
      head += quoted ? `@"${esc}"` : `@${esc}`;
    }

    const attrsString = attrPairsToString(attrs);
    if (attrsString) head += attrsString;

    const children = (tag === "script")
      ? [] // do not serialize inline code
      : (Array.isArray(el.childNodes) ? el.childNodes : []);
    const contentParts: string[] = [];
    let firstPartIsText: boolean | null = null;
    for (const n of children) {
      if (n && n.nodeName === "#text") {
        const text = (n as any).value ?? (n as any).data ?? "";
        if (String(text).length > 0) {
          if (firstPartIsText === null) firstPartIsText = true;
          const esc = escapeTencText(String(text));
          contentParts.push(esc);
        }
      } else if (n && typeof (n as any).tagName === "string") {
        const childStr = elementToTencP5(n);
        if (childStr) {
          if (firstPartIsText === null) firstPartIsText = false;
          contentParts.push(childStr);
        }
      }
    }

    if (contentParts.length === 0 || voidTag) {
      return head + ">";
    }
    if (firstPartIsText === true) {
      return head + " " + contentParts.join("") + ">";
    }
    return head + contentParts.join("") + ">";
  }
  function serializeRootsP5(roots: any[]) {
    let out = "";
    for (const n of roots) {
      if (n && typeof n.tagName === "string") {
        const s = elementToTencP5(n);
        if (s) out += s;
      } else if (n && n.nodeName === "#text") {
        // Ignore text outside of elements
      }
    }
    return out;
  }

  function serializeRoots(roots: Node[]) {
    let out = "";
    for (const n of roots) {
      if ((n as any).nodeType === (window as any).Node.ELEMENT_NODE) {
        const s = elementToTenc(n as Element);
        if (s) out += s;
      } else if ((n as any).nodeType === (window as any).Node.TEXT_NODE) {
        // ignore non-whitespace text outside elements
      }
    }
    return out;
  }

  let tenc = "";
  let roots: Node[] | null = null;

  if (typeof input === "string") {
    // Prefer DOMParser if available (browser), else use parse5 (Node)
    if (typeof (globalThis as any).DOMParser !== "undefined") {
      const parser = new (globalThis as any).DOMParser();
      const doc = parser.parseFromString(input, "text/html");
      roots = (doc.body && doc.body.childNodes && doc.body.childNodes.length
        ? Array.from(doc.body.childNodes)
        : (doc.documentElement ? Array.from(doc.documentElement.childNodes) : []));
      tenc = serializeRoots(roots);
    } else {
      // Node path: parse5 AST
      const doc: any = parse5.parse(String(input));
      // Find <html> → <body> children
      const htmlEl = (doc.childNodes || []).find((n: any) => n.tagName === "html") || null;
      const bodyEl = htmlEl && Array.isArray(htmlEl.childNodes)
        ? htmlEl.childNodes.find((n: any) => n.tagName === "body")
        : null;
      const rootNodes = bodyEl && Array.isArray(bodyEl.childNodes)
        ? bodyEl.childNodes
        : (htmlEl && Array.isArray(htmlEl.childNodes) ? htmlEl.childNodes : (doc.childNodes || []));
      tenc = serializeRootsP5(rootNodes);
    }
  } else if (input && typeof input === "object") {
    const anyInput: any = input;
    if (anyInput.nodeType === (window as any).Node.ELEMENT_NODE) {
      roots = [input as Node];
      tenc = elementToTenc(input as Element);
    } else if (anyInput.nodeType === (window as any).Node.DOCUMENT_FRAGMENT_NODE || anyInput.nodeType === (window as any).Node.DOCUMENT_NODE) {
      roots = Array.from((input as DocumentFragment | Document).childNodes || []);
      let out = "";
      for (const nn of roots) {
        if ((nn as any).nodeType === (window as any).Node.ELEMENT_NODE) {
          const s = elementToTenc(nn as Element);
          if (s) out += s;
        }
      }
      tenc = out;
    } else {
      throw new Error("Unsupported input node type for htmlToTenc");
    }
  } else {
    throw new Error("Unsupported input type for htmlToTenc");
  }

  if (opts && opts.validateRoundTrip) {
    const parsed = parseTenc(tenc);
    const ast = parsed.ast;
    const dicts = parsed.dicts || {};
    const diags = validateAst(ast, tenc, { escapeChecks: true, dicts });
    if (diags && diags.length) {
      const first = diags[0] || ({} as any);
      const pos = typeof (first as any).index === "number" ? ` at pos ${(first as any).index}` : "";
      throw new Error(`Generated TENC did not validate: ${(first as any).message || "diagnostics present"}${pos}`);
    }
  }
  return tenc;
}


