// 结构化 SPDX 许可表达式解析与求值。
// 只支持本项目需要的子集：license-id、AND、OR、括号、WITH 异常、尾随 "+"。
// 绝不使用字符串包含匹配。

export type LicenseNode =
  | { kind: 'license'; id: string }
  | { kind: 'and'; left: LicenseNode; right: LicenseNode }
  | { kind: 'or'; left: LicenseNode; right: LicenseNode };

export class SpdxParseError extends Error {}

const LICENSE_ID = /^[A-Za-z0-9.:+-]+/;

export function parseSpdx(input: string): LicenseNode {
  const tokens = tokenize(input);
  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }
  function next(): string {
    const t = tokens[pos];
    if (t === undefined) throw new SpdxParseError(`表达式意外结束: ${input}`);
    pos += 1;
    return t;
  }
  function parsePrimary(): LicenseNode {
    const t = next();
    if (t === '(') {
      const node = parseOr();
      if (next() !== ')') throw new SpdxParseError(`缺少右括号: ${input}`);
      return node;
    }
    if (t === 'AND' || t === 'OR' || t === ')') {
      throw new SpdxParseError(`意外的操作符 ${t}: ${input}`);
    }
    // 跳过 WITH <exception-id>（异常修饰不改变许可 id 本身的政策判定）
    if (peek() === 'WITH') {
      next();
      const exc = next();
      if (!LICENSE_ID.test(exc)) throw new SpdxParseError(`WITH 后缺少异常 id: ${input}`);
    }
    return { kind: 'license', id: t };
  }
  function parseAnd(): LicenseNode {
    let node = parsePrimary();
    while (peek() === 'AND') {
      next();
      node = { kind: 'and', left: node, right: parsePrimary() };
    }
    return node;
  }
  function parseOr(): LicenseNode {
    let node = parseAnd();
    while (peek() === 'OR') {
      next();
      node = { kind: 'or', left: node, right: parseAnd() };
    }
    return node;
  }

  const root = parseOr();
  if (pos !== tokens.length) throw new SpdxParseError(`表达式存在多余内容: ${input}`);
  return root;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i += 1;
      continue;
    }
    const m = LICENSE_ID.exec(input.slice(i));
    if (!m) throw new SpdxParseError(`无法解析的字符 "${ch}": ${input}`);
    let word = m[0];
    // 去掉尾随 "+"（如 Apache-2.0+），它只表示“或更高版本”
    if (word.endsWith('+')) word = word.slice(0, -1);
    const upper = word.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'WITH') {
      tokens.push(upper);
    } else {
      tokens.push(word);
    }
    i += m[0].length;
  }
  if (tokens.length === 0) throw new SpdxParseError('空表达式');
  return tokens;
}

export type Effect = 'allow' | 'deny' | 'needs_exception' | 'unknown';

const RANK: Record<Effect, number> = {
  allow: 0,
  unknown: 1,
  needs_exception: 2,
  deny: 3,
};

export function rankOf(effect: Effect): number {
  return RANK[effect];
}

export function worstOf(a: Effect, b: Effect): Effect {
  return RANK[a] >= RANK[b] ? a : b;
}

export function bestOf(a: Effect, b: Effect): Effect {
  return RANK[a] <= RANK[b] ? a : b;
}

// 按结构求值：AND 取最差分支，OR 取最好分支；未命中任何政策的许可为 unknown。
export function evaluateExpression(
  node: LicenseNode,
  lookup: (licenseId: string) => Effect,
): Effect {
  switch (node.kind) {
    case 'license':
      return lookup(node.id);
    case 'and':
      return worstOf(evaluateExpression(node.left, lookup), evaluateExpression(node.right, lookup));
    case 'or':
      return bestOf(evaluateExpression(node.left, lookup), evaluateExpression(node.right, lookup));
  }
}

// 收集表达式中的全部许可 id（用于记录判定依据）
export function licenseIds(node: LicenseNode): string[] {
  switch (node.kind) {
    case 'license':
      return [node.id];
    case 'and':
    case 'or':
      return [...licenseIds(node.left), ...licenseIds(node.right)];
  }
}
