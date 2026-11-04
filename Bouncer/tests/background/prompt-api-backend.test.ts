import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PromptApiBackend, isPromptApiCached } from '../../src/background/backends/prompt-api-backend.js';
import type { LocalModelDef } from '../../src/types.js';

const modelDef: LocalModelDef = {
  name: 'gemini-nano-chrome',
  display: 'Gemini Nano',
  isLocal: true,
  backend: 'prompt-api',
  supportsImages: false,
};

type Session = {
  prompt: ReturnType<typeof vi.fn>;
  clone: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  measureContextUsage: ReturnType<typeof vi.fn>;
  contextWindow: number;
};

function makeSession(): Session {
  const s: Session = {
    prompt: vi.fn().mockResolvedValue('| yes | no'),
    clone: vi.fn(),
    destroy: vi.fn(),
    // 1 token per 4 chars.
    measureContextUsage: vi.fn((input: unknown) =>
      Promise.resolve(typeof input === 'string' ? Math.ceil(input.length / 4) : 10)),
    contextWindow: 6144,
  };
  s.clone.mockImplementation(() => Promise.resolve(makeSession()));
  return s;
}

let LM: {
  availability: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  params: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  LM = {
    availability: vi.fn().mockResolvedValue('available'),
    create: vi.fn(() => Promise.resolve(makeSession())),
    params: vi.fn().mockResolvedValue({ defaultTopK: 3, maxTopK: 8, defaultTemperature: 1, maxTemperature: 2 }),
  };
  (globalThis as Record<string, unknown>).LanguageModel = LM;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).LanguageModel;
});

describe('PromptApiBackend', () => {
  it('reports cached only when Chrome says available', async () => {
    expect(await isPromptApiCached(modelDef)).toBe(true);
    LM.availability.mockResolvedValue('downloadable');
    expect(await isPromptApiCached(modelDef)).toBe(false);
    delete (globalThis as Record<string, unknown>).LanguageModel;
    expect(await isPromptApiCached(modelDef)).toBe(false);
  });

  it('forwards download progress from the create() monitor', async () => {
    LM.create.mockImplementationOnce((opts: { monitor: (m: EventTarget) => void }) => {
      const target = new EventTarget();
      opts.monitor(target);
      target.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.5 }));
      return Promise.resolve(makeSession());
    });
    const onProgress = vi.fn();
    await new PromptApiBackend().initialize(modelDef, onProgress, new AbortController().signal);
    expect(onProgress).toHaveBeenCalledWith({ progress: 0.5, text: '' });
  });

  it('rejects when the device is unsupported', async () => {
    LM.availability.mockResolvedValue('unavailable');
    await expect(new PromptApiBackend().initialize(modelDef, vi.fn(), new AbortController().signal))
      .rejects.toThrow(/unavailable/);
  });

  it('clones a cached base session per call and applies the verdict regex', async () => {
    const backend = new PromptApiBackend();
    await backend.initialize(modelDef, vi.fn(), new AbortController().signal);

    const messages = [
      { role: 'system' as const, content: 'SYS' },
      { role: 'user' as const, content: 'post' },
    ];
    expect(await backend.generate(messages, 64, { verdictCount: 2 })).toBe('| yes | no');
    await backend.generate(messages, 64, { verdictCount: 2 });

    // util session + one base session; the second call reuses the base.
    expect(LM.create).toHaveBeenCalledTimes(2);
    const baseOpts = LM.create.mock.calls[1][0] as { initialPrompts: unknown; topK: number; temperature: number };
    expect(baseOpts.initialPrompts).toEqual([{ role: 'system', content: 'SYS' }]);
    expect(baseOpts.topK).toBe(1);
    expect(baseOpts.temperature).toBe(0);

    const base = await (LM.create.mock.results[1].value as Promise<Session>);
    expect(base.clone).toHaveBeenCalledTimes(2);
    const clone = await (base.clone.mock.results[0].value as Promise<Session>);
    const { responseConstraint } = clone.prompt.mock.calls[0][1] as { responseConstraint: RegExp };
    expect(responseConstraint).toBeInstanceOf(RegExp);
    expect(responseConstraint.test('| yes | no')).toBe(true);
    expect(responseConstraint.test('yes')).toBe(false);
    expect(clone.destroy).toHaveBeenCalled();
  });

  it('falls back to unconstrained prompting when RegExp constraints are unsupported', async () => {
    const backend = new PromptApiBackend();
    await backend.initialize(modelDef, vi.fn(), new AbortController().signal);
    const base = makeSession();
    const clone = makeSession();
    clone.prompt
      .mockRejectedValueOnce(new TypeError('bad constraint'))
      .mockResolvedValueOnce('| no | no');
    base.clone.mockResolvedValue(clone);
    LM.create.mockResolvedValueOnce(base);

    const out = await backend.generate([{ role: 'user', content: 'post' }], 64, { verdictCount: 2 });
    expect(out).toBe('| no | no');
    expect(clone.prompt).toHaveBeenCalledTimes(2);
  });

  it('truncates text against the measured token count', async () => {
    const backend = new PromptApiBackend();
    await backend.initialize(modelDef, vi.fn(), new AbortController().signal);
    const text = 'a'.repeat(400); // 100 tokens at 4 chars/token
    expect(await backend.truncateText(text, 200)).toBe(text);
    const cut = await backend.truncateText(text, 50);
    expect(Math.ceil(cut.length / 4)).toBeLessThanOrEqual(50);
    expect(cut.length).toBeGreaterThan(150);
    expect(await backend.getContextWindow()).toBe(6144);
  });
});
