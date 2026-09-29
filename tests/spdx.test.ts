import { describe, expect, it } from 'vitest';
import { parseSpdx, satisfies, componentAst, isValidSpdx } from '../server/spdx.ts';

// Every check compares parsed ASTs structurally — never string containment.

describe('SPDX parser structure', () => {
  it('parses OR with correct precedence vs AND', () => {
    const node = parseSpdx('MIT OR Apache-2.0 AND BSD-3-Clause');
    expect(node.kind).toBe('or');
    if (node.kind !== 'or') throw new Error('expected or');
    expect(node.left).toEqual({ kind: 'license', id: 'MIT', plus: false });
    expect(node.right.kind).toBe('and');
  });

  it('parses parentheses and WITH exception as one atom', () => {
    const node = parseSpdx('GPL-3.0-only WITH Classpath-exception-2.0');
    expect(node.kind).toBe('license');
    if (node.kind === 'license') expect(node.id).toContain('WITH Classpath-exception');
    const grouped = parseSpdx('(MIT OR Apache-2.0) AND BSD-3-Clause');
    expect(grouped.kind).toBe('and');
  });

  it('rejects malformed expressions', () => {
    expect(isValidSpdx('MIT OR')).toBe(false);
    expect(isValidSpdx('(MIT')).toBe(false);
    expect(() => parseSpdx('AND MIT')).toThrow();
  });

  it('treats multiple CycloneDX licenses as alternatives (OR)', () => {
    const { node } = componentAst(['MIT', 'Apache-2.0']);
    expect(node?.kind).toBe('or');
  });
});

describe('AND / OR structural matching', () => {
  // rule: permissive OR set
  const permissive = parseSpdx('(MIT OR Apache-2.0 OR ISC)');

  it('single MIT satisfies', () => {
    expect(satisfies(parseSpdx('MIT'), permissive)).toBe(true);
  });

  it('conjunctive GPL+Classpath satisfies the combined rule', () => {
    const cp = parseSpdx('(GPL-3.0-only AND Classpath-exception-2.0)');
    expect(satisfies(parseSpdx('GPL-3.0-only AND Classpath-exception-2.0'), cp)).toBe(true);
    expect(satisfies(parseSpdx('GPL-3.0-only'), cp)).toBe(false);
  });

  it('dual licensed (MIT OR GPL) does NOT fully satisfy permissive only', () => {
    // conservative: every offered alternative must satisfy the rule
    expect(satisfies(parseSpdx('(MIT OR GPL-3.0-only)'), permissive)).toBe(false);
  });

  it('dual licensed component can satisfy a dual rule (OR branch coverage)', () => {
    const dualRule = parseSpdx('(MIT OR GPL-3.0-only)');
    expect(satisfies(parseSpdx('(MIT OR GPL-3.0-only)'), dualRule)).toBe(true);
  });

  it('AND on the rule side requires all atoms present', () => {
    const andRule = parseSpdx('(MIT AND Apache-2.0)');
    expect(satisfies(parseSpdx('MIT AND Apache-2.0'), andRule)).toBe(true);
    expect(satisfies(parseSpdx('MIT'), andRule)).toBe(false);
  });
});

describe('unknown licenses stay unknown', () => {
  it('unknown single license yields unknown, not allow/deny', () => {
    expect(satisfies(parseSpdx('LicenseRef-SecretLicense'), parseSpdx('MIT'))).toBe(
      'unknown',
    );
  });

  it('unknown branch in dual licensing yields unknown', () => {
    const permissive = parseSpdx('(MIT OR Apache-2.0)');
    expect(satisfies(parseSpdx('(MIT OR LicenseRef-SecretLicense)'), permissive)).toBe(
      'unknown',
    );
  });

  it('no licenses => no AST', () => {
    expect(componentAst([]).node).toBeNull();
  });
});
