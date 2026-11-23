// mend: one patch tool for every AI edit format.
// Implements SPEC.md v1: unified diffs, SEARCH/REPLACE blocks, V4A patches
// and JSON editor calls, with three-tier fuzzy matching and all-or-nothing writes.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------- text helpers ----------

function patchLines(text: string): string[] {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  if (s.endsWith('\n')) parts.pop();
  return parts;
}

interface FileState {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseFileText(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const idx = text.indexOf('\n');
  let br = '\n';
  if (idx > 0 && text[idx - 1] === '\r') br = '\r\n';
  const eol = text.endsWith(br);
  const parts = text.split(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function serializeFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.eol ? s.br : '');
}

function isSafe(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// ---------- matching (section 5) ----------

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function findOccurrences(file: string[], o: string[], tier: number, start: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = start; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function firstTierWith(
  file: string[],
  o: string[],
  strict: boolean,
  start: number,
): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = findOccurrences(file, o, t, start);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function reindentLine(line: string, f: string, p: string): string {
  if (line === '') return line;
  if (/^[ \t]*$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

// N lines where ctx[i] marks a context line (written as the file's own line).
// ctxOIdx lists, in order, the O-indices of the context lines.
function buildN(
  n: string[],
  nCtx: boolean[],
  o: string[],
  ctxOIdx: number[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const out: string[] = [];
  let c = 0;
  const f = tier === 2 && o.length > 0 ? leadingWs(fileLines[pos]) : '';
  const p = tier === 2 && o.length > 0 ? leadingWs(o[0]) : '';
  for (let i = 0; i < n.length; i++) {
    if (nCtx[i]) {
      out.push(fileLines[pos + ctxOIdx[c]]);
      c++;
    } else if (tier === 2) {
      out.push(reindentLine(n[i], f, p));
    } else {
      out.push(n[i]);
    }
  }
  return out;
}

// ---------- in-memory tree ----------

class Tree {
  cur = new Map<string, string | null>();
  orig = new Map<string, string | null>();

  get(p: string): string | null {
    if (this.cur.has(p)) return this.cur.get(p) as string | null;
    let v: string | null;
    if (this.orig.has(p)) {
      v = this.orig.get(p) as string | null;
    } else {
      try {
        v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    this.cur.set(p, v);
    return v;
  }

  set(p: string, v: string | null): void {
    this.cur.set(p, v);
  }

  diskOrig(p: string): string | null {
    if (this.orig.has(p)) return this.orig.get(p) as string | null;
    let v: string | null = null;
    try {
      v = readFileSync(p, 'utf8');
    } catch {
      v = null;
    }
    this.orig.set(p, v);
    return v;
  }
}

// ---------- edit representation ----------

interface Hunk {
  a: number;
  o: string[];
  oCtx: boolean[];
  n: string[];
  nCtx: boolean[];
  noBreak: boolean;
  plus: string[];
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  oCtx: boolean[];
  n: string[];
  nCtx: boolean[];
}

type Edit =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'change'; path: string; hunks: Hunk[] }
  | { kind: 'move'; oldPath: string; newPath: string; hunks: Hunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'vupdate'; path: string; newPath: string | null; chunks: VChunk[] }
  | { kind: 'json-str'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; line: number; newStr: string }
  | { kind: 'noop' };

interface Failure {
  code: string;
  path: string;
}

function fail(code: string, path: string): Failure {
  return { code, path };
}

// ---------- format detection (section 4) ----------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const t = lines[first].trimStart();
  if (t.startsWith('[') || t.startsWith('{')) return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- unified diffs (section 6) ----------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface BodyItem {
  kind: string; // 'ctx' | 'old' | 'new' | 'bs'
  text: string;
  emptyLine: boolean;
}

function collectHunkBody(lines: string[], start: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ') || l === 'diff --git') break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', emptyLine: true });
      j++;
      continue;
    }
    const c = l[0];
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1), emptyLine: false });
      j++;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1), emptyLine: false });
      j++;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1), emptyLine: false });
      j++;
      continue;
    }
    if (c === '\\') {
      items.push({ kind: 'bs', text: '', emptyLine: false });
      j++;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1];
    if (last.kind === 'ctx' && last.emptyLine) items.pop();
    else break;
  }
  return { items, next: j };
}

function hunkFromItems(a: number, items: BodyItem[]): Hunk {
  const o: string[] = [];
  const oCtx: boolean[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  const plus: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      oCtx.push(true);
      n.push(it.text);
      nCtx.push(true);
    } else if (it.kind === 'old') {
      o.push(it.text);
      oCtx.push(false);
    } else if (it.kind === 'new') {
      n.push(it.text);
      nCtx.push(false);
      plus.push(it.text);
    }
  }
  let noBreak = false;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'ctx' || items[i].kind === 'new') {
      // last context or '+' line: a '\' directly after it?
      let isLast = true;
      for (let k = i + 1; k < items.length; k++) {
        if (items[k].kind === 'ctx' || items[k].kind === 'new') {
          isLast = false;
          break;
        }
      }
      if (isLast && i + 1 < items.length && items[i + 1].kind === 'bs') noBreak = true;
    }
  }
  return { a, o, oCtx, n, nCtx, noBreak, plus };
}

function headerPath(line: string): string {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  const cut = tab === -1 ? raw : raw.slice(0, tab);
  return cut.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface Section {
  oldHdr: string | null;
  newHdr: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function newSection(diffOld: string | null, diffNew: string | null): Section {
  return {
    oldHdr: null,
    newHdr: null,
    renameFrom: null,
    renameTo: null,
    diffOld,
    diffNew,
    isCreate: false,
    isDelete: false,
    hasPair: false,
    hunks: [],
  };
}

function sectionToEdit(sec: Section): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (sec.hasPair) {
    oldP = sec.oldHdr;
    newP = sec.newHdr;
  } else {
    oldP = sec.renameFrom !== null ? sec.renameFrom : sec.diffOld;
    newP = sec.renameTo !== null ? sec.renameTo : sec.diffNew;
  }
  if (oldP === '/dev/null') oldP = null;
  if (newP === '/dev/null') newP = null;
  if (oldP !== null) oldP = stripAB(oldP);
  if (newP !== null) newP = stripAB(newP);
  if (oldP === null || sec.isCreate) {
    if (newP === null) return { kind: 'noop' };
    const plus: string[] = [];
    let noBreak = false;
    for (const h of sec.hunks) {
      for (const p of h.plus) plus.push(p);
    }
    // '\' after the last '+' line of all hunks
    for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
      if (sec.hunks[hi].plus.length > 0) {
        noBreak = sec.hunks[hi].noBreak;
        break;
      }
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n');
    return { kind: 'create', path: newP, text };
  }
  if (newP === null || sec.isDelete) {
    return { kind: 'delete', path: oldP };
  }
  if (oldP !== newP) {
    return { kind: 'move', oldPath: oldP, newPath: newP, hunks: sec.hunks };
  }
  return { kind: 'change', path: oldP, hunks: sec.hunks };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: Section | null = null;
  let inHunks = false;
  let i = 0;

  const startDiffSection = (lineNo: number): void => {
    const line = lines[lineNo - 1];
    const m = /^diff --git a\/([^ ]+) b\/([^ ]+)\s*$/.exec(line);
    if (!m) throw new ParseError(lineNo);
    if (sec !== null) edits.push(sectionToEdit(sec));
    sec = newSection(m[1], m[2]);
    inHunks = false;
  };

  const startBareSection = (lineNo: number): void => {
    if (sec !== null) edits.push(sectionToEdit(sec));
    sec = newSection(null, null);
    inHunks = false;
    // consume the '--- ' line as this section's header
    const line = lines[lineNo - 1];
    sec.oldHdr = headerPath(line);
    sec.hasPair = true;
  };

  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      startDiffSection(lineNo);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseError(lineNo);
      const m = HUNK_RE.exec(line);
      if (!m) throw new ParseError(lineNo);
      const a = parseInt(m[1], 10);
      const body = collectHunkBody(lines, i + 1);
      sec.hunks.push(hunkFromItems(a, body.items));
      inHunks = true;
      i = body.next;
      continue;
    }
    if (sec === null) {
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        startBareSection(lineNo);
        i++;
        continue;
      }
      i++;
      continue;
    }
    // inside a section
    if (!inHunks) {
      if (line.startsWith('--- ')) {
        if (sec.oldHdr === null) {
          if (!(i + 1 < lines.length && lines[i + 1].startsWith('+++ '))) {
            throw new ParseError(lineNo + 1);
          }
          sec.oldHdr = headerPath(line);
          sec.hasPair = true;
          i++;
          continue;
        }
        // already have a '--- ': new section if followed by '+++ '
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          startBareSection(lineNo);
          i++;
          continue;
        }
        throw new ParseError(lineNo + 1);
      }
      if (line.startsWith('+++ ')) {
        if (sec.newHdr === null) sec.newHdr = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (sec.renameFrom === null) sec.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (sec.renameTo === null) sec.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // after hunks started
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      startBareSection(lineNo);
      i++;
      continue;
    }
    i++;
  }
  if (sec !== null) edits.push(sectionToEdit(sec));
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------- SEARCH/REPLACE (section 7) ----------

function parseSR(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new ParseError(searchLine);
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trimEnd();
        if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
        if (t === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new ParseError(searchLine);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        const t = lines[j].trimEnd();
        if (t === '<<<<<<< SEARCH') break;
        if (t === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new ParseError(searchLine);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push({ kind: 'sr', path, oldLines, newLines });
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------- V4A (section 8) ----------

function chunkFromBody(anchor: string | null, eof: boolean, body: string[]): VChunk {
  const o: string[] = [];
  const oCtx: boolean[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      oCtx.push(true);
      n.push(t);
      nCtx.push(true);
    } else if (l[0] === '-') {
      o.push(l.slice(1));
      oCtx.push(false);
    } else if (l[0] === '+') {
      n.push(l.slice(1));
      nCtx.push(false);
    }
  }
  return { anchor, eof, o, oCtx, n, nCtx };
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].trim() !== '') {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    let headerKind: string | null = null;
    let headerPath = '';
    if (line.startsWith('*** Add File: ')) {
      headerKind = 'add';
      headerPath = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      headerKind = 'delete';
      headerPath = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      headerKind = 'update';
      headerPath = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseError(i + 1);
    }
    // collect raw section lines (with numbers) until next header or End Patch
    const raw: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j];
      if (
        l.startsWith('*** Add File: ') ||
        l.startsWith('*** Delete File: ') ||
        l.startsWith('*** Update File: ')
      ) {
        break;
      }
      raw.push({ text: l, no: j + 1 });
      j++;
    }
    // strip trailing blank lines
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
    if (headerKind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new ParseError(r.no);
      }
      const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
      edits.push({ kind: 'create', path: headerPath, text });
    } else if (headerKind === 'delete') {
      for (const r of raw) {
        if (r.text.trim() !== '') throw new ParseError(r.no);
      }
      edits.push({ kind: 'delete', path: headerPath });
    } else {
      // update
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
      let firstLine = true;
      for (const r of raw) {
        const l = r.text;
        if (firstLine && l.startsWith('*** Move to: ')) {
          moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(chunkFromBody(cur.anchor, cur.eof, cur.body));
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new ParseError(r.no);
          cur.eof = true;
          chunks.push(chunkFromBody(cur.anchor, cur.eof, cur.body));
          cur = null;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseError(r.no);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push(l);
          continue;
        }
        throw new ParseError(r.no);
      }
      if (cur !== null) chunks.push(chunkFromBody(cur.anchor, cur.eof, cur.body));
      if (chunks.length === 0 && moveTo === null) throw new ParseError(i + 1);
      edits.push({ kind: 'vupdate', path: headerPath, newPath: moveTo, chunks });
    }
    i = j;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------- JSON (section 9) ----------

function validateEditObject(o: unknown, line: number): Edit {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new ParseError(line);
  const r = o as Record<string, unknown>;
  if (typeof r.path !== 'string') throw new ParseError(line);
  if (typeof r.command !== 'string') throw new ParseError(line);
  if (r.command === 'create') {
    if (typeof r.file_text !== 'string') throw new ParseError(line);
    return { kind: 'create', path: r.path, text: r.file_text };
  }
  if (r.command === 'str_replace') {
    if (typeof r.old_str !== 'string' || r.old_str === '') throw new ParseError(line);
    if (r.new_str !== undefined && typeof r.new_str !== 'string') throw new ParseError(line);
    return {
      kind: 'json-str',
      path: r.path,
      oldStr: r.old_str,
      newStr: typeof r.new_str === 'string' ? r.new_str : '',
    };
  }
  if (r.command === 'insert') {
    if (typeof r.insert_line !== 'number' || !Number.isInteger(r.insert_line)) throw new ParseError(line);
    if (typeof r.new_str !== 'string') throw new ParseError(line);
    return { kind: 'json-insert', path: r.path, line: r.insert_line, newStr: r.new_str };
  }
  throw new ParseError(line);
}

function parseJSON(lines: string[], text: string): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(first + 1);
    const edits: Edit[] = [];
    for (const el of arr) edits.push(validateEditObject(el, first + 1));
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[k]);
    } catch {
      throw new ParseError(k + 1);
    }
    edits.push(validateEditObject(obj, k + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------- applying edits (section 10) ----------

function ctxOIndices(oCtx: boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < oCtx.length; i++) if (oCtx[i]) out.push(i);
  return out;
}

function applyHunk(
  st: FileState,
  h: Hunk,
  d: number,
  strict: boolean,
): { ok: true; st: FileState; d: number } | { ok: false; code: string } {
  if (h.o.length === 0) {
    const ins = Math.max(0, Math.min(h.a + d, st.lines.length));
    const lines = st.lines.slice();
    lines.splice(ins, 0, ...h.n);
    let eol = st.eol;
    if (ins === st.lines.length) eol = !h.noBreak;
    return { ok: true, st: { lines, br: st.br, eol }, d: d + h.n.length };
  }
  const found = firstTierWith(st.lines, h.o, strict, 0);
  if (!found) return { ok: false, code: 'no-match' };
  const target = h.a - 1 + d;
  let best = found.occ[0];
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const nPrime = buildN(h.n, h.nCtx, h.o, ctxOIndices(h.oCtx), st.lines, best, found.tier);
  const lines = st.lines.slice();
  lines.splice(best, h.o.length, ...nPrime);
  let eol = st.eol;
  if (best + h.o.length === st.lines.length) eol = !h.noBreak;
  return { ok: true, st: { lines, br: st.br, eol }, d: d + (h.n.length - h.o.length) };
}

function countOccurrences(text: string, needle: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let idx = 0;
  while (true) {
    const p = text.indexOf(needle, idx);
    if (p === -1) break;
    count++;
    if (first === -1) first = p;
    idx = p + 1;
  }
  return { count, first };
}

function applyEdit(
  tree: Tree,
  ed: Edit,
  strict: boolean,
  moves: { old: string; nw: string }[],
): Failure | null {
  switch (ed.kind) {
    case 'noop':
      return null;
    case 'create': {
      if (!isSafe(ed.path)) return fail('unsafe', ed.path);
      if (tree.get(ed.path) !== null) return fail('exists', ed.path);
      tree.set(ed.path, ed.text);
      return null;
    }
    case 'delete': {
      if (!isSafe(ed.path)) return fail('unsafe', ed.path);
      if (tree.get(ed.path) === null) return fail('missing', ed.path);
      tree.set(ed.path, null);
      return null;
    }
    case 'change': {
      if (!isSafe(ed.path)) return fail('unsafe', ed.path);
      const cur = tree.get(ed.path);
      if (cur === null) return fail('missing', ed.path);
      let st = parseFileText(cur);
      let d = 0;
      for (const h of ed.hunks) {
        const res = applyHunk(st, h, d, strict);
        if (!res.ok) return fail(res.code, ed.path);
        st = res.st;
        d = res.d;
      }
      tree.set(ed.path, serializeFile(st));
      return null;
    }
    case 'move': {
      if (!isSafe(ed.oldPath)) return fail('unsafe', ed.oldPath);
      if (!isSafe(ed.newPath)) return fail('unsafe', ed.newPath);
      const cur = tree.get(ed.oldPath);
      if (cur === null) return fail('missing', ed.oldPath);
      if (tree.get(ed.newPath) !== null) return fail('exists', ed.newPath);
      let st = parseFileText(cur);
      let d = 0;
      for (const h of ed.hunks) {
        const res = applyHunk(st, h, d, strict);
        if (!res.ok) return fail(res.code, ed.oldPath);
        st = res.st;
        d = res.d;
      }
      tree.set(ed.newPath, serializeFile(st));
      tree.set(ed.oldPath, null);
      moves.push({ old: ed.oldPath, nw: ed.newPath });
      return null;
    }
    case 'sr': {
      if (!isSafe(ed.path)) return fail('unsafe', ed.path);
      if (ed.oldLines.length === 0) {
        if (tree.get(ed.path) !== null) return fail('exists', ed.path);
        const text = ed.newLines.length === 0 ? '' : ed.newLines.join('\n') + '\n';
        tree.set(ed.path, text);
        return null;
      }
      const cur = tree.get(ed.path);
      if (cur === null) return fail('missing', ed.path);
      const st = parseFileText(cur);
      const found = firstTierWith(st.lines, ed.oldLines, strict, 0);
      if (!found) return fail('no-match', ed.path);
      if (found.occ.length !== 1) return fail('ambiguous', ed.path);
      const pos = found.occ[0];
      const nPrime = buildN(
        ed.newLines,
        ed.newLines.map(() => false),
        ed.oldLines,
        [],
        st.lines,
        pos,
        found.tier,
      );
      const lines = st.lines.slice();
      lines.splice(pos, ed.oldLines.length, ...nPrime);
      tree.set(ed.path, serializeFile({ lines, br: st.br, eol: st.eol }));
      return null;
    }
    case 'vupdate': {
      if (!isSafe(ed.path)) return fail('unsafe', ed.path);
      if (ed.newPath !== null && !isSafe(ed.newPath)) return fail('unsafe', ed.newPath);
      const cur = tree.get(ed.path);
      if (cur === null) return fail('missing', ed.path);
      if (ed.newPath !== null && tree.get(ed.newPath) !== null) return fail('exists', ed.newPath);
      const st = parseFileText(cur);
      const lines = st.lines.slice();
      let cursor = 0;
      for (const ch of ed.chunks) {
        if (ch.anchor !== null) {
          let foundIdx = -1;
          for (const t of tiers(strict)) {
            for (let k = cursor; k < lines.length; k++) {
              if (lineEq(lines[k], ch.anchor as string, t)) {
                foundIdx = k;
                break;
              }
            }
            if (foundIdx !== -1) break;
          }
          if (foundIdx === -1) return fail('no-match', ed.path);
          cursor = foundIdx + 1;
        }
        if (ch.o.length === 0) {
          const ins = ch.eof ? lines.length : cursor;
          lines.splice(ins, 0, ...ch.n);
          cursor = ins + ch.n.length;
        } else {
          const found = firstTierWith(lines, ch.o, strict, cursor);
          if (!found) return fail('no-match', ed.path);
          let occ = found.occ;
          if (ch.eof) occ = occ.filter((p) => p + ch.o.length === lines.length);
          if (occ.length === 0) return fail('no-match', ed.path);
          const pos = occ[0];
          const nPrime = buildN(ch.n, ch.nCtx, ch.o, ctxOIndices(ch.oCtx), lines, pos, found.tier);
          lines.splice(pos, ch.o.length, ...nPrime);
          cursor = pos + nPrime.length;
        }
      }
      const out = serializeFile({ lines, br: st.br, eol: st.eol });
      if (ed.newPath !== null) {
        tree.set(ed.newPath, out);
        tree.set(ed.path, null);
        moves.push({ old: ed.path, nw: ed.newPath });
      } else {
        tree.set(ed.path, out);
      }
      return null;
    }
    case 'json-str': {
      if (!isSafe(ed.path)) return fail('unsafe', ed.path);
      const cur = tree.get(ed.path);
      if (cur === null) return fail('missing', ed.path);
      const st = parseFileText(cur);
      if (st.br === '\r\n') {
        const norm = (s: string): string => s.split('\r\n').join('\n');
        const text = norm(cur);
        const oldN = norm(ed.oldStr);
        const newN = norm(ed.newStr);
        const { count, first } = countOccurrences(text, oldN);
        if (count === 0) return fail('no-match', ed.path);
        if (count > 1) return fail('ambiguous', ed.path);
        const res = text.slice(0, first) + newN + text.slice(first + oldN.length);
        tree.set(ed.path, res.split('\n').join('\r\n'));
      } else {
        const { count, first } = countOccurrences(cur, ed.oldStr);
        if (count === 0) return fail('no-match', ed.path);
        if (count > 1) return fail('ambiguous', ed.path);
        tree.set(ed.path, cur.slice(0, first) + ed.newStr + cur.slice(first + ed.oldStr.length));
      }
      return null;
    }
    case 'json-insert': {
      if (!isSafe(ed.path)) return fail('unsafe', ed.path);
      const cur = tree.get(ed.path);
      if (cur === null) return fail('missing', ed.path);
      const st = parseFileText(cur);
      if (ed.line < 0 || ed.line > st.lines.length) return fail('no-match', ed.path);
      const insLines = splitNewStr(ed.newStr);
      const lines = st.lines.slice();
      lines.splice(ed.line, 0, ...insLines);
      tree.set(ed.path, serializeFile({ lines, br: st.br, eol: st.eol }));
      return null;
    }
  }
}

// ---------- CLI (section 1) ----------

function usage(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  const seen = new Set<string>();
  let endOpts = false;
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seen.has('check')) return usage();
        seen.add('check');
        check = true;
      } else if (a === '--strict') {
        if (seen.has('strict')) return usage();
        seen.add('strict');
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seen.has('format')) return usage();
        seen.add('format');
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') {
          return usage();
        }
        format = v;
      } else {
        return usage();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return usage();

  let patchText: string;
  if (positional.length === 1 && positional[0] !== '-') {
    try {
      patchText = readFileSync(positional[0], 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    patchText = readFileSync(0, 'utf8');
  }

  const lines = patchLines(patchText);
  let fmt = format === null ? 'auto' : format;
  if (fmt === 'auto') {
    const det = detectFormat(lines);
    if (det === null) return { code: 2, out: ['error: format'] };
    fmt = det;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSR(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new Tree();
  const failures: Failure[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const ed of edits) {
    const f = applyEdit(tree, ed, strict, moves);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  // output lines + write (section 2)
  const disk = new Map<string, string | null>();
  for (const p of tree.cur.keys()) disk.set(p, tree.diskOrig(p));
  const keyed: { key: string; line: string }[] = [];
  const usedR = new Set<string>();
  for (const m of moves) {
    const oOrig = disk.get(m.old);
    const nOrig = disk.get(m.nw);
    const oCur = tree.cur.get(m.old);
    const nCur = tree.cur.get(m.nw);
    if (oOrig !== null && oOrig !== undefined && oCur === null && nOrig === null && nCur !== null) {
      keyed.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      usedR.add(m.old);
      usedR.add(m.nw);
    }
  }
  for (const p of tree.cur.keys()) {
    const o = disk.get(p);
    const c = tree.cur.get(p);
    if (o === c) continue;
    if (usedR.has(p)) continue;
    if (o === null || o === undefined) keyed.push({ key: p, line: `A ${p}` });
    else if (c === null) keyed.push({ key: p, line: `D ${p}` });
    else keyed.push({ key: p, line: `M ${p}` });
  }
  keyed.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  const out = keyed.map((k) => k.line);
  out.push(keyed.length === 1 ? 'ok: 1 file' : `ok: ${keyed.length} files`);

  if (!check) {
    for (const p of tree.cur.keys()) {
      const o = disk.get(p);
      const c = tree.cur.get(p);
      if (o === c) continue;
      if (c === null) {
        if (existsSync(p)) unlinkSync(p);
      } else {
        const d = dirname(p);
        if (d !== '.' && d !== '') mkdirSync(d, { recursive: true });
        writeFileSync(p, c, 'utf8');
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
