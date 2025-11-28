import { parseTenc } from "./parser.js";
import { validateAst } from "./validator.js";

export interface RepairResult { fixed: boolean; string: string }

export function repairTenc(input: string, opts: { maxPasses?: number } = {}): RepairResult {
  const maxPasses = Math.max(1, (opts.maxPasses as number | 0) || 64);
  const original = String(input ?? "");
  let s = original;
  let fixedAny = false;

  for (let pass = 0; pass < maxPasses; pass++) {
    // 1) Parse
    let ast, dicts;
    try {
      const r = parseTenc(s);
      ast = r.ast;
      dicts = r.dicts || Object.create(null);
    } catch (e: any) {
      const f = applyParseErrorFix(s, e);
      if (f == null) {
        return { fixed: false, string: original };
      }
      s = f;
      fixedAny = true;
      continue;
    }

    // 2) Validate semantic/escaping rules
    const diags = validateAst(ast, s, { escapeChecks: true, dicts });
    const firstError = diags.find(d => d && d.severity !== "warn");
    if (!firstError) {
      return { fixed: fixedAny, string: s };
    }
    const f2 = applyDiagnosticFix(s, firstError);
    if (f2 == null) {
      return { fixed: false, string: original };
    }
    s = f2;
    fixedAny = true;
  }

  return { fixed: false, string: original };
}

function applyParseErrorFix(s: string, err: any): string | null {
  if (!err || typeof err.message !== "string") return null;
  const msg = String(err.message || "");
  const idx = clampIndex(s, err.index);

  if (/Unexpected character outside of element:/i.test(msg)) {
    if (idx >= 0 && idx < s.length) {
      return removeAt(s, idx, 1);
    }
  }

  if (/Unclosed element: expected '>'/i.test(msg) || /^Expected '>' but got 'EOF'$/i.test(msg)) {
    return s + ">";
  }

  if (/^Unclosed attribute block:/i.test(msg) || /^Unclosed dictionary block:/i.test(msg)) {
    const insertPos = findNextCharOrEnd(s, idx, ">");
    return insertAt(s, insertPos, ")");
  }

  if (/^Expected space between attributes$/i.test(msg) || /^Expected space between dictionary pairs$/i.test(msg)) {
    return insertAt(s, idx, " ");
  }

  if (/Unescaped '%' is not allowed inside dictionary values/i.test(msg)) {
    return insertAt(s, idx, "\\");
  }

  if (/Backslash at EOF in quoted value/i.test(msg) || /Backslash at EOF in unquoted value/i.test(msg) || /Dangling backslash at end of TEXT/i.test(msg)) {
    return s + "\\";
  }

  return null;
}

function applyDiagnosticFix(s: string, d: { code?: string, index?: number }): string | null {
  const code = String(d?.code || "");
  const i = clampIndex(s, d?.index);

  switch (code) {
    case "E_MISSING_HEAD_SPACE":
      return insertAt(s, i, " ");
    case "E_UNESCAPED_TEXT_SPECIAL":
    case "E_UNESCAPED_ATTR_SPECIAL":
      return insertAt(s, i, "\\");
    case "E_ATTR_LITERAL_PERCENT":
    case "E_REF_IN_TEXT":
    case "E_REF_MALFORMED":
      return insertAt(s, i, "\\");
    default:
      return null;
  }
}

function clampIndex(s: string, idx?: number) {
  const n = typeof idx === "number" ? (idx | 0) : s.length;
  return Math.max(0, Math.min(n, s.length));
}

function insertAt(s: string, index: number, insert: string) {
  const i = Math.max(0, Math.min(index | 0, s.length));
  return s.slice(0, i) + String(insert || "") + s.slice(i);
}

function removeAt(s: string, index: number, count: number = 1) {
  const i = Math.max(0, Math.min(index | 0, s.length));
  const n = Math.max(0, count | 0);
  return s.slice(0, i) + s.slice(i + n);
}

function findNextCharOrEnd(s: string, fromIndex: number, ch: string) {
  const i = Math.max(0, Math.min((fromIndex | 0), s.length));
  const j = s.indexOf(ch, i);
  return j >= 0 ? j : s.length;
}


