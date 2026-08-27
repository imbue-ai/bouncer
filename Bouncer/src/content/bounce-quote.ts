// "Bounce" post UX: when the user clicks a chip / custom phrase / "missed"
// link in the why-annoying tooltip, we hide the post, override the cache,
// optionally add a filter phrase, and (if the quote toggle is on) drive X's
// native quote-tweet flow with a screenshot of the user's Bouncer card.
//
// Extracted from ui.ts to keep that file's filter-pack UI focused. ui.ts wires
// the rest of the why-annoying tooltip and remains the only owner of the
// shared filtered-posts state — we reach into its exported helpers
// (storeFilteredPost / hidePost / addFilterPhrase) rather than re-implementing
// them here.

import { formatPostForEvaluation } from '../shared/utils';
import { encodeFilterPackCode, buildFilterPackShareUrl } from '../shared/share-encoding';
import type { ContentUIDeps, PostContent } from '../types';
import {
  addFilterPhrase,
  hidePost,
  screenshotFilterCardOffscreen,
  storeFilteredPost,
  waitForElement,
} from './ui';

let _deps: ContentUIDeps | null = null;

export function initBounceQuote(deps: ContentUIDeps): void {
  _deps = deps;
}

function deps(): ContentUIDeps {
  if (!_deps) throw new Error('bounce-quote not initialized; call initBounceQuote(deps) first');
  return _deps;
}

// Build the screenshot off-screen so capture is independent of viewport width
// and doesn't flicker the live filter bar. Renders a single .filter-phrase-
// inline span into the throwaway card — the "and" + empty input that sit
// beside the list survive via buildFilterContainerHTML so the visual matches
// the in-page card.
export async function captureBouncerScreenshot(phrase: string): Promise<File | null> {
  try {
    return await screenshotFilterCardOffscreen(
      (list) => {
        const span = document.createElement('span');
        span.className = 'filter-phrase-inline';
        span.textContent = phrase;
        list.appendChild(span);
      },
      'bouncer-bounce.png',
    );
  } catch (err) {
    console.error('[Bouncer/bounce-quote] screenshot capture failed:', err);
    return null;
  }
}

// Drive X's native quote-tweet flow in-page: click the article's Repost
// button, click the resulting Quote menu link, then attach the bouncer
// screenshot and inject the bounce message into the compose textarea. Stays
// in the same tab so the action feels native. Caller pre-captures the
// screenshot to avoid a race with addFilterPhrase's syncFilterPhrases
// re-render — the substitution in captureBouncerScreenshot needs the live
// phrase list to be quiescent for getComputedStyle to return a properly
// cascaded result.
export async function openBounceQuoteComposer(
  article: HTMLElement,
  phrase: string | null,
  file: File | null,
): Promise<void> {
  console.log('[Bouncer/bounce-quote] openBounceQuoteComposer start', {
    phrase,
    hasFile: !!file,
    fileSize: file?.size,
    fileType: file?.type,
  });

  // Mirror Share Filters: append a base64 share-pack URL so the quote tweet
  // doubles as a one-click import for whoever sees it. Pack contains just the
  // bounced phrase (matching the screenshot above).
  let text = 'I bounced this tweet.';
  if (phrase) {
    try {
      const shareCode = await encodeFilterPackCode({ phrases: [phrase] });
      text = `${text}\n\n${buildFilterPackShareUrl(shareCode)}`;
    } catch (err) {
      console.error('[Bouncer/bounce-quote] Failed to build share URL:', err);
    }
  }
  console.log('[Bouncer/bounce-quote] text prepared', { text });

  const retweetBtn = article.querySelector<HTMLElement>('[data-testid="retweet"]');
  console.log('[Bouncer/bounce-quote] retweet button lookup', {
    found: !!retweetBtn,
    articleConnected: article.isConnected,
    articleHidden: window.getComputedStyle(article).display === 'none',
  });
  if (!retweetBtn) {
    console.warn('[Bouncer/bounce-quote] retweet button missing — abort');
    return;
  }
  retweetBtn.click();
  console.log('[Bouncer/bounce-quote] retweet button clicked');

  // Quote option is an <a href="/compose/post"> inside the dropdown menu.
  // Prefer the menu-scoped selector; fall back to the bare link if X's menu
  // structure changes.
  const quoteLink =
    (await waitForElement<HTMLAnchorElement>('[role="menu"] a[href="/compose/post"]', 1200))
    ?? (await waitForElement<HTMLAnchorElement>('a[href="/compose/post"]', 600));
  console.log('[Bouncer/bounce-quote] quote link lookup', { found: !!quoteLink });
  if (!quoteLink) {
    console.warn('[Bouncer/bounce-quote] quote link missing — abort');
    return;
  }
  quoteLink.click();
  console.log('[Bouncer/bounce-quote] quote link clicked');

  // Scope to the dialog so we don't grab the inline /home composer's
  // tweetTextarea_0 by mistake (same testid earlier in the DOM).
  const textarea = await waitForElement<HTMLElement>('[role="dialog"] [data-testid="tweetTextarea_0"]', 3000);
  console.log('[Bouncer/bounce-quote] textarea lookup', {
    found: !!textarea,
    tag: textarea?.tagName,
    contentEditable: textarea?.contentEditable,
    hasContentEditableChild: !!textarea?.querySelector('[contenteditable="true"]'),
  });
  if (!textarea) {
    console.warn('[Bouncer/bounce-quote] textarea did not appear — abort');
    return;
  }

  textarea.focus();
  console.log('[Bouncer/bounce-quote] textarea focused', { activeElement: document.activeElement?.tagName });

  // Paste image first, then text — same sequence as openComposerWithImage
  // (the share flow). DraftJS' paste handler is more reliable with one data
  // type at a time than with a combined payload.
  if (file) {
    const imageDt = new DataTransfer();
    imageDt.items.add(file);
    console.log('[Bouncer/bounce-quote] dispatching image paste', {
      files: imageDt.files.length,
      itemKinds: Array.from(imageDt.items).map(i => i.kind),
      itemTypes: Array.from(imageDt.items).map(i => i.type),
    });
    const accepted = textarea.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: imageDt,
      bubbles: true,
      cancelable: true,
    }));
    console.log('[Bouncer/bounce-quote] image paste dispatched', { defaultNotPrevented: accepted });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    textarea.focus();
  } else {
    console.log('[Bouncer/bounce-quote] no file to paste — skipping image step');
  }

  const textDt = new DataTransfer();
  textDt.setData('text/plain', text);
  console.log('[Bouncer/bounce-quote] dispatching text paste', { textLength: text.length });
  const textAccepted = textarea.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: textDt,
    bubbles: true,
    cancelable: true,
  }));
  console.log('[Bouncer/bounce-quote] text paste dispatched', { defaultNotPrevented: textAccepted });
}

// Tell the background we missed a post that should have been filtered. Pulled
// out so the two .ff-missed-link handlers (loading state + response state)
// share one call site.
export function sendMissedFeedback(article: HTMLElement, content: PostContent): void {
  const r = deps().postReasonings.get(article);
  chrome.runtime.sendMessage({
    type: 'sendFeedback',
    siteId: deps().adapter.siteId,
    postUrl: content.postUrl || null,
    tweetData: { text: formatPostForEvaluation(content), imageUrls: content.imageUrls || [] },
    rawResponse: r?.rawResponse || '',
    reasoning: r?.reasoning || '',
    decision: 'false_negative',
  }).catch(err => console.error('[Bouncer] Missed feedback error:', err));
}

// Shared end-state for every "bounce this post" path in the annoying-reasons
// tooltip — chip click, custom-input submit, and the "missed" link. Hides the
// post, overrides the cache, optionally adds a filter phrase (block paths
// only), and pops the quote composer if the user kept the toggle on.
export async function applyBounceAction(opts: {
  article: HTMLElement;
  content: PostContent;
  tooltip: HTMLElement;
  phrase: string | null;
  reasoning: string;
}): Promise<void> {
  const { article, content, tooltip, phrase, reasoning } = opts;
  const quoteEnabled = tooltip.querySelector<HTMLInputElement>('.ff-bounce-quote-toggle')?.checked ?? true;
  console.log('[Bouncer/bounce-quote] applyBounceAction start', { phrase, quoteEnabled, reasoning });
  tooltip.remove();
  if (phrase !== null) {
    storeFilteredPost(article, content, reasoning, '', phrase);
  } else {
    storeFilteredPost(article, content, reasoning);
  }
  article.style.transition = 'opacity 0.3s ease';
  article.style.opacity = '0';
  setTimeout(() => hidePost(article), 300);
  chrome.runtime.sendMessage({
    type: 'overrideCacheEntry',
    post: formatPostForEvaluation(content),
    imageUrls: content.imageUrls || [],
    postUrl: content.postUrl || null,
    siteId: deps().adapter.siteId,
    shouldHide: true,
    reasoning,
  }).catch(err => console.error('[Bouncer] Override cache error:', err));

  const file = (phrase !== null && quoteEnabled)
    ? await captureBouncerScreenshot(phrase).catch(err => {
        console.error('[Bouncer/bounce-quote] Screenshot capture error:', err);
        return null;
      })
    : null;
  console.log('[Bouncer/bounce-quote] applyBounceAction post-capture', {
    fileAcquired: !!file,
    fileSize: file?.size,
  });
  if (phrase !== null) {
    addFilterPhrase(phrase).catch(err => console.error('[UI] addFilterPhrase failed:', err));
  }
  if (quoteEnabled) {
    await openBounceQuoteComposer(article, phrase, file);
  }
  console.log('[Bouncer/bounce-quote] applyBounceAction done');
}
