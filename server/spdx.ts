// Structured SPDX license expression handling.
// Parses expressions into an AST (AND / OR / license atoms), never uses
// string containment to decide compatibility.

export type SpdxNode =
  | { kind: 'license'; id: string; plus: boolean }
  | { kind: 'and'; left: SpdxNode; right: SpdxNode }
  | { kind: 'or'; left: SpdxNode; right: SpdxNode };

type Token =
  | { t: 'word'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'and' }
  | { t: 'or' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = input.trim();
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      tokens.push({ t: 'lparen' });
      i += 1;
    } else if (ch === ')') {
      tokens.push({ t: 'rparen' });
      i += 1;
    } else if (/\s/.test(ch)) {
      i += 1;
    } else {
      let j = i;
      let buf = '';
      while (j < s.length && s[j] !== '(' && s[j] !== ')' && !/\s/.test(s[j])) {
        buf += s[j];
        j += 1;
      }
      i = j;
      if (buf === 'AND') tokens.push({ t: 'and' });
      else if (buf === 'OR') tokens.push({ t: 'or' });
      else if (buf === 'WITH') {
        // WITH <exception-id>: glue the exception id onto the prior atom.
        let k = i;
        while (k < s.length && /\s/.test(s[k])) k += 1;
        let ex = '';
        while (k < s.length && s[k] !== '(' && s[k] !== ')' && !/\s/.test(s[k])) {
          ex += s[k];
          k += 1;
        }
        i = k;
        const prev = tokens[tokens.length - 1];
        if (prev && prev.t === 'word') prev.v = `${prev.v} WITH ${ex}`;
        else throw new SpdxError(`dangling WITH near "${ex}"`);
      } else {
        tokens.push({ t: 'word', v: buf });
      }
    }
  }
  return tokens;
}

export class SpdxError extends Error {}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): SpdxNode {
    const node = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new SpdxError('unexpected trailing tokens');
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  // AND binds tighter than OR (SPDX grammar).
  private parseOr(): SpdxNode {
    let left = this.parseAnd();
    while (this.peek()?.t === 'or') {
      this.pos += 1;
      left = { kind: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): SpdxNode {
    let left = this.parseAtom();
    while (this.peek()?.t === 'and') {
      this.pos += 1;
      left = { kind: 'and', left, right: this.parseAtom() };
    }
    return left;
  }

  private parseAtom(): SpdxNode {
    const tok = this.peek();
    if (!tok) throw new SpdxError('unexpected end of expression');
    if (tok.t === 'lparen') {
      this.pos += 1;
      const inner = this.parseOr();
      const close = this.peek();
      if (!close || close.t !== 'rparen') throw new SpdxError('missing ")"');
      this.pos += 1;
      return inner;
    }
    if (tok.t === 'word') {
      this.pos += 1;
      let id = tok.v;
      let plus = false;
      if (id.endsWith('+')) {
        plus = true;
        id = id.slice(0, -1);
      }
      if (id === 'AND' || id === 'OR') throw new SpdxError(`unexpected operator ${id}`);
      return { kind: 'license', id, plus };
    }
    throw new SpdxError(`unexpected token ${JSON.stringify(tok)}`);
  }
}

/** Parse a raw SPDX expression. Throws SpdxError when structurally invalid. */
export function parseSpdx(raw: string): SpdxNode {
  const trimmed = raw.trim();
  if (!trimmed) throw new SpdxError('empty expression');
  return new Parser(tokenize(trimmed)).parse();
}

export function isValidSpdx(raw: string): boolean {
  try {
    parseSpdx(raw);
    return true;
  } catch {
    return false;
  }
}

function stripPlus(id: string): string {
  return id.endsWith('+') ? id.slice(0, -1) : id;
}

function atomMatches(atomId: string, atomPlus: boolean, available: Set<string>): boolean {
  const base = stripPlus(atomId);
  if (!atomPlus) return available.has(base);
  for (const a of available) {
    if (a === base || a.startsWith(`${base}.`) || a.startsWith(`${base}-`)) {
      return true;
    }
  }
  return false;
}

export type Tri = true | false | 'unknown';

/**
 * Whether the component's declared license AST satisfies the rule's AST.
 * Three-valued result:
 *  - true      : every licensing choice offered upstream covers the requirement
 *  - false     : no offered choice can cover it
 *  - 'unknown' : depends on an unrecognized license id
 */
export function satisfies(component: SpdxNode, rule: SpdxNode): Tri {
  return evalDnf(component, rule);
}

type Term = { id: string; plus: boolean }[];

// Disjunctive normal form: OR of AND-terms of license atoms.
function dnf(node: SpdxNode): Term[] {
  if (node.kind === 'license') return [[{ id: node.id, plus: node.plus }]];
  if (node.kind === 'and') {
    const l = dnf(node.left);
    const r = dnf(node.right);
    const out: Term[] = [];
    for (const a of l) for (const b of r) out.push([...a, ...b]);
    return out;
  }
  return [...dnf(node.left), ...dnf(node.right)];
}

// Does a single offered license (conjunction set) satisfy one AND-term of
// the rule? A term is satisfied when every required atom is present.
function termCovers(term: Term, offered: Set<string>, offeredUnknown: boolean): Tri {
  let sawUnknown = false;
  for (const req of term) {
    if (atomMatches(req.id, req.plus, offered)) continue;
    if (offeredUnknown) sawUnknown = true;
    else return false;
  }
  return sawUnknown ? 'unknown' : true;
}

/**
 * Component licensing expressed in DNF: the upstream offers a choice (OR)
 * between conjunctions (AND). The rule is likewise DNF.
 * Conservative semantics: EVERY offered alternative must be coverable by at
 * least one rule term; otherwise the component could be used under a
 * non-covered license. Unknown licenses propagate the 'unknown' value.
 */
function evalDnf(comp: SpdxNode, rule: SpdxNode): Tri {
  const ruleTerms = dnf(rule);
  const options = dnf(comp);
  let anyUnknown = false;

  for (const option of options) {
    const offered = new Set(option.map((a) => stripPlus(a.plus ? `${a.id}+` : a.id)));
    const offeredUnknown = option.some((a) => !known(a.plus ? `${a.id}+` : a.id));
    let best: Tri = false;
    for (const term of ruleTerms) {
      const r = termCovers(term, offered, offeredUnknown);
      if (r === true) {
        best = true;
        break;
      }
      if (r === 'unknown') best = 'unknown';
    }
    if (best === false) return false;
    if (best === 'unknown') anyUnknown = true;
  }
  return anyUnknown ? 'unknown' : true;
}

let KNOWN: Set<string> | null = null;
export function known(id: string): boolean {
  if (!KNOWN) KNOWN = new Set(KNOWN_SPDX_IDS);
  const base = stripPlus(id);
  if (base.includes(' WITH ')) {
    const [lic] = base.split(' WITH ');
    return KNOWN.has(lic);
  }
  return KNOWN.has(base);
}

/**
 * Build the component AST from CycloneDX license entries. Multiple entries
 * are alternatives (OR) per spec. Unparseable entries stay unknown.
 */
export function componentAst(rawExpressions: string[]): {
  node: SpdxNode | null;
  unknownRaw: string[];
} {
  const parsed: SpdxNode[] = [];
  const unknownRaw: string[] = [];
  for (const raw of rawExpressions) {
    try {
      parsed.push(parseSpdx(raw));
    } catch {
      unknownRaw.push(raw);
    }
  }
  if (parsed.length === 0) return { node: null, unknownRaw };
  let node = parsed[0];
  for (let i = 1; i < parsed.length; i += 1) {
    node = { kind: 'or', left: node, right: parsed[i] };
  }
  return { node, unknownRaw };
}

export function atomsOf(node: SpdxNode): string[] {
  if (node.kind === 'license') return [node.plus ? `${node.id}+` : node.id];
  return [...atomsOf(node.left), ...atomsOf(node.right)];
}

const KNOWN_SPDX_IDS = [
  'MIT', 'Apache-2.0', 'Apache-1.1', 'BSD-2-Clause', 'BSD-3-Clause',
  'ISC', 'MPL-1.1', 'MPL-2.0', 'LGPL-2.0-only', 'LGPL-2.0-or-later',
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Classpath-exception-2.0',
  'Unicode-DFS-2016', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0',
  '0BSD', 'Zlib', 'PostgreSQL', 'Python-2.0', 'PSF-2.0', 'BSL-1.1',
  'CDDL-1.0', 'CDDL-1.1', 'EPL-1.0', 'EPL-2.0', 'JSON', 'W3C',
];

/**
 * Normalize raw declared license expressions down to a flat list of the
 * SPDX ids they contain. Unknown ids are kept verbatim so policy can leave
 * them "unknown" rather than silently dropping them.
 */
export function stripKnownIds(rawExpressions: string[]): string[] {
  const ids: string[] = [];
  for (const raw of rawExpressions) {
    try {
      for (const id of atomsOf(parseSpdx(raw))) ids.push(id);
    } catch {
      ids.push(raw);
    }
  }
  return ids;
}
