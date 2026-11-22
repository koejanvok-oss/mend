// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

function readState(tree: Tree, p: string): FileState | null {
  const t = tree.get(p);
  return t === null ? null : parseFile(t);
}

function writeState(tree: Tree, p: string, f: FileState | null): void {
  tree.now.set(p, f === null ? null : renderFile(f));
}

type Edit = (tree: Tree) => void;

// ---- Matching lines (SPEC.md section 5) ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in the file at one tier; occurrences may overlap. */
function occurrencesAt(file: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(file[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, or 0..2 unless strict) with an occurrence at or after `from`. */
function findTier(file: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrencesAt(file, O, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is. */
function findSingle(file: string[], line: string, from: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < file.length; i++) {
      if (tierEq(file[i]!, line, t)) return i;
    }
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** The lines N writes over O matched at `pos`, re-indented at tier 2. */
function buildReplacement(file: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const out: string[] = [];
  const F = leadWs(file[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  for (const n of N) {
    if (n.ctx) {
      out.push(file[pos + n.oIndex]!);
      continue;
    }
    let t = n.text;
    if (tier === 2 && t !== '' && !onlyWs(t) && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

// ---- Unified diffs (SPEC.md section 6) ----

type BodyItem = { kind: 'ctx' | 'del' | 'add' | 'noeol'; text: string };

function parseBody(raw: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const l of raw) {
    if (l === '') items.push({ kind: 'ctx', text: '' });
    else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1) });
    else if (l[0] === '-') items.push({ kind: 'del', text: l.slice(1) });
    else if (l[0] === '+') items.push({ kind: 'add', text: l.slice(1) });
    else if (l[0] === '\\') items.push({ kind: 'noeol', text: l.slice(1) });
  }
  return items;
}

/** Split a hunk body into its old lines O and its new lines N. */
function splitHunk(items: BodyItem[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const idx = O.length;
      O.push(it.text);
      N.push({ text: it.text, ctx: true, oIndex: idx });
    } else if (it.kind === 'del') {
      O.push(it.text);
    } else if (it.kind === 'add') {
      N.push({ text: it.text, ctx: false, oIndex: -1 });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'add') {
      return items[k + 1]?.kind === 'noeol';
    }
  }
  return false;
}

interface Hunk {
  A: number;
  body: string[];
}

/** Apply a section's hunks in order to a file; throws Fail on no-match. */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    const items = parseBody(h.body);
    const { O, N } = splitHunk(items);
    const noEol = hunkNoEol(items);
    if (O.length === 0) {
      const at = Math.min(h.A + d, cur.lines.length);
      const ins = N.map((n) => n.text);
      const lines = [...cur.lines.slice(0, at), ...ins, ...cur.lines.slice(at)];
      let final = cur.final;
      if (at === cur.lines.length) final = !noEol;
      cur = { lines, br: cur.br, final };
      d += N.length;
    } else {
      const found = findTier(cur.lines, O, 0, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const rep = buildReplacement(cur.lines, best, O, N, found.tier);
      const lines = [...cur.lines.slice(0, best), ...rep, ...cur.lines.slice(best + O.length)];
      let final = cur.final;
      if (best + O.length === cur.lines.length) final = !noEol;
      cur = { lines, br: cur.br, final };
      d += N.length - O.length;
    }
  }
  return cur;
}

interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  diffOld: string | null;
  diffNew: string | null;
  hunks: Hunk[];
}

function newSection(diffOld: string, diffNew: string): Section {
  return {
    oldPath: undefined,
    newPath: undefined,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    diffOld,
    diffNew,
    hunks: [],
  };
}

/** A `--- <path>` / `+++ <path>` header line: the path, or null for `/dev/null`. */
function diffPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let section: Section | null = null;
  let hunk: Hunk | null = null;
  let body: string[] = [];
  const finalizeBody = (): void => {
    if (hunk) {
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      hunk.body = body;
      body = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      finalizeBody();
      hunk = null;
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (section) sections.push(section);
      section = newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!section) throw new Exit2(`error: parse ${i + 1}`);
      finalizeBody();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: parseInt(m[1]!, 10), body: [] };
      section.hunks.push(hunk);
      body = [];
      i++;
      continue;
    }
    if (hunk) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finalizeBody();
        hunk = null;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        body.push(line);
        i++;
        continue;
      }
      finalizeBody();
      hunk = null;
      continue;
    }
    if (!section) {
      if (line.startsWith('--- ')) {
        const next = lines[i + 1];
        if (next !== undefined && next.startsWith('+++ ')) {
          section = newSection('', '');
          section.oldPath = diffPath(line);
          section.newPath = diffPath(next);
          i += 2;
          continue;
        }
      }
      i++;
      continue;
    }
    const inHeader = section.hunks.length === 0;
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) {
        if (!inHeader) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (!inHeader) {
        if (section) sections.push(section);
        section = newSection('', '');
        section.oldPath = diffPath(line);
        section.newPath = diffPath(next);
        i += 2;
        continue;
      }
      section.oldPath = diffPath(line);
      section.newPath = diffPath(next);
      i += 2;
      continue;
    }
    if (!inHeader) {
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      section.newPath = diffPath(line);
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      section.renameFrom = line.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      section.renameTo = line.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      section.isCreate = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      section.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  finalizeBody();
  if (section) sections.push(section);
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(s: Section, strict: boolean): Edit {
  let oldP: string | null | undefined = s.oldPath;
  let newP: string | null | undefined = s.newPath;
  if (oldP === undefined && s.renameFrom !== null) oldP = s.renameFrom;
  if (newP === undefined && s.renameTo !== null) newP = s.renameTo;
  if (oldP === undefined) oldP = s.diffOld;
  if (newP === undefined) newP = s.diffNew;
  if (oldP === undefined) oldP = newP;
  if (newP === undefined) newP = oldP;
  const oldPath = oldP as string | null;
  const newPath = newP as string | null;
  const isCreate = oldPath === null || s.isCreate;
  const isDelete = !isCreate && (newPath === null || s.isDelete);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const created: string[] = [];
      let lastNoEol = false;
      for (const h of s.hunks) {
        const items = parseBody(h.body);
        let hasPlus = false;
        let thisNoEol = false;
        for (let k = 0; k < items.length; k++) {
          if (items[k]!.kind === 'add') {
            created.push(items[k]!.text);
            hasPlus = true;
            thisNoEol = items[k + 1]?.kind === 'noeol';
          }
        }
        if (hasPlus) lastNoEol = thisNoEol;
      }
      writeState(tree, p, { lines: created, br: '\n', final: created.length > 0 ? !lastNoEol : false });
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      writeState(tree, p, null);
      return;
    }
    if (isMove) {
      const from = oldPath!;
      const to = newPath!;
      if (tree.get(from) === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const f = applyHunks(readState(tree, from)!, s.hunks, strict, from);
      writeState(tree, from, null);
      writeState(tree, to, f);
      tree.moves.push({ old: from, new: to });
      return;
    }
    const p = oldPath!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    const f = applyHunks(readState(tree, p)!, s.hunks, strict, p);
    writeState(tree, p, f);
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
      if (l.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      writeState(tree, path, { lines: [...newLines], br: '\n', final: newLines.length > 0 });
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = parseFile(t);
    const found = findTier(f.lines, oldLines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const N: NLine[] = newLines.map((text) => ({ text, ctx: false, oIndex: -1 }));
    const rep = buildReplacement(f.lines, pos, oldLines, N, found.tier);
    const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)];
    writeState(tree, path, { lines, br: f.br, final: f.final });
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const updateLine = i + 1;
    const start = i + 1;
    let j = start;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j++;
    }
    let end = j;
    while (end > start && blank(lines[end - 1]!)) end--;
    const secLines = lines.slice(start, end);
    edits.push(v4aEdit(parseV4aSection(kind, path, secLines, start, updateLine), strict));
    i = j;
  }
  return edits;
}

function parseV4aSection(kind: 'add' | 'delete' | 'update', path: string, secLines: string[], start: number, updateLine: number): V4aSection {
  const sec: V4aSection = { kind, path, moveTo: null, addLines: [], chunks: [], updateLine };
  if (kind === 'add') {
    for (let k = 0; k < secLines.length; k++) {
      const l = secLines[k]!;
      if (l.startsWith('+')) sec.addLines.push(l.slice(1));
      else if (l === '') sec.addLines.push('');
      else throw new Exit2(`error: parse ${start + k + 1}`);
    }
    return sec;
  }
  if (kind === 'delete') {
    if (secLines.length > 0) throw new Exit2(`error: parse ${start + 1}`);
    return sec;
  }
  let k = 0;
  if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
    sec.moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  let chunk: V4aChunk | null = null;
  const body: BodyItem[] = [];
  const finishChunk = (): void => {
    if (!chunk) return;
    const { O, N } = splitHunk(parseBody(body));
    chunk.O = O;
    chunk.N = N;
    sec.chunks.push(chunk);
    chunk = null;
    body.length = 0;
  };
  for (; k < secLines.length; k++) {
    const l = secLines[k]!;
    if (l.startsWith('@@')) {
      finishChunk();
      chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, O: [], N: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (!chunk) throw new Exit2(`error: parse ${start + k + 1}`);
      chunk.eof = true;
      finishChunk();
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (!chunk) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${start + k + 1}`);
        chunk = { anchor: null, eof: false, O: [], N: [] };
      }
      body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${start + k + 1}`);
  }
  finishChunk();
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return sec;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      writeState(tree, sec.path, { lines: [...sec.addLines], br: '\n', final: sec.addLines.length > 0 });
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      writeState(tree, sec.path, null);
      return;
    }
    const t = tree.get(sec.path);
    if (t === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let f = parseFile(t);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findSingle(f.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = ch.N.map((n) => n.text);
        const lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
        f = { lines, br: f.br, final: f.final };
        cursor = at + ins.length;
      } else {
        const found = findTier(f.lines, ch.O, cursor, strict);
        if (!found) throw new Fail('no-match', sec.path);
        let pos = found.occ[0]!;
        if (ch.eof) {
          const ok = found.occ.filter((p) => p + ch.O.length === f.lines.length);
          if (ok.length === 0) throw new Fail('no-match', sec.path);
          pos = ok[0]!;
        }
        const rep = buildReplacement(f.lines, pos, ch.O, ch.N, found.tier);
        const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + ch.O.length)];
        f = { lines, br: f.br, final: f.final };
        cursor = pos + rep.length;
      }
    }
    if (sec.moveTo !== null) {
      writeState(tree, sec.path, null);
      writeState(tree, sec.moveTo, f);
      tree.moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      writeState(tree, sec.path, f);
    }
  };
}

// ---- JSON edits (SPEC.md section 9) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Running the patch (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const newWas = tree.original(m.new);
    const oldNow = tree.get(m.old);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      changed.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
