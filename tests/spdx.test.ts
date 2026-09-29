import { describe, expect, it } from 'vitest';
import { evaluateExpression, parseSpdx, type Effect } from '../src/spdx.ts';

const EFFECTS: Record<string, Effect> = {
  MIT: 'allow',
  'Apache-2.0': 'allow',
  'GPL-3.0-only': 'deny',
  'LGPL-3.0-only': 'needs_exception',
};
const lookup = (id: string): Effect => EFFECTS[id] ?? 'unknown';

describe('SPDX 结构化求值', () => {
  it('AND 取最差分支', () => {
    expect(evaluateExpression(parseSpdx('MIT AND GPL-3.0-only'), lookup)).toBe('deny');
    expect(evaluateExpression(parseSpdx('MIT AND Apache-2.0'), lookup)).toBe('allow');
  });

  it('OR 取最好分支', () => {
    expect(evaluateExpression(parseSpdx('MIT OR GPL-3.0-only'), lookup)).toBe('allow');
    expect(evaluateExpression(parseSpdx('LGPL-3.0-only OR GPL-3.0-only'), lookup)).toBe(
      'needs_exception',
    );
  });

  it('括号嵌套按结构而非字符串', () => {
    expect(
      evaluateExpression(parseSpdx('(MIT OR Apache-2.0) AND LGPL-3.0-only'), lookup),
    ).toBe('needs_exception');
    expect(
      evaluateExpression(parseSpdx('(GPL-3.0-only OR MIT) AND (Apache-2.0 OR LGPL-3.0-only)'), lookup),
    ).toBe('allow');
  });

  it('未知许可保持 unknown，且通过 AND 传播、被 OR 兜底', () => {
    expect(evaluateExpression(parseSpdx('WTFPL'), lookup)).toBe('unknown');
    expect(evaluateExpression(parseSpdx('MIT AND WTFPL'), lookup)).toBe('unknown');
    expect(evaluateExpression(parseSpdx('MIT OR WTFPL'), lookup)).toBe('allow');
  });

  it('字符串包含不等于结构匹配：MIT 政策不影响 MIT-false 之类的不同 id', () => {
    expect(evaluateExpression(parseSpdx('MIT-fake'), lookup)).toBe('unknown');
  });
});
