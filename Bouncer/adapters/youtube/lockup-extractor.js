(function() {
  // YouTube lockup data lives as a JS property on the <yt-lockup-view-model>
  // custom element (Lit/Polymer). Content scripts run in an isolated world
  // and can't read it; this script runs in the page world and bridges it
  // back via CustomEvent, mirroring adapters/twitter/fiber-extractor.js.

  const DATA_PROP_FALLBACKS = ['data', '__data', '_data'];
  let warnedNoData = false;

  function readObj(el, key) {
    try {
      const v = el[key];
      if (v && typeof v === 'object') return v;
    } catch { /* property access may throw on locked elements */ }
    return null;
  }

  // Read a property that might be a signal-style lazy getter — newer YT
  // lockup components store the lockup payload as `rawProps.data = () =>
  // { erB(R); return R.value; }`. Plain `readObj` rejects functions, so
  // we try calling it and unwrap the returned object.
  function readSignalObj(holder, key) {
    if (!holder || typeof holder !== 'object') return null;
    try {
      const v = holder[key];
      if (v && typeof v === 'object') return v;
      if (typeof v === 'function') {
        const result = v();
        if (result && typeof result === 'object') return result;
      }
    } catch { /* getter may require reactive context — skip and try fallbacks */ }
    return null;
  }

  // Read the raw payload off a card element. Two element shapes are
  // supported:
  //   1. `<ytd-rich-item-renderer>` (home feed): Polymer element holding
  //      its data directly via `.data` / `.__data` / `polymerController.data`.
  //      Payload shape: `{ content: { lockupViewModel | adSlotRenderer | ... } }`.
  //   2. `<yt-lockup-view-model>` (watch sidebar): newer reactive
  //      component that exposes its payload via `rawProps.data` /
  //      `componentProps.data`. The element's own `.data` accessor on
  //      this shape returns a Symbol sentinel — useless to us, so we
  //      check rawProps/componentProps first. Payload is the lockup
  //      directly (handled by `normalize`'s "Direct lockup" branch).
  function readRichItemData(richItem) {
    if (!richItem) return null;

    const fromRawProps = readSignalObj(richItem.rawProps, 'data')
      || readSignalObj(richItem.componentProps, 'data');
    if (fromRawProps) return fromRawProps;

    for (const k of DATA_PROP_FALLBACKS) {
      const v = readObj(richItem, k);
      if (v) return v;
    }
    const ctrl = readObj(richItem, 'polymerController');
    if (ctrl) {
      const d = readObj(ctrl, 'data');
      if (d) return d;
    }
    return null;
  }

  // Diagnostic: list non-DOM-standard properties on an element so we can
  // discover where YouTube currently stows the lockup data.
  // Walk an object graph until we find a node satisfying `pred`. Used to
  // locate nested ViewModels regardless of YouTube's exact ad path.
  function deepFind(root, pred, maxDepth) {
    if (!root || typeof root !== 'object') return null;
    if (maxDepth === undefined) maxDepth = 12;
    const seen = new WeakSet();
    const stack = [{ node: root, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (pred(node)) return node;
      if (depth >= maxDepth) continue;
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push({ node: v, depth: depth + 1 });
      }
    }
    return null;
  }

  function getVideoIdFromHost(richItem) {
    const host = richItem.querySelector('[class*="content-id-"]');
    if (!host) return null;
    for (const cls of host.classList) {
      if (cls.startsWith('content-id-')) return cls.slice('content-id-'.length);
    }
    return null;
  }

  function flattenText(part) {
    if (!part) return '';
    if (typeof part === 'string') return part;
    if (part.text?.content) return part.text.content;
    return '';
  }

  // Classic InnerTube text shape: `{ runs: [{ text }, ...] }`. Used by the
  // mobile watch page's videoWithContextRenderer.
  function runsText(o) {
    if (!o || !Array.isArray(o.runs)) return '';
    return o.runs.map(r => (r && r.text) || '').join('').trim();
  }

  // Pick a thumbnail roughly sized for the filtered-panel card (~300-500px wide).
  // Prefer the smallest source that's still >= TARGET_WIDTH; fall back to the
  // largest if every source is undersized. Avoids fetching multi-megabyte ad
  // images when the lockup has variants up to 1152px.
  const TARGET_WIDTH = 480;
  function pickThumbFromSources(sources) {
    if (!Array.isArray(sources) || sources.length === 0) return null;
    let chosen = null;
    let chosenWidth = Infinity;
    let fallback = null, fallbackWidth = -1;
    for (const s of sources) {
      const w = s.width || 0;
      if (w >= TARGET_WIDTH && w < chosenWidth) { chosenWidth = w; chosen = s.url; }
      if (w > fallbackWidth) { fallbackWidth = w; fallback = s.url; }
    }
    return chosen || fallback;
  }
  function pickLargestThumb(lockup) {
    return pickThumbFromSources(lockup?.contentImage?.thumbnailViewModel?.image?.sources);
  }
  // Playlists / podcasts / mixes / albums stack their thumbnail under a
  // collectionThumbnailViewModel instead of a plain thumbnailViewModel.
  function pickCollectionThumb(lockup) {
    return pickThumbFromSources(
      lockup?.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources
    );
  }

  function normalizeVideo(lockup, videoId) {
    if (!lockup) return null;
    const contentType = lockup.contentType;
    const isVideo = !contentType || contentType === 'LOCKUP_CONTENT_TYPE_VIDEO';
    // Collections (playlists, podcasts, mixes, albums) carry a
    // collectionThumbnailViewModel and are filterable by their title/owner just
    // like videos. Other non-video lockups (channel cards, etc.) are skipped.
    const isCollection = !!lockup.contentImage?.collectionThumbnailViewModel;
    if (!isVideo && !isCollection) {
      return { skip: true, reason: 'contentType=' + contentType };
    }

    const meta = lockup.metadata?.lockupMetadataViewModel;
    if (!meta) return { skip: true, reason: 'no lockupMetadataViewModel' };

    const title = meta.title?.content?.trim() || '';

    // Flatten all metadata rows into a single channel/views/age string set.
    const rows = meta.metadata?.contentMetadataViewModel?.metadataRows || [];
    const rowTexts = rows.map(r =>
      (r.metadataParts || []).map(flattenText).filter(Boolean).join(' • ')
    ).filter(Boolean);

    // Channel name is the first link-bearing text part in row 0.
    let channelName = '';
    let channelHandle = '';
    let channelBrowseId = '';
    const firstRow = rows[0]?.metadataParts || [];
    for (const part of firstRow) {
      const content = part.text?.content;
      if (!content) continue;
      channelName = content.trim();
      const run = part.text?.commandRuns?.[0]?.onTap?.innertubeCommand?.browseEndpoint;
      if (run) {
        channelHandle = run.canonicalBaseUrl || '';
        channelBrowseId = run.browseId || '';
      }
      break;
    }

    // Channel avatar
    const avatarSources = meta.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources || [];
    const avatarUrl = avatarSources[0]?.url || null;

    const thumbUrl = pickLargestThumb(lockup) || pickCollectionThumb(lockup);

    // Duration badge (also serves as a video-vs-other discriminator). Absent
    // for collections (they show an episode/video count instead).
    const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || [];
    let duration = null;
    for (const o of overlays) {
      const badge = o.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel;
      if (badge?.text) { duration = badge.text; break; }
    }

    const id = lockup.contentId || videoId;
    let outVideoId, postUrl;
    if (isVideo) {
      outVideoId = id;
      postUrl = id ? 'https://www.youtube.com/watch?v=' + id : null;
    } else {
      // Collection: leave videoId null so the real collection thumbnail is
      // used as-is (not rewritten to a canonical single-video mqdefault), and
      // link to the playlist. `id` may carry a `VL` browse prefix.
      outVideoId = null;
      const listId = (id || '').replace(/^VL/, '');
      postUrl = listId ? 'https://www.youtube.com/playlist?list=' + listId : null;
    }

    return {
      kind: 'video',
      videoId: outVideoId,
      title,
      channelName,
      channelHandle,
      channelBrowseId,
      avatarUrl,
      thumbnailUrl: thumbUrl,
      duration,
      metadataRows: rowTexts,
      postUrl,
    };
  }

  // Ad payloads come in two layouts we've seen so far:
  //   1. VIDEO_DISPLAY_BUTTON_GROUP (in-feed video ad)
  //      → videoDisplayButtonGroupLayoutViewModel.videoLockup.lockupViewModel
  //      Has contentImage.thumbnailViewModel + metadata.feedAdMetadataViewModel,
  //      and a contentId pointing at a real videoId.
  //   2. TOP_LANDSCAPE_IMAGE (image-only display ad, e.g. T-Mobile, Shopify storefront)
  //      → topLandscapeImageLayoutViewModel
  //      Has adImageViewModel (no thumbnailViewModel wrapper) and no contentId.
  // Both nest a `feedAdMetadataViewModel` for the headline+advertiser+avatar,
  // so we find that node first and pull image separately.
  function normalizeAd(adSlotRenderer, videoId) {
    if (!adSlotRenderer) return null;

    const renderingContent =
      adSlotRenderer.fulfillmentContent?.fulfilledLayout?.inFeedAdLayoutRenderer?.renderingContent;

    // Direct paths for known layouts; deepFind covers anything else.
    const videoLockup =
      renderingContent?.videoDisplayButtonGroupLayoutViewModel?.videoLockup?.lockupViewModel;
    const topLandscape = renderingContent?.topLandscapeImageLayoutViewModel;

    const feedMeta =
      videoLockup?.metadata?.feedAdMetadataViewModel
      || topLandscape?.feedAdMetadata?.feedAdMetadataViewModel
      || deepFind(adSlotRenderer, n => n.headline && n.adDetailsLine?.adDetailsLineViewModel);

    if (!feedMeta) return { skip: true, reason: 'no feedAdMetadataViewModel' };

    const headline = feedMeta.headline?.content?.trim() || '';
    const description = feedMeta.description?.content?.trim() || '';
    const title = [headline, description].filter(Boolean).join(' — ');

    // Advertiser: details-line attributes, fall back to avatar a11y label.
    let advertiser = '';
    const detailsAttrs = feedMeta.adDetailsLine?.adDetailsLineViewModel?.attributes;
    if (Array.isArray(detailsAttrs)) {
      for (const a of detailsAttrs) {
        const t = a?.text?.content?.trim();
        if (t) { advertiser = t; break; }
      }
    }
    if (!advertiser) {
      advertiser = feedMeta.adAvatar?.adAvatarViewModel
        ?.rendererContext?.accessibilityContext?.label?.trim() || '';
    }

    const avatarSources = feedMeta.adAvatar?.adAvatarViewModel?.image?.sources || [];
    const avatarUrl = avatarSources[0]?.url || null;

    // Thumbnail: video ads expose it via lockup.contentImage.thumbnailViewModel
    // (with the standard `image.sources[]`). Image ads expose it directly via
    // topLandscape.thumbnailImage.adImageViewModel.imageSources[] — note the
    // flatter shape: `imageSources`, not `image.sources`.
    let thumbUrl;
    if (videoLockup) {
      thumbUrl = pickLargestThumb(videoLockup);
    } else {
      const adImage =
        topLandscape?.thumbnailImage?.adImageViewModel
        || deepFind(adSlotRenderer, n => Array.isArray(n.imageSources) && n.imageSources[0]?.url);
      thumbUrl = pickThumbFromSources(adImage?.imageSources);
    }

    const id = videoLockup?.contentId || videoId;
    const postUrl = id ? 'https://www.youtube.com/watch?v=' + id : null;

    return {
      kind: 'ad',
      videoId: id,
      title,
      channelName: advertiser,
      channelHandle: '',
      channelBrowseId: '',
      avatarUrl,
      thumbnailUrl: thumbUrl,
      duration: null,
      metadataRows: ['Sponsored', advertiser].filter(Boolean),
      postUrl,
    };
  }

  // Mobile watch-page suggestions render from the classic
  // `videoWithContextRenderer` (InnerTube) shape, not a lockupViewModel — the
  // `ytm-video-with-context-renderer` element's own `.data` is this renderer.
  // Shape (see mobile-youtube-dom notes):
  //   headline.runs[].text                                  // title
  //   shortBylineText.runs[0].text + .navigationEndpoint    // channel + handle/browseId
  //   lengthText.runs[].text / shortViewCountText / publishedTimeText
  //   thumbnail.thumbnails[]                                // video thumbnail
  //   channelThumbnail.channelThumbnailWithLinkRenderer.thumbnail.thumbnails[] // avatar
  function normalizeVideoWithContext(v, videoId) {
    if (!v) return null;
    const id = v.videoId || videoId;
    const title = runsText(v.headline) || runsText(v.title);

    const byline = v.shortBylineText || v.longBylineText;
    const channelName = runsText(byline);
    let channelHandle = '';
    let channelBrowseId = '';
    const browse = byline?.runs?.[0]?.navigationEndpoint?.browseEndpoint;
    if (browse) {
      channelHandle = browse.canonicalBaseUrl || '';
      channelBrowseId = browse.browseId || '';
    }

    const views = runsText(v.shortViewCountText) || runsText(v.viewCountText);
    const age = runsText(v.publishedTimeText);
    const duration = runsText(v.lengthText) || null;

    const thumbUrl = pickThumbFromSources(v.thumbnail?.thumbnails);
    const avatarUrl =
      v.channelThumbnail?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url
      || v.channelThumbnail?.thumbnails?.[0]?.url
      || null;

    const postUrl = id ? 'https://www.youtube.com/watch?v=' + id : null;

    return {
      kind: 'video',
      videoId: id,
      title,
      channelName,
      channelHandle,
      channelBrowseId,
      avatarUrl,
      thumbnailUrl: thumbUrl,
      duration,
      metadataRows: [channelName, views, age].filter(Boolean),
      postUrl,
    };
  }

  // Classic InnerTube `videoRenderer`. Shape (see live capture):
  //   videoId
  //   title.runs[].text (fallback .simpleText)
  //   ownerText/shortBylineText.runs[0].text (+ navigationEndpoint.browseEndpoint)
  //   thumbnail.thumbnails[] ({url,width})  — lh3.googleusercontent for Movies
  //   lengthText.simpleText
  //   avatar.decoratedAvatarViewModel{.a11yLabel, .avatar.avatarViewModel.image.sources}
  // Movies cards put a genre/year string in the byline and carry the real owner
  // ("YouTube Movies") only in the avatar a11y label, with no view/age text.
  function normalizeVideoRenderer(v, videoId) {
    if (!v) return null;
    const id = v.videoId || videoId;
    const title = runsText(v.title) || v.title?.simpleText || '';

    // Channel: prefer the byline when it links to a real channel; else fall back
    // to the avatar's "Go to channel <name>" a11y label (the Movies case).
    const ownerRun = v.ownerText?.runs?.[0] || v.shortBylineText?.runs?.[0];
    const browse = ownerRun?.navigationEndpoint?.browseEndpoint;
    const a11yChannel = (v.avatar?.decoratedAvatarViewModel?.a11yLabel || '')
      .replace(/^Go to channel\s+/i, '').trim();
    const channelName = browse ? (ownerRun.text || '').trim() : (a11yChannel || (ownerRun?.text || '').trim());

    const avatarUrl =
      v.avatar?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.[0]?.url
      || v.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url
      || null;

    // Views / age when present (normal videos); for Movies neither exists, so
    // surface the genre/year byline instead (when it isn't already the channel).
    const metadataRows = [];
    const views = v.viewCountText?.simpleText || runsText(v.viewCountText);
    if (views) metadataRows.push(views);
    const age = v.publishedTimeText?.simpleText || runsText(v.publishedTimeText);
    if (age) metadataRows.push(age);
    if (!browse) {
      const byline = runsText(v.shortBylineText) || runsText(v.ownerText);
      if (byline && byline !== channelName) metadataRows.push(byline);
    }

    return {
      kind: 'video',
      videoId: id,
      title,
      channelName,
      channelHandle: browse?.canonicalBaseUrl || '',
      channelBrowseId: browse?.browseId || '',
      avatarUrl,
      thumbnailUrl: pickThumbFromSources(v.thumbnail?.thumbnails),
      duration: v.lengthText?.simpleText || runsText(v.lengthText) || null,
      metadataRows,
      postUrl: id ? 'https://www.youtube.com/watch?v=' + id : null,
    };
  }

  function normalize(richData, videoId) {
    if (!richData) return null;
    const content = richData.content || richData;
    if (content.lockupViewModel) return normalizeVideo(content.lockupViewModel, videoId);
    if (content.adSlotRenderer) return normalizeAd(content.adSlotRenderer, videoId);
    if (content.shortsLockupViewModel) return normalizeShort(content.shortsLockupViewModel, videoId);
    // Classic `videoRenderer` (YouTube Movies "Free with ads" cards in the home
    // grid, and some legacy/search surfaces) — not a lockup, so it needs its own
    // branch or it falls through to "unknown shape" and never classifies.
    if (content.videoRenderer) return normalizeVideoRenderer(content.videoRenderer, videoId);
    // Mobile Shorts shelf: the `ytm-shorts-lockup-view-model` element's own
    // `.data` IS the shortsLockupViewModel (overlayMetadata + onTap/entityId),
    // not wrapped under `content`.
    if (richData.overlayMetadata && (richData.onTap || richData.entityId)) {
      return normalizeShort(richData, videoId);
    }
    // Mobile watch suggestions: classic videoWithContextRenderer (the card
    // element's own `.data`, or occasionally wrapped under the key).
    const vwc = richData.videoWithContextRenderer
      || content.videoWithContextRenderer
      || ((richData.videoId && (richData.headline || richData.shortBylineText)) ? richData : null);
    if (vwc) return normalizeVideoWithContext(vwc, videoId);
    // Direct lockup (e.g. the inner element's own .data).
    if (richData.contentId || richData.contentType) return normalizeVideo(richData, videoId);
    return { skip: true, reason: 'unknown shape: ' + Object.keys(content).slice(0, 3).join(',') };
  }

  // Shorts payload shape (shortsLockupViewModel on the home feed's Shorts shelf):
  //   onTap.innertubeCommand.reelWatchEndpoint.videoId            // videoId
  //   overlayMetadata.primaryText.content                         // title
  //   overlayMetadata.secondaryText.content                       // "2.8M views"
  //   thumbnailViewModel.thumbnailViewModel.image.sources[]       // thumbnail (note the double wrapper)
  // Channel info isn't included in the shorts lockup.
  function normalizeShort(short, videoId) {
    if (!short) return null;

    const id =
      short.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ||
      short.onTap?.innertubeCommand?.watchEndpoint?.videoId ||
      (typeof short.entityId === 'string'
        ? short.entityId.replace(/^shorts-shelf-item-/, '')
        : null) ||
      videoId;

    const title = short.overlayMetadata?.primaryText?.content?.trim() || '';
    const views = short.overlayMetadata?.secondaryText?.content?.trim() || '';

    const thumbUrl = pickThumbFromSources(
      short.thumbnailViewModel?.thumbnailViewModel?.image?.sources
    );

    const postUrl = id ? 'https://www.youtube.com/shorts/' + id : null;

    return {
      kind: 'short',
      videoId: id,
      title,
      // Shorts don't expose channel info in the lockup; the filtered panel
      // displays this as the author label, so use a stable "Short" tag.
      channelName: 'Short',
      channelHandle: '',
      channelBrowseId: '',
      avatarUrl: null,
      thumbnailUrl: thumbUrl,
      duration: null,
      metadataRows: ['Shorts', views].filter(Boolean),
      postUrl,
    };
  }

  document.addEventListener('ff-extract-youtube-data', function() {
    const targets = document.querySelectorAll('[data-ff-request]');
    if (!targets.length) return;

    targets.forEach(richItem => {
      const requestId = richItem.getAttribute('data-ff-request');
      richItem.removeAttribute('data-ff-request');
      try {
        const raw = readRichItemData(richItem);

        if (!raw) {
          if (!warnedNoData) {
            warnedNoData = true;
            const describe = (v) => v === undefined ? 'undefined'
              : v === null ? 'null'
              : typeof v === 'symbol' ? 'Symbol(' + (v.description || '') + ')'
              : typeof v !== 'object' ? typeof v + '(' + String(v).slice(0, 40) + ')'
              : 'object{' + Object.keys(v).slice(0, 8).join(',') + '}';
            console.warn('[Bouncer][YT] No data found on', richItem.tagName.toLowerCase(), {
              ref: richItem,
              rawProps: describe(richItem.rawProps),
              'rawProps.data': describe(richItem.rawProps && richItem.rawProps.data),
              componentProps: describe(richItem.componentProps),
              'componentProps.data': describe(richItem.componentProps && richItem.componentProps.data),
              '.data': describe(richItem.data),
              '.__data': describe(richItem.__data),
              '._data': describe(richItem._data),
              polymerController: describe(richItem.polymerController),
              ownProps: Object.getOwnPropertyNames(richItem).slice(0, 30),
            });
          }
          console.log('[Bouncer][YT][bridge] no-data-property', { requestId, tag: richItem.tagName.toLowerCase() });
          document.dispatchEvent(new CustomEvent('ff-youtube-data-result', {
            detail: JSON.stringify({ requestId, success: false, error: 'no-data-property' })
          }));
          return;
        }

        const videoId = getVideoIdFromHost(richItem);
        const isAd = !!raw.content?.adSlotRenderer;
        const isShort = !!raw.content?.shortsLockupViewModel;
        if (isAd) {
          console.log('[Bouncer][YT][bridge] AD raw', {
            requestId, videoId,
            adSlotRenderer: raw.content.adSlotRenderer,
          });
        }
        if (isShort) {
          console.log('[Bouncer][YT][bridge] SHORT raw', {
            requestId, videoId,
            shortsLockupViewModel: raw.content.shortsLockupViewModel,
          });
        }
        const data = normalize(raw, videoId);
        if (!data) {
          console.log('[Bouncer][YT][bridge] normalize-failed', { requestId, videoId, rawKeys: Object.keys(raw) });
          document.dispatchEvent(new CustomEvent('ff-youtube-data-result', {
            detail: JSON.stringify({ requestId, success: false, error: 'normalize-failed' })
          }));
          return;
        }
        if (data.skip) {
          console.log('[Bouncer][YT][bridge] skipping', { requestId, videoId, reason: data.reason });
        } else if (isAd) {
          console.log('[Bouncer][YT][bridge] AD extracted', {
            requestId,
            videoId: data.videoId,
            title: data.title,
            channelName: data.channelName,
            avatarUrl: data.avatarUrl,
            thumbnailUrl: data.thumbnailUrl,
          });
        } else if (isShort) {
          console.log('[Bouncer][YT][bridge] SHORT extracted', {
            requestId,
            videoId: data.videoId,
            title: data.title,
            thumbnailUrl: data.thumbnailUrl,
          });
        }
        document.dispatchEvent(new CustomEvent('ff-youtube-data-result', {
          detail: JSON.stringify({ requestId, success: true, data })
        }));
      } catch (e) {
        console.warn('[Bouncer][YT][bridge] threw', { requestId, error: e && e.message ? e.message : String(e) });
        document.dispatchEvent(new CustomEvent('ff-youtube-data-result', {
          detail: JSON.stringify({ requestId, success: false, error: e && e.message ? e.message : String(e) })
        }));
      }
    });
  });
})();
