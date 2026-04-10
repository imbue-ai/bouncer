(function() {
  function getStore() {
    const reactRoot = document.getElementById('react-root');
    if (!reactRoot) return null;
    const rootKey = Object.keys(reactRoot).find(k => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
    if (!rootKey) return null;
    let node = reactRoot[rootKey];
    for (let i = 0; i < 30 && node; i++) {
      for (const propSet of [node.memoizedProps, node.pendingProps]) {
        if (!propSet) continue;
        try {
          if (propSet.store && typeof propSet.store.getState === 'function') return propSet.store;
        } catch { /* property access may throw */ }
        try {
          if (propSet.value?.store && typeof propSet.value.store.getState === 'function') return propSet.value.store;
        } catch { /* property access may throw */ }
      }
      node = node.child;
    }
    return null;
  }

  function getTweetIdFromFiber(cellInnerDiv) {
    const fiberKey = Object.keys(cellInnerDiv).find(k => k.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    let current = cellInnerDiv[fiberKey];
    for (let d = 0; d < 5; d++) {
      if (!current) break;
      const props = current.memoizedProps;
      const entry = props?.children?.props?.entry || props?.entry;
      if (entry?.entryId) {
        const raw = entry.entryId;
        // Extract tweet ID: find the numeric ID after "tweet-" in any format:
        //   tweet-123, promoted-tweet-123-hex, conversationthread-456-tweet-123
        const match = raw.match(/tweet-(\d+)/);
        const cleaned = match ? match[1] : raw;
        return cleaned;
      }
      current = current.return;
    }
    return null;
  }

  function extractTweetData(tweetId, state, includeQuoted = true) {
    const tweetEntity = state.entities?.tweets?.entities?.[tweetId];
    if (!tweetEntity) return null;

    // Text: prefer Grok translation (non-English), then note_tweet (long tweets), then full_text
    // Strip t.co URLs from text — they're just media/link references, not useful for classification
    const rawText = tweetEntity.grok_translated_post?.translation || tweetEntity.note_tweet?.text || tweetEntity.full_text || '';
    const fullText = rawText.replace(/https?:\/\/t\.co\/\w+/g, '').replace(/\s+/g, ' ').trim();

    // Media from tweet entities
    const mediaEntities = tweetEntity.entities?.media || tweetEntity.extended_entities?.media || [];
    const imageUrls = [];
    const videoThumbnailUrls = [];
    for (const m of mediaEntities) {
      const url = m.media_url_https || m.media_url || '';
      if (!url) continue;
      if (m.type === 'photo') {
        imageUrls.push(url + '?format=jpg&name=medium');
      } else if (m.type === 'video' || m.type === 'animated_gif') {
        videoThumbnailUrls.push(url);
      }
    }

    // Media from link cards (unified_card contains media_entities with card images)
    let cardUrl = null;
    if (tweetEntity.card) {
      const cardEntity = state.entities?.cards?.entities?.[tweetEntity.card];
      if (cardEntity?.binding_values) {
        const bv = cardEntity.binding_values;

        // unified_card: JSON string with media_entities
        if (bv.unified_card?.string_value) {
          try {
            const uc = JSON.parse(bv.unified_card.string_value);
            if (uc.media_entities) {
              for (const me of Object.values(uc.media_entities)) {
                const url = me.media_url_https || me.media_url || '';
                if (url && !imageUrls.includes(url) && !imageUrls.includes(url + '?format=jpg&name=medium')) {
                  imageUrls.push(url + '?format=jpg&name=medium');
                }
              }
            }
            // Extract card destination URL
            if (uc.destination_objects) {
              for (const dest of Object.values(uc.destination_objects)) {
                const u = dest.data?.url_data?.url;
                if (u) { cardUrl = u; break; }
              }
            }
          } catch (e) {
            console.log('[Bouncer][Store] Failed to parse unified_card:', e.message);
          }
        }

        // Non-unified cards: thumbnail_image_original or thumbnail_image
        const thumbKey = bv.thumbnail_image_original || bv.thumbnail_image;
        if (thumbKey?.image_value?.url) {
          const url = thumbKey.image_value.url;
          if (!imageUrls.includes(url)) {
            imageUrls.push(url);
          }
        }

        // Card destination URL fallback
        if (!cardUrl && bv.card_url?.string_value) {
          cardUrl = bv.card_url.string_value;
        }
      }
    }

    // User
    const userId = tweetEntity.user_id_str || tweetEntity.user;
    const userEntity = userId ? state.entities?.users?.entities?.[userId] : null;
    const userName = userEntity?.name || '';
    const userHandle = userEntity?.screen_name ? '@' + userEntity.screen_name : '';
    const userAvatarUrl = userEntity?.profile_image_url_https || null;

    // Post URL
    const screenName = userEntity?.screen_name || '';
    const postUrl = screenName ? 'https://x.com/' + screenName + '/status/' + tweetId : null;

    // Quoted tweet
    let quotedTweet = null;
    const quotedId = tweetEntity.quoted_status_id_str || tweetEntity.quoted_status;
    if (quotedId && includeQuoted) {
      const quotedData = extractTweetData(quotedId, state, false);
      if (quotedData) {
        quotedTweet = {
          fullText: quotedData.fullText,
          userName: quotedData.userName,
          userHandle: quotedData.userHandle,
          userAvatarUrl: quotedData.userAvatarUrl,
          imageUrls: [...quotedData.imageUrls, ...quotedData.videoThumbnailUrls],
        };
      }
    }

    return {
      tweetId,
      fullText,
      imageUrls,
      videoThumbnailUrls,
      cardUrl,
      userName,
      userHandle,
      userAvatarUrl,
      postUrl,
      quotedTweet,
    };
  }

  document.addEventListener('ff-extract-tweet-data', function() {
    // Process ALL pending requests to avoid race conditions when multiple
    // extractTweetDataFromStore calls set their attribute before the event fires
    const targets = document.querySelectorAll('[data-ff-request]');
    if (!targets.length) return;

    const store = getStore();
    const state = store ? store.getState() : null;

    // const tweetEntities = state?.entities?.tweets?.entities;
    // if (tweetEntities) {
    targets.forEach(targetEl => {
      const requestId = targetEl.getAttribute('data-ff-request');
      targetEl.removeAttribute('data-ff-request');
      try {
        if (!store || !state) {
          document.dispatchEvent(new CustomEvent('ff-tweet-data-result', {
            detail: JSON.stringify({ requestId, success: false, error: 'No Redux store found' })
          }));
          return;
        }

        const tweetId = getTweetIdFromFiber(targetEl);
        if (!tweetId) {
          document.dispatchEvent(new CustomEvent('ff-tweet-data-result', {
            detail: JSON.stringify({ requestId, success: false, error: 'No tweet ID found in fiber' })
          }));
          return;
        }

        const data = extractTweetData(tweetId, state);
        if (!data) {
          document.dispatchEvent(new CustomEvent('ff-tweet-data-result', {
            detail: JSON.stringify({ requestId, success: false, error: 'Tweet entity not found: ' + tweetId })
          }));
          return;
        }

        document.dispatchEvent(new CustomEvent('ff-tweet-data-result', {
          detail: JSON.stringify({ requestId, success: true, data })
        }));
      } catch (e) {
        document.dispatchEvent(new CustomEvent('ff-tweet-data-result', {
          detail: JSON.stringify({ requestId, success: false, error: e.message })
        }));
      }
    });
  });
})();
