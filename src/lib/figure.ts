/**
 * A ```figure fence: a text picture as the agent drew it, colored with `{role:text}` markup
 * (Claude Code's prismantis mod draws the same fences in the terminal). The markup takes no
 * columns, so the picture lines up once it is gone. A role this app does not know stays as
 * written, and so does markup that spans lines or nests.
 */
export const FIGURE_ROLES = ["accent", "warn", "ok", "note", "dim", "strong"] as const;
export type FigureRole = (typeof FIGURE_ROLES)[number];
export interface FigureSpan { text: string; role: FigureRole | null }

const MARKUP = new RegExp(`\\{(${FIGURE_ROLES.join("|")}):([^{}\\n]*)\\}`, "g");

export function figureLines(source: string): FigureSpan[][] {
  return source.split("\n").map((line) => {
    const spans: FigureSpan[] = [];
    let at = 0;
    for (const match of line.matchAll(MARKUP)) {
      if (match.index > at) spans.push({ text: line.slice(at, match.index), role: null });
      spans.push({ text: match[2]!, role: match[1] as FigureRole });
      at = match.index + match[0].length;
    }
    if (at < line.length) spans.push({ text: line.slice(at), role: null });
    return spans;
  });
}

/** The picture without its markup: what a copy takes. */
export function figureText(source: string): string {
  return figureLines(source).map((spans) => spans.map((span) => span.text).join("")).join("\n");
}
