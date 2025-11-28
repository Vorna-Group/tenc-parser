export * from "./types.js";
export * from "./parser.js";
export * from "./validator.js";
export * from "./repair.js";
export * from "./htmlToTenc.js";

// Friendly alias names for public API
export { htmlToTenc as convertHtmlToTenc } from "./htmlToTenc.js";
export { tencToHtml as convertTencToHtml } from "./parser.js";
export { repairTenc as fixTenc } from "./repair.js";


