// Controller for the full stats dashboard page (stats.html), opened in its own
// tab from the popup's "See full stats" button and from the close/next-visit
// recap flow. Fetches the same getUsageSummary the popup uses and renders the
// full breakdown (both pies + all windows).

import type { UsageSummary, NotFilteredRow, FilteredRow } from '../types';
import { formatDuration } from '../shared/usage-utils';
import { pieSlices, renderPie } from '../shared/usage-render';
import { setStorage } from '../shared/storage';

type StatsWindowKey = 'today' | 'week' | 'allTime';

let usageSummary: UsageSummary | null = null;
let activeWindow: StatsWindowKey = 'today';

// This page isn't injected into a platform feed, so there's no platform theme to
// read — follow the OS preference instead.
function applyTheme(): void {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.body.classList.add(dark ? 'dark-mode' : 'light-mode');
}

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setupWindowToggle(): void {
  const toggle = el('statsWindowToggle');
  if (!toggle) return;
  for (const btn of toggle.querySelectorAll<HTMLButtonElement>('.stats-window-btn')) {
    btn.addEventListener('click', () => {
      const win = btn.dataset.window as StatsWindowKey | undefined;
      if (!win || win === activeWindow) return;
      activeWindow = win;
      for (const b of toggle.querySelectorAll('.stats-window-btn')) b.classList.toggle('active', b === btn);
      render();
    });
  }
}

function render(): void {
  if (!usageSummary) return;
  const win = usageSummary[activeWindow];

  const set = (id: string, text: string) => { const e = el(id); if (e) e.textContent = text; };
  set('statsTimeSavedValue', formatDuration(win.timeSavedMs));
  set('statsTimeValue', formatDuration(win.totalTimeMs));
  set('statsSeenValue', win.totalSeen.toLocaleString());
  set('statsBlockedValue', win.totalBlocked.toLocaleString());

  const empty = el('statsEmpty');
  const hasData = win.totalTimeMs > 0 || win.totalSeen > 0 || win.totalBlocked > 0;
  if (empty) empty.style.display = hasData ? 'none' : '';

  // Pie 1 — not-filtered posts by content type, weighted by dwell time.
  const nfBlock = el('statsNotFilteredBlock');
  const nfPie = el('statsPieNotFiltered');
  const nfLegend = el('statsLegendNotFiltered');
  const nfSlices = pieSlices<NotFilteredRow>(win.notFiltered, (r) => r.timeMs);
  if (nfBlock && nfPie && nfLegend) {
    if (nfSlices.length > 0) {
      nfBlock.style.display = '';
      renderPie(nfPie, nfLegend, nfSlices, formatDuration);
    } else {
      nfBlock.style.display = 'none';
    }
  }

  // Pie 2 — filtered posts by topic, weighted by blocked count.
  const fBlock = el('statsFilteredBlock');
  const fPie = el('statsPieFiltered');
  const fLegend = el('statsLegendFiltered');
  const fSlices = pieSlices<FilteredRow>(win.filtered, (r) => r.blocked);
  if (fBlock && fPie && fLegend) {
    if (fSlices.length > 0) {
      fBlock.style.display = '';
      renderPie(fPie, fLegend, fSlices, (v) => v.toLocaleString());
    } else {
      fBlock.style.display = 'none';
    }
  }
}

async function main(): Promise<void> {
  applyTheme();

  // Recap context: opened automatically when the user closed the feed (or on
  // their next visit). Reframe the header and clear the "armed" flag so the
  // recap doesn't fire again for this session.
  const isRecap = new URLSearchParams(window.location.search).get('context') === 'recap';
  if (isRecap) {
    const title = el('statsPageTitle');
    const sub = el('statsPageSub');
    if (title) title.textContent = 'Your session recap';
    if (sub) sub.textContent = "Here's what Bouncer did for your feed this session.";
    await setStorage({ recapArmed: false }).catch(() => { /* best effort */ });
  }

  setupWindowToggle();

  try {
    usageSummary = await chrome.runtime.sendMessage({ type: 'getUsageSummary' });
    render();
  } catch (err) {
    console.error('[Stats] failed to load summary:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => { main().catch(err => console.error('[Stats] init failed:', err)); });
