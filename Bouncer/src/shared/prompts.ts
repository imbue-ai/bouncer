// System prompts and message builders for API calls

import type { ChatMessage, EvaluationPostData } from '../types';

// System prompt for API models (single post, XML-tagged response with category)
// Used by OpenAI, OpenRouter, and Gemini
export const API_SYSTEM_POST_PROMPT = `Classify the post into one of the given categories or "no match".

Output your reasoning and the best matching category in this format:

<reasoning>one sentence of reasoning</reasoning>
<category>category or "no match"</category>
`;

// System prompt for local models — pipe-delimited yes/no row over
// categories. Ported from imbue-ai/bouncer-evals-and-results' table_yesno.
// The model emits one verdict per category in the order given.
//
// Known weakness on Gemma 4 IT at 4B: the pipe character has a strong
// markdown-table prior in the training distribution, so the model
// occasionally drifts into `| Category | Verdict | \n|---|` form. The
// parser below (`parseTableYesnoResponse`) tolerates this drift by
// surfacing a malformed-row reasoning and falling back to SHOW (no
// false-positive hides). For a hard guarantee, see the LiteRT-LM
// LlGuidance regex constraint wired through `iosLocalClassify` — when
// enabled, the FSM rejects any token outside the regex's language
// during decode.
//
// Note: the Python eval pipeline pairs this same prompt with outlines-
// constrained decoding so the FSM rejects any non-conforming output.
export const LOCAL_SYSTEM_PROMPT = `You will see a social media post and a list of candidate categories. For each category, decide whether the post matches that category.

Output exactly one row of pipe-delimited verdicts, one per category, in the order they were given. Each verdict is \`yes\` or \`no\`. Output nothing else.

Format example for 3 categories: | no | yes | no
`;

// User-message builder for local models (both desktop LiteRT-LM-via-WebGPU and
// iOS LiteRT-LM-via-Metal). Categories live in the user message so the system
// prompt above stays a single immutable string. The iOS side prefix-caches a
// base Conversation keyed on that bare system string and `.clone()`s it per
// post; the categories are re-prefilled per post as part of the user message
// (~30-50 tokens — small compared to the ~120-token system prompt that stays
// cached).
export function buildTableYesnoUserMessage(postText: string, categories: string[], hasImages: boolean): string {
  const mediaDesc = hasImages ? ' (includes images)' : '';
  const categoryList = categories.join(', ');
  return `Post${mediaDesc}: ${postText}\n\nCategories (in order): ${categoryList}\n\nOutput the verdict row:`;
}

// Gemma export quirks: leaked turn-template markers leak into the generated
// text in different ways across the model variants Bouncer runs:
//   - Gemma 4 IT (iOS .litertlm) emits `<turn|>` as end-of-turn; the runtime's
//     stop_tokens list only includes <eos> so the marker reaches the JS side.
//     The matching `<|turn>` open form is also stripped in case templating
//     round-trips it.
//   - Gemma 4 web (desktop .litertlm) leaks `<start_of_turn>` / `<end_of_turn>`
//     and occasionally `<eos>` / `<bos>` / `<pad>` in raw text.
// Normalize all of them to newlines (turn markers) or empty (special tokens)
// before the row-parser sees the text.
function stripGemmaMarkers(raw: string): string {
  return (raw ?? '')
    .replace(/<\|?turn\|?>/g, '\n')
    .replace(/<\|?(?:start|end)_of_turn\|?>/g, '\n')
    .replace(/<(?:eos|bos|pad)>/gi, '')
    .trim();
}

// Parse the table_yesno verdict row produced by the local model.
// `matches` is the list of categories that received a `yes` verdict (in order);
// the caller decides how to render them — typically joined with `, ` so the
// View-Filtered popup can show one badge per match.
//
// Primary shape (what LOCAL_SYSTEM_PROMPT asks for):
//   `| yes | no | yes |`  — one pipe-delimited row, one cell per category.
//
// Also tolerated, in this precedence order:
//   `no\nyes\nno` — newline-per-verdict (first scan: lines starting with
//                   yes/no), useful when the model emits one verdict per
//                   line despite the prompt asking for a pipe row.
//   `yes|no|yes`, `| yes | no` — missing leading or trailing pipe.
//   `Verdict: | yes | no` — junk preamble cells dropped if they don't look
//                           like `yes`/`no` and there's enough overflow.
//   bare `yes` / `no` for single-category packs (with optional filler text).
//   markdown-table headers like `| Category | Verdict |\n|---|` — fails to
//     parse and surfaces a malformed-row reasoning so callers fall back to
//     "show post" (no false-positive hides on parse failures).
export function parseTableYesnoResponse(
  rawResponse: string | null,
  categories: string[],
): { shouldHide: boolean; reasoning: string; matches: string[] } {
  if (!rawResponse) {
    return { shouldHide: false, reasoning: 'Empty model response — model returned no output', matches: [] };
  }
  const cleaned = stripGemmaMarkers(rawResponse);
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);

  const verdictFrom = (s: string): 'yes' | 'no' | null => {
    const m = s.match(/^(yes|no)\b/i);
    return m ? (m[1].toLowerCase() as 'yes' | 'no') : null;
  };
  const isVerdict = (s: string): boolean => verdictFrom(s) !== null;

  // Primary path: newline-per-verdict. Take the first N consecutive lines
  // (after any leading non-verdict preamble) where each begins with yes/no.
  let parts: string[] | null = null;
  const verdictLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (verdictFrom(lines[i]) !== null) verdictLineIndices.push(i);
  }
  if (verdictLineIndices.length >= categories.length) {
    // Use the first N verdict-starting lines (ignoring any garbage in between
    // or after, e.g. a trailing "Output the verdict row:" echo).
    parts = verdictLineIndices.slice(0, categories.length)
      .map(i => verdictFrom(lines[i])!);
  } else {
    // Fallback: pipe-delimited row (legacy / drift shape). Pick the first
    // line containing a `|` so a stray preamble line doesn't poison parsing.
    const rowLine = lines.find(l => l.includes('|'));
    if (rowLine) {
      let cells = rowLine.split('|').map(s => s.trim());
      while (cells.length > 0 && cells[0] === '') cells.shift();
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      // Some checkpoints prepend a few words before the first `|`. If we have
      // more cells than expected AND the overflow cells aren't valid verdicts,
      // treat them as preamble and drop them.
      if (cells.length > categories.length && !isVerdict(cells[0])) {
        const overflow = cells.length - categories.length;
        if (cells.slice(0, overflow).every(c => !isVerdict(c))) {
          cells = cells.slice(overflow);
        }
      }
      parts = cells;
    } else if (categories.length === 1) {
      // Single-category packs: model often emits a bare `yes`/`no` with
      // optional filler text. Use the first verdict-starting line.
      const v = lines.map(verdictFrom).find(x => x !== null);
      if (v) parts = [v];
    }
  }

  if (!parts) {
    return { shouldHide: false, reasoning: `Malformed verdict row (no verdict lines found): ${rawResponse}`, matches: [] };
  }

  if (parts.length !== categories.length) {
    return {
      shouldHide: false,
      reasoning: `Malformed verdict row (expected ${categories.length} verdicts, got ${parts.length}): ${rawResponse}`,
      matches: [],
    };
  }
  const matches: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const v = parts[i].toLowerCase();
    if (v !== 'yes' && v !== 'no') {
      return {
        shouldHide: false,
        reasoning: `Malformed verdict row (verdict ${i} = ${JSON.stringify(parts[i])}): ${rawResponse}`,
        matches: [],
      };
    }
    if (v === 'yes') matches.push(categories[i]);
  }
  const shouldHide = matches.length > 0;
  const reasoning = shouldHide
    ? `${rawResponse} (Matched: ${matches.join(', ')})`
    : rawResponse;
  return { shouldHide, reasoning, matches };
}

// Build messages array for API models (used by direct API backends)
// Single post with images and category-based classification
export function buildAPIMessages(postData: EvaluationPostData, bannedCategories: string[], systemPrompt = API_SYSTEM_POST_PROMPT): ChatMessage[] {
  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  const categoryList = bannedCategories.map(cat => `"${cat}"`).join(', ');

  userContent.push({
    type: 'text',
    text: `The categories are: ${categoryList}.\n\nClassify this post:\n`
  });

  userContent.push({ type: 'text', text: `\n${postData.text}` });

  if (postData.imageUrls && postData.imageUrls.length > 0) {
    for (const imageUrl of postData.imageUrls) {
      userContent.push({ type: 'image_url', image_url: { url: imageUrl } });
    }
  }

  userContent.push({
    type: 'text',
    text: '\nClassify the post. Output the best matching category or "no match".'
  });

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];
}
