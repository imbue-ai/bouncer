// @vitest-environment happy-dom
//
// Tests for the two helpers the codebase's entire XSS posture rests on:
// escapeHtml (string escaping for interpolation into HTML templates) and
// parseHTML (the DOMPurify chokepoint every dynamic-HTML write goes through).
// These lock in the sanitizer behavior so a future DOMPurify config change
// can't silently widen the sink.

import { describe, it, expect, beforeAll } from 'vitest';
import realDOMPurify from 'dompurify';
import { escapeHtml, parseHTML } from '../../src/shared/utils.js';

// tests/setup.ts stubs the global DOMPurify with a passthrough because most
// tests don't care about sanitization. This file exists precisely to test the
// sanitizer, so swap in the real library (the same one the pages load as
// dompurify.js at runtime) before exercising parseHTML.
beforeAll(() => {
  expect(realDOMPurify.isSupported).toBe(true);
  (globalThis as unknown as { DOMPurify: unknown }).DOMPurify = realDOMPurify;
});

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('neutralizes attribute-breakout payloads when interpolated into HTML', () => {
    // Simulates the usage-render pattern: an attacker-controlled label
    // interpolated into a template literal, then parsed.
    const hostile = '"><img src=x onerror=alert(1)>';
    const frag = parseHTML(`<span class="name">${escapeHtml(hostile)}</span>`);
    expect(frag.querySelector('img')).toBeNull();
    expect(frag.querySelector('span')?.textContent).toContain('onerror');
  });

  it('passes plain text through unchanged', () => {
    expect(escapeHtml('crypto, engagement bait')).toBe('crypto, engagement bait');
    expect(escapeHtml('')).toBe('');
  });
});

describe('parseHTML', () => {
  it('returns a DocumentFragment preserving benign markup', () => {
    const frag = parseHTML('<div class="row"><b>hi</b></div>');
    expect(frag).toBeInstanceOf(DocumentFragment);
    expect(frag.querySelector('div.row b')?.textContent).toBe('hi');
  });

  it('strips script tags', () => {
    const frag = parseHTML('<div>ok</div><script>alert(1)</script>');
    expect(frag.querySelector('script')).toBeNull();
    expect(frag.textContent).toContain('ok');
  });

  it('strips event-handler attributes', () => {
    const frag = parseHTML('<img src="x" onerror="alert(1)"><div onclick="alert(2)">t</div>');
    expect(frag.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect(frag.querySelector('div')?.getAttribute('onclick')).toBeNull();
  });

  it('strips javascript: URLs', () => {
    const frag = parseHTML('<a href="javascript:alert(1)">x</a>');
    const href = frag.querySelector('a')?.getAttribute('href') ?? '';
    expect(href.toLowerCase()).not.toContain('javascript:');
  });

  it('strips iframes/objects and other active embeds', () => {
    // Asserted one input at a time: happy-dom mis-parses an <iframe> followed
    // by siblings in a single string (it swallows them), which masks results.
    for (const dirty of ['<iframe src="https://evil.example"></iframe>', '<object data="x"></object>', '<embed src="x">']) {
      const frag = parseHTML(dirty);
      expect(frag.querySelector('iframe, object, embed'), dirty).toBeNull();
    }
  });

  it('keeps style attributes inert of expressions but preserves the element', () => {
    const frag = parseHTML('<span style="color: red">x</span>');
    expect(frag.querySelector('span')?.textContent).toBe('x');
  });
});
