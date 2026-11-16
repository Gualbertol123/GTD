import { describe, expect, it } from "vitest";
import { aliasMatch, filterIndex, sections } from "../productTree";

const products = sections.find((s) => s.id === "products")!.roots;

describe("product tree aliases", () => {
  it("finds a family by its Italian name and says which word matched", () => {
    const { hits } = filterIndex(products, "carte", null);
    expect(hits.has("cards")).toBe(true);
    const cards = products.find((r) => r.id === "cards")!;
    expect(aliasMatch(cards, "Carte")).toBe("carte");
  });

  it("gives no alias note when the label itself matches", () => {
    const cards = products.find((r) => r.id === "cards")!;
    expect(aliasMatch(cards, "card")).toBeUndefined();
  });

  it("ignores aliases for queries under three letters", () => {
    expect(filterIndex(products, "fi", null).hits.has("lending.overdraft")).toBe(false);
    expect(filterIndex(products, "fido", null).hits.has("lending.overdraft")).toBe(true);
  });
});
