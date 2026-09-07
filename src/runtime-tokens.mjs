/**
 * What a token actually computes to in a browser, against what the project's
 * own stylesheets declare.
 *
 * The static check in src/tokens.mjs reads files. That is the right tool for
 * "does DESIGN.md still describe the CSS", and the wrong one for "is something
 * else overriding this token at runtime", because the thing doing the
 * overriding is usually a shared component library whose stylesheet the static
 * scan never reads. Comparing `:root` blocks by hand across two repos, I
 * predicted a shared library was overriding 32 tokens in one app. Measured in
 * a browser it was 0. Every one of the 32 was the same value spelled
 * differently.
 *
 * So this compares through the browser rather than as strings, and only
 * reports a token when the computed value is genuinely a different value from
 * everything the project itself declares.
 */

/**
 * Runs in the page. `list` is [{ name, declared: [string] }].
 *
 * Canonicalisation is the whole trick. The browser prints `rgba(0,0,0,.45)` as
 * `rgba(0, 0, 0, 0.45)` and `300ms` as `0.3s`, so a string comparison reports
 * drift on values that paint identically. Feeding both sides through the same
 * CSS property and reading the computed result back makes the two spellings
 * one string.
 */
export function readTokensInPage(list) {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden";
  document.body.appendChild(probe);

  // Enough properties to cover what a token can hold. A value is canonicalised
  // by the first property that accepts it; if none do, it is compared as a
  // whitespace-normalised string, which is still the same rule on both sides.
  const PROPS = ["color", "width", "transition-duration", "font-weight", "font-family", "box-shadow"];
  const canon = (v) => {
    if (v == null) return null;
    const str = String(v).trim();
    if (!str) return "";
    for (const prop of PROPS) {
      // CSS.supports decides whether the property accepted the value.
      // Inferring that from "the computed value changed" does not work: a
      // value that happens to equal the inherited one changes nothing, falls
      // through every property, and ends up compared as a raw string. That
      // reported #111 against #111111 as an override on a page whose text
      // colour was #111, which is the exact class of false positive this
      // whole check exists to avoid.
      if (!CSS.supports(prop, str)) continue;
      probe.style.setProperty(prop, str);
      const got = getComputedStyle(probe).getPropertyValue(prop);
      probe.style.setProperty(prop, "");
      return prop + ":" + got;
    }
    return "raw:" + str.toLowerCase().replace(/\s+/g, " ");
  };

  const root = getComputedStyle(document.documentElement);
  const out = [];
  for (const t of list) {
    const computed = root.getPropertyValue(t.name).trim();
    const cc = canon(computed);
    const declared = t.declared.map((d) => ({ value: d, canon: canon(d) }));
    out.push({
      name: t.name,
      computed,
      declared,
      // Undefined at :root is not an override. A token declared only inside a
      // component's own scope legitimately computes to nothing on the root.
      unset: computed === "",
      matches: declared.some((d) => d.canon === cc),
    });
  }
  probe.remove();
  return out;
}

/**
 * Split the page's answers into the three things worth saying.
 *
 * `overridden` is the only one that is a finding: the token is defined, and
 * what the browser computed is a different value from every value this project
 * declares for it, so something outside the project won.
 */
export function classify(rows) {
  const overridden = [];
  const unset = [];
  const agreed = [];
  for (const r of rows) {
    if (r.unset) unset.push(r);
    else if (r.matches) agreed.push(r);
    else overridden.push(r);
  }
  return { overridden, unset, agreed };
}
