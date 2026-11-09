/** Decode a plain or single fenced JSON research result; no prose extraction or repair. */
export function researchJson(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return JSON.parse(fenced?.[1] ?? text) as unknown;
}
