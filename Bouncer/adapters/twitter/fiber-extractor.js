(function() {
  // ---------- x-web (X's rewritten web app): Relay store ----------
  //
  // x-web keeps tweets in a Relay store instead of Redux. Relay's
  // RelayModernEnvironment constructor hands itself to
  // window.__RELAY_DEVTOOLS_HOOK__.registerEnvironment when that global
  // exists, so defining the hook before the app boots (iOS injects this
  // script at document start) captures the environment directly. Later
  // injections (Chrome runs it at document_idle) fall back to finding the
  // RelayEnvironmentProvider context in the React fiber tree.
  const relayEnvironments = [];
  (function installRelayHook() {
    // Only on x-web (the legacy app never sees the hook). <html> and its
    // attributes exist even at document start.
    if (!document.documentElement?.hasAttribute('data-app-version')) return;
    const existing = window.__RELAY_DEVTOOLS_HOOK__;
    const register = (env) => {
      if (env && typeof env.getStore === 'function' && !relayEnvironments.includes(env)) {
        relayEnvironments.push(env);
      }
    };
    if (existing && typeof existing.registerEnvironment === 'function') {
      // Relay DevTools is installed — wrap its hook rather than replace it.
      const original = existing.registerEnvironment.bind(existing);
      existing.registerEnvironment = (env) => { register(env); return original(env); };
    } else if (!existing) {
      try {
        Object.defineProperty(window, '__RELAY_DEVTOOLS_HOOK__', {
          value: { registerEnvironment: register },
          configurable: true,
        });
      } catch { /* page defined it non-configurably; fiber fallback covers it */ }
    }
  })();

  function findRelayEnvironment(el) {
    if (relayEnvironments.length) return relayEnvironments[relayEnvironments.length - 1];
    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    let node = fiberKey ? el[fiberKey] : null;
    for (let i = 0; i < 300 && node; i++) {
      const props = node.memoizedProps;
      try {
        const env = props?.value?.environment || props?.environment;
        if (env && typeof env.getStore === 'function') {
          relayEnvironments.push(env);
          return env;
        }
      } catch { /* property access may throw */ }
      node = node.return;
    }
    return null;
  }

  // Read a field off a normalized Relay record, following linked-record
  // references. Fields queried with arguments are stored under
  // `name(arg:value)`, so fall back to a prefix match on `name(`.
  function relayField(source, record, name) {
    if (!record || typeof record !== 'object') return undefined;
    let value = record[name];
    if (value === undefined) {
      const key = Object.keys(record).find(k => k.startsWith(name + '('));
      value = key ? record[key] : undefined;
    }
    return resolveRelayValue(source, value);
  }

  function resolveRelayValue(source, value) {
    if (value && typeof value === 'object') {
      if (typeof value.__ref === 'string') return source.get(value.__ref);
      if (Array.isArray(value.__refs)) return value.__refs.map(id => source.get(id));
    }
    return value;
  }

  // Walk a dotted path through records (and plain inline objects).
  function relayPath(source, record, path) {
    let cur = record;
    for (const part of path.split('.')) {
      if (cur == null) return undefined;
      cur = relayField(source, cur, part);
    }
    return cur;
  }

  const relayTweetId = (restId) => btoa('Tweet:' + restId);

  function relayMediaUrls(source, tweet) {
    const imageUrls = [];
    const videoThumbnailUrls = [];
    let media = relayPath(source, tweet, 'media_entities2');
    if (!Array.isArray(media) || !media.length) media = relayPath(source, tweet, 'legacy.entities.media');
    for (const m of Array.isArray(media) ? media : []) {
      const url = relayField(source, m, 'media_url_https') || relayField(source, m, 'media_url');
      if (!url) continue;
      const type = relayField(source, m, 'type');
      if (type === 'video' || type === 'animated_gif') {
        if (!videoThumbnailUrls.includes(url)) videoThumbnailUrls.push(url);
      } else {
        const sized = url + '?format=jpg&name=medium';
        if (!imageUrls.includes(sized)) imageUrls.push(sized);
      }
    }
    // Link-card thumbnail. GraphQL binding_values is a [{key, value}] list.
    const bindings = relayPath(source, tweet, 'card.legacy.binding_values');
    if (Array.isArray(bindings)) {
      for (const want of ['thumbnail_image_original', 'thumbnail_image', 'photo_image_full_size_original']) {
        const b = bindings.find(x => relayField(source, x, 'key') === want);
        const url = b && relayPath(source, b, 'value.image_value.url');
        if (url) {
          if (!imageUrls.includes(url)) imageUrls.push(url);
          break;
        }
      }
    }
    return { imageUrls, videoThumbnailUrls };
  }

  function extractRelayTweet(source, restId, includeQuoted = true) {
    let tweet = source.get(relayTweetId(restId));
    if (!tweet) return null;
    // Visibility wrappers (TweetWithVisibilityResults) nest the real tweet.
    if (relayField(source, tweet, '__typename') !== 'Tweet') {
      tweet = relayField(source, tweet, 'tweet') || tweet;
    }

    // A repost's own record is the reposter's wrapper; read the original.
    let repostHeader = null;
    const original = relayPath(source, tweet, 'retweeted_status_results.result')
      || relayPath(source, tweet, 'legacy.retweeted_status_result.result');
    if (original) {
      const reposter = relayPath(source, tweet, 'core.user_results.result.core.name');
      repostHeader = reposter ? reposter + ' reposted' : 'Reposted';
      tweet = relayField(source, original, 'tweet') || original;
    }
    const tweetRestId = relayField(source, tweet, 'rest_id') || restId;

    const rawText = relayPath(source, tweet, 'grok_translated_post_with_availability.translation')
      || relayPath(source, tweet, 'note_tweet.note_tweet_results.result.text')
      || relayPath(source, tweet, 'details.full_text')
      || relayPath(source, tweet, 'legacy.full_text')
      || '';
    // GraphQL text fields are HTML-escaped (&amp; &lt; &gt;).
    const fullText = rawText.replace(/https?:\/\/t\.co\/\w+/g, '').replace(/\s+/g, ' ').trim()
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

    const user = relayPath(source, tweet, 'core.user_results.result');
    const screenName = relayPath(source, user, 'core.screen_name') || relayPath(source, user, 'legacy.screen_name') || '';
    const userName = relayPath(source, user, 'core.name') || relayPath(source, user, 'legacy.name') || '';
    const userAvatarUrl = relayPath(source, user, 'avatar.image_url')
      || relayPath(source, user, 'legacy.profile_image_url_https') || null;

    const { imageUrls, videoThumbnailUrls } = relayMediaUrls(source, tweet);

    let quotedTweet = null;
    const quoted = relayPath(source, tweet, 'quoted_tweet_results.result')
      || relayPath(source, tweet, 'quoted_status_result.result');
    const quotedRestId = quoted && (relayField(source, quoted, 'rest_id') || relayPath(source, quoted, 'tweet.rest_id'));
    if (includeQuoted && quotedRestId) {
      const q = extractRelayTweet(source, quotedRestId, false);
      if (q) {
        quotedTweet = {
          fullText: q.fullText,
          userName: q.userName,
          userHandle: q.userHandle,
          userAvatarUrl: q.userAvatarUrl,
          imageUrls: [...q.imageUrls, ...q.videoThumbnailUrls],
        };
      }
    }

    return {
      tweetId: tweetRestId,
      fullText,
      imageUrls,
      videoThumbnailUrls,
      userName,
      userHandle: screenName ? '@' + screenName : '',
      userAvatarUrl,
      postUrl: screenName ? 'https://x.com/' + screenName + '/status/' + tweetRestId : null,
      quotedTweet,
      mediaBlurred: !!relayPath(source, tweet, 'mediaVisibilityResults.blurred_image_interstitial'),
      isRepost: !!original,
      repostHeader,
    };
  }

  function extractFromRelay(targetEl, restId) {
    const env = findRelayEnvironment(targetEl);
    if (!env) return { success: false, error: 'No Relay environment found' };
    const data = extractRelayTweet(env.getStore().getSource(), restId);
    if (!data) return { success: false, error: 'Relay record not found: ' + restId };
    return { success: true, data };
  }

  // ---------- legacy X web app: Redux store ----------

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
    let tweetEntity = state.entities?.tweets?.entities?.[tweetId];
    if (!tweetEntity) return null;

    // A retweet resolves to a wrapper entity whose user is the REPOSTER and
    // whose full_text is a truncated "RT @..." copy. Follow the pointer so
    // text/media/author come from the original tweet (matching what the DOM
    // renders), and keep the reposter's name for the repost header.
    let repostHeader = null;
    const retweetedId = tweetEntity.retweeted_status_id_str || tweetEntity.retweeted_status;
    if (retweetedId) {
      const reposterId = tweetEntity.user_id_str || tweetEntity.user;
      const reposter = reposterId ? state.entities?.users?.entities?.[reposterId] : null;
      repostHeader = reposter?.name ? reposter.name + ' reposted' : 'Reposted';
      const originalEntity = state.entities?.tweets?.entities?.[retweetedId];
      if (originalEntity) {
        tweetEntity = originalEntity;
        tweetId = retweetedId;
      }
    }

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

    // Check if media is blurred (age-restricted / sensitive content interstitial)
    const mediaBlurred = !!tweetEntity.mediaVisibilityResults?.blurred_image_interstitial;

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
      mediaBlurred,
      isRepost: !!retweetedId,
      repostHeader,
    };
  }

  // x-web: tell the adapter we're listening (it waits for this before its
  // first Relay request, since Chrome injects us after posts start
  // rendering), and answer its ping in case it was set up after we loaded.
  if (document.documentElement?.hasAttribute('data-app-version')) {
    const announce = () => document.dispatchEvent(new CustomEvent('ff-extractor-ready'));
    document.addEventListener('ff-extractor-ping', announce);
    announce();
  }

  document.addEventListener('ff-extract-tweet-data', function() {
    // Process ALL pending requests to avoid race conditions when multiple
    // extractTweetDataFromStore calls set their attribute before the event fires
    const targets = document.querySelectorAll('[data-ff-request]');
    if (!targets.length) return;

    // x-web pages have no Redux store; only look it up for legacy requests.
    let store, state;
    const legacyState = () => {
      if (store === undefined) {
        store = getStore();
        state = store ? store.getState() : null;
      }
    };

    targets.forEach(targetEl => {
      const requestId = targetEl.getAttribute('data-ff-request');
      targetEl.removeAttribute('data-ff-request');
      // x-web requests carry the status id (from the post's permalink).
      const relayRestId = targetEl.getAttribute('data-ff-tweet-id');
      if (relayRestId) {
        targetEl.removeAttribute('data-ff-tweet-id');
        let result;
        try {
          result = extractFromRelay(targetEl, relayRestId);
        } catch (e) {
          result = { success: false, error: e.message };
        }
        document.dispatchEvent(new CustomEvent('ff-tweet-data-result', {
          detail: JSON.stringify({ requestId, ...result })
        }));
        return;
      }
      legacyState();
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
