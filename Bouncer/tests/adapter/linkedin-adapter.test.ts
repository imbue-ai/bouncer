/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PlatformAdapter } from '../../src/types';

let LinkedInAdapter: new () => PlatformAdapter;

beforeEach(async () => {
  globalThis.chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
    } as unknown as typeof chrome.runtime,
  } as typeof chrome;

  // The adapter only claims `window.BouncerAdapter` when running on a
  // linkedin.com host (see LinkedInAdapter.ts). happy-dom defaults to
  // localhost, so point it at linkedin.com before the module's hostname
  // guard runs on import.
  (window as unknown as { happyDOM: { setURL(url: string): void } })
    .happyDOM.setURL('https://www.linkedin.com/feed/');

  await import('../../adapters/linkedin/LinkedInAdapter.js');
  LinkedInAdapter = window.BouncerAdapter;
});

// Real desktop SDUI actor header captured from the live feed (obfuscated class
// names). Wrapped in the FeedType listitem so the adapter treats it as desktop.
const ACTOR_HEADER = `
<a tabindex="0" href="https://www.linkedin.com/in/teddy-zheng/">
  <figure>
    <svg viewBox="0 0 128 128" role="img" aria-label="View Teddy Zheng’s profile"></svg>
  </figure>
</a>
<div>
  <div>
    <div>
      <div>
        <a tabindex="0" href="https://www.linkedin.com/in/teddy-zheng/">
          <div>
            <div aria-label="Teddy Zheng Premium Profile 3rd+">
              <div>
                <div><p><span>Teddy Zheng</span></p></div>
              </div>
              <div>
                <p><span><span> </span><span aria-hidden="true"><svg id="linkedin-bug-small" aria-hidden="true" viewBox="0 0 16 16"></svg></span><span> </span>• 3rd+</span></p>
              </div>
            </div>
          </div>
        </a>
      </div>
    </div>
    <div><p><span>Building something new | CS &amp; Film @ Harvard</span></p></div>
    <div><div></div></div>
    <div>
      <p><span>1d •<span> </span><svg id="globe-americas-small" aria-hidden="false" viewBox="0 0 16 16" role="img" aria-label="Visibility: Global"></svg></span></p>
    </div>
    <a tabindex="0" href="https://www.linkedin.com/in/teddy-zheng/"><div></div></a>
  </div>
</div>
`;

function makeDesktopPost(headerHtml: string): HTMLElement {
  const post = document.createElement('div');
  post.setAttribute('role', 'listitem');
  post.setAttribute('componentkey', 'FeedType:12345');
  const header = document.createElement('div');
  header.innerHTML = headerHtml;
  post.appendChild(header);
  document.body.appendChild(post);
  return post;
}

describe('LinkedIn desktop actor header extraction', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    document.body.replaceChildren();
    adapter = new LinkedInAdapter();
  });

  it('extracts author name from the identity aria-label (no control-menu button needed)', () => {
    const post = makeDesktopPost(ACTOR_HEADER);
    expect(adapter.extractPostContent(post).author).toBe('Teddy Zheng');
  });

  it('extracts the headline even when it is wrapped in a <span>, not a <p>', () => {
    const post = makeDesktopPost(ACTOR_HEADER);
    expect(adapter.extractPostContent(post).handle).toBe(
      'Building something new | CS & Film @ Harvard'
    );
  });

  it('extracts the connection degree', () => {
    const post = makeDesktopPost(ACTOR_HEADER);
    expect(adapter.extractPostContent(post).degree).toBe('3rd+');
  });

  it('extracts the timestamp', () => {
    const post = makeDesktopPost(ACTOR_HEADER);
    expect(adapter.extractPostContent(post).timeText).toBe('1d');
  });

  it('returns the headline, not a CTA link that sits between headline and timestamp', () => {
    // Posts can carry a profile CTA ("Book an appointment", "Visit my website")
    // on its own row below the headline. The headline must still win.
    const withCta = ACTOR_HEADER.replace(
      '<div><div></div></div>',
      '<div><a href="https://calendly.com/noah/intro">Book an appointment</a></div>'
    );
    const post = makeDesktopPost(withCta);
    expect(adapter.extractPostContent(post).handle).toBe(
      'Building something new | CS & Film @ Harvard'
    );
  });

  it('falls back to the CTA line when there is no headline', () => {
    // When the author has only a CTA and no headline, show the CTA (matches the
    // earlier "Visit my website" behaviour).
    const ctaOnly = ACTOR_HEADER
      .replace(
        '<div><p><span>Building something new | CS &amp; Film @ Harvard</span></p></div>',
        ''
      )
      .replace(
        '<div><div></div></div>',
        '<div><a href="https://example.com">Visit my website</a></div>'
      );
    const post = makeDesktopPost(ctaOnly);
    expect(adapter.extractPostContent(post).handle).toBe('Visit my website');
  });

  it('does not mistake the author name for the headline when no headline is present', () => {
    // Drop the headline node: the row that holds "Building something new …".
    const noHeadline = ACTOR_HEADER.replace(
      '<div><p><span>Building something new | CS &amp; Film @ Harvard</span></p></div>',
      ''
    );
    const post = makeDesktopPost(noHeadline);
    const content = adapter.extractPostContent(post);
    expect(content.author).toBe('Teddy Zheng');
    expect(content.handle).toBe('');
  });
});
