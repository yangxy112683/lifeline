import type { AgentsWindowDump } from '../packages/agent/src/drivers/cursor/agents-window.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { cdpCallExpression } from '../packages/agent/src/cdp/client.js';
import {
  AGENTS_WINDOW_PAGE_DEPS,
  dumpAgentsWindow,
  readOpenAgentsComposerId,
  switchAgentsRowOnPage,
} from '../packages/agent/src/drivers/cursor/agents-window.js';

/**
 * Agents window, Cursor 3.24 (measured 2026-10-15): the open session id is not on
 * `div.composer-bar.editor`. It is `data-sidebar-item-key="row:<uuid>"` on the
 * sidebar row whose button has `data-active="true"`.
 */

const WANT = '4bceca53-b899-42e1-86d1-b3c413f32ea2';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const AGENTS_SIDEBAR = `
<div class="ui-sidebar-section" data-agent-drop-section-id="repo:acme">
  <button class="ui-sidebar-menu-button" data-section-head data-section-expanded="true">
    <span class="ui-sidebar-menu-button-label">acme/demo-repo</span>
  </button>
  <ul>
    <li class="ui-sidebar-menu-item" data-sidebar-item-key="row:${OTHER}">
      <button class="ui-sidebar-menu-button" aria-id="glass-sidebar-agent-row" data-variant="idle" data-active="true">
        <span class="ui-sidebar-menu-button-label">Retro discussion</span>
      </button>
    </li>
    <li class="ui-sidebar-menu-item" data-sidebar-item-key="row:${WANT}">
      <button class="ui-sidebar-menu-button" aria-id="glass-sidebar-agent-row" data-variant="idle">
        <span class="ui-sidebar-menu-button-label">Retro discussion</span>
      </button>
    </li>
  </ul>
</div>
<div class="ui-tray glass-questionnaire-tray">
  <div class="ui-tray-step" data-active="true">
    <div class="ui-tray-step__title">继续？</div>
  </div>
</div>
`;

async function withDom<T>(html: string, fn: () => T | Promise<T>): Promise<T> {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  try {
    return await fn();
  }
  finally {
    if (documentDescriptor)
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete (globalThis as { document?: unknown }).document;
  }
}

function followActiveRow(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const btn = target?.closest?.('[aria-id="glass-sidebar-agent-row"]');
    if (!btn)
      return;
    for (const el of Array.from(document.querySelectorAll('[aria-id="glass-sidebar-agent-row"]')))
      el.removeAttribute('data-active');
    btn.setAttribute('data-active', 'true');
  });
}

describe('Agents 窗口当前会话 id', () => {
  it('没有 composer bar 时，从 data-active 侧栏行的 row: 键读出当前会话', async () => {
    const dump = await withDom(AGENTS_SIDEBAR, () => dumpAgentsWindow());
    assert.equal(dump.activeComposerId, OTHER);
    assert.equal(dump.questionnaire?.composerId, OTHER);
  });

  it('composer bar 还在时仍读 bar 上的 id', async () => {
    const html = `<div class="composer-bar editor" data-composer-id="from-bar" data-composer-status="completed"></div>${AGENTS_SIDEBAR}`;
    const dump = await withDom(html, () => dumpAgentsWindow());
    assert.equal(dump.activeComposerId, 'from-bar');
    assert.equal(dump.composerStatus, 'completed');
    assert.equal(dump.questionnaire?.composerId, 'from-bar');
  });

  it('送进页面的 dump 脚本同样读到侧栏 id', async () => {
    const expr = cdpCallExpression(
      dumpAgentsWindow as (...args: never[]) => unknown,
      [],
      AGENTS_WINDOW_PAGE_DEPS,
    );
    const dump = await withDom(AGENTS_SIDEBAR, () => vm.runInThisContext(expr) as AgentsWindowDump);
    assert.equal(dump.activeComposerId, OTHER);
  });

  it('同名两行时按 row 键点中目标，并回读该 id', async () => {
    const expr = cdpCallExpression(
      switchAgentsRowOnPage as (...args: never[]) => unknown,
      [{ title: 'Retro discussion', section: 'acme/demo-repo', wantIdx: 0, wantId: WANT }],
      [readOpenAgentsComposerId],
    );
    const outcome = await withDom(AGENTS_SIDEBAR, () => {
      followActiveRow();
      return vm.runInThisContext(expr) as ReturnType<typeof switchAgentsRowOnPage>;
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.landedComposerId, WANT);
    assert.equal(outcome.via, 'agents');
  });

  it('点完激活行没换，就报落到了原来的会话', async () => {
    const outcome = await withDom(AGENTS_SIDEBAR, () => switchAgentsRowOnPage({
      title: 'Retro discussion',
      section: 'acme/demo-repo',
      wantIdx: 0,
      wantId: WANT,
    }));
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.error,
      `点了 Retro discussion 但落到别的 agent（want ${WANT} got ${OTHER}）`,
    );
  });

  it('页面上没有激活行、也没有 composer bar 时，报 got none', async () => {
    const html = AGENTS_SIDEBAR.replace(' data-active="true"', '');
    const outcome = await withDom(html, () => switchAgentsRowOnPage({
      title: 'Retro discussion',
      section: 'acme/demo-repo',
      wantIdx: 0,
      wantId: WANT,
    }));
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.error,
      `点了 Retro discussion 但落到别的 agent（want ${WANT} got none）`,
    );
  });
});
