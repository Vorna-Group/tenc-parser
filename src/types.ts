export type TencNode = TencElementNode | TencTextNode;

export interface TencTextNode {
  type: "text";
  value: string;
  loc?: { start: number; end: number };
}

export interface TencElementNode {
  type: "element";
  tag: string;
  classes: string[];
  id: string | null;
  primary: string | null;
  attrs: Record<string, string>;
  parts: TencNode[];
  loc?: { start: number; end: number };
  headLoc?: { start: number; end: number };
  primaryRawLoc?: { start: number; end: number; quoted: boolean } | null;
  attrLocs?: Record<string, { start: number; end: number; quoted: boolean }> | null;
}

export interface Diagnostic {
  code: string;
  message: string;
  index: number;
  severity: "error" | "warn";
}


