// Remove reels from Instagram's Reels pager the way Instagram itself does.
//
// MAIN world (imported by ./hook.ts). The pager renders from a list owned by
// Instagram's reels-ads manager (`PolarisClipsViewer` subscribes to it); the
// manager's own `hideClip` drops a hidden ad by splicing it out of that list
// and notifying subscribers, and React re-renders the pager without it. We do
// the same for organic reels, and also delete the reel's edge from the Relay
// connection the list is rebuilt from, so the next page can't append it again.
//
// Nothing here touches Instagram's DOM. Every earlier approach did —
// display:none on a heuristically chosen "card", fades, overlays planted inside
// it — and React reusing those nodes is what left half-hidden reels behind (a
// caption gone while its video played on). The one thing we draw is our own
// overlay for the dip described below.
//
// Where the reel is decides when it goes. The pager shows "item N of the
// list" — on touch it's a transform Instagram applies imperatively, not a
// scroll position — so:
//   - below the reel on screen: now. Nothing visible moves.
//   - the reel ON screen: now, behind a short dip to black. Item N becomes the
//     next reel, which slides into place and plays — the same thing Instagram
//     does when it hides an ad you're looking at.
//   - above it: not removed. Every item would shift up under a fixed N and the
//     view would jump a reel; nothing outside Instagram's gesture code can
//     move N with it. A reel already behind you stays pending, and goes if you
//     scroll back to it (it's then the reel on screen).
// Nothing happens while the pager is between reels (a finger or an animation
// is moving it). Removals wait for it to come to rest on one.
//
// Everything is located by structure and by unminified method names
// (getList / processLoadedClips / fireCallbacks / commitUpdate), never by
// minified field names. If any of it can't be found — a different Instagram
// build — removal does nothing at all rather than something half-visible.

import { mediaMatchKeys } from './rewrite';

/** The pager counts as at rest once it hasn't scrolled or changed address for
 *  this long AND the reel on screen sits flush with it (within ALIGN_PX) — an
 *  animation can pause longer than SETTLE_MS on its way, but Instagram always
 *  comes to rest snapped to a reel. */
const SETTLE_MS = 200;
const ALIGN_PX = 3;
/** Duration of each half of the dip over the reel being watched. */
const DIP_MS = 140;
/** Retry cadence while removals are pending and the pager isn't mounted yet. */
const LOCATE_RETRY_MS = 1000;

interface ListItem {
  __typename?: string;
  __id?: string;
  pk?: unknown;
}

interface ClipsManager {
  getList(): ListItem[];
  processLoadedClips(...args: unknown[]): unknown;
  subscribe?: (cb: () => void) => unknown;
  [key: string]: unknown;
}

interface RelayRecordProxy {
  getDataID(): string;
  getLinkedRecord(name: string): RelayRecordProxy | null | undefined;
  getLinkedRecords(name: string): (RelayRecordProxy | null)[] | null | undefined;
  setLinkedRecords(records: (RelayRecordProxy | null)[], name: string): void;
  getValue(name: string): unknown;
}

interface RelayEnvironment {
  getStore(): { getSource(): { get(id: string): Record<string, unknown> | null | undefined } };
  commitUpdate(updater: (store: { get(id: string): RelayRecordProxy | null | undefined }) => void): void;
}

interface Pager {
  manager: ClipsManager;
  listKey: string;
  notify: () => void;
  env: RelayEnvironment;
  connectionId: string | null;
  scroller: HTMLElement;
}

type Fiber = {
  return: Fiber | null;
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: unknown;
};

function fiberOf(el: Element): Fiber | null {
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
  return key ? (el as unknown as Record<string, Fiber>)[key] : null;
}

function isManager(v: unknown): v is ClipsManager {
  return !!v && typeof v === 'object'
    && typeof (v as ClipsManager).getList === 'function'
    && typeof (v as ClipsManager).processLoadedClips === 'function';
}

function isEnvironment(v: unknown): v is RelayEnvironment {
  return !!v && typeof v === 'object'
    && typeof (v as RelayEnvironment).getStore === 'function'
    && typeof (v as RelayEnvironment).commitUpdate === 'function';
}

/** The manager, wherever the viewer's hooks keep it (an effect's deps). */
function managerInHooks(fiber: Fiber): ClipsManager | null {
  let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
  for (let i = 0; hook && i < 200; i++) {
    // Effects keep { deps }, memos keep [value, deps]; the manager rides in deps.
    const s = hook.memoizedState as { deps?: unknown } | unknown[] | null | undefined;
    const deps = Array.isArray(s) ? s : s?.deps;
    const candidates: unknown[] = Array.isArray(deps) ? deps : [];
    for (const c of candidates) if (isManager(c)) return c;
    hook = hook.next as typeof hook;
  }
  return null;
}

/** The pager's scroll container: the nearest ancestor of a reel's <video>
 *  whose content overflows it. Its children are the slides, in list order. */
function scrollerOf(video: Element): HTMLElement | null {
  let el = video.parentElement;
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 50) return el;
    el = el.parentElement;
  }
  return null;
}

function locate(): Pager | null {
  const video = document.querySelector('video');
  if (!video) { diag('pager not found: no <video>'); return null; }
  const scroller = scrollerOf(video);
  if (!scroller) { diag('pager not found: no scrolling ancestor of the <video>'); return null; }
  let manager: ClipsManager | null = null;
  let env: RelayEnvironment | null = null;
  let connectionId: string | null = null;
  for (let f = fiberOf(video); f && !(manager && env); f = f.return) {
    const props = f.memoizedProps;
    if (!props) continue;
    if (!manager && Array.isArray(props.edges)) {
      manager = managerInHooks(f);
      const firstEdge = props.edges[0] as { __id?: unknown } | undefined;
      if (manager && typeof firstEdge?.__id === 'string') {
        connectionId = firstEdge.__id.replace(/:edges:\d+$/, '');
      }
    }
    if (!env && isEnvironment(props.environment)) env = props.environment;
  }
  if (!manager || !env) {
    diag(`pager not found: ${manager ? '' : 'no clips manager '}${env ? '' : 'no Relay environment'}`);
    return null;
  }
  const mgr = manager;
  const listKey = Object.keys(mgr).find(k => mgr[k] === mgr.getList());
  const notifier = Object.values(mgr).find(
    (v): v is { fireCallbacks: () => void } =>
      !!v && typeof (v as { fireCallbacks?: unknown }).fireCallbacks === 'function');
  if (!listKey || !notifier) {
    diag(`pager not found: ${listKey ? '' : 'no list field '}${notifier ? '' : 'no notifier'}`);
    return null;
  }
  return { manager: mgr, listKey, notify: () => notifier.fireCallbacks(), env, connectionId, scroller };
}

// ---- Diagnostics (TEMP: removal on device) ----
//
// One console line per distinct outcome, so a reel that stays put while marked
// hidden says why — and a pass that keeps hitting the same wall says it once.

let lastDiag = '';
function diag(line: string): void {
  if (line === lastDiag) return;
  lastDiag = line;
  console.log(`[IG unrender] ${line}`);
}

// ---- Naming list items ----

// Every name a list item answers to — code, pk, id, cover filenames — read
// from its Relay record, so it lines up with what the isolated world sends.
const namesById = new Map<string, string[]>();

function itemNames(env: RelayEnvironment, item: ListItem): string[] {
  const id = item.__id;
  if (typeof id !== 'string') return [];
  const cached = namesById.get(id);
  if (cached) return cached;
  const source = env.getStore().getSource();
  const rec = source.get(id);
  if (!rec) return [];
  const ivRef = (rec.image_versions2 as { __ref?: string } | undefined)?.__ref;
  const iv = ivRef ? source.get(ivRef) : null;
  const refs = (iv?.candidates as { __refs?: string[] } | undefined)?.__refs ?? [];
  const media = {
    code: rec.code,
    pk: rec.pk,
    id: rec.id,
    image_versions2: { candidates: refs.map(r => ({ url: source.get(r)?.url as string | undefined })) },
  };
  const names = mediaMatchKeys(media);
  namesById.set(id, names);
  return names;
}

// ---- Removal ----

const pending = new Set<string>();
const subscribed = new WeakSet<object>();
let applying = false;
let retryTimer: ReturnType<typeof setInterval> | null = null;

/** Which slide is on screen: the one under the viewport's middle. */
function currentIndex(scroller: HTMLElement): number {
  const mid = window.innerHeight / 2;
  return Array.from(scroller.children).findIndex((el) => {
    const r = el.getBoundingClientRect();
    return r.top <= mid && r.bottom > mid;
  });
}

/** A full-pager black overlay of our own, for the cut away from the reel
 *  being watched. Resolves once it's fully opaque; the returned function fades
 *  it out and removes it. */
function dipToBlack(scroller: HTMLElement): Promise<() => void> {
  const r = scroller.getBoundingClientRect();
  const el = document.createElement('div');
  el.style.cssText = [
    'position: fixed',
    `left: ${r.left}px`, `top: ${r.top}px`, `width: ${r.width}px`, `height: ${r.height}px`,
    'background: #000', 'opacity: 0', 'pointer-events: none', 'z-index: 2147483646',
    `transition: opacity ${DIP_MS}ms ease`,
  ].join(';');
  document.documentElement.appendChild(el);
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      setTimeout(() => resolve(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), DIP_MS + 20);
      }), DIP_MS);
    });
  });
}

/** Drop the given pks from the Relay connection the pager's list is rebuilt
 *  from when the next page loads. */
function removeFromConnection(pager: Pager, pks: Set<string>): void {
  if (!pager.connectionId) return;
  const connectionId = pager.connectionId;
  pager.env.commitUpdate((store) => {
    const conn = store.get(connectionId);
    const edges = conn?.getLinkedRecords('edges');
    if (!conn || !edges) return;
    const keep = edges.filter((e) => {
      const pk = e?.getLinkedRecord('node')?.getLinkedRecord('media')?.getValue('pk');
      return !pks.has(String(pk));
    });
    if (keep.length !== edges.length) conn.setLinkedRecords(keep, 'edges');
  });
}

function setList(pager: Pager, list: ListItem[]): void {
  (pager.manager as Record<string, unknown>)[pager.listKey] = list;
  pager.notify();
}

/** Remove every listed reel the pending set names, from the one on screen
 *  down. Returns false when the pager couldn't be found (caller retries). */
function apply(): boolean {
  if (applying || pending.size === 0) return true;
  if (performance.now() - lastMoveAt < SETTLE_MS) {
    scheduleSettledApply();
    return true;
  }
  const pager = locate();
  if (!pager) return false;
  subscribe(pager);

  const list = pager.manager.getList();
  // Slides are the scroller's children in list order. If they've drifted
  // apart, or nothing sits flush with the pager (it's between reels), we
  // can't tell what's on screen — leave it for the next change.
  const slides = Array.from(pager.scroller.children);
  if (slides.length !== list.length) {
    diag(`skipped: ${slides.length} slides but ${list.length} list items`);
    return true;
  }
  const current = currentIndex(pager.scroller);
  if (current < 0) {
    diag('skipped: no slide under the middle of the viewport');
    return true;
  }
  const offset = slides[current].getBoundingClientRect().top - pager.scroller.getBoundingClientRect().top;
  if (Math.abs(offset) > ALIGN_PX) {
    diag(`skipped: between reels (slide ${current} is ${Math.round(offset)}px off the pager top)`);
    return true;
  }

  const pks = new Set<string>();
  let above = 0;
  list.forEach((item, i) => {
    if (item.__typename !== 'XDTMediaDict') return;   // ads are Instagram's to hide
    if (!itemNames(pager.env, item).some(n => pending.has(n))) return;
    if (i < current) above++;
    else pks.add(String(item.pk));
  });
  if (pks.size === 0) {
    diag(`nothing to remove: ${above} pending reel(s) above the one on screen, ${pending.size} name(s) pending, ${list.length} listed`);
    return true;
  }
  diag(`removing ${pks.size} reel(s)${pks.has(String(list[current].pk)) ? ', including the one on screen' : ''}; ${above} left above`);

  const commit = (): void => {
    applying = true;
    try {
      // Re-read: the list may have grown while the dip ran.
      setList(pager, pager.manager.getList().filter(item => !pks.has(String(item.pk))));
      removeFromConnection(pager, pks);
    } finally {
      applying = false;
    }
  };

  if (pks.has(String(list[current].pk))) {
    applying = true;
    void dipToBlack(pager.scroller).then((reveal) => {
      applying = false;
      commit();
      requestAnimationFrame(reveal);
    });
  } else {
    commit();
  }
  return true;
}

// ---- Waiting for the pager to come to rest ----

let lastMoveAt = -Infinity;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSettledApply(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    try { applyOrRetry(); } catch { /* never break the page */ }
  }, SETTLE_MS);
}

function noteMove(): void {
  lastMoveAt = performance.now();
  if (pending.size > 0) scheduleSettledApply();
}

// Every arrival is a chance: a pending reel may be the one on screen now.
// Scrolling moves the pager on desktop; on touch it doesn't scroll at all, but
// Instagram rewrites the address to the new reel's.
document.addEventListener('scroll', noteMove, { capture: true, passive: true });
window.addEventListener('popstate', noteMove);
for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method];
  history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
    const result = original.apply(this, args);
    try { noteMove(); } catch { /* never break the page */ }
    return result;
  };
}

/** Re-apply whenever the manager's list changes, so a reel named before it
 *  arrived is removed the moment the next page appends it. */
function subscribe(pager: Pager): void {
  if (subscribed.has(pager.manager) || typeof pager.manager.subscribe !== 'function') return;
  subscribed.add(pager.manager);
  pager.manager.subscribe(() => { try { apply(); } catch { /* never break the page */ } });
}

function applyOrRetry(): void {
  if (apply()) {
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    return;
  }
  retryTimer ??= setInterval(() => {
    try {
      if (apply() && retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    } catch { /* never break the page */ }
  }, LOCATE_RETRY_MS);
}

/** Remove the reels these names identify (codes, pks, cover filenames) from
 *  the pager, now and whenever they turn up again this page session. */
export function unrenderReels(keys: Iterable<string>): void {
  const added: string[] = [];
  for (const k of keys) {
    if (typeof k === 'string' && k.length > 0 && !pending.has(k)) {
      pending.add(k);
      added.push(k);
    }
  }
  if (added.length === 0) return;
  diag(`requested: ${added.map(k => k.slice(-28)).join(', ')}`);
  applyOrRetry();
}
