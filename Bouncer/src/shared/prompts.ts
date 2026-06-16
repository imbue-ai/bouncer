// System prompts and message builders for API calls

import type { ChatMessage, EvaluationPostData } from '../types';

// System prompt for API models (single post, XML-tagged response with category)
// Used by OpenAI, OpenRouter, and Gemini
export const API_SYSTEM_POST_PROMPT = `Classify the post into one of the given categories or "no match".

Output your reasoning and the best matching category in this format:

<reasoning>one sentence of reasoning</reasoning>
<category>category or "no match"</category>
`;

// Table-yesno prompt ported from imbue-ai/bouncer-evals-and-results
// (src/prompts/table_yesno.py). The model emits one pipe-delimited row of
// `yes`/`no` verdicts — one per category, in the order given. Drastically
// fewer output tokens than a reasoning sentence, which dominates wall-clock
// for a 4B model decoding on consumer WebGPU.
//
// Note: the Python version pairs this with outlines-constrained decoding so
// the FSM rejects any non-conforming output. The LiteRT-LM JS API exposes a
// `enableConstrainedDecoding` flag but we don't wire it yet, so callers must
// parse leniently and fall back to SHOW on a malformed row.
export const TABLE_YESNO_SYSTEM_PROMPT = `You will see a social media post and a list of candidate categories. For each category, decide whether the post matches that category.

Output exactly one row of pipe-delimited verdicts, one per category, in the order they were given. Each verdict is \`yes\` or \`no\`. Output nothing else.

Format example for 3 categories: | no | yes | no
`;

export function buildTableYesnoUserMessage(postText: string, categories: string[], hasImages: boolean): string {
  const mediaDesc = hasImages ? ' (includes images)' : '';
  const categoryList = categories.join(', ');
  return `Post${mediaDesc}: ${postText}\n\nCategories (in order): ${categoryList}\n\nOutput the verdict row:`;
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
