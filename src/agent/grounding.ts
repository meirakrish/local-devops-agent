/**
 * Deterministic checks of the model's conclusion against the data it was shown: tool
 * output gathered in the investigation loop, and the rules' own issue text. No LLM.
 */

/** Words too common to say anything about whether a sentence came from the data. */
const STOPWORDS = new Set(
  (
    "the and for are was were has have had not but with that this from its it's into than then " +
    "there their they them which while when what who will would can could should may might " +
    "been being also only each any all some more most other such very just due because cause " +
    "caused causing indicates indicate shows show showing seen see per via over under about " +
    // The model's own judgement around a fact: "the limit is 32Mi, which is too low".
    "too low high insufficient enough likely probably current currently still already multiple times several"
  ).split(" "),
);

/** Crude stemming, so "terminated" matches "termination" and "restarts" matches "restart". */
function stem(word: string): string {
  if (/\d/.test(word)) return word;
  if (word.length > 4) return word.replace(/(ations?|ions?|ing|ed|es|s)$/, "");
  return word.length > 3 ? word.replace(/s$/, "") : word;
}

/**
 * Lowercase word tokens. camelCase is split first ("exitCode" -> exit, code), and dots stay
 * inside numbers and versions ("1.36"), so "restarts=27" gives "restart" and "27".
 */
function words(text: string): string[] {
  return (
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? []
  );
}

export function tokens(text: string): string[] {
  return words(text).map(stem);
}

/** Tokens that carry meaning: numbers, and words of 3+ letters that are not stopwords. */
function contentTokens(text: string): string[] {
  const meaningful = words(text).filter((w) => /\d/.test(w) || (w.length >= 3 && !STOPWORDS.has(w)));
  return [...new Set(meaningful.map(stem))];
}

/** Share of a claim's content words that must appear near each other in the data. */
export const SUPPORT_THRESHOLD = 0.5;

/**
 * Text the model's claims are checked against, split into lines. Claims are matched
 * against a few neighbouring lines at a time, not the whole text, because a long tool
 * output contains most common words somewhere.
 */
export class Corpus {
  private readonly windows: Set<string>[];
  private readonly all: Set<string>;
  readonly lower: string;

  constructor(texts: string[], windowLines = 3) {
    const lines = texts.flatMap((t) => t.split("\n")).filter((l) => l.trim() !== "");
    const lineTokens = lines.map((l) => tokens(l));
    this.windows = lineTokens.map((_, i) => new Set(lineTokens.slice(i, i + windowLines).flat()));
    this.all = new Set(lineTokens.flat());
    this.lower = texts.join("\n").toLowerCase();
  }

  get empty(): boolean {
    return this.all.size === 0;
  }

  /** Best share of `text`'s content tokens found within one window of lines (0 to 1). */
  coverage(text: string): number {
    const wanted = contentTokens(text);
    if (wanted.length === 0) return 0;
    let best = 0;
    for (const window of this.windows) {
      best = Math.max(best, wanted.filter((t) => window.has(t)).length / wanted.length);
      if (best === 1) break;
    }
    return best;
  }

  /**
   * Whether a claim quotes or closely paraphrases this text: every number in it appears
   * somewhere (a misread "1000m" or an invented "80%" fails), and at least
   * SUPPORT_THRESHOLD of its content words appear within a few neighbouring lines.
   */
  supports(text: string): boolean {
    const wanted = contentTokens(text);
    if (wanted.length === 0) return false;
    if (wanted.some((t) => /\d/.test(t) && !this.all.has(t))) return false;
    return this.coverage(text) >= SUPPORT_THRESHOLD;
  }

  /**
   * Whether a concrete value (an image, a name, a quantity) appears as a whole word,
   * ignoring case: "web" does not match inside "web-7db8d69f68".
   */
  hasValue(value: string): boolean {
    const escaped = value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w-]|\\w\\.)${escaped}(?![\\w-]|\\.\\w)`).test(this.lower);
  }
}
