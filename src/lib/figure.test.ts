import { describe, expect, it } from "bun:test";
import { figureLines, figureText } from "./figure.ts";

describe("figure fences", () => {
  it("colors known roles and drops their markup, so the columns line up", () => {
    expect(figureLines(" {accent:request}──►{strong:Jarvis}")).toEqual([[
      { text: " ", role: null }, { text: "request", role: "accent" }, { text: "──►", role: null }, { text: "Jarvis", role: "strong" },
    ]]);
    expect(figureText("{ok:a}│\n{dim:bb}│")).toBe("a│\nbb│");
  });
  it("keeps an unknown role, nesting and a brace across lines as written", () => {
    expect(figureText("{loud:x} {ok:{dim:y}} {ok:z")).toBe("{loud:x} {ok:y} {ok:z");
    expect(figureLines("{note:a\nb}")).toEqual([[{ text: "{note:a", role: null }], [{ text: "b}", role: null }]]);
  });
});
