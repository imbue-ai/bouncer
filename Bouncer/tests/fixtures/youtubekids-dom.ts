/**
 * Hand-authored minimal YouTube Kids DOM fixtures for adapter tests.
 *
 * Each builder inserts a single tile into document.body and returns the tile
 * element. The markup contains only the classes/attributes that
 * YouTubeKidsAdapter actually reads (see
 * adapters/youtubekids/YouTubeKidsAdapter.ts) — deliberately NOT a full
 * real-page capture, so the fixtures stay small and survive markup churn.
 *
 * Real-page shape (from the ytk-compact-video-renderer Polymer template):
 * home/search tiles are stamped with id="ytk-compact-video-renderer-<id>";
 * watch-page up-next tiles carry no id and only expose the video id via the
 * endpoint anchor's /watch?v= href.
 */

function setBody(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

/** Home/search tile — video id lives in the element id. Uses an id with `-`
 *  and `_` so tests catch prefix-slicing bugs. */
export function homeTile(videoId = 'a-b_c1234-Z'): HTMLElement {
  return setBody(`
    <ytk-compact-video-renderer id="ytk-compact-video-renderer-${videoId}" data-index="tile-0">
      <a class="yt-simple-endpoint" aria-label="Play Fun Learning Video 4 minutes 12 seconds" href="/watch?v=${videoId}">
        <div class="thumbnail">
          <yt-img-shadow>
            <img src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg">
          </yt-img-shadow>
          <span class="overlay">4:12</span>
        </div>
        <div class="details">
          <div class="primary-text"><span>Fun Learning Video</span></div>
        </div>
      </a>
      <div class="menu"><button aria-label="Menu"></button></div>
    </ytk-compact-video-renderer>
  `);
}

/** Watch-page up-next tile — no id attribute; the video id is only in the
 *  endpoint anchor's href. */
export function watchTile(videoId = 'dQw4w9WgXcQ'): HTMLElement {
  return setBody(`
    <ytk-compact-video-renderer>
      <a class="yt-simple-endpoint" aria-label="Play Suggested Video" href="/watch?v=${videoId}">
        <div class="thumbnail">
          <yt-img-shadow>
            <img src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg">
          </yt-img-shadow>
        </div>
        <div class="details">
          <div class="primary-text"><span>Suggested Video</span></div>
        </div>
      </a>
      <div class="menu"><button aria-label="Menu"></button></div>
    </ytk-compact-video-renderer>
  `);
}

/** Recycled/unhydrated tile — Polymer has stamped the element but not yet
 *  bound data: no id, no anchor, no title. */
export function unhydratedTile(): HTMLElement {
  return setBody('<ytk-compact-video-renderer></ytk-compact-video-renderer>');
}

/** Tile whose title hasn't rendered but whose anchor aria-label has — the
 *  extraction falls back to the anchor label. */
export function ariaOnlyTile(videoId = 'xyzXYZ01234'): HTMLElement {
  return setBody(`
    <ytk-compact-video-renderer id="ytk-compact-video-renderer-${videoId}">
      <a class="yt-simple-endpoint" aria-label="Play Aria Label Title" href="/watch?v=${videoId}">
        <div class="thumbnail"><yt-img-shadow></yt-img-shadow></div>
        <div class="details"><div class="primary-text"></div></div>
      </a>
    </ytk-compact-video-renderer>
  `);
}
