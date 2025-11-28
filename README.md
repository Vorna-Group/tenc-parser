# tenc-parser

TENCparser — reference-quality utilities for TENC (Token Efficient Nested Codec):

- Parse TENC → AST
- Validate AST and source (escaping, primary rules, dictionaries)
- Repair near‑valid TENC strings
- Convert TENC → HTML (string serializer)
- Convert HTML → TENC

Released by Vorna Group LLC. Conceived and implemented by Felix Orlov and Nick Medved.

## Install

```bash
npm install @vorna-group/tencparser
```

## Usage

### Parse and validate

```ts
import { parseTenc, validateAst } from "@vorna-group/tencparser";

const src = '<a@https://example.com Hello>';
const { ast, dicts } = parseTenc(src);
const diags = validateAst(ast, src, { escapeChecks: true, dicts });
if (diags.length) {
  console.error(diags);
}
```

### Repair

```ts
import { fixTenc } from "@vorna-group/tencparser";

const { fixed, string } = fixTenc('<p Hello'); // missing '>'
// fixed === true; string === '<p Hello>'
```

### TENC → HTML

```ts
import { convertTencToHtml } from "@vorna-group/tencparser";

const html = convertTencToHtml('<a@https://example.com Hello>');
// <a href="https://example.com">Hello</a>
```

### HTML → TENC

```ts
import { convertHtmlToTenc } from "@vorna-group/tencparser";

const tenc = convertHtmlToTenc('<a href="https://example.com">Hello</a>');
// '<a@https://example.com Hello>'
```

Works in browsers (DOMParser) and in Node.js (built‑in parse5).

## API

- `parseTenc(input: string): { ast: TencNode[]; dicts: Record<string,Record<string,string>> }`
- `validateAst(ast: TencNode[], source?: string, opts?): Diagnostic[]`
- `fixTenc(input: string, opts?): { fixed: boolean; string: string }`
- `astToHtml(ast: TencNode[], opts?): string` (low-level)
- `convertTencToHtml(src: string, opts?): string`
- `convertHtmlToTenc(input: string|Element|Document|DocumentFragment, opts?): string`
- `defaultPrimaryMap`, `createPrimaryMap(override)`
- `indexToLineCol(input, index)`

Types: see `dist/index.d.ts`.

## Notes

 - The HTML → TENC converter supports both browsers (DOMParser) and Node.js (parse5). You can pass a string or a DOM node (Document/Element/DocumentFragment).
 - The validator enforces the TENC 0.3 rules, including `@primary` precedence and required escaping (`<`, `>`, `(`, `)`, `#`, `@`, `\\`, `%`), and forbids dictionary references in TEXT.
 - Inline `<script>` and `<style>` are ignored. External resources are included: `<script src="...">` and `<link rel="stylesheet" href="...">`.

## License

This library is source‑available and free for entities with annual gross revenue under USD $150,000. Otherwise, please contact `legal@vornagroup.com` for a commercial license. See `LICENSE` for details.


