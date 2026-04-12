// System prompts and message builders for API calls

import type { ChatMessage, EvaluationPostData } from '../types';

// System prompt for local models processing one post at a time
export const LOCAL_SYSTEM_PROMPT = `You filter posts. Classify whether a post matches any of the given filter categories.

Respond with JSON: {"reasoning": "<10-15 words about what the post is about>", "match": "<matched category or null>"}

Be precise in your judgment; only match posts that clearly and directly relate to the filter categories.`;

// System prompt for API models (single post, XML-tagged response with category)
// Used by OpenAI, OpenRouter, and Gemini
export const API_SYSTEM_POST_PROMPT = `Classify the post into one of the given categories or "no match".

Output your reasoning and the best matching category in this format:

<reasoning>one sentence of reasoning</reasoning>
<category>category or "no match"</category>
`;

// Build user message for local models — single post with filter categories
export function buildLocalUserMessage(postText: string, bannedCategories: string[], hasImages: boolean): string {
  const forbiddenList = bannedCategories.join(', ');
  const mediaDesc = hasImages ? ' (includes images)' : '';

  let prompt = `You should make your judgment based ONLY on the following list of filter categories, not the ones in the above examples!\n<filter_categories>${forbiddenList}</filter_categories>`;

  prompt += `\n<post${mediaDesc}>${postText}</post>`;
  return prompt;
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
