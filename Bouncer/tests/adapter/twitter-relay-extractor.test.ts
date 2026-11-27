/**
 * @vitest-environment happy-dom
 *
 * fiber-extractor.js reading x-web's Relay store. The fixture is a real
 * GraphQL tweet object (a quote post) from x.com's server-rendered payload,
 * captured 2026-11-27; normalizeRelay() stores it the way Relay does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const quoteTweet = JSON.parse(readFileSync(resolve(here, '../fixtures/x-web-relay-quote-tweet.json'), 'utf8'));

type RelayRecord = Record<string, unknown>;

/** Relay-style normalization: objects with an `id` become records under that
 *  id, other objects become `client:<parent>:<field>` records, and links are
 *  stored as {__ref} / {__refs}. */
function normalizeRelay(root: RelayRecord): Map<string, RelayRecord> {
  const records = new Map<string, RelayRecord>();
  const visit = (obj: RelayRecord, dataId: string): string => {
    const record: RelayRecord = { __id: dataId };
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value) && value.some(v => v && typeof v === 'object')) {
        record[key] = {
          __refs: value.map((v, i) => visit(v as RelayRecord, (v as RelayRecord).id as string ?? `client:${dataId}:${key}:${i}`)),
        };
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const v = value as RelayRecord;
        record[key] = { __ref: visit(v, typeof v.id === 'string' ? v.id : `client:${dataId}:${key}`) };
      } else {
        record[key] = value;
      }
    }
    records.set(dataId, { ...records.get(dataId), ...record });
    return dataId;
  };
  visit(root, root.id as string);
  return records;
}

function fakeEnvironment(root: RelayRecord) {
  const records = normalizeRelay(root);
  return { getStore: () => ({ getSource: () => ({ get: (id: string) => records.get(id) }) }) };
}

interface ExtractResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown> & { quotedTweet?: Record<string, unknown> };
}

function request(restId: string): Promise<ExtractResult> {
  const el = document.createElement('article');
  document.body.appendChild(el);
  const requestId = 'req-' + restId + '-' + Math.random();
  return new Promise(resolvePromise => {
    const onResult = (e: Event) => {
      const result = JSON.parse((e as CustomEvent).detail as string);
      if (result.requestId !== requestId) return;
      document.removeEventListener('ff-tweet-data-result', onResult);
      el.remove();
      resolvePromise(result);
    };
    document.addEventListener('ff-tweet-data-result', onResult);
    el.setAttribute('data-ff-request', requestId);
    el.setAttribute('data-ff-tweet-id', restId);
    document.dispatchEvent(new CustomEvent('ff-extract-tweet-data'));
  });
}

let registerEnvironment: (env: unknown) => void;

beforeAll(() => {
  // Loading the script installs window.__RELAY_DEVTOOLS_HOOK__, which is how
  // x-web's Relay environment registers itself at boot.
  document.documentElement.setAttribute('data-app-version', 'test');
  const src = readFileSync(resolve(here, '../../adapters/twitter/fiber-extractor.js'), 'utf8');
  (0, eval)(src);
  const hook = (window as unknown as { __RELAY_DEVTOOLS_HOOK__: { registerEnvironment(env: unknown): void } })
    .__RELAY_DEVTOOLS_HOOK__;
  registerEnvironment = env => hook.registerEnvironment(env);
});

describe('fiber-extractor Relay path (x-web)', () => {
  it('reports a missing record', async () => {
    registerEnvironment(fakeEnvironment(quoteTweet));
    const result = await request('1');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Relay record not found/);
  });

  it('extracts a quote post with its quoted long-form post', async () => {
    const { success, data } = await request('2126222666994737622');
    expect(success).toBe(true);
    expect(data).toMatchObject({
      fullText: 'True',
      userName: 'Elon Musk',
      userHandle: '@elonmusk',
      postUrl: 'https://x.com/elonmusk/status/2126222666994737622',
      imageUrls: [],
      isRepost: false,
      repostHeader: null,
    });
    expect(data?.userAvatarUrl).toContain('profile_images');
    const quoted = data!.quotedTweet!;
    expect(quoted.userHandle).toBe('@SVTrivo');
    // Full note_tweet text, which the DOM truncates.
    expect((quoted.fullText as string).length).toBeGreaterThan(900);
    // Two photos, then the video's thumbnail.
    expect(quoted.imageUrls).toEqual([
      'https://pbs.twimg.com/media/HYG8-lFaQAAiWHY.jpg?format=jpg&name=medium',
      'https://pbs.twimg.com/media/HYG9BQYagAEI_04.jpg?format=jpg&name=medium',
      'https://pbs.twimg.com/amplify_video_thumb/2125942421938712576/img/HLwNZzjHDACl48Ob.jpg',
    ]);
  });

  it('reads a repost as the original post with a repost header', async () => {
    const original = quoteTweet.quoted_tweet_results.result;
    const wrapper = {
      __typename: 'Tweet',
      id: btoa('Tweet:999'),
      rest_id: '999',
      core: quoteTweet.core,
      details: { full_text: 'RT @SVTrivo: I used to think…' },
      retweeted_status_results: { id: btoa('TweetResults:' + original.rest_id), rest_id: original.rest_id, result: original },
    };
    registerEnvironment(fakeEnvironment(wrapper));
    const { success, data } = await request('999');
    expect(success).toBe(true);
    expect(data).toMatchObject({
      isRepost: true,
      repostHeader: 'Elon Musk reposted',
      userHandle: '@SVTrivo',
      postUrl: 'https://x.com/SVTrivo/status/2126188487825318156',
    });
    expect(data?.fullText).toMatch(/^I used to think Trump Accounts/);
  });
});
