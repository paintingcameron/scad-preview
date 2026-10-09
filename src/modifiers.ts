/**
 * Debug modifiers: `#` (highlight) and `%` (background). OpenSCAD leaves both out of an exported
 * mesh as separate parts (`%` entirely), so they are found in a `.csg` export instead, pulled out
 * with the transforms and colors above them, and rendered on their own.
 */

export type Marker = '#' | '%';

/**
 * Whether OpenSCAD source uses `#` or `%` as a modifier. Cheap enough to run before deciding on the
 * slow CSG export. `%` is also the modulo operator, so it only counts at statement level: outside
 * brackets and not in the value of an assignment.
 */
export function hasModifiers(source: string): boolean {
  let depth = 0; // ( and [ nesting
  let inValue = false; // between a statement-level "=" and its ";"
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return false;
    } else if (c === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) return false;
      i++;
    } else if (c === '"') {
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === '\\') i++;
    } else if (c === '<' && depth === 0 && /\b(include|use)\s*$/.test(source.slice(Math.max(0, i - 12), i))) {
      i = source.indexOf('>', i); // a library path, which may contain anything
      if (i < 0) return false;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && c === '=' && next !== '=' && !'<>!='.includes(source[i - 1])) {
      inValue = true;
    } else if (depth === 0 && c === ';') {
      inValue = false;
    } else if ((c === '#' || c === '%') && depth === 0 && !inValue) {
      return true;
    }
  }
  return false;
}

/** One node of a `.csg` file: `name(args) { children }` or `name(args);`, maybe with a marker. */
export interface CsgNode {
  marker?: '#' | '%' | '!' | '*';
  name: string;
  /** The argument text between the parentheses, with strings re-escaped. */
  args: string;
  children: CsgNode[];
}

/** Parse a `.csg` export. Throws on text it can't follow. */
export function parseCsg(text: string): CsgNode[] {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const fail = (what: string): never => {
    throw new Error(`CSG: expected ${what} at offset ${i}`);
  };

  const parseNodes = (closing: boolean): CsgNode[] => {
    const nodes: CsgNode[] = [];
    for (;;) {
      skipSpace();
      if (i >= text.length) {
        if (closing) fail('"}"');
        return nodes;
      }
      if (text[i] === '}') {
        if (!closing) fail('a node');
        i++;
        return nodes;
      }
      nodes.push(parseNode());
    }
  };

  const parseNode = (): CsgNode => {
    let marker: CsgNode['marker'];
    if ('#%!*'.includes(text[i])) {
      marker = text[i] as CsgNode['marker'];
      i++;
      skipSpace();
    }
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 64));
    if (!nameMatch) fail('a module name');
    const name = nameMatch![0];
    i += name.length;
    skipSpace();
    if (text[i] !== '(') fail('"("');
    const args = parseArgs();
    skipSpace();
    let children: CsgNode[] = [];
    if (text[i] === '{') {
      i++;
      children = parseNodes(true);
    } else if (text[i] === ';') {
      i++;
    } else {
      fail('"{" or ";"');
    }
    return { marker, name, args, children };
  };

  /** From "(" to its matching ")", returning what's inside. */
  const parseArgs = (): string => {
    let out = '';
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        out += parseString();
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth === 0) {
        i++;
        return out.slice(1); // drop the opening "("
      }
      out += c;
    }
    return fail('")"');
  };

  /**
   * OpenSCAD writes strings without escaping quotes inside them (`"hi "q""`), so a quote only ends
   * the string when an argument separator or closing bracket follows it. Returns it escaped, and
   * leaves `i` on the closing quote for the caller's loop to step past.
   */
  const parseString = (): string => {
    const start = ++i;
    while (i < text.length && !(text[i] === '"' && /^\s*([,)\]]|$)/.test(text.slice(i + 1, i + 8)))) i++;
    const content = text.slice(start, i);
    return `"${content.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };

  return parseNodes(false);
}

/** Wrappers kept around an extracted part: they place and color it. Booleans and groups are dropped. */
const KEPT_ANCESTORS = new Set(['multmatrix', 'color']);
/** A marked node under one of these is a 2D shape, which can't go in a 3D mesh; it is skipped. */
const FLAT_CONTEXT = new Set(['linear_extrude', 'rotate_extrude', 'offset']);
const FLAT_SHAPES = new Set(['square', 'circle', 'polygon', 'text', 'import_svg']);

/**
 * CSG text holding every outermost part marked with `marker`, each inside the `multmatrix` and
 * `color` nodes above it, with the marker removed so it renders. Undefined when there are none.
 * Markers of the same kind inside a part are removed too (OpenSCAD would drop nested `%` parts).
 */
export function extractMarked(nodes: CsgNode[], marker: Marker): string | undefined {
  const parts: string[] = [];
  const visit = (node: CsgNode, wrappers: CsgNode[], flat: boolean) => {
    if (node.marker === '*') return;
    if (node.marker === marker) {
      if (!flat && !FLAT_SHAPES.has(node.name)) {
        let text = write({ ...node, marker: undefined }, marker, 0);
        for (const w of [...wrappers].reverse()) text = `${w.name}(${w.args}) {\n${indent(text)}\n}`;
        parts.push(text);
      }
      return;
    }
    const keep = KEPT_ANCESTORS.has(node.name) ? [...wrappers, node] : wrappers;
    for (const child of node.children) visit(child, keep, flat || FLAT_CONTEXT.has(node.name));
  };
  for (const node of nodes) visit(node, [], false);
  return parts.length > 0 ? `${parts.join('\n')}\n` : undefined;
}

function write(node: CsgNode, strip: Marker, level: number): string {
  const marker = node.marker && node.marker !== strip ? node.marker : '';
  const head = `${marker}${node.name}(${node.args})`;
  if (node.children.length === 0) return `${head};`;
  const body = node.children.map((c) => indent(write(c, strip, level + 1))).join('\n');
  return `${head} {\n${body}\n}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `\t${line}`)
    .join('\n');
}
