import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Adapted from durable-pi's cached Markdown renderer; see THIRD_PARTY_NOTICES.md.
const cache = new Map<string, string>();
export function markdown(text: string): string {
  const existing = cache.get(text);
  if (existing !== undefined) return existing;
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }), {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'form', 'input', 'style'],
  }).trim();
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  cache.set(text, html);
  return html;
}
