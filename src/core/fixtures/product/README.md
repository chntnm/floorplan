# Product page fixtures

**These are synthetic.** They are hand-authored to exercise one parser tier each, not
saved copies of real retailer pages.

PLAN.md §13 originally asked for "saved HTML fixtures from real retailer pages checked
into the repo". Two reasons that is not what is here:

1. Fetching those pages to build fixtures is an outward-facing action against third
   parties, done for the convenience of this repository rather than at a user's request.
2. Checking the result in would commit someone else's markup — thousands of lines of
   minified page furniture — into a repository that is not theirs, where it would also
   be stale within a month.

What is lost is real: a synthetic fixture cannot surprise the parser the way a real page
does, so these prove the tiers work as designed rather than that they work on
`article.com` today. That is a coverage limitation and is stated rather than implied.
The tiers themselves — JSON-LD, microdata, OpenGraph, text — are drawn from the
schema.org vocabulary those retailers publish, so the shapes are real even when the
pages are not.

| File | Tier it exercises |
|------|-------------------|
| `json-ld.html` | schema.org/Product in `application/ld+json`, with `additionalProperty` rows |
| `json-ld-graph.html` | the same, buried in an `@graph` alongside other node types |
| `microdata.html` | inline `itemprop` attributes, no JSON-LD |
| `opengraph.html` | `og:title` and `og:image` only — name and image, no dimensions |
| `spec-table.html` | no structured data at all; the numbers are in a spec table |
| `messy.html` | a broken JSON-LD block followed by a good one, and a unitless number |
