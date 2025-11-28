import type { TencElementNode, TencNode } from "./types.js";
import { validateAst } from "./validator.js";

export class ParseError extends Error {
  index: number;
  constructor(message: string, index: number) {
    super(message);
    this.name = "ParseError";
    this.index = index;
  }
}

const DEFAULT_PRIMARY_MAP: Record<string, string> = {
  a: "href",
  abbr: "title",
  area: "href",
  audio: "src",
  embed: "src",
  base: "href",
  button: "type",
  data: "value",
  form: "action",
  html: "lang",
  iframe: "src",
  img: "src",
  input: "name",
  label: "for",
  link: "href",
  map: "name",
  meter: "value",
  meta: "name",
  object: "data",
  option: "value",
  progress: "value",
  script: "src",
  select: "name",
  source: "src",
  textarea: "name",
  time: "datetime",
  track: "src",
  video: "src"
};

// HTML void elements that do not require closing tags
const VOID_TAGS = new Set([
  "area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"
]);

export const defaultPrimaryMap: Record<string, string> = { ...DEFAULT_PRIMARY_MAP };
export function createPrimaryMap(override: Record<string, string> = {}) {
  return { ...DEFAULT_PRIMARY_MAP, ...(override || {}) };
}

function isLetter(ch: string) { return /[A-Za-z]/.test(ch); }
function isDigit(ch: string) { return /[0-9]/.test(ch); }
function isIdentChar(ch: string) { return /[A-Za-z0-9-]/.test(ch); }

export function indexToLineCol(input: string, index: number) {
  let line = 1, col = 1;
  const i = Math.max(0, Math.min(index | 0, input.length));
  for (let k = 0; k < i; k++) {
    if (input[k] === "\n") { line++; col = 1; } else { col++; }
  }
  return { line, col };
}

class TencParser {
  input: string;
  len: number;
  pos: number;
  dicts: Record<string, Record<string, string>>;
  seenElement: boolean;

  constructor(input: string) {
    this.input = input;
    this.len = input.length;
    this.pos = 0;
    this.dicts = Object.create(null);
    this.seenElement = false;
  }
  eof() { return this.pos >= this.len; }
  peek() { return this.input[this.pos]; }
  next() { return this.input[this.pos++]; }
  expect(ch: string) {
    const got = this.next();
    if (got !== ch) throw new ParseError(`Expected '${ch}' but got '${got ?? "EOF"}'`, this.pos - 1);
  }

  parseDocument(): TencNode[] {
    const nodes: TencNode[] = [];
    this.skipOptionalWhitespace();
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === "<") {
        // Dictionary definitions must appear before first element
        if (this.pos + 1 < this.len && this.input[this.pos + 1] === "%") {
          if (this.seenElement) {
            throw new ParseError("Dictionary definitions must appear before the first element", this.pos);
          }
          this.parseDictdef();
        } else {
          const el = this.parseElement();
          nodes.push(el);
          this.seenElement = true;
        }
        this.skipOptionalWhitespace();
      } else if (/\s/.test(ch)) {
        this.next();
      } else {
        throw new ParseError("Unexpected character outside of element: '" + ch + "'", this.pos);
      }
    }
    return nodes;
  }

  parseDictdef() {
    const start = this.pos;
    this.expect("<");
    this.expect("%");
    const dictname = this.parseIdent(true);
    if (!dictname) throw new ParseError("Expected dictionary name after '<%'", this.pos);
    if (this.dicts[dictname] != null) {
      throw new ParseError("Duplicate dictionary name '" + dictname + "'", start);
    }
    this.skipSpaces();
    this.expect("(");
    const pairs: Record<string, string> = {};
    const blockStart = this.pos - 1;
    let sawAny = false;
    while (!this.eof()) {
      this.skipSpaces();
      if (this.peek() === ")") { this.next(); break; }
      const key = this.parseIdent(false) || this.parseIdent(true);
      if (!key) throw new ParseError("Expected dictionary key", this.pos);
      if (pairs[key] != null) throw new ParseError("Duplicate key '" + key + "' in dictionary '" + dictname + "'", this.pos);
      this.skipSpaces();
      this.expect("=");
      while (!this.eof() && /\s/.test(this.peek())) this.next();
      const valueStart = this.pos;
      const value = this.parseValue();
      const quoted = this.input[valueStart] === "\"";
      const rawStart = quoted ? valueStart + 1 : valueStart;
      const rawEnd = quoted ? this.pos - 1 : this.pos;
      // Forbid unescaped '%' in dictionary values (no references inside dictionaries in 0.2/0.3)
      const span = this.input.slice(rawStart, rawEnd);
      for (let i = 0; i < span.length; i++) {
        const ch = span[i];
        if (ch === "\\") { i++; continue; }
        if (ch === "%") {
          throw new ParseError("Unescaped '%' is not allowed inside dictionary values in 0.2/0.3", rawStart + i);
        }
      }
      pairs[key] = value;
      sawAny = true;
      let sawWhitespace = false;
      while (!this.eof() && /\s/.test(this.peek())) { this.next(); sawWhitespace = true; }
      if (this.peek() === ")") { this.next(); break; }
      if (!sawWhitespace) {
        const got = this.peek();
        if (got === "<" || got === ">" || got === undefined) {
          throw new ParseError("Unclosed dictionary block: expected ')' after value", blockStart);
        }
        throw new ParseError("Expected space between dictionary pairs", this.pos);
      }
    }
    if (this.eof()) {
      throw new ParseError("Unclosed dictionary block: missing ')'", blockStart);
    }
    if (!sawAny) {
      throw new ParseError("Dictionary must contain at least one key=value pair", start);
    }
    this.skipSpaces();
    this.expect(">");
    this.dicts[dictname] = pairs;
  }

  parseElement(): TencElementNode {
    const start = this.pos;
    this.expect("<");
    const { tag, classes, id, primary, primaryRawLoc, attrs, attrLocs, headEnd } = this.parseHead();
    const contentStart = this.pos;
    const parts = this.parseContentAndChildren();
    this.expect(">");
    return {
      type: "element",
      tag, classes, id, primary, attrs, parts,
      loc: { start, end: this.pos },
      headLoc: { start: start + 1, end: headEnd ?? contentStart },
      primaryRawLoc: primaryRawLoc || null,
      attrLocs: attrLocs || null
    };
  }

  parseHead() {
    const tag = this.parseTag();
    const classes: string[] = [];
    let id: string | null = null;
    let primary: string | null = null;
    let primaryRawLoc: { start: number; end: number; quoted: boolean } | null = null;
    let attrs: Record<string, string> = {};
    let attrLocs: Record<string, { start: number; end: number; quoted: boolean }> | null = null;
    let headEnd: number | null = null;
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === ".") {
        this.next();
        const cls = this.parseIdent(true);
        if (!cls) throw new ParseError("Expected class name after '.'", this.pos);
        classes.push(cls);
      } else if (ch === "#") {
        if (id !== null) throw new ParseError("Duplicate id segment", this.pos);
        this.next();
        id = this.parseIdent(true);
        if (!id) throw new ParseError("Expected id after '#'", this.pos);
      } else if (ch === "@") {
        if (primary !== null) throw new ParseError("Duplicate primary segment", this.pos);
        this.next();
        const valueStart = this.pos;
        primary = this.parseValue({ stopAtOpenParen: true, stopAtCloseAngle: true, stopAtOpenAngle: true });
        const quoted = this.input[valueStart] === "\"";
        const rawStart = quoted ? valueStart + 1 : valueStart;
        const rawEnd = quoted ? this.pos - 1 : this.pos;
        primaryRawLoc = { start: rawStart, end: rawEnd, quoted };
      } else if (ch === "(") {
        if (Object.keys(attrs).length > 0) throw new ParseError("Duplicate attribute block", this.pos);
        const r = this.parseAttrBlock();
        attrs = r.attrs;
        attrLocs = r.attrLocs;
      } else {
        headEnd = this.pos;
        break;
      }
    }
    return { tag, classes, id, primary, primaryRawLoc, attrs, attrLocs, headEnd };
  }

  parseTag() {
    const start = this.pos;
    if (this.eof()) throw new ParseError("Unexpected EOF while reading tag", this.pos);
    const first = this.peek();
    if (!isLetter(first) && !isDigit(first)) {
      throw new ParseError("Invalid tag start: '" + first + "'", this.pos);
    }
    let out = this.next();
    while (!this.eof() && isIdentChar(this.peek())) out += this.next();
    if (!out) throw new ParseError("Empty tag at " + start, start);
    return out;
  }

  parseIdent(allowDigitStart: boolean) {
    if (this.eof()) return "";
    const first = this.peek();
    if (!(isLetter(first) || (allowDigitStart && isDigit(first)))) return "";
    let out = this.next();
    while (!this.eof() && isIdentChar(this.peek())) out += this.next();
    return out;
  }

  parseValue(options: { stopAtOpenParen?: boolean; stopAtCloseAngle?: boolean; stopAtOpenAngle?: boolean } = {}) {
    const stopAtOpenParen = !!options.stopAtOpenParen;
    const stopAtCloseAngle = !!options.stopAtCloseAngle;
    const stopAtOpenAngle = !!options.stopAtOpenAngle;
    if (this.eof()) throw new ParseError("Unexpected EOF in value", this.pos);
    const ch = this.peek();
    if (ch === "\"") return this.parseQuoted();
    if (ch === "\\" && this.pos + 1 < this.len && this.input[this.pos + 1] === "\"") {
      this.pos += 1;
      return this.parseQuoted();
    }
    return this.parseUnquoted(stopAtOpenParen, stopAtCloseAngle, stopAtOpenAngle);
  }

  parseQuoted() {
    this.expect("\"");
    let out = "";
    while (!this.eof()) {
      const ch = this.next();
      if (ch === "\"") break;
      if (ch === "\\") {
        if (this.eof()) throw new ParseError("Backslash at EOF in quoted value", this.pos);
        const esc = this.next();
        if ("<>().#@\\\"%".includes(esc)) out += esc;
        else out += esc;
      } else {
        out += ch;
      }
    }
    return out;
  }

  parseUnquoted(stopAtOpenParen = false, stopAtCloseAngle = false, stopAtOpenAngle = false) {
    let out = "";
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === " " || ch === ")" || (stopAtOpenParen && ch === "(") || (stopAtCloseAngle && ch === ">") || (stopAtOpenAngle && ch === "<")) break;
      if (ch === "\\") {
        this.next();
        if (this.eof()) throw new ParseError("Backslash at EOF in unquoted value", this.pos);
        const esc = this.next();
        if ("<>().#@\\\"%".includes(esc)) out += esc;
        else out += esc;
      } else {
        out += this.next();
      }
    }
    if (!out.length) throw new ParseError("Empty unquoted value", this.pos);
    return out;
  }

  parseAttrBlock() {
    this.expect("(");
    const attrs: Record<string, string> = {};
    const attrLocs: Record<string, { start: number; end: number; quoted: boolean }> = {};
    const blockStart = this.pos - 1;
    while (!this.eof()) {
      this.skipSpaces();
      if (this.peek() === ")") { this.next(); break; }
      const key = this.parseIdent(false) || this.parseIdent(true);
      if (!key) throw new ParseError("Expected attribute key", this.pos);
      this.skipSpaces();
      this.expect("=");
      while (!this.eof() && /\s/.test(this.peek())) this.next();
      const valueStart = this.pos;
      const value = this.parseValue({ stopAtCloseAngle: true });
      const quoted = this.input[valueStart] === "\"";
      const rawStart = quoted ? valueStart + 1 : valueStart;
      const rawEnd = quoted ? this.pos - 1 : this.pos;
      attrs[key] = value;
      attrLocs[key] = { start: rawStart, end: rawEnd, quoted };
      let sawWhitespace = false;
      while (!this.eof() && /\s/.test(this.peek())) { this.next(); sawWhitespace = true; }
      if (this.peek() === ")") { this.next(); break; }
      if (!sawWhitespace) {
        const got = this.peek();
        if (got === "<" || got === ">" || got === undefined) {
          throw new ParseError("Unclosed attribute block: expected ')' after attribute value", blockStart);
        }
        throw new ParseError("Expected space between attributes", this.pos);
      }
    }
    if (this.eof()) {
      throw new ParseError("Unclosed attribute block: missing ')'", blockStart);
    }
    return { attrs, attrLocs };
  }

  parseContentAndChildren() {
    const parts: TencNode[] = [];
    let textBuf = "";
    let textStart = this.pos;
    let atStart = true;
    const flushText = () => {
      if (textBuf.length) {
        parts.push({ type: "text", value: textBuf, loc: { start: textStart, end: this.pos } });
        textBuf = "";
      }
    };
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === ">") {
        flushText();
        return parts;
      }
      if (ch === "<") {
        flushText();
        const child = this.parseElement();
        parts.push(child);
        atStart = false;
        textStart = this.pos;
        continue;
      }
      if (atStart && ch === " ") {
        this.next();
        atStart = false;
        textStart = this.pos;
        continue;
      }
      if (ch === "\\") {
        this.next();
        if (this.eof()) throw new ParseError("Dangling backslash at end of TEXT", this.pos);
        const esc = this.next();
        if ("<>().#@\\\"%".includes(esc)) { /* consume */ }
        textBuf += esc;
      } else {
        textBuf += this.next();
      }
      atStart = false;
    }
    throw new ParseError("Unclosed element: expected '>'", this.pos);
  }

  skipOptionalWhitespace() { while (!this.eof() && /\s/.test(this.peek())) this.next(); }
  skipSpaces() { while (!this.eof() && /\s/.test(this.peek())) this.next(); }
}

export function parseTenc(input: string): { ast: TencNode[]; dicts: Record<string, Record<string, string>> } {
  const parser = new TencParser(input);
  const ast = parser.parseDocument();
  const dicts = Object.assign({}, parser.dicts);
  return { ast, dicts };
}

// String serializer (no DOM dependency)
function escapeHtmlText(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttrValue(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function astToHtml(astNodes: TencNode[], opts: { primaryMap?: Record<string, string> } = {}) {
  const pm = createPrimaryMap(opts.primaryMap || {});
  let out = "";
  const writeNode = (n: TencNode) => {
    if (n.type === "text") { out += escapeHtmlText(n.value || ""); return; }
    out += "<" + n.tag;
    if (n.classes && n.classes.length) out += ' class="' + n.classes.join(" ") + '"';
    if (n.id) out += ' id="' + n.id + '"';
    if (n.primary != null) {
      const primaryAttrName = pm[String(n.tag).toLowerCase()] || "data-primary";
      out += ' ' + primaryAttrName + '="' + escapeAttrValue(n.primary) + '"';
    }
    if (n.attrs) {
      for (const k of Object.keys(n.attrs)) {
        if (n.primary != null) {
          const primaryAttrName = pm[String(n.tag).toLowerCase()] || "data-primary";
          if (k === primaryAttrName) continue;
        }
        out += ' ' + k + '="' + escapeAttrValue(n.attrs[k]) + '"';
      }
    }
    out += ">";
    const tagLower = String(n.tag).toLowerCase();
    if (!VOID_TAGS.has(tagLower)) {
      if (n.parts) for (const c of n.parts) writeNode(c);
      out += "</" + n.tag + ">";
    }
  };
  for (const n of astNodes) writeNode(n);
  return out;
}

export function tencToHtml(input: string, opts: { primaryMap?: Record<string, string> } = {}) {
  const { ast, dicts } = parseTenc(input);
  // Expand dictionary references and perform escape checks to normalize values
  // We intentionally ignore returned diagnostics here; this is a serializer path.
  validateAst(ast as any, input, { escapeChecks: true, dicts });
  return astToHtml(ast, opts);
}


