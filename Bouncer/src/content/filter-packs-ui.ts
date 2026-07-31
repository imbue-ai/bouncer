// Filter-pack UI: badge row, suggested-pack section, inline phrase editor,
// color picker, pack CRUD, jiggle/shrink animations, and the active-pack chips
// rendered into the phrase list.
//
// Extracted from ui.ts to keep that file focused on the phrase input, filtered-
// posts modal, reasoning popup, and theming. We follow the same dep-injection
// pattern as bounce-quote.ts: ui.ts calls initFilterPacksUI(deps) at startup
// and we reach back into its exported helpers (getFilterContainers,
// syncFilterPhrases, restoreOrRefreshFilteredPosts, etc.) for the bits of
// shared state that still live there.

import { getSuggestedPacks, type SuggestedPack } from '../shared/suggested-packs';
import {
  getFilterPacks, getFilterPackNames, getActiveFilterPacks,
  activateFilterPack, deactivateFilterPack, setPackPhrases,
  createFilterPack, renameFilterPack, deleteFilterPack,
  getFilterPackColors, setFilterPackColor, mergeFilterPackColors,
} from '../shared/storage';
import { parseHTML } from '../shared/utils';
import type { ContentUIDeps, SiteId } from '../types';
import {
  clearFilteredPosts,
  getFilterContainers,
  restoreOrRefreshFilteredPosts,
  shareIconSVG,
  shareSingleFilterPack,
  syncFilterPhrases,
} from './ui';

let _deps: ContentUIDeps | null = null;

export function initFilterPacksUI(deps: ContentUIDeps): void {
  _deps = deps;
}

function deps(): ContentUIDeps {
  if (!_deps) throw new Error('filter-packs-ui not initialized; call initFilterPacksUI(deps) first');
  return _deps;
}

// ==================== Public types ====================

// Renders as a single deactivatable chip inside the active-filters row.
export interface PackChipData {
  name: string;
  phrases: string[];
  kind?: 'pack';
}

export interface RenderPhrasesOptions { activePackChips?: PackChipData[] }

// ==================== Constants ====================

// Fixed palette offered by the in-edit color picker. Stored per-pack in
// chrome.storage.local as hex strings. The order matters — it's both what
// users see in the picker grid and the sequence Suggested/Your Packs walk
// through when locking in a pack's color at creation time.
const PACK_COLOR_PALETTE: ReadonlyArray<string> = [
  '#D26645', '#8EAFCB', '#CECD0C', '#FCEFD4', '#492222',
  '#0B292B', '#E9ECD9', '#F50D00', '#4B4C08', '#CFC7B3',
  '#E4999A', '#000000', '#F5D6A0', '#97630C',
];

function paletteColorAt(index: number): string {
  return PACK_COLOR_PALETTE[((index % PACK_COLOR_PALETTE.length) + PACK_COLOR_PALETTE.length) % PACK_COLOR_PALETTE.length];
}

// Filter-pack region rendered under the actions row — a collapsing grid
// wrapper holding the row of pack badges. The share-filter-pack action lives
// on the actions row (next to Settings), not inside the region.
export const packRegionHTML = `<div class="filter-pack-region"><div class="filter-pack-region-inner">`
  + `<div class="filter-pack-badges-inner" role="listbox" aria-label="Filter packs"></div>`
  + `</div></div>`;

// Module-level cache of stored pack colors. Refreshed by syncPackBadges() and
// by syncFilterPhrases() via refreshPackColorCache() — both render code paths
// that consult resolvePackColor() synchronously when constructing DOM nodes,
// and either can fire before the other on a given pass. Every pack has a
// stored color (assigned at creation, or backfilled on first render), so
// resolvePackColor never needs to derive one on the fly.
let _packColorOverrides: Record<string, string> = {};

/** Reload pack colors from storage into the module-level cache. */
export async function refreshPackColorCache(siteId: SiteId): Promise<Record<string, string>> {
  const colors = await getFilterPackColors(siteId);
  _packColorOverrides = colors;
  return colors;
}

function resolvePackColor(name: string): string {
  return _packColorOverrides[name] ?? paletteColorAt(0);
}

// ==================== Pack badges ====================

export async function syncPackBadges(): Promise<void> {
  const siteId = deps().adapter.siteId;
  const [packNames, packs, activeList, suggestedPacks, colorOverrides] = await Promise.all([
    getFilterPackNames(siteId),
    getFilterPacks(siteId),
    getActiveFilterPacks(siteId),
    getSuggestedPacks(),
    getFilterPackColors(siteId),
  ]);
  _packColorOverrides = colorOverrides;
  // Backfill missing colors for legacy packs so every rendered badge has a
  // stored color from here on — no more hash fallback that could drift on
  // rename. Positional (palette[i]) matches the counter used by every other
  // creation entry point.
  const legacyBackfill: Record<string, string> = {};
  packNames.forEach((name, i) => {
    if (typeof _packColorOverrides[name] !== 'string') {
      const color = paletteColorAt(i);
      _packColorOverrides[name] = color;
      legacyBackfill[name] = color;
    }
  });
  if (Object.keys(legacyBackfill).length > 0) {
    mergeFilterPackColors(siteId, legacyBackfill)
      .catch(err => console.error('[UI] legacy pack color backfill failed:', err));
  }
  const activeSet = new Set(activeList);

  getFilterContainers().forEach((container) => {
    if (!container || !container.isConnected) return;
    const inner = container.querySelector<HTMLElement>('.filter-pack-badges-inner');
    if (!inner) return;
    if (inner.querySelector('.filter-pack-badge.editing')) {
      inner.querySelectorAll<HTMLElement>('.filter-pack-badge').forEach((b) => {
        const isActive = b.dataset.packName ? activeSet.has(b.dataset.packName) : false;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      return;
    }
    inner.replaceChildren();

    const yourPacksHeading = document.createElement('div');
    yourPacksHeading.className = 'filter-pack-suggested-heading';
    yourPacksHeading.textContent = 'Your packs';
    inner.appendChild(yourPacksHeading);

    packNames.forEach((name) => {
      inner.appendChild(createBadge(name, activeSet.has(name), packs[name] || []));
    });

    inner.appendChild(createAddButton());

    const installedNames = new Set(packNames);
    const pending = suggestedPacks.filter(s => !installedNames.has(s.name));
    if (pending.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'filter-pack-suggested-heading';
      heading.textContent = 'Suggested';
      inner.appendChild(heading);
      inner.appendChild(createSuggestedSection(pending));
    }
  });
}

function createAddButton(): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'filter-pack-add-btn';
  btn.setAttribute('aria-label', 'Add a filter pack');
  btn.title = 'Add a filter pack';
  btn.replaceChildren(parseHTML('<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M6 1.5 V10.5 M1.5 6 H10.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>'));
  return btn;
}

function createSuggestedSection(suggestions: SuggestedPack[]): DocumentFragment {
  const frag = document.createDocumentFragment();

  suggestions.forEach((suggestion, i) => {
    const badge = document.createElement('div');
    badge.className = 'filter-pack-badge';
    badge.dataset.suggestedId = suggestion.id;
    badge.style.setProperty('--pack-color', paletteColorAt(i));

    const label = document.createElement('span');
    label.className = 'filter-pack-badge-label';
    label.textContent = suggestion.name;
    badge.appendChild(label);

    if (suggestion.phrases.length > 0) {
      const preview = document.createElement('span');
      preview.className = 'filter-pack-phrase-preview';
      preview.textContent = suggestion.phrases.join(', ');
      badge.appendChild(preview);
    }

    badge.addEventListener('click', () => {
      installSuggestedPack(suggestion, i).catch(err => console.error('[UI] Failed to install suggested pack:', err));
    });

    frag.appendChild(badge);
  });

  return frag;
}

async function installSuggestedPack(suggestion: SuggestedPack, suggestedIndex: number): Promise<void> {
  const siteId = deps().adapter.siteId;
  // Inherit the color the suggested badge was already displaying so it
  // visually keeps its identity as it moves from Suggested → Your Packs.
  const color = paletteColorAt(suggestedIndex);
  _packColorOverrides[suggestion.name] = color;

  await createFilterPack(siteId, suggestion.name, color);
  await setPackPhrases(siteId, suggestion.name, suggestion.phrases);
  await activateFilterPack(siteId, suggestion.name);
  await syncPackBadges();
  await syncFilterPhrases();
  jigglePackChip(suggestion.name);
}

// Trigger the "pop and settle" jiggle on every element matching `selector` —
// our cue that a pack just landed in the active-filters row. Removing the
// class first (and forcing a reflow) ensures the animation restarts on rapid
// re-toggles.
function jiggleNodes(selector: string): void {
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    node.classList.remove('jiggling');
    void node.offsetWidth;
    node.classList.add('jiggling');
    node.addEventListener(
      'animationend',
      () => node.classList.remove('jiggling'),
      { once: true },
    );
  }
}

// Play the shrink + fade removal animation on every element matching
// `selector` and resolve once they've all finished — callers (deactivate
// flows) await this BEFORE the storage write so the chip isn't torn out by
// the subsequent syncFilterPhrases re-render mid-animation. A safety timeout
// guards against animationend never firing (e.g., a hidden ancestor).
async function animateChipRemoval(selector: string): Promise<void> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
  if (nodes.length === 0) return;
  await Promise.all(
    nodes.map((node) => new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      node.addEventListener('animationend', done, { once: true });
      setTimeout(done, 220);
      node.classList.add('removing');
    })),
  );
}

function jigglePackChip(packName: string): void {
  const sel = CSS.escape(packName);
  jiggleNodes(`.filter-pack-chip[data-pack-name="${sel}"]`);
}

function createBadge(name: string, isActive: boolean, phrases: string[] = []): HTMLElement {
  const badge = document.createElement('div');
  badge.className = 'filter-pack-badge';
  if (isActive) badge.classList.add('active');
  badge.dataset.packName = name;
  badge.setAttribute('role', 'option');
  badge.setAttribute('aria-selected', isActive ? 'true' : 'false');
  badge.tabIndex = 0;
  badge.style.setProperty('--pack-color', resolvePackColor(name));

  renderBadgeCollapsed(badge, name, phrases);
  return badge;
}

function renderBadgeCollapsed(badge: HTMLElement, name: string, phrases: string[] = []) {
  badge.replaceChildren();
  badge.classList.remove('editing');

  const label = document.createElement('span');
  label.className = 'filter-pack-badge-label';
  label.textContent = name;
  badge.appendChild(label);

  if (phrases.length > 0) {
    const preview = document.createElement('span');
    preview.className = 'filter-pack-phrase-preview';
    preview.textContent = phrases.join(', ');
    badge.appendChild(preview);
  }

  const actions = document.createElement('div');
  actions.className = 'filter-pack-badge-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'filter-pack-badge-edit';
  editBtn.setAttribute('aria-label', `Edit phrases in ${name}`);
  editBtn.title = 'Edit phrases';
  editBtn.replaceChildren(parseHTML('<svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true" focusable="false"><path d="M9.5 2 L12 4.5 L4.5 12 L1.5 12.5 L2 9.5 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>'));
  actions.appendChild(editBtn);

  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'filter-pack-badge-share';
  shareBtn.setAttribute('aria-label', `Share ${name}`);
  shareBtn.title = 'Share pack';
  shareBtn.replaceChildren(parseHTML(shareIconSVG));
  if (phrases.length === 0) shareBtn.disabled = true;
  actions.appendChild(shareBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'filter-pack-badge-remove';
  removeBtn.setAttribute('aria-label', `Delete ${name}`);
  removeBtn.title = 'Delete pack';
  removeBtn.replaceChildren(parseHTML('<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'));
  actions.appendChild(removeBtn);

  badge.appendChild(actions);
}

export function setupPackBadgesEventHandlers(container: HTMLElement): void {
  const region = container.querySelector<HTMLElement>('.filter-pack-region');
  const row = container.querySelector<HTMLElement>('.filter-pack-badges-inner');
  if (!region || !row) return;

  const toggleBtn = container.querySelector<HTMLButtonElement>('.filter-pack-toggle-btn');
  if (toggleBtn) {
    // Collapsed/expanded state lives only in the DOM (the .collapsed class on
    // .filter-pack-region) — deliberately not persisted, so every page load /
    // new tab starts in the collapsed state the HTML builder bakes in.
    toggleBtn.addEventListener('click', () => {
      const willHide = !region.classList.contains('collapsed');
      region.classList.toggle('collapsed', willHide);
      toggleBtn.classList.toggle('active', !willHide);
      toggleBtn.setAttribute('aria-expanded', willHide ? 'false' : 'true');
    });
  }

  row.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    if (target.closest('.filter-pack-add-btn')) {
      createPackAndEdit(row).catch(err => console.error('[UI] createPackAndEdit failed:', err));
      return;
    }

    const editingHost = target.closest<HTMLElement>('.filter-pack-badge.editing');
    if (editingHost) return;

    const editBtn = target.closest<HTMLButtonElement>('.filter-pack-badge-edit');
    if (editBtn) {
      e.stopPropagation();
      const badge = editBtn.closest<HTMLElement>('.filter-pack-badge');
      const name = badge?.dataset.packName;
      if (!badge || !name) return;
      enterPhraseEdit(badge, name).catch(err => console.error('[UI] enterPhraseEdit failed:', err));
      return;
    }

    const shareBtn = target.closest<HTMLButtonElement>('.filter-pack-badge-share');
    if (shareBtn) {
      e.stopPropagation();
      if (shareBtn.disabled) return;
      const badge = shareBtn.closest<HTMLElement>('.filter-pack-badge');
      const name = badge?.dataset.packName;
      if (!name) return;
      shareSingleFilterPack(name).catch(err => console.error('[UI] shareSingleFilterPack failed:', err));
      return;
    }

    const removeBtn = target.closest<HTMLButtonElement>('.filter-pack-badge-remove');
    if (removeBtn) {
      e.stopPropagation();
      if (removeBtn.disabled) return;
      const badge = removeBtn.closest<HTMLElement>('.filter-pack-badge');
      const name = badge?.dataset.packName;
      if (!name) return;
      deletePackByName(name).catch(err => console.error('[UI] deletePackByName failed:', err));
      return;
    }

    const badge = target.closest<HTMLElement>('.filter-pack-badge');
    if (badge && badge.dataset.packName) {
      const name = badge.dataset.packName;
      togglePackActive(name).catch(err => console.error('[UI] togglePackActive failed:', err));
    }
  });
}

let toggleChain: Promise<void> = Promise.resolve();
let localToggleInFlight = 0;

export function isLocalPackToggleActive(): boolean {
  return localToggleInFlight > 0;
}

function togglePackActive(name: string): Promise<void> {
  localToggleInFlight++;
  const next = toggleChain.then(() => doTogglePackActive(name));
  toggleChain = next.catch(() => undefined);
  next.finally(() => { localToggleInFlight--; }).catch(() => undefined);
  return next;
}

async function doTogglePackActive(name: string) {
  const siteId = deps().adapter.siteId;

  try {
    const [packs, activeList] = await Promise.all([
      getFilterPacks(siteId),
      getActiveFilterPacks(siteId),
    ]);
    if (!packs[name]) return;
    const packPhrases = packs[name] || [];
    if (packPhrases.length === 0) return;
    const isActive = activeList.includes(name);

    if (isActive) {
      // Run the shrink+fade on the chip *before* the storage write so the
      // chip isn't torn out by the syncFilterPhrases re-render that follows.
      await animateChipRemoval(`.filter-pack-chip[data-pack-name="${CSS.escape(name)}"]`);

      // The pack's phrases that are NOT still claimed by another active pack
      // are the ones actually dropped from the active rule set. Pass only
      // those to the restore/refresh flow — phrases still claimed elsewhere
      // continue to apply and would still hide the affected posts.
      const otherActiveClaims = new Set<string>();
      for (const otherName of activeList) {
        if (otherName === name) continue;
        for (const p of packs[otherName] || []) otherActiveClaims.add(p);
      }
      const actuallyRemoved = packPhrases.filter(p => !otherActiveClaims.has(p));

      await deactivateFilterPack(siteId, name);
      await syncFilterPhrases();
      if (actuallyRemoved.length > 0) {
        await restoreOrRefreshFilteredPosts(actuallyRemoved, 'Filter pack deactivated; post no longer matches.');
      }
    } else {
      await activateFilterPack(siteId, name);
      clearFilteredPosts();
      await syncFilterPhrases();
      jigglePackChip(name);
    }
    const iosPageContainer = deps().getIOSPageContainer();
    if (iosPageContainer && iosPageContainer.isConnected) {
      deps().renderIOSCategories(iosPageContainer);
    }
    deps().reEvaluateAllPosts();
  } catch (err) {
    console.error('[UI] togglePackActive failed:', err);
  }
}

function nextDefaultPackName(existing: Record<string, string[]>): string {
  const base = 'New pack';
  if (!existing[base]) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`;
    if (!existing[candidate]) return candidate;
  }
  return `${base} ${Date.now()}`;
}

// Pick a palette color for a fresh Your Pack. Prefer one that no visible badge
// currently occupies (both existing Your Packs and pending Suggested) so the
// two sections share one continuous walk through the palette. If every entry
// is already taken (14+ visible badges), fall back to positional rotation off
// the existing Your Pack count so consecutive creations still differ.
function pickFreshPackColor(
  yourPackColors: Iterable<string>,
  suggestedColors: Iterable<string>,
  existingCount: number,
): string {
  const used = new Set<string>();
  for (const c of yourPackColors) used.add(c.toUpperCase());
  for (const c of suggestedColors) used.add(c.toUpperCase());
  const firstFree = PACK_COLOR_PALETTE.find(c => !used.has(c.toUpperCase()));
  if (firstFree) return firstFree;
  return paletteColorAt(existingCount);
}

async function createPackAndEdit(clickedRow: HTMLElement) {
  const siteId = deps().adapter.siteId;
  const [packs, existingColors, suggestedPacks] = await Promise.all([
    getFilterPacks(siteId),
    getFilterPackColors(siteId),
    getSuggestedPacks(),
  ]);
  const name = nextDefaultPackName(packs);

  const yourPackColors = Object.keys(packs)
    .map(n => existingColors[n])
    .filter((c): c is string => typeof c === 'string');
  const installedNames = new Set(Object.keys(packs));
  const pendingSuggested = suggestedPacks.filter(s => !installedNames.has(s.name));
  const suggestedColors = pendingSuggested.map((_, i) => paletteColorAt(i));
  const color = pickFreshPackColor(yourPackColors, suggestedColors, Object.keys(packs).length);

  const addBtn = clickedRow.querySelector<HTMLElement>('.filter-pack-add-btn');
  const badge = createBadge(name, false, []);
  badge.style.setProperty('--pack-color', color);
  _packColorOverrides[name] = color;
  if (addBtn) clickedRow.insertBefore(badge, addBtn);
  else clickedRow.appendChild(badge);

  try {
    await createFilterPack(siteId, name, color);
    enterPhraseEdit(badge, name, { selectName: true })
      .catch(err => console.error('[UI] enterPhraseEdit failed:', err));
    void syncFilterPhrases();
  } catch (err) {
    badge.remove();
    delete _packColorOverrides[name];
    console.error('[Bouncer] createFilterPack error:', err);
  }
}

async function deletePackByName(name: string) {
  const siteId = deps().adapter.siteId;
  try {
    await deleteFilterPack(siteId, name);
    void syncFilterPhrases();
  } catch (err) {
    console.error('[Bouncer] deleteFilterPack error:', err);
  }
}

async function renamePack(oldName: string, newName: string) {
  const siteId = deps().adapter.siteId;
  try {
    await renameFilterPack(siteId, oldName, newName);
    void syncFilterPhrases();
  } catch (err) {
    console.error('[Bouncer] renameFilterPack error:', err);
    void syncFilterPhrases();
  }
}

// ==================== Inline phrase editor ====================

async function enterPhraseEdit(
  badge: HTMLElement,
  name: string,
  opts: { selectName?: boolean } = {},
): Promise<void> {
  // Mark editing synchronously so a concurrent syncPackBadges (e.g. the one
  // kicked off by createPackAndEdit right after calling us) sees the flag and
  // skips its replaceChildren wipe — otherwise the just-inserted badge flashes,
  // gets blown away, then re-animates in from the rebuild.
  badge.classList.add('editing');

  const row = badge.parentElement;
  if (row) {
    row.querySelectorAll<HTMLElement>('.filter-pack-badge.editing').forEach((other) => {
      if (other !== badge) void finishPhraseEdit(other);
    });
  }

  const siteId = deps().adapter.siteId;
  const packs = await getFilterPacks(siteId);
  const phrases = packs[name] || [];
  renderPhraseEdit(badge, name, phrases, opts);
}

async function collapsePhraseEdit(badge: HTMLElement) {
  const name = badge.dataset.packName;
  if (!name) return;
  const siteId = deps().adapter.siteId;
  const packs = await getFilterPacks(siteId);
  const phrases = packs[name] || [];
  renderBadgeCollapsed(badge, name, phrases);
}

// Dismiss an in-edit badge — the "close this badge" logic shared by the Done
// button and by the "close the previously-open one" branch in enterPhraseEdit
// (which fires when the user hits + or opens another badge's editor). Commits
// any typed-but-uncommitted phrase, then either deletes the pack if it ended
// up empty or collapses the badge back to the read-only view.
async function finishPhraseEdit(badge: HTMLElement): Promise<void> {
  const name = badge.dataset.packName;
  if (!name) return;

  const input = badge.querySelector<HTMLInputElement>('.filter-pack-edit-phrases-input');
  const phrasesList = badge.querySelector<HTMLElement>('.filter-pack-edit-phrases-list');
  const pending = input?.value.trim() ?? '';
  if (pending && input && phrasesList) {
    try {
      await addPhraseInline(name, pending, phrasesList, input);
    } catch (err) {
      console.error('[UI] addPhraseInline failed:', err);
    }
  }

  const siteId = deps().adapter.siteId;
  const packs = await getFilterPacks(siteId);
  const current = packs[name] || [];
  if (current.length === 0) {
    // Drop .editing so the syncPackBadges triggered by deletePackByName can
    // re-render the row without this stale badge.
    badge.classList.remove('editing');
    badge.remove();
    delete _packColorOverrides[name];
    await deletePackByName(name);
    return;
  }
  await collapsePhraseEdit(badge);
}

function renderPhraseEdit(
  badge: HTMLElement,
  packName: string,
  phrases: string[],
  opts: { selectName?: boolean } = {},
) {
  badge.replaceChildren();
  badge.classList.add('editing');

  let name = packName;

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'filter-pack-edit-done';
  doneBtn.setAttribute('aria-label', 'Close editor');
  doneBtn.title = 'Done';
  doneBtn.textContent = 'Done';
  badge.appendChild(doneBtn);

  const sentence = document.createElement('div');
  sentence.className = 'filter-pack-edit-sentence';
  badge.appendChild(sentence);

  // Swatch sits in the same slot the ::before colored square occupies in the
  // collapsed view — but here it's a real button that opens the color picker.
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'filter-pack-edit-color-swatch';
  swatch.setAttribute('aria-label', 'Change pack color');
  swatch.title = 'Pack color';
  swatch.addEventListener('click', (e) => {
    e.stopPropagation();
    openPackColorPicker(badge, swatch, () => name);
  });
  sentence.appendChild(swatch);

  const titleEl = document.createElement('span');
  titleEl.className = 'filter-pack-edit-title';
  titleEl.contentEditable = 'plaintext-only';
  titleEl.spellcheck = false;
  titleEl.setAttribute('aria-label', 'Pack name');
  titleEl.textContent = name;

  const commitRename = () => {
    const next = (titleEl.textContent ?? '').trim();
    if (!next || next === name) { titleEl.textContent = name; return; }
    const prev = name;
    name = next;
    badge.dataset.packName = next;
    // Carry the pack's color under the new name in the local cache; the
    // storage rename has already moved the persisted entry.
    const carriedColor = _packColorOverrides[prev];
    if (typeof carriedColor === 'string') {
      _packColorOverrides[next] = carriedColor;
      delete _packColorOverrides[prev];
    }
    badge.style.setProperty('--pack-color', resolvePackColor(next));
    titleEl.textContent = next;
    renamePack(prev, next).catch(err => console.error('[UI] renamePack failed:', err));
  };
  titleEl.addEventListener('blur', commitRename);
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); titleEl.textContent = name; titleEl.blur(); }
  });
  sentence.appendChild(titleEl);

  // New-pack flow: focus the title and select its placeholder text so the
  // user's first keystroke replaces "New pack" instead of appending to it.
  if (opts.selectName) {
    queueMicrotask(() => {
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  }

  const includesLabel = document.createElement('span');
  includesLabel.className = 'filter-pack-edit-includes';
  includesLabel.textContent = 'includes';
  sentence.appendChild(includesLabel);

  const phrasesList = document.createElement('span');
  phrasesList.className = 'filter-pack-edit-phrases-list';
  sentence.appendChild(phrasesList);

  const andInput = document.createElement('span');
  andInput.className = 'filter-pack-edit-and-input';

  const andLabel = document.createElement('span');
  andLabel.className = 'filter-pack-edit-and';
  andLabel.textContent = 'and';
  andInput.appendChild(andLabel);

  const inputWrapper = document.createElement('span');
  inputWrapper.className = 'filter-pack-edit-input-wrapper';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'filter-pack-edit-phrases-input';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Add a phrase');
  inputWrapper.appendChild(input);
  andInput.appendChild(inputWrapper);
  sentence.appendChild(andInput);

  let submitting = false;
  // Commit whatever's currently in the input as a phrase. Shared by the
  // Enter/comma keypress and the Done button so the partial text isn't lost
  // when the user finishes by clicking Done instead of pressing Enter.
  const commitPending = async (): Promise<void> => {
    if (submitting) return;
    const text = input.value.trim();
    if (!text) return;
    submitting = true;
    try {
      await addPhraseInline(name, text, phrasesList, input);
    } catch (err) {
      console.error('[UI] addPhraseInline failed:', err);
    } finally {
      submitting = false;
    }
  };

  input.addEventListener('keypress', (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    void commitPending();
  });
  input.addEventListener('click', (e) => e.stopPropagation());

  doneBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void finishPhraseEdit(badge);
  });

  rerenderPhraseEditList(phrasesList, name, phrases);
}

// Open a palette color picker anchored to the edit-mode swatch. Selecting a
// color persists it under the pack's current name, updates --pack-color on the
// badge, and dismisses the popover. Clicking outside also dismisses.
function openPackColorPicker(
  badge: HTMLElement,
  anchor: HTMLElement,
  getPackName: () => string,
) {
  // If a picker is already open for this badge, toggle it closed.
  const existing = badge.querySelector<HTMLElement>('.filter-pack-color-picker');
  if (existing) {
    existing.remove();
    return;
  }

  const currentColor = resolvePackColor(getPackName()).toUpperCase();

  const picker = document.createElement('div');
  picker.className = 'filter-pack-color-picker';
  picker.setAttribute('role', 'listbox');
  picker.setAttribute('aria-label', 'Choose pack color');
  picker.addEventListener('click', (e) => e.stopPropagation());

  PACK_COLOR_PALETTE.forEach((color) => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'filter-pack-color-swatch';
    if (color.toUpperCase() === currentColor) opt.classList.add('selected');
    opt.style.backgroundColor = color;
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-label', `Color ${color}`);
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const packName = getPackName();
      badge.style.setProperty('--pack-color', color);
      _packColorOverrides[packName] = color;
      // Mirror the new color onto any rendered chip(s) for this pack so the
      // active-filters row updates without waiting for the next re-render.
      const sel = (window.CSS?.escape ?? ((s: string) => s))(packName);
      document.querySelectorAll<HTMLElement>(`.filter-pack-chip[data-pack-name="${sel}"]`)
        .forEach((chipEl) => chipEl.style.setProperty('--chip-color', color));
      const siteId = deps().adapter.siteId;
      setFilterPackColor(siteId, packName, color)
        .catch(err => console.error('[UI] setFilterPackColor failed:', err));
      picker.remove();
      cleanup();
    });
    picker.appendChild(opt);
  });

  // Position below the swatch within the badge's coordinate system.
  const anchorRect = anchor.getBoundingClientRect();
  const badgeRect = badge.getBoundingClientRect();
  picker.style.top = `${anchorRect.bottom - badgeRect.top + 6}px`;
  picker.style.left = `${anchorRect.left - badgeRect.left}px`;

  badge.appendChild(picker);

  const onDocClick = (e: MouseEvent) => {
    const target = e.target as Node | null;
    if (!target) return;
    if (picker.contains(target) || anchor.contains(target)) return;
    picker.remove();
    cleanup();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      picker.remove();
      cleanup();
    }
  };
  const cleanup = () => {
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };
  // Defer to skip the click that opened the picker.
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }, 0);
}

function rerenderPhraseEditList(container: HTMLElement, packName: string, phrases: string[]) {
  container.replaceChildren();
  const len = phrases.length;
  phrases.forEach((phrase, index) => {
    const phraseEl = document.createElement('span');
    phraseEl.className = 'filter-phrase-inline';
    phraseEl.textContent = phrase;
    phraseEl.title = 'Click to remove';
    phraseEl.addEventListener('click', (e) => {
      e.stopPropagation();
      removePhraseFromPackEdit(packName, phrase, container)
        .catch(err => console.error('[UI] removePhraseFromPackEdit failed:', err));
    });
    container.appendChild(phraseEl);

    if (index < len - 1 || len > 1) {
      const sep = document.createElement('span');
      sep.className = 'filter-phrase-separator';
      sep.textContent = ', ';
      container.appendChild(sep);
    }
  });
}

async function addPhraseInline(
  packName: string,
  phrase: string,
  container: HTMLElement,
  input: HTMLInputElement,
): Promise<void> {
  const siteId = deps().adapter.siteId;
  const packs = await getFilterPacks(siteId);
  const current = packs[packName] || [];
  if (current.includes(phrase)) {
    input.value = '';
    input.focus();
    return;
  }
  const next = [...current, phrase];
  await setPackPhrases(siteId, packName, next);
  input.value = '';
  rerenderPhraseEditList(container, packName, next);
  void syncFilterPhrases();
  deps().reEvaluateAllPosts();
  input.focus();
}

async function removePhraseFromPackEdit(
  packName: string,
  phrase: string,
  list: HTMLElement,
): Promise<void> {
  const siteId = deps().adapter.siteId;
  const packs = await getFilterPacks(siteId);
  const current = packs[packName] || [];
  if (!current.includes(phrase)) {
    rerenderPhraseEditList(list, packName, current);
    return;
  }
  const next = current.filter(p => p !== phrase);
  await setPackPhrases(siteId, packName, next);
  rerenderPhraseEditList(list, packName, next);
  clearFilteredPosts();
  void syncFilterPhrases();
  deps().reEvaluateAllPosts();
}

// ==================== Active-pack chip ====================

// Rendered inside the active-filters row (alongside individual phrases) by
// ui.ts's renderPhrasesInContainer. Clicking deactivates the pack — the same
// path as clicking the badge in the pack region.
export function createPackChip(chip: PackChipData): HTMLElement {
  const el = document.createElement('span');
  el.className = 'filter-pack-chip';
  el.dataset.packName = chip.name;
  el.style.setProperty('--chip-color', resolvePackColor(chip.name));
  el.setAttribute('role', 'button');
  el.tabIndex = 0;

  const label = document.createElement('span');
  label.className = 'filter-pack-chip-label';
  label.textContent = chip.name;
  el.appendChild(label);

  const tooltipText = chip.phrases.length > 0 ? chip.phrases.join(', ') : '(empty pack)';
  const tooltip = document.createElement('span');
  tooltip.className = 'filter-pack-chip-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = tooltipText;
  el.appendChild(tooltip);

  const deactivate = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    togglePackActive(chip.name).catch(err => console.error('[UI] togglePackActive failed:', err));
  };
  el.addEventListener('click', deactivate);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') deactivate(e);
  });
  return el;
}
