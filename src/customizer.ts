/**
 * Reads customizer parameters straight from .scad source, matching OpenSCAD's own `-o x.param`
 * export (see test/fixtures/customizer). OpenSCAD's export evaluates the whole model, which can
 * take as long as a render, so reading the comments ourselves keeps the sliders instant.
 */

export type ParamValue = number | string | boolean | number[];

export interface ParamOption {
  name: string;
  value: number | string;
}

/** Same shape as an entry in OpenSCAD's parameter JSON. */
export interface ParamDef {
  name: string;
  type: 'number' | 'string' | 'boolean';
  initial: ParamValue;
  group: string;
  caption?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: ParamOption[];
  maxLength?: number;
  /**
   * A same-line `//` comment that isn't a spec, e.g. `gap = 5; // to the inner edge`. Not part of
   * OpenSCAD's format (its GUI ignores these); the preview shows it as the hint when there's no caption.
   */
  note?: string;
}

type Token =
  | { kind: 'ident' | 'number' | 'punct'; text: string; line: number }
  | { kind: 'string'; text: string; value: string; line: number }
  | { kind: 'lineComment'; text: string; line: number; ownLine: boolean }
  | { kind: 'blockComment'; text: string; line: number };

/**
 * Rules, all checked against OpenSCAD 2026.09.27:
 * - Only top-level `name = literal;` counts. Literals: number, string, true/false, or a non-empty vector of numbers.
 * - The list ends at the first `module` definition (functions and geometry don't end it).
 * - Any block comment containing `[...]` starts a group; the group "Hidden" is left out.
 * - Caption: a whole-line `//` comment on the line directly above.
 * - Spec: a `//` comment after the `;` on the same line, either exactly `[...]` or a bare number.
 * - A name assigned twice keeps its first position and its last value.
 */
export function parseCustomizer(source: string): ParamDef[] {
  const tokens = tokenize(source);
  const captions = new Map<number, string>();
  for (const t of tokens) if (t.kind === 'lineComment' && t.ownLine) captions.set(t.line, t.text.trim());

  const params = new Map<string, ParamDef>();
  let group = 'Parameters';
  let hidden = false;
  let depth = 0;
  let atStatementStart = true;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === 'blockComment') {
      const m = depth === 0 ? /\[([^\]]*)\]/.exec(tok.text) : null;
      if (m) {
        group = m[1].trim();
        hidden = group === 'Hidden';
      }
      continue;
    }
    if (tok.kind === 'lineComment') continue;

    if (tok.kind === 'punct') {
      if (tok.text === '{') depth++;
      if (tok.text === '}') depth = Math.max(depth - 1, 0);
      atStatementStart = depth === 0 && (tok.text === ';' || tok.text === '}');
      continue;
    }

    if (depth === 0 && atStatementStart && tok.kind === 'ident') {
      if (tok.text === 'module') break;
      if (tok.text === 'include' || tok.text === 'use') {
        // `include <path>` has no semicolon; skip to the closing '>'.
        while (i < tokens.length && !(tokens[i].kind === 'punct' && tokens[i].text === '>')) i++;
        atStatementStart = true;
        continue;
      }
      const eq = tokens[i + 1];
      if (eq?.kind === 'punct' && eq.text === '=') {
        const literal = parseLiteral(tokens, i + 2);
        const semi = literal && tokens[literal.end];
        if (literal && semi?.kind === 'punct' && semi.text === ';') {
          if (!hidden) {
            const after = tokens[literal.end + 1];
            const spec = after?.kind === 'lineComment' && after.line === semi.line ? after.text : undefined;
            // Overwriting a Map key keeps its original position, which is what OpenSCAD does.
            params.set(tok.text, makeDef(tok.text, literal.value, group, captions.get(tok.line - 1), spec));
          }
          i = literal.end;
          atStatementStart = true;
          continue;
        }
      }
    }
    atStatementStart = false;
  }
  return [...params.values()];
}

function makeDef(name: string, initial: ParamValue, group: string, caption: string | undefined, spec: string | undefined): ParamDef {
  const type = typeof initial === 'boolean' ? 'boolean' : typeof initial === 'string' ? 'string' : 'number';
  const def: ParamDef = { name, type, initial, group };
  if (caption) def.caption = caption;
  const specText = spec?.trim() ?? '';
  const bracket = /^\[(.*)\]$/.exec(specText);

  if (type === 'number') {
    if (bracket) applyNumberSpec(def, bracket[1]);
    else if (/^\d+(\.\d+)?$/.test(specText) && !Array.isArray(initial)) def.step = Number(specText);
    if (!Array.isArray(initial) && !def.options && def.step === undefined) def.step = 1;
  } else if (type === 'string') {
    if (bracket) def.options = parseOptions(bracket[1], false);
    else if (/^\d+$/.test(specText)) def.maxLength = Number(specText);
  }
  if (specText && !bracket && !/^\d+(\.\d+)?$/.test(specText)) def.note = specText;
  return def;
}

function applyNumberSpec(def: ParamDef, inner: string): void {
  if (!inner.includes(',')) {
    const parts = inner.split(':').map((p) => p.trim());
    if (parts.every(isNumeric) && parts.length >= 1 && parts.length <= 3) {
      const n = parts.map(Number);
      [def.min, def.step, def.max] = n.length === 1 ? [0, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : [n[0], n[1], n[2]];
      if (typeof def.initial === 'number') {
        // OpenSCAD stretches the range to include the default (and warns).
        def.max = Math.max(def.max!, def.initial);
        def.min = Math.min(def.min!, def.initial);
      }
      return;
    }
  }
  const options = parseOptions(inner, true);
  if (options) def.options = options;
}

/** `a, b:Label, c` → options. For numbers every value must be numeric, else the spec is ignored. */
function parseOptions(inner: string, numeric: boolean): ParamOption[] | undefined {
  const options: ParamOption[] = [];
  for (const item of inner.split(',')) {
    const trimmed = item.trim();
    const colon = trimmed.indexOf(':');
    const rawValue = (colon >= 0 ? trimmed.slice(0, colon) : trimmed).trim();
    const label = (colon >= 0 ? trimmed.slice(colon + 1) : trimmed).trim();
    if (numeric) {
      if (!isNumeric(rawValue)) return undefined;
      options.push({ name: label, value: Number(rawValue) });
    } else {
      options.push({ name: label, value: rawValue });
    }
  }
  return options;
}

function isNumeric(s: string): boolean {
  return /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s);
}

function parseLiteral(tokens: Token[], start: number): { value: ParamValue; end: number } | undefined {
  const scalar = parseNumber(tokens, start);
  if (scalar) return scalar;
  const tok = tokens[start];
  if (!tok) return undefined;
  if (tok.kind === 'string') return { value: tok.value, end: start + 1 };
  if (tok.kind === 'ident' && (tok.text === 'true' || tok.text === 'false')) return { value: tok.text === 'true', end: start + 1 };
  if (tok.kind === 'punct' && tok.text === '[') {
    const values: number[] = [];
    let i = start + 1;
    for (;;) {
      const n = parseNumber(tokens, i);
      if (!n) return undefined;
      values.push(n.value);
      i = n.end;
      const sep = tokens[i];
      if (sep?.kind !== 'punct') return undefined;
      if (sep.text === ']') return { value: values, end: i + 1 };
      if (sep.text !== ',') return undefined;
      i++;
    }
  }
  return undefined;
}

function parseNumber(tokens: Token[], start: number): { value: number; end: number } | undefined {
  let i = start;
  let sign = 1;
  if (tokens[i]?.kind === 'punct' && tokens[i].text === '-') {
    sign = -1;
    i++;
  }
  const tok = tokens[i];
  if (tok?.kind !== 'number') return undefined;
  return { value: sign * Number(tok.text), end: i + 1 };
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineHasCode = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') {
      line++;
      lineHasCode = false;
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
    } else if (ch === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = src.length;
      tokens.push({ kind: 'lineComment', text: src.slice(i + 2, end), line, ownLine: !lineHasCode });
      i = end;
    } else if (ch === '/' && src[i + 1] === '*') {
      let end = src.indexOf('*/', i + 2);
      if (end < 0) end = src.length;
      const text = src.slice(i + 2, end);
      tokens.push({ kind: 'blockComment', text, line });
      line += text.split('\n').length - 1;
      i = end + 2;
    } else if (ch === '"') {
      const start = line;
      let value = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const { text, length } = unescape(src, i);
          value += text;
          i += length;
        } else {
          if (src[i] === '\n') line++;
          value += src[i++];
        }
      }
      i++; // closing quote
      tokens.push({ kind: 'string', text: '', value, line: start });
      lineHasCode = true;
    } else if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i, i + 256))!;
      tokens.push({ kind: 'ident', text: m[0], line });
      i += m[0].length;
      lineHasCode = true;
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i, i + 64))!;
      tokens.push({ kind: 'number', text: m[0], line });
      i += m[0].length;
      lineHasCode = true;
    } else {
      tokens.push({ kind: 'punct', text: ch, line });
      i++;
      lineHasCode = true;
    }
  }
  return tokens;
}

function unescape(src: string, i: number): { text: string; length: number } {
  const next = src[i + 1];
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"' };
  if (next in simple) return { text: simple[next], length: 2 };
  const hex = (len: number) => /^[0-9a-fA-F]+$/.test(src.slice(i + 2, i + 2 + len)) ? parseInt(src.slice(i + 2, i + 2 + len), 16) : NaN;
  if (next === 'x' && !Number.isNaN(hex(2))) return { text: String.fromCodePoint(hex(2)), length: 4 };
  if (next === 'u' && !Number.isNaN(hex(4))) return { text: String.fromCodePoint(hex(4)), length: 6 };
  if (next === 'U' && !Number.isNaN(hex(6))) return { text: String.fromCodePoint(hex(6)), length: 8 };
  return { text: next, length: 2 };
}

/** OpenSCAD source for a value, for use in `-D name=value`. */
export function scadLiteral(value: ParamValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatNumber).join(', ')}]`;
  return formatNumber(value);
}

function formatNumber(n: number): string {
  return Number.isFinite(n) ? String(n) : '0';
}

/** `-D` arguments for every override. */
export function defineArgs(values: Record<string, ParamValue>): string[] {
  return Object.entries(values).flatMap(([name, value]) => ['-D', `${name}=${scadLiteral(value)}`]);
}

export function valuesEqual(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Keep only overrides that still match a parameter of the same type and differ from its default. */
export function pruneValues(values: Record<string, ParamValue>, defs: ParamDef[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const def of defs) {
    const v = values[def.name];
    if (v === undefined || valuesEqual(v, def.initial)) continue;
    if (Array.isArray(def.initial) !== Array.isArray(v) || typeof v !== (Array.isArray(v) ? 'object' : typeof def.initial)) continue;
    if (Array.isArray(v) && Array.isArray(def.initial) && v.length !== def.initial.length) continue;
    out[def.name] = v;
  }
  return out;
}
