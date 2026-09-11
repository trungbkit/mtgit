import { describe, expect, it } from "vitest";
import { addCoAuthor, coAuthorEmails } from "./coauthors";

describe("coAuthorEmails", () => {
  it("finds the addresses already credited, case-insensitively", () => {
    const body = "why\n\nCo-authored-by: Ada L <Ada@Example.com>\nco-authored-by: B <b@e.com>";
    expect([...coAuthorEmails(body)]).toEqual(["ada@example.com", "b@e.com"]);
  });

  it("ignores a trailer with no address", () => {
    expect(coAuthorEmails("Co-authored-by: Nobody").size).toBe(0);
  });

  it("finds nothing in an empty message", () => {
    expect(coAuthorEmails("").size).toBe(0);
  });
});

describe("addCoAuthor", () => {
  it("is the whole body when there was none", () => {
    expect(addCoAuthor("", "Ada", "ada@e.com")).toBe("Co-authored-by: Ada <ada@e.com>");
  });

  it("separates the trailer from prose with a blank line", () => {
    expect(addCoAuthor("why this change", "Ada", "ada@e.com")).toBe(
      "why this change\n\nCo-authored-by: Ada <ada@e.com>",
    );
  });

  /**
   * The rule the separate module exists for: git reads trailers only in the
   * last paragraph, so a blank line here would demote the first trailer to
   * prose and lose the credit.
   */
  it("joins an existing trailer block without a blank line", () => {
    const body = "why\n\nCo-authored-by: B <b@e.com>";
    expect(addCoAuthor(body, "Ada", "ada@e.com")).toBe(
      "why\n\nCo-authored-by: B <b@e.com>\nCo-authored-by: Ada <ada@e.com>",
    );
  });

  it("falls back to the address when the name is blank", () => {
    expect(addCoAuthor("", "", "ada@e.com")).toBe("Co-authored-by: ada@e.com <ada@e.com>");
  });

  it("does not accumulate trailing blank lines", () => {
    expect(addCoAuthor("why\n\n\n", "Ada", "ada@e.com")).toBe("why\n\nCo-authored-by: Ada <ada@e.com>");
  });
});
