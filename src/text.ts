export function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  return /(?:s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`;
}
