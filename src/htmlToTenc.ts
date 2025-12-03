import { createPrimaryMap, parseTenc } from "./parser.js";
import { validateAst } from "./validator.js";
import { repairTenc } from "./repair.js";
import * as parse5 from "parse5";

const VOID_TAGS = new Set([
  "area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"
]);

// ---- Small helpers for length/cost estimation and key generation ----
function chooseQuotedAndEscape(val: string) {
  const q = shouldQuoteValue(val);
  const esc = escapeTencValue(val, q);
  return { quoted: q, escaped: esc, length: esc.length + (q ? 2 : 0) };
}
function originalValueCost(val: string) {
  const { length } = chooseQuotedAndEscape(val);
  return length;
}
function refLen(dictName: string, key: string) {
  // "%"+dict+"."+key
  return 1 + String(dictName).length + 1 + String(key).length;
}
function* keySequence(): Generator<string> {
  const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 1-char keys
  for (let i = 0; i < alpha.length; i++) yield alpha[i]!;
  // 2+ char keys
  const chars = alpha.split("");
  for (let len = 2; len <= 8; len++) {
    const idx = new Array<number>(len).fill(0);
    let done = false;
    while (!done) {
      let s = "";
      for (let i = 0; i < len; i++) s += chars[idx[i]!]!;
      yield s;
      // increment
      let p = len - 1;
      while (p >= 0) {
        idx[p]!++;
        if (idx[p]! < chars.length) break;
        idx[p] = 0;
        p--;
      }
      if (p < 0) done = true;
    }
  }
}

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

function isIdentStartChar(ch: string | undefined) {
  return typeof ch === "string" && /[A-Za-z0-9-]/.test(ch);
}

function assembleTokensSafely(tokens: Array<{ __ref: true; t: string } | { __lit: true; v: string } | string>) {
  let assembled = "";
  let prevWasRef = false;
  for (const token of tokens) {
    if (token && typeof token === "object" && (token as any).__ref === true) {
      assembled += (token as any).t;
      prevWasRef = true;
    } else if (token && typeof token === "object" && (token as any).__lit === true) {
      const raw = String((token as any).v ?? "");
      const esc = escapeTencValue(raw, true);
      if (prevWasRef && isIdentStartChar(raw[0])) {
        assembled += "\\";
      }
      assembled += esc;
      prevWasRef = false;
    } else {
      const raw = String(token ?? "");
      const esc = escapeTencValue(raw, true);
      if (prevWasRef && isIdentStartChar(raw[0])) {
        assembled += "\\";
      }
      assembled += esc;
      prevWasRef = false;
    }
  }
  return assembled;
}

// Remove IE conditional comment markers from raw HTML strings to avoid stray text like '>' from downlevel-revealed blocks.
// Keep inner HTML intact (for downlevel-revealed), only strip markers:
//   <!--[if !IE]><!-->   ...content...   <!--<![endif]-->
function stripIeConditionalCommentMarkers(html: string) {
  let s = String(html ?? "");
  // Opening marker (downlevel-revealed)
  s = s.replace(/<!--\s*\[if[^\]]*\]\s*><!-->/gi, "");
  // Closing marker (downlevel-revealed)
  s = s.replace(/<!--\s*<!\[endif\]\s*-->/gi, "");
  return s;
}

function attrPairsToString(attrsObj: Record<string, any>, forceQuoteAll: boolean = false) {
  const keys = Object.keys(attrsObj);
  if (keys.length === 0) return "";
  keys.sort();
  const parts: string[] = [];
  for (const k of keys) {
    const raw = (attrsObj as any)[k];
    if (raw && typeof raw === "object" && (raw as any).__ref === true) {
      // Quote pure reference values to avoid any spacing/lexing edge cases across pairs
      parts.push(`${k}="${(raw as any).t}"`);
      continue;
    }
    if (Array.isArray(raw)) {
      const assembled = assembleTokensSafely(raw as any);
      parts.push(`${k}="${assembled}"`);
      continue;
    }
    const val = raw == null ? "" : String(raw);
    const quoted = forceQuoteAll ? true : shouldQuoteValue(val);
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
  const dictName = (typeof opts?.dictName === "string" && opts.dictName) ? opts.dictName : "a";

  // -------- Dictionary extraction (values-only, with single best substring fallback) --------
  type DictMapping = { valueToKey: Record<string, string>, keyToValue: Record<string, string> };
  function buildDictionaryFromValues(values: string[]): DictMapping {
    const MIN_LEN = 8;
    const counts = new Map<string, number>();
    for (const v of values) {
      const s = String(v ?? "");
      if (s.length < MIN_LEN) continue;
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    // Rank candidates by net benefit approximation
    type Candidate = { value: string; count: number; origCost: number; estRefCost: number; estGain: number };
    const cands: Candidate[] = [];
    for (const [value, count] of counts) {
      if (count < 2) continue;
      const origCost = originalValueCost(value);
      // optimistic estimate with 1-char key (most top keys)
      const estRefCost = refLen(dictName, "a");
      const estGain = count * (origCost - estRefCost);
      if (estGain > 0) {
        cands.push({ value, count, origCost, estRefCost, estGain });
      }
    }
    // Sort by decreasing estimated gain, then by longer values first
    cands.sort((a, b) => (b.estGain - a.estGain) || (b.value.length - a.value.length) || (a.value < b.value ? -1 : 1));

    const valueToKey: Record<string, string> = Object.create(null);
    const keyToValue: Record<string, string> = Object.create(null);

    // Assign keys greedily and keep only truly beneficial ones after actual costs computed
    const keys = keySequence();
    let headerOverheadApplied = false;
    let selectedCount = 0;
    for (const cand of cands) {
      const nxt = keys.next();
      if (nxt.done) break;
      const key = nxt.value;
      // actual ref length
      const thisRefLen = refLen(dictName, key);
      // cost to store this pair in the dict block
      const dictPairLen = (() => {
        const { length } = chooseQuotedAndEscape(cand.value);
        return String(key).length + 1 /* '=' */ + length;
      })();
      // header overhead counted once: "<%a(" + ")>" and spaces between pairs (~ (#pairs-1))
      const headerOverhead = headerOverheadApplied ? 1 /* space before this pair */ : (2 /* ')>' */ + 3 /* '<%a' */ + 1 /* '(' */);
      const net = cand.count * (cand.origCost - thisRefLen) - (dictPairLen + headerOverhead);
      if (net > 0) {
        valueToKey[cand.value] = key;
        keyToValue[key] = cand.value;
        headerOverheadApplied = true;
        selectedCount++;
      } else {
        // skip this candidate; do not consume keyspace unfairly
        // put key back by starting a fresh sequence for same index (no, sequence cannot rewind)
        // acceptable trade-off: small waste of a key slot
      }
    }
    return { valueToKey, keyToValue };
  }

  // Single best substring replacement for extra compression (quoted fallback)
  type EncodedTokens = { onlyRef: boolean; unquoted: boolean; tokens: Array<{__ref: true, t: string} | {__lit: true, v: string}> };
  function encodeWithDictTokens(val: string, valueToKey: Record<string, string>): EncodedTokens | null {
    const s = String(val ?? "");
    if (!s) return null;
    // 1) exact match → unquoted single ref
    const exactKey = valueToKey[s];
    if (exactKey) {
      return { onlyRef: true, unquoted: true, tokens: [{ __ref: true, t: `%${dictName}.${exactKey}` }] as any };
    }
    // 2) Try greedy longest single substring match that yields net benefit with quoting
    // Compute original minimal cost
    const origCost = originalValueCost(s);
    let best: { start: number; end: number; key: string; gain: number } | null = null;
    // Scan all dict values via indexOf (acceptable scale for typical sizes)
    for (const [v, key] of Object.entries(valueToKey)) {
      const needle = v;
      if (!needle || needle.length < 8) continue;
      let from = 0;
      while (true) {
        const idx = s.indexOf(needle, from);
        if (idx < 0) break;
        const left = s.slice(0, idx);
        const right = s.slice(idx + needle.length);
        const leftEscLen = escapeTencValue(left, true).length;
        const rightEscLen = escapeTencValue(right, true).length;
        const newCost = 2 /* quotes */ + leftEscLen + refLen(dictName, key) + rightEscLen;
        const gain = origCost - newCost;
        if (gain > 0 && (!best || gain > best.gain)) {
          best = { start: idx, end: idx + needle.length, key, gain };
        }
        from = idx + 1;
      }
    }
    if (best) {
      const left = s.slice(0, best.start);
      const right = s.slice(best.end);
      const tokens: EncodedTokens["tokens"] = [];
      if (left) tokens.push({ __lit: true, v: left } as any);
      tokens.push({ __ref: true, t: `%${dictName}.${best.key}` } as any);
      if (right) tokens.push({ __lit: true, v: right } as any);
      return { onlyRef: false, unquoted: false, tokens };
    }
    return null;
  }

  function collectAttributes(el: Element) {
    const out: Record<string, string> = {};
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i] as Attr;
      out[a.name] = a.value;
    }
    return out;
  }

  function elementToTenc(el: Element, dict: DictMapping | null, forceQuoteAll: boolean): string {
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
      if (name === "style") continue; // do not touch style
      if (!isIdent(name)) continue;
      const v = value === "" ? (booleanEncoding === "key" ? name : "") : value;
      // Apply dictionary encoding for attribute values
      if (dict && v !== "" && name !== "style") {
        const enc = encodeWithDictTokens(String(v), dict.valueToKey);
        if (enc) {
          if (enc.onlyRef && enc.unquoted) {
            attrs[name] = { __ref: true, t: `%${dictName}.${dict.valueToKey[String(v)]}` };
          } else {
            attrs[name] = enc.tokens;
          }
        } else {
          attrs[name] = v;
        }
      } else {
        attrs[name] = v;
      }
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
      if (dict) {
        const enc = encodeWithDictTokens(pVal, dict.valueToKey);
        if (enc && enc.onlyRef && enc.unquoted) {
          // thin form without quotes
          head += `@%${dictName}.${dict.valueToKey[pVal]}`;
        } else if (enc) {
          // mixed tokens → quoted, add boundary escapes where needed
          const assembled = assembleTokensSafely(enc.tokens as any);
          head += `@"${assembled}"`;
        } else {
          const quoted = shouldQuoteValue(pVal);
          const esc = escapeTencValue(pVal, quoted);
          head += quoted ? `@"${esc}"` : `@${esc}`;
        }
      } else {
        const quoted = shouldQuoteValue(pVal);
        const esc = escapeTencValue(pVal, quoted);
        head += quoted ? `@"${esc}"` : `@${esc}`;
      }
    }

    const attrsString = attrPairsToString(attrs, forceQuoteAll);
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
        const childStr = elementToTenc(n as Element, dict, forceQuoteAll);
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
  function elementToTencP5(el: any, dict: DictMapping | null, forceQuoteAll: boolean): string {
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
      if (name === "style") continue;
      if (!isIdent(name)) continue;
      const v = valueRaw === "" ? (booleanEncoding === "key" ? name : "") : String(valueRaw);
      if (dict && v !== "" && name !== "style") {
        const enc = encodeWithDictTokens(String(v), dict.valueToKey);
        if (enc) {
          if (enc.onlyRef && enc.unquoted) {
            attrs[name] = { __ref: true, t: `%${dictName}.${dict.valueToKey[String(v)]}` };
          } else {
            attrs[name] = enc.tokens;
          }
        } else {
          attrs[name] = v;
        }
      } else {
        attrs[name] = v;
      }
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
      if (dict) {
        const enc = encodeWithDictTokens(pVal, dict.valueToKey);
        if (enc && enc.onlyRef && enc.unquoted) {
          head += `@%${dictName}.${dict.valueToKey[pVal]}`;
        } else if (enc) {
          const assembled = assembleTokensSafely(enc.tokens as any);
          head += `@"${assembled}"`;
        } else {
          const quoted = shouldQuoteValue(pVal);
          const esc = escapeTencValue(pVal, quoted);
          head += quoted ? `@"${esc}"` : `@${esc}`;
        }
      } else {
        const quoted = shouldQuoteValue(pVal);
        const esc = escapeTencValue(pVal, quoted);
        head += quoted ? `@"${esc}"` : `@${esc}`;
      }
    }

    const attrsString = attrPairsToString(attrs, forceQuoteAll);
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
        const childStr = elementToTencP5(n, dict, forceQuoteAll);
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
  function serializeRootsP5(roots: any[], dict: DictMapping | null, dictHeader: string, forceQuoteAll: boolean) {
    let out = "";
    if (dict && dictHeader) out += dictHeader;
    for (const n of roots) {
      if (n && typeof n.tagName === "string") {
        const s = elementToTencP5(n, dict, forceQuoteAll);
        if (s) out += s;
      } else if (n && n.nodeName === "#text") {
        // Ignore text outside of elements
      }
    }
    return out;
  }

  function serializeRoots(roots: Node[], dict: DictMapping | null, dictHeader: string, forceQuoteAll: boolean) {
    let out = "";
    if (dict && dictHeader) out += dictHeader;
    for (const n of roots) {
      if ((n as any).nodeType === (window as any).Node.ELEMENT_NODE) {
        const s = elementToTenc(n as Element, dict, forceQuoteAll);
        if (s) out += s;
      } else if ((n as any).nodeType === (window as any).Node.TEXT_NODE) {
        // ignore non-whitespace text outside elements
      }
    }
    return out;
  }

  // Build dictionary candidates by scanning roots, then serialize with dictionary header and refs
  function collectValuesFromDomRoots(roots: Node[]): string[] {
    const vals: string[] = [];
    const walk = (el: Element) => {
      const tag = String(el.tagName || "").toLowerCase();
      if (tag === "style") return;
      const attrs = collectAttributes(el);
      if (tag === "script" && !attrs.src) return; // ignore inline
      const primaryName = pm[tag] || "data-primary";
      const primaryRaw = (el as Element).getAttribute(primaryName);
      if (primaryRaw != null) vals.push(String(primaryRaw));
      // attrs
      const classes = Array.from((el as any).classList || []);
      const idRaw = (el as any).id || attrs.id || "";
      for (const [name, value] of Object.entries(attrs)) {
        if (name === "class" && classes.length > 0 && classes.every(isIdent)) continue;
        if (name === "id" && idRaw && isIdent(idRaw)) continue;
        if (name === primaryName) continue;
        if (name === "style") continue;
        if (!isIdent(name)) continue;
        const v = value === "" ? (booleanEncoding === "key" ? name : "") : value;
        if (v !== "" && v !== name) vals.push(String(v));
      }
      // children
      const children = Array.from((el as Element).childNodes || []);
      for (const n of children) {
        if ((n as any).nodeType === (window as any).Node.ELEMENT_NODE) {
          walk(n as Element);
        }
      }
    };
    for (const n of roots) {
      if ((n as any).nodeType === (window as any).Node.ELEMENT_NODE) walk(n as Element);
    }
    return vals;
  }
  function collectValuesFromP5Roots(roots: any[]): string[] {
    const vals: string[] = [];
    const walk = (el: any) => {
      const tag = String(el?.tagName || "").toLowerCase();
      if (tag === "style") return;
      const attrs = collectAttributesP5(el);
      if (tag === "script" && !attrs.src) return;
      const primaryName = pm[tag] || "data-primary";
      const primaryRaw = attrs[primaryName];
      if (primaryRaw != null) vals.push(String(primaryRaw));
      for (const [name, value] of Object.entries(attrs)) {
        if (name === "class") {
          const classes = (attrs.class ? String(attrs.class).trim().split(/\s+/).filter(Boolean) : []);
          if (classes.length > 0 && classes.every(isIdent)) { /* segment-based */ } else {
            if (attrs.class) vals.push(String(attrs.class));
          }
          continue;
        }
        if (name === "id") {
          const idRaw = attrs.id || "";
          if (!(idRaw && isIdent(String(idRaw)))) {
            if (attrs.id) vals.push(String(attrs.id));
          }
          continue;
        }
        if (name === primaryName) continue;
        if (name === "style") continue;
        if (!isIdent(name)) continue;
        const v = value === "" ? (booleanEncoding === "key" ? name : "") : String(value);
        if (v !== "" && v !== name) vals.push(String(v));
      }
      const children = (Array.isArray(el?.childNodes) ? el.childNodes : []);
      for (const c of children) {
        if (c && typeof (c as any).tagName === "string") walk(c);
      }
    };
    for (const n of roots) {
      if (n && typeof (n as any).tagName === "string") walk(n);
    }
    return vals;
  }

  function makeDictHeader(dict: DictMapping | null): string {
    if (!dict) return "";
    const entries = Object.entries(dict.keyToValue);
    if (!entries.length) return "";
    // Render compact and deterministic: sort by key
    entries.sort(([a], [b]) => (a < b ? -1 : 1));
    const parts: string[] = [];
    for (const [key, value] of entries) {
      const { quoted, escaped } = chooseQuotedAndEscape(value);
      parts.push(quoted ? `${key}="${escaped}"` : `${key}=${escaped}`);
    }
    return `<%${dictName}(${parts.join(" ")})>`;
  }

  let tenc = "";
  let roots: Node[] | null = null;
  let dict: DictMapping | null = null;
  let dictHeader = "";
  let forceQuoteAll = false;
  let usingParse5 = false;
  let p5Roots: any[] | null = null;

  if (typeof input === "string") {
    // Prefer DOMParser if available (browser), else use parse5 (Node)
    if (typeof (globalThis as any).DOMParser !== "undefined") {
      const parser = new (globalThis as any).DOMParser();
      const pre = stripIeConditionalCommentMarkers(input);
      const doc = parser.parseFromString(pre, "text/html");
      roots = (doc.body && doc.body.childNodes && doc.body.childNodes.length
        ? Array.from(doc.body.childNodes)
        : (doc.documentElement ? Array.from(doc.documentElement.childNodes) : []));
      // Build dictionary
      const values = collectValuesFromDomRoots(roots);
      dict = buildDictionaryFromValues(values);
      dictHeader = makeDictHeader(dict);
      tenc = serializeRoots(roots, dict, dictHeader, forceQuoteAll);
    } else {
      // Node path: parse5 AST
      const pre = stripIeConditionalCommentMarkers(String(input));
      const doc: any = parse5.parse(pre);
      // Find <html> → <body> children
      const htmlEl = (doc.childNodes || []).find((n: any) => n.tagName === "html") || null;
      const bodyEl = htmlEl && Array.isArray(htmlEl.childNodes)
        ? htmlEl.childNodes.find((n: any) => n.tagName === "body")
        : null;
      const rootNodes = bodyEl && Array.isArray(bodyEl.childNodes)
        ? bodyEl.childNodes
        : (htmlEl && Array.isArray(htmlEl.childNodes) ? htmlEl.childNodes : (doc.childNodes || []));
      const values = collectValuesFromP5Roots(rootNodes);
      dict = buildDictionaryFromValues(values);
      dictHeader = makeDictHeader(dict);
      usingParse5 = true;
      p5Roots = rootNodes;
      tenc = serializeRootsP5(rootNodes, dict, dictHeader, forceQuoteAll);
    }
  } else if (input && typeof input === "object") {
    const anyInput: any = input;
    if (anyInput.nodeType === (window as any).Node.ELEMENT_NODE) {
      roots = [input as Node];
      const values = collectValuesFromDomRoots(roots);
      dict = buildDictionaryFromValues(values);
      dictHeader = makeDictHeader(dict);
      tenc = (dictHeader || "") + elementToTenc(input as Element, dict, forceQuoteAll);
    } else if (anyInput.nodeType === (window as any).Node.DOCUMENT_FRAGMENT_NODE || anyInput.nodeType === (window as any).Node.DOCUMENT_NODE) {
      roots = Array.from((input as DocumentFragment | Document).childNodes || []);
      let out = "";
      for (const nn of roots) {
        if ((nn as any).nodeType === (window as any).Node.ELEMENT_NODE) {
          const s = elementToTenc(nn as Element, null, forceQuoteAll);
          if (s) out += s;
        }
      }
      // Build dict using full set, then re-serialize for consistency
      const values = collectValuesFromDomRoots(roots);
      dict = buildDictionaryFromValues(values);
      dictHeader = makeDictHeader(dict);
      // re-run serialize with dict
      out = "";
      for (const nn of roots) {
        if ((nn as any).nodeType === (window as any).Node.ELEMENT_NODE) {
          const s = elementToTenc(nn as Element, dict, forceQuoteAll);
          if (s) out += s;
        }
      }
      tenc = (dictHeader || "") + out;
    } else {
      throw new Error("Unsupported input node type for htmlToTenc");
    }
  } else {
    throw new Error("Unsupported input type for htmlToTenc");
  }

  if (opts && opts.validateRoundTrip) {
    let ok = false;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const parsed = parseTenc(tenc);
        const ast = parsed.ast;
        const dicts = parsed.dicts || {};
        const diags = validateAst(ast, tenc, { escapeChecks: true, dicts });
        const first = diags && diags.find(d => d && d.severity !== "warn");
        if (first) {
          lastErr = new Error(`Generated TENC did not validate: ${first.message}${typeof first.index === "number" ? ` at pos ${first.index}` : ""}`);
          // Try one repair pass
          const r = repairTenc(tenc, { maxPasses: 4 });
          if (r && r.fixed && r.string && r.string !== tenc) {
            tenc = r.string;
            continue; // re-validate
          }
          throw lastErr;
        }
        ok = true;
        break;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e && e.message || "");
        // Special fallback: quote all attribute values and re-serialize once
        if (!forceQuoteAll && /Expected space between attributes/i.test(msg)) {
          forceQuoteAll = true;
          if (usingParse5 && p5Roots) {
            tenc = serializeRootsP5(p5Roots, dict, dictHeader, forceQuoteAll);
          } else if (roots) {
            tenc = serializeRoots(roots, dict, dictHeader, forceQuoteAll);
          }
          continue;
        }
        // Try to repair parse errors as well
        const r = repairTenc(tenc, { maxPasses: 4 });
        if (r && r.fixed && r.string && r.string !== tenc) {
          tenc = r.string;
          continue;
        }
        break;
      }
    }
    if (!ok && lastErr) {
      throw lastErr;
    }
  }
  return tenc;
}


