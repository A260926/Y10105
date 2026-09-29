import './styles.css';
import { api } from './api.ts';
import type {
  CandidateExport,
  Decision,
  DependencyPath,
  ExceptionRecord,
  PolicyRule,
  QuarantineEntryLike,
  Verdict,
} from './types-ui.ts';

interface CandidateRow {
  id: number;
  name: string;
  status: 'draft' | 'frozen';
  purpose: string | null;
  createdAt: string;
  frozenAt: string | null;
  overallVerdict: string | null;
  policyVersion: number | null;
}

interface CandidateView {
  candidate: CandidateRow;
  quarantineOpen: number;
  decisions: Decision[];
  flaggedPaths: DependencyPath[];
  frozen: boolean;
  evaluationClock: string;
}

const state = {
  clock: '2026-09-30T00:00:00Z',
  candidates: [] as CandidateRow[],
  selected: 0,
  view: null as CandidateView | null,
  tab: 'candidate' as 'candidate' | 'quarantine' | 'exceptions' | 'import',
  policies: [] as PolicyRule[],
  exceptions: [] as ExceptionRecord[],
  quarantine: [] as QuarantineEntryLike[],
};

const $ = (sel: string) => document.querySelector(sel)!;
const clockQs = () => `?clock=${encodeURIComponent(state.clock)}`;

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function toast(message: string, isErr = false): void {
  const el = document.createElement('div');
  el.className = `toast${isErr ? ' err' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function verdictBadge(v: Verdict | string | null): string {
  const label: Record<string, string> = {
    allow: '允许 allow',
    deny: '拒绝 deny',
    needs_exception: '需例外 needs_exception',
    unknown: '未知 unknown',
  };
  return `<span class="badge ${escapeHtml(v ?? 'unknown')}">${label[v ?? 'unknown'] ?? escapeHtml(v)}</span>`;
}

async function loadCandidates(): Promise<void> {
  const data = await api.get<{ candidates: CandidateRow[] }>('/api/candidates');
  state.candidates = data.candidates;
  if (!state.selected && data.candidates.length) state.selected = data.candidates[0].id;
  renderSidebar();
  if (state.tab === 'candidate') await openCandidate(state.selected);
}

async function openCandidate(id: number): Promise<void> {
  state.selected = id;
  renderSidebar();
  try {
    state.view = await api.get<CandidateView>(`/api/candidates/${id}${clockQs()}`);
  } catch (e) {
    toast((e as Error).message, true);
    return;
  }
  renderMain();
}

function renderSidebar(): void {
  const list = state.candidates
    .map(
      (c) => `
      <div class="cand-item ${c.id === state.selected ? 'active' : ''}" data-id="${c.id}">
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="meta">
          <span class="badge ${c.status}">${c.status === 'frozen' ? '已冻结' : '草稿'}</span>
          ${c.overallVerdict ? verdictBadge(c.overallVerdict) : ''}
        </div>
      </div>`,
    )
    .join('');
  const tabs = ['candidate', 'quarantine', 'exceptions', 'import']
    .map(
      (t) =>
        `<button class="ghost ${state.tab === t ? '' : ''}" data-tab="${t}" style="margin:2px">${
          { candidate: '候选', quarantine: '隔离', exceptions: '例外', import: '导入 BOM' }[t]
        }</button>`,
    )
    .join('');
  $('#sidebar').innerHTML = `
    <div class="clock">
      查询时钟
      <input id="clock-input" value="${escapeHtml(state.clock)}" />
    </div>
    <div class="row" style="margin-bottom:10px">${tabs}</div>
    <div id="candidate-list">${list}</div>
  `;
  $('#clock-input').addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (Number.isNaN(Date.parse(v))) return toast('时钟格式无法解析', true);
    state.clock = new Date(v).toISOString();
    if (state.tab === 'candidate') void openCandidate(state.selected);
    else renderMain();
  });
  document.querySelectorAll<HTMLElement>('.cand-item').forEach((el) =>
    el.addEventListener('click', () => {
      state.tab = 'candidate';
      void openCandidate(Number(el.dataset.id));
    }),
  );
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) =>
    el.addEventListener('click', () => {
      state.tab = el.dataset.tab as typeof state.tab;
      void refreshTab();
    }),
  );
}

async function refreshTab(): Promise<void> {
  renderSidebar();
  if (state.tab === 'candidate') await openCandidate(state.selected);
  else if (state.tab === 'quarantine') await renderQuarantine();
  else if (state.tab === 'exceptions') await renderExceptions();
  else renderImport();
}

function renderMain(): void {
  if (state.tab === 'candidate') renderCandidate();
  else if (state.tab === 'quarantine') void renderQuarantine();
  else if (state.tab === 'exceptions') void renderExceptions();
  else renderImport();
}

function decisionBasis(d: Decision): string {
  if (d.exception) {
    return `例外 #${d.exception.id}（政策 v${d.exception.policyVersion}，批准人 ${escapeHtml(
      d.exception.approver,
    )}，到期 ${escapeHtml(d.exception.expiresAt)}）<br/><span class="muted">${escapeHtml(
      d.exception.reason,
    )}</span>`;
  }
  if (d.policyHit) {
    return `政策 <code>${escapeHtml(d.policyHit.ruleId)}</code> v${
      d.policyHit.policyVersion
    } → <b>${escapeHtml(d.policyHit.effect)}</b>`;
  }
  return '<span class="muted">无匹配政策</span>';
}

function renderPath(p: DependencyPath): string {
  const nodes = p.path
    .map(
      (n: { name: string; version: string | null }, i: number) =>
        `${i === 0 ? '根 ' : ''}${escapeHtml(n.name)}<span class="muted">@${escapeHtml(
          n.version ?? '?',
        )}</span>`,
    )
    .join('<span class="arrow">→</span>');
  return `<div class="path">${nodes}</div>`;
}

function renderCandidate(): void {
  const v = state.view;
  if (!v) {
    $('#main').innerHTML = '<p class="muted">没有候选</p>';
    return;
  }
  const c = v.candidate;
  const grouped = new Map<string, DependencyPath[]>();
  for (const p of v.flaggedPaths) {
    const leaf = p.path[p.path.length - 1];
    const key = leaf.purl;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(p);
  }

  const rows = v.decisions
    .map(
      (d) => `
      <tr>
        <td><code>${escapeHtml(d.purl)}</code><div class="muted">${escapeHtml(
          d.version ?? '',
        )} · ${d.depKind === 'direct' ? '直接' : '传递'}</div></td>
        <td>${verdictBadge(d.verdict)}</td>
        <td>${decisionBasis(d)}</td>
        <td class="muted">${escapeHtml(d.detail)}</td>
      </tr>`,
    )
    .join('');

  const pathBlocks = [...grouped.entries()]
    .map(([purl, paths]) => {
      const d = v.decisions.find((x) => x.purl === purl);
      return `
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <div><code>${escapeHtml(purl)}</code> ${verdictBadge(d?.verdict ?? 'deny')}</div>
            <div class="muted">${paths.length} 条到根路径</div>
          </div>
          ${paths.map(renderPath).join('')}
          <div class="muted">依据：${d ? decisionBasis(d) : '—'}</div>
        </div>`;
    })
    .join('');

  const freezeBanner =
    c.status === 'draft' && v.quarantineOpen > 0
      ? `<div class="card" style="border-color:var(--deny)">
           <b class="warn">冻结被阻断：</b>该导入仍有
           <b>${v.quarantineOpen}</b> 个隔离组件未处理。请先到“隔离”页处置。
         </div>`
      : '';

  $('#main').innerHTML = `
    <div class="section">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2 style="display:inline-block;margin:0">${escapeHtml(c.name)}</h2>
          <span class="badge ${c.status}" style="margin-left:8px">${
            c.status === 'frozen' ? '已冻结快照' : '草稿（随政策/例外实时重算）'
          }</span>
          ${c.overallVerdict ? verdictBadge(c.overallVerdict) : ''}
        </div>
        <div class="row">
          <button id="btn-freeze" ${c.status === 'frozen' ? 'disabled' : ''}>冻结候选</button>
          <button class="ghost" id="btn-export">导出 JSON（无 properties）</button>
        </div>
      </div>
      <div class="muted" style="margin-top:6px">
        创建 ${escapeHtml(c.createdAt)} · 评估时钟 ${escapeHtml(v.evaluationClock)}
        ${c.frozenAt ? ` · 冻结于 ${escapeHtml(c.frozenAt)}（政策 v${escapeHtml(String(c.policyVersion))}）` : ''}
      </div>
    </div>
    ${freezeBanner}
    <div class="section">
      <h2>逐项决议（${v.decisions.length}）</h2>
      <div class="card" style="padding:4px 8px">
        <table><thead><tr>
          <th>组件身份 (purl@version)</th><th>结论</th><th>政策 / 例外依据</th><th>说明</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>
    <div class="section">
      <h2>从被拒组件沿依赖边追到根（${v.flaggedPaths.length} 条路径）</h2>
      ${pathBlocks || '<p class="muted">没有被拒 / 需例外 / 未知的组件。</p>'}
    </div>
  `;

  $('#btn-freeze').addEventListener('click', async () => {
    try {
      await api.post(`/api/candidates/${c.id}/freeze${clockQs()}`, {});
      toast('候选已冻结：依赖图与决议已固化');
      await loadCandidates();
    } catch (e) {
      toast((e as Error).message, true);
    }
  });
  $('#btn-export').addEventListener('click', () => {
    window.open(`/api/candidates/${c.id}/export${clockQs()}`, '_blank');
  });
}

async function renderQuarantine(): Promise<void> {
  const data = await api.get<{ quarantine: QuarantineEntryLike[] }>('/api/quarantine');
  state.quarantine = data.quarantine;
  const blocks = data.quarantine
    .map(
      (q) => `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <b>${escapeHtml(q.name ?? '(无名)')}</b>
            <span class="tag">ref: ${escapeHtml(q.ref)}</span>
            <span class="badge ${q.status === 'open' ? 'needs_exception' : 'allow'}">${
              q.status === 'open' ? '未处理' : q.status === 'resolved' ? '已处理' : '已拒绝'
            }</span>
          </div>
          <div class="muted">import #${q.importId}</div>
        </div>
        <p class="warn" style="margin:8px 0 4px">${escapeHtml(q.reason)}</p>
        <details><summary>原始记录（不会进入导出的 properties）</summary>
          <pre class="path">${escapeHtml(JSON.stringify(q.raw, null, 2))}</pre></details>
        ${
          q.status === 'open'
            ? `<div class="row" style="margin-top:8px">
                 <button data-q="${q.id}" data-action="resolved">标记已处理</button>
                 <button class="ghost" data-q="${q.id}" data-action="rejected">维持拒绝</button>
               </div>`
            : `<div class="muted" style="margin-top:6px">处置：${escapeHtml(q.resolution ?? '')}</div>`
        }
      </div>`,
    )
    .join('');
  $('#main').innerHTML = `
    <div class="section"><h2>组件隔离区（${data.quarantine.filter((q) => q.status === 'open').length} 未处理）</h2>
      <p class="muted">格式错误的组件进入这里；合法组件仍会入库，但存在未处理项时候选不能冻结。</p>
      ${blocks || '<p class="good">没有隔离记录。</p>'}
    </div>`;
  document.querySelectorAll<HTMLElement>('[data-q]').forEach((el) =>
    el.addEventListener('click', async () => {
      try {
        await api.post(`/api/quarantine/${el.dataset.q}/resolve${clockQs()}`, {
          resolution: el.dataset.action,
          note: `marked ${el.dataset.action} from UI`,
        });
        toast('隔离项已更新');
        await renderQuarantine();
      } catch (e) {
        toast((e as Error).message, true);
      }
    }),
  );
}

async function renderExceptions(): Promise<void> {
  const [excData, polData] = await Promise.all([
    api.get<{ exceptions: ExceptionRecord[] }>(`/api/exceptions${clockQs()}`),
    api.get<{ rules: PolicyRule[] }>('/api/policies'),
  ]);
  state.exceptions = excData.exceptions;
  state.policies = polData.rules;
  const versions = [...new Set(polData.rules.map((r) => r.policyVersion))].sort();
  const rows = excData.exceptions
    .map(
      (e) => `
      <tr>
        <td><code>${escapeHtml(e.componentPurl)}</code><div class="muted">${escapeHtml(
          e.componentVersion ?? '(任意版本)',
        )}${e.purpose ? ` · 用途 ${escapeHtml(e.purpose)}` : ''}</div></td>
        <td>v${e.policyVersion}</td>
        <td>${escapeHtml(e.approver)}<div class="muted">${escapeHtml(e.reason)}</div></td>
        <td>${escapeHtml(e.expiresAt)}<br/>
          <span class="badge ${e.status === 'active' ? 'allow' : 'unknown'}">
            ${e.status === 'active' ? '生效中（由查询时钟推导）' : '已到期（历史不改写）'}
          </span></td>
        <td><span class="tag">row v${e.rowVersion}</span></td>
        <td><button class="ghost" data-exc="${e.id}" data-ver="${e.rowVersion}">延期 / 修改</button></td>
      </tr>`,
    )
    .join('');

  $('#main').innerHTML = `
    <div class="section">
      <h2>有期限例外（绑定组件身份 + 政策版本 + 用途）</h2>
      <div class="card">
        <table><thead><tr>
          <th>组件身份</th><th>政策版本</th><th>批准人 / 理由</th><th>到期时刻与状态</th><th>版本</th><th></th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>
    <div class="section">
      <h2>登记例外</h2>
      <div class="card grid2">
        <div>组件 purl<br/><input id="f-purl" style="width:100%" placeholder="pkg:npm/foo@1.0.0"/></div>
        <div>版本（可空=任意）<br/><input id="f-ver" style="width:100%" placeholder="1.0.0"/></div>
        <div>政策版本
          <select id="f-pol">${versions.map((v) => `<option value="${v}">v${v}</option>`).join('')}</select></div>
        <div>用途（可空）<br/><input id="f-purpose" style="width:100%" placeholder="production"/></div>
        <div>批准人<br/><input id="f-approver" style="width:100%" placeholder="legal@corp"/></div>
        <div>到期时刻 (ISO)<br/><input id="f-exp" style="width:100%" value="2027-01-01T00:00:00Z"/></div>
        <div style="grid-column:1/3">理由<br/><textarea id="f-reason"></textarea></div>
        <div style="grid-column:1/3"><button id="btn-save-exc">保存例外</button></div>
      </div>
    </div>`;

  $('#btn-save-exc').addEventListener('click', async () => {
    try {
      const ver = ($('#f-ver') as HTMLInputElement).value.trim();
      await api.post('/api/exceptions', {
        componentPurl: ($('#f-purl') as HTMLInputElement).value.trim(),
        componentVersion: ver || null,
        policyVersion: Number(($('#f-pol') as HTMLSelectElement).value),
        purpose: ($('#f-purpose') as HTMLInputElement).value.trim() || null,
        approver: ($('#f-approver') as HTMLInputElement).value.trim(),
        expiresAt: ($('#f-exp') as HTMLInputElement).value.trim(),
        reason: ($('#f-reason') as HTMLTextAreaElement).value.trim(),
      });
      toast('例外已保存');
      await renderExceptions();
    } catch (e) {
      toast((e as Error).message, true);
    }
  });

  document.querySelectorAll<HTMLElement>('[data-exc]').forEach((el) => {
    el.addEventListener('click', async () => {
      const expiresAt = prompt('新的到期时刻 (ISO 8601)，留空取消', '2027-06-01T00:00:00Z');
      if (!expiresAt) return;
      try {
        await api.patch(`/api/exceptions/${el.dataset.exc}`, {
          expectedRowVersion: Number(el.dataset.ver),
          expiresAt,
        });
        toast('例外已更新，行版本 +1');
        await renderExceptions();
      } catch (e) {
        toast(`并发冲突：${(e as Error).message}`, true);
      }
    });
  });
}

function renderImport(): void {
  $('#main').innerHTML = `
    <div class="section">
      <h2>导入 CycloneDX JSON</h2>
      <div class="card">
        <p class="muted">
          幂等：相同 import 键 + 相同内容返回原结果；相同键 + 不同内容返回 409 冲突。
          导入是原子事务，组件与边要么全部可见，要么全部回滚。
        </p>
        <div class="row" style="margin-bottom:8px">
          import 键（可空，默认 serialNumber@version）
          <input id="i-key" placeholder="可选" />
        </div>
        <textarea id="i-json" style="min-height:200px" placeholder='{"bomFormat":"CycloneDX",...}'></textarea>
        <div class="row" style="margin-top:10px"><button id="i-btn">导入</button></div>
        <pre id="i-out" class="path" style="display:none;margin-top:10px"></pre>
      </div>
    </div>`;
  $('#i-btn').addEventListener('click', async () => {
    const key = ($('#i-key') as HTMLInputElement).value.trim();
    const payload = ($('#i-json') as HTMLTextAreaElement).value;
    const out = $('#i-out') as HTMLPreElement;
    try {
      const data = await api.post<{ import: { id: number }; warnings: string[] }>(
        `/api/imports${key ? `?key=${encodeURIComponent(key)}` : ''}`,
        JSON.parse(payload),
      );
      out.style.display = 'block';
      out.style.borderColor = '';
      out.textContent = `已入库 import #${data.import.id}；告警：${
        data.warnings.length ? data.warnings.join('; ') : '无'
      }`;
      toast('导入完成');
      await loadCandidates();
    } catch (e) {
      out.style.display = 'block';
      out.style.borderLeftColor = 'var(--deny)';
      out.textContent = (e as Error).message;
    }
  });
}

function boot(): void {
  $('#app').innerHTML = `
    <header>
      <h1>依赖许可例外台</h1>
      <div class="sub">
        本地导入软件物料清单 · 解释组件准入决议 · 跟踪有期限例外 · 冻结完整依赖图
      </div>
    </header>
    <div class="layout">
      <aside class="sidebar" id="sidebar"></aside>
      <main class="main" id="main"></main>
    </div>`;
  void loadCandidates();
}

boot();
