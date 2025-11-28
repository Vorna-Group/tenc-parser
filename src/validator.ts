import type { Diagnostic, TencNode } from "./types.js";

export function validateAst(
  ast: TencNode[],
  source: string = "",
  opts: { strict?: boolean; escapeChecks?: boolean; dicts?: Record<string, Record<string, string>> } = {}
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const strict = !!opts.strict;
  const escapeChecks = !!opts.escapeChecks;
  const dicts = opts && typeof opts.dicts === "object" ? opts.dicts : Object.create(null);
  const PRIMARY_MAP_03: Record<string, string> = {
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

  function diag(code: string, message: string, index: number, severity: "error" | "warn" = "error") {
    diagnostics.push({ code, message, index: Math.max(0, index | 0), severity });
  }

  function isIdentChar(ch: string) { return /[A-Za-z0-9-]/.test(ch); }
  function resolvePrimaryName(tag: string) {
    const t = String(tag || "").toLowerCase();
    return PRIMARY_MAP_03[t] || "data-primary";
  }

  // Expand dictionary references inside a raw span and validate references.
  function expandFromRawSpan(start: number, end: number) {
    const span = source.slice(start | 0, end | 0);
    let out = "";
    for (let i = 0; i < span.length; i++) {
      const ch = span[i];
      if (ch === "\\") {
        if (i + 1 < span.length) {
          out += span[i + 1];
          i++;
        }
        continue;
      }
      if (ch === "%") {
        // Parse %dict.key
        let j = i + 1;
        // dictname
        let dictname = "";
        while (j < span.length && isIdentChar(span[j])) { dictname += span[j]; j++; }
        if (!dictname || j >= span.length || span[j] !== ".") {
          // Literal percent not escaped in an attribute value → error
          diag("E_ATTR_LITERAL_PERCENT", "Literal '%' in value must be escaped as '\\%'.", start + i, "error");
          out += "%";
          continue;
        }
        j++; // skip '.'
        let key = "";
        while (j < span.length && isIdentChar(span[j])) { key += span[j]; j++; }
        if (!key) {
          diag("E_REF_MALFORMED", "Malformed dictionary reference: expected key after '.'.", start + i, "error");
          out += "%";
          i = j - 1;
          continue;
        }
        const dict = dicts[dictname];
        if (dict == null) {
          diag("E_REF_UNKNOWN_DICT", `Unknown dictionary '${dictname}'`, start + i, "error");
        } else if (dict[key] == null) {
          diag("E_REF_UNKNOWN_KEY", `Unknown key '${key}' in dictionary '${dictname}'`, start + i, "error");
        }
        const value = (dict && dict[key] != null) ? String(dict[key]) : "";
        out += value;
        i = j - 1;
        continue;
      }
      out += ch;
    }
    return out;
  }

  function walk(node: TencNode) {
    if (node.type === "text") return;

    if (!node.tag || typeof node.tag !== "string") {
      diag("E_TAG", "Empty or invalid tag", node.loc?.start ?? 0);
    }
    if (node.classes && !Array.isArray(node.classes)) {
      diag("E_CLASSES", "Classes must be an array", node.loc?.start ?? 0);
    }
    if (node.attrs && typeof node.attrs === "object") {
      for (const k of Object.keys(node.attrs)) {
        if (k.trim() === "") {
          diag("E_ATTR_KEY", "Empty attribute key", node.loc?.start ?? 0);
        }
      }
    }
    // Canonical head→TEXT separator
    if (node.headLoc && node.parts && node.parts.length > 0) {
      const first = node.parts[0];
      if (first && first.type === "text" && first.loc && typeof first.loc.start === "number") {
        const delta = first.loc.start - node.headLoc.end;
        if (delta === 0) {
          diag("E_MISSING_HEAD_SPACE", "Missing canonical space between head and TEXT", first.loc.start, "error");
        }
      }
    }
    if (node.parts && Array.isArray(node.parts)) {
      for (const c of node.parts) walk(c);
    } else if ((node as any).parts != null) {
      diag("E_PARTS", "Element parts must be an array", node.loc?.start ?? 0);
    }
  }

  if (Array.isArray(ast)) {
    for (const n of ast) walk(n);
  } else {
    diag("E_ROOT", "AST root must be an array", 0);
  }

  // Escaping + dictionary rules
  if (escapeChecks && typeof source === "string" && Array.isArray(ast)) {
    const specialsText = new Set(["(", ")", "#", "@", "\\", "<", ">"]);
    const specialsAttr = new Set(["(", ")", "#", "@", "\\", "<", ">"]);
    const visit = (node: TencNode) => {
      if (node.type === "text" && node.loc && typeof node.loc.start === "number" && typeof node.loc.end === "number") {
        const start = node.loc.start | 0;
        const end = node.loc.end | 0;
        const span = source.slice(start, end);
        for (let i = 0; i < span.length; i++) {
          const ch = span[i];
          if (ch === "\\") { i++; continue; }
          if (ch === "%") {
            // References are forbidden in TEXT
            diag("E_REF_IN_TEXT", "Dictionary references are not allowed in TEXT; escape '%' as '\\%'.", start + i, "error");
            continue;
          }
          if (specialsText.has(ch)) {
            diag("E_UNESCAPED_TEXT_SPECIAL", `Unescaped special '${ch}' in TEXT. Escape as '\\${ch}'.`, start + i, "error");
          }
        }
      } else if (node.type === "element") {
        if (node.primaryRawLoc && typeof node.primaryRawLoc.start === "number") {
          const s = node.primaryRawLoc.start | 0;
          const e = node.primaryRawLoc.end | 0;
          if (e > s) {
            const span = source.slice(s, e);
            for (let i = 0; i < span.length; i++) {
              const ch = span[i];
              if (ch === "\\") { i++; continue; }
              if (specialsAttr.has(ch)) {
                diag("E_UNESCAPED_ATTR_SPECIAL", `Unescaped special '${ch}' in primary value. Escape as '\\${ch}'.`, s + i, "error");
              }
            }
            const expanded = expandFromRawSpan(s, e);
            (node as any).primary = expanded;
          }
        }
        if (node.attrLocs && typeof node.attrLocs === "object") {
          for (const k of Object.keys(node.attrLocs)) {
            const loc = node.attrLocs[k];
            if (!loc || typeof loc.start !== "number") continue;
            const s = loc.start | 0;
            const e = loc.end | 0;
            if (e > s) {
              const span = source.slice(s, e);
              for (let i = 0; i < span.length; i++) {
                const ch = span[i];
                if (ch === "\\") { i++; continue; }
                if (specialsAttr.has(ch)) {
                  diag("E_UNESCAPED_ATTR_SPECIAL", `Unescaped special '${ch}' in attribute '${k}' value. Escape as '\\${ch}'.`, s + i, "error");
                }
              }
              const expanded = expandFromRawSpan(s, e);
              if (!(node as any).attrs) (node as any).attrs = {};
              (node as any).attrs[k] = expanded;
            }
          }
        }
        if (node.primary != null && (node as any).attrs && typeof (node as any).attrs === "object") {
          const primaryKey = resolvePrimaryName((node as any).tag);
          if (Object.prototype.hasOwnProperty.call((node as any).attrs, primaryKey)) {
            const conflictLoc = ((node as any).attrLocs && (node as any).attrLocs[primaryKey] && typeof (node as any).attrLocs[primaryKey].start === "number")
              ? (node as any).attrLocs[primaryKey].start
              : ((node as any).loc?.start ?? 0);
            diag("W_PRIMARY_CONFLICT_ATTR_DUPLICATE", `@primary overrides attribute '${primaryKey}' inside (attrs).`, conflictLoc, "warn");
          }
        }
        if ((node as any).parts) for (const c of (node as any).parts) visit(c);
      }
    };
    for (const n of ast) visit(n);
  }

  if (strict && diagnostics.length === 0) {
    // Hook for extra strict checks in the future
  }

  return diagnostics;
}


