// Create a tiny CJS entry that re-exports the true CommonJS build from ./cjs/index.js
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = join(__dirname, "..", "dist");
const cjsBuiltIndex = join(distDir, "cjs", "index.js");

function makeCjsEntry() {
  const cjsEntry = join(distDir, "index.cjs");
  if (!existsSync(cjsBuiltIndex)) return;
  // Minimal wrapper that forwards to the true CommonJS build
  const wrapper = 'module.exports = require("./cjs/index.js");\n';
  writeFileSync(cjsEntry, wrapper, "utf8");
  console.log("Wrote CJS entry:", cjsEntry);
}

mkdirSync(distDir, { recursive: true });
makeCjsEntry();

