/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hideTopBar, showTopBar, installTopBarHider } from '../../src/instagram/topbar';

const SCREEN_H = 800;
const SCREEN_W = 390;

/** A pinned strip across the head of the screen, the shape Instagram's is. */
function bar(options: {
  position?: string;
  height?: number;
  width?: number;
  top?: number;
  tag?: string;
  nest?: boolean;
} = {}): HTMLElement {
  const el = document.createElement(options.tag ?? 'div');
  const height = options.height ?? 48;
  const width = options.width ?? SCREEN_W;
  const top = options.top ?? 0;
  el.style.position = options.position ?? 'fixed';
  el.getBoundingClientRect = () => ({
    width, height, top, bottom: top + height, left: 0, right: width,
    x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect;
  if (options.nest) {
    const wrapper = document.createElement('div');
    wrapper.appendChild(el);
    document.body.appendChild(wrapper);
  } else {
    document.body.appendChild(el);
  }
  return el;
}

beforeEach(() => {
  document.body.replaceChildren();
  window.innerHeight = SCREEN_H;
  window.innerWidth = SCREEN_W;
});

afterEach(() => { showTopBar(); });

describe('the reels top bar', () => {
  it('hides a strip pinned across the top', () => {
    const el = bar();
    expect(hideTopBar()).toBe(1);
    expect(el.style.display).toBe('none');
  });

  it('deals with each bar once', () => {
    bar();
    expect(hideTopBar()).toBe(1);
    expect(hideTopBar()).toBe(0);
  });

  it('finds a <header> nested deeper than the shallow sweep', () => {
    const el = bar({ tag: 'header', nest: true });
    expect(hideTopBar()).toBe(1);
    expect(el.style.display).toBe('none');
  });

  it('gives it back', () => {
    const el = bar();
    hideTopBar();
    showTopBar();
    expect(el.style.display).toBe('');
    expect(el.hasAttribute('data-bouncer-topbar')).toBe(false);
  });
});

describe('what it leaves alone', () => {
  it('a bar that is not pinned', () => {
    const el = bar({ position: 'static' });
    expect(hideTopBar()).toBe(0);
    expect(el.style.display).toBe('');
  });

  it('something nowhere near the top', () => {
    const el = bar({ top: 300 });
    expect(hideTopBar()).toBe(0);
    expect(el.style.display).toBe('');
  });

  // Past a fraction of the screen it is a page, not a bar.
  it('a pinned thing that is most of the screen', () => {
    const el = bar({ height: 600 });
    expect(hideTopBar()).toBe(0);
    expect(el.style.display).toBe('');
  });

  it('a stray pinned pixel', () => {
    const el = bar({ height: 4 });
    expect(hideTopBar()).toBe(0);
    expect(el.style.display).toBe('');
  });

  it('a narrow pinned thing, which is a rail not a bar', () => {
    const el = bar({ width: 60 });
    expect(hideTopBar()).toBe(0);
    expect(el.style.display).toBe('');
  });

  // Caught mid-layout, the reel itself can briefly measure like a bar.
  it('anything with a video in it', () => {
    const el = bar();
    el.appendChild(document.createElement('video'));
    expect(hideTopBar()).toBe(0);
    expect(el.style.display).toBe('');
  });

  it('our own surfaces', () => {
    const el = bar();
    el.id = 'bouncer-ig-frame';
    expect(hideTopBar()).toBe(0);
  });
});

describe('leaving the reels routes', () => {
  // Off reels that bar is the navigation; hiding it would strand the user.
  it('puts the bar back when the route stops being reels', () => {
    const el = bar();
    let onReels = true;
    const stop = installTopBarHider(() => onReels, 10_000);
    expect(el.style.display).toBe('none');

    onReels = false;
    stop();
    expect(el.style.display).toBe('');
  });
});
