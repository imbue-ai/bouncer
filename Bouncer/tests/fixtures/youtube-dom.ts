/**
 * Hand-authored minimal YouTube DOM fixtures for adapter tests.
 *
 * Each builder inserts a single card into document.body and returns the card
 * element. The markup contains only the classes/attributes that
 * YouTubeAdapter actually reads (see adapters/youtube/YouTubeAdapter.ts) —
 * deliberately NOT a full real-page capture, so the fixtures stay small and
 * survive YouTube's frequent markup churn.
 */

function setBody(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

/**
 * Desktop home/watch lockup (`yt-lockup-view-model`). Channel is metadata
 * row 0 (an anchor); views/age live in a later row. Video id comes from the
 * `content-id-<id>` class.
 */
export function desktopVideoLockup(): HTMLElement {
  return setBody(`
    <yt-lockup-view-model>
      <div class="ytLockupViewModelHost ytLockupViewModelVertical content-id-dQw4w9WgXcQ">
        <a class="ytLockupViewModelContentImage" href="/watch?v=dQw4w9WgXcQ">
          <yt-thumbnail-view-model>
            <img class="ytCoreImageHost" src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg">
          </yt-thumbnail-view-model>
        </a>
        <div class="ytLockupMetadataViewModelTitle">Never Gonna Give You Up</div>
        <div class="ytContentMetadataViewModelMetadataRow">
          <a href="/@RickAstley">Rick Astley</a>
        </div>
        <div class="ytContentMetadataViewModelMetadataRow">
          <span class="ytContentMetadataViewModelMetadataText">1.4B views</span>
          <span class="ytContentMetadataViewModelMetadataText">15 years ago</span>
        </div>
        <img class="ytSpecAvatarShapeImage" src="https://yt3.ggpht.com/abc/avatar.jpg">
      </div>
    </yt-lockup-view-model>
  `);
}

/**
 * Desktop Shorts lockup — same lockup element, but the content image links to
 * `/shorts/<id>` and there is no channel/avatar metadata.
 */
export function desktopShortLockup(): HTMLElement {
  return setBody(`
    <yt-lockup-view-model>
      <div class="ytLockupViewModelHost content-id-shortID12345">
        <a class="ytLockupViewModelContentImage" href="/shorts/shortID12345">
          <yt-thumbnail-view-model>
            <img class="ytCoreImageHost" src="https://i.ytimg.com/vi/shortID12345/oardefault.jpg">
          </yt-thumbnail-view-model>
        </a>
        <div class="ytLockupMetadataViewModelTitle">A Wild Desktop Short</div>
      </div>
    </yt-lockup-view-model>
  `);
}

/**
 * Mobile (m.youtube.com) watch-page related card
 * (`ytm-media-item`). Title is `.media-item-headline`; byline items carry
 * channel + views/age; video id comes from the `/watch?v=` thumbnail link.
 */
export function mobileWatchCard(): HTMLElement {
  return setBody(`
    <ytm-media-item>
      <a class="media-item-thumbnail-container" href="/watch?v=abc123XYZ_-">
        <ytm-thumbnail-cover>
          <img class="ytCoreImageHost" src="https://i.ytimg.com/vi/abc123XYZ_-/hqdefault.jpg">
        </ytm-thumbnail-cover>
      </a>
      <div class="media-item-details">
        <div class="media-channel">
          <a href="/@SomeChannel">
            <img class="ytProfileIconImage" src="https://yt3.ggpht.com/m/avatar.jpg">
          </a>
        </div>
        <h3 class="media-item-headline">Some Mobile Video Title</h3>
        <ytm-badge-and-byline-renderer>
          <span class="YtmBadgeAndBylineRendererItemByline">Some Channel</span>
          <span class="YtmBadgeAndBylineRendererItemByline">2.3M views</span>
          <span class="YtmBadgeAndBylineRendererItemByline">1 year ago</span>
        </ytm-badge-and-byline-renderer>
      </div>
    </ytm-media-item>
  `);
}

/**
 * Mobile Shorts shelf card (`ytm-shorts-lockup-view-model`). Title lives in
 * `.shortsLockupViewModelHostMetadataTitle`; id is in the `/shorts/<id>` href.
 */
export function mobileShort(): HTMLElement {
  return setBody(`
    <ytm-shorts-lockup-view-model>
      <a href="/shorts/mShort99XYZ">
        <yt-thumbnail-view-model>
          <img class="ytCoreImageHost" src="https://i.ytimg.com/vi/mShort99XYZ/oardefault.jpg">
        </yt-thumbnail-view-model>
      </a>
      <span class="shortsLockupViewModelHostMetadataTitle">A Funny Mobile Short</span>
    </ytm-shorts-lockup-view-model>
  `);
}
