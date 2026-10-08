import * as path from 'node:path';

export interface SourceLocation {
  /** Absolute path. */
  file: string;
  /** 1-based line number. */
  line: number;
}

export interface ScadMessage {
  severity: 'error' | 'warning';
  message: string;
  location?: SourceLocation;
  /** TRACE lines that followed the message, e.g. the call chain for an assert. */
  trace: { message: string; location?: SourceLocation }[];
}

const MESSAGE = /^(ERROR|WARNING|DEPRECATED): (.*)$/;
const TRACE = /^TRACE: (.*)$/;
const LOCATION = /^(.*?) in file (.+), line (\d+)\s*$/;

/**
 * Pull errors and warnings out of OpenSCAD's console output. File names in the output are relative
 * to the main file's folder (e.g. "lib/helper.scad"), so they are resolved against it.
 */
export function parseScadMessages(output: string, mainFile: string): ScadMessage[] {
  const baseDir = path.dirname(mainFile);
  const messages: ScadMessage[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const msg = MESSAGE.exec(line);
    if (msg) {
      const { text, location } = splitLocation(msg[2], baseDir);
      messages.push({ severity: msg[1] === 'ERROR' ? 'error' : 'warning', message: text, location, trace: [] });
      continue;
    }
    const trace = TRACE.exec(line);
    if (trace && messages.length > 0) {
      const { text, location } = splitLocation(trace[1], baseDir);
      messages[messages.length - 1].trace.push({ message: text, location });
    }
  }
  return messages;
}

function splitLocation(text: string, baseDir: string): { text: string; location?: SourceLocation } {
  const m = LOCATION.exec(text);
  if (!m) return { text };
  return { text: m[1], location: { file: path.resolve(baseDir, m[2]), line: Number(m[3]) } };
}

/** Lines produced by echo(), without the "ECHO: " prefix. */
export function parseEchoes(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((l) => l.startsWith('ECHO: '))
    .map((l) => l.slice(6));
}

/**
 * Parse a make-style dependency file written by `openscad -d`:
 * `target: \` followed by one escaped path per continuation line.
 */
export function parseDepsFile(text: string): string[] {
  const body = text.replace(/\\\r?\n/g, ' ');
  const colon = body.search(/:\s/);
  if (colon < 0) return [];
  return body
    .slice(colon + 1)
    .trim()
    .split(/(?<!\\)\s+/)
    .filter(Boolean)
    .map((p) => p.replace(/\\ /g, ' ').replace(/\$\$/g, '$'));
}
