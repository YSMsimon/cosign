// Shared by the voice endpoint (stays quiet on a pause) and the call screen (does not wait for an answer to one).

/**
 * Is this a pause, not a turn? ElevenLabs sends "..." when the person goes quiet, and sometimes a fragment when they
 * pause mid-sentence ("Uh-", "Um...", "Can you-"): answering cuts them off, so we stay quiet and let them finish.
 */
export function stillTalking(text: string): boolean {
  const t = text.trim();
  if (/^[\s.…]*$/.test(t)) return true;
  const words = t.toLowerCase().replace(/[.…,!?]/g, " ").split(/\s+/).filter(Boolean);
  if (words.every((w) => /^(uh+|um+|hmm+|mm+|er+|ah+|eh|oh|so|and|but|like|well)-?$/.test(w))) return true;
  return /-$/.test(t) && words.length <= 3; // cut off after a word or two
}
