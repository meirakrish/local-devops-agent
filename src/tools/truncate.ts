/**
 * Shortens text to at most `maxChars`, keeping the start and the end and cutting the
 * middle. For logs and describe output the end usually holds the error, so the tail
 * gets the larger share. Cuts happen at line breaks when possible.
 */
export function truncateMiddle(text: string, maxChars: number, headShare = 0.3): string {
  if (text.length <= maxChars) return text;
  const marker = (omitted: number) => `\n... [${omitted} characters truncated] ...\n`;
  const budget = Math.max(0, maxChars - marker(text.length).length);
  let head = text.slice(0, Math.floor(budget * headShare));
  let tail = text.slice(text.length - (budget - head.length));

  // Prefer whole lines: trim the head back to its last newline, the tail forward to its first.
  const headCut = head.lastIndexOf("\n");
  if (headCut > head.length / 2) head = head.slice(0, headCut);
  const tailCut = tail.indexOf("\n");
  if (tailCut !== -1 && tailCut < tail.length / 2) tail = tail.slice(tailCut + 1);

  return `${head}${marker(text.length - head.length - tail.length)}${tail}`;
}
