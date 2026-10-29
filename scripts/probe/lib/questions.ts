// Questions sent with the generated probe media, and scorers that compare answers with the
// ground truth baked into that media (see media.ts): the cart total is $50.00 for the first half
// of the video and $45.00 after.

export const OK_PROMPT = "Reply with exactly the word OK.";
export const scoreOk = (answer: string): boolean => /\bok\b/i.test(answer);

export const IMAGE_QUESTION =
  "What order total is shown in this screenshot? Reply with the number only.";
export const scoreImage = (answer: string): boolean => amounts(answer).includes(50);

export const VIDEO_QUESTION =
  "This screen recording shows an order total that changes partway through. " +
  "What is the order total at the start and at the end? " +
  "Reply exactly in the form: start=<amount>, end=<amount>";

export const FRAMES_QUESTION =
  "These are frames from one screen recording, in order, each labelled with its timestamp. " +
  "The order total changes partway through. What is it at the start and at the end? " +
  "Reply exactly in the form: start=<amount>, end=<amount>";

/** True when the answer says the total started at 50 and ended at 45. */
export function scoreTotals(answer: string): boolean {
  const start = /start\s*[=:]\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(answer);
  const end = /end\s*[=:]\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(answer);
  return Number(start?.[1]) === 50 && Number(end?.[1]) === 45;
}

export const SPEECH =
  "Apply the code save ten, and the order total should drop to forty five dollars.";

/** True when a transcript caught the key amount, spoken or as digits. */
export const scoreTranscript = (transcript: string): boolean =>
  /forty[\s-]?five|\b45\b/i.test(transcript);

/** Every number in a string, with currency symbols and thousands separators ignored. */
export function amounts(text: string): number[] {
  return [...text.replace(/,(?=\d{3}\b)/g, "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}
