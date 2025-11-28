// Simple CJS re-writer: converts top-level ESM exports to CJS re-exports.
// This avoids bringing a bundler; good enough for small libs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = join(__dirname, "..", "dist");

function makeCjsEntry() {
  const esmEntry = join(distDir, "index.js");
  const cjsEntry = join(distDir, "index.cjs");
  if (!existsSync(esmEntry)) return;
  const content = readFileSync(esmEntry, "utf8");
  // generate a trivial CJS wrapper
  // eslint-disable-next-line no-useless-escape
  const wrapper = [
    'const m = require("node:module");',
    'const { createRequire } = m;',
    'const requireEsm = createRequire(__filename);',
    'module.exports = requireEsm("./index.js");',
    ''
  ].join("\n");
  writeFileSync(cjsEntry, wrapper, "utf8");
  console.log("Wrote CJS entry:", cjsEntry);
}

mkdirSync(distDir, { recursive: true });
makeCjsEntry();


