# Prototype: recipe ↔ menu item matching

Throwaway prototype for the first row of the TypeSafe judgment-assist table in [the feature matrix](../../docs/FEATURE_MATRIX.md). It covers MIGRATION step 6: Luma recipes link to dishes only by name, and each link must be reviewed before it becomes a stable ID.

It is not application code and writes nothing to a database.

## How it works

1. **Shortlist (code).** `src/candidates.ts` ranks menu items against the recipe by name trigrams, name tokens, and ingredient overlap, and keeps the top 6. TypeSafe can only pick from this list, so coverage is reported separately.
2. **Judgment (TypeSafe).** `src/match.ts` sends one request per recipe: the recipe name and ingredients as state, and one Choice question whose options are the 6 candidates plus `none` (prep component or not on the menu).
3. **Routing (code).** Confidence ≥ 0.9 pre-selects the answer on the review screen (`prefill` or `suggest_no_match`); anything lower goes to `review` with nothing pre-selected. In every case an operator confirms before a link is saved.

The fixtures in `src/fixtures.ts` are a fictional Mexican menu (22 items) and 20 legacy recipes. They include typos, synonyms (sopa azteca), an English name, portion sizes, look-alike dishes, and prep components that should match nothing.

## Run

```sh
npm install
npm run match:dry   # shortlists only, no API calls
npm run match       # calls TypeSafe; reads TYPESAFE_API_KEY from ../../.env
npm run typecheck
```

A `TYPESAFE_API_KEY` already exported in the shell takes precedence over `.env`. If it holds a placeholder you'll get a 401; run `env -u TYPESAFE_API_KEY npm run match`.

Full answers, probabilities, and request IDs go to `out/results.json` (ignored by Git).

## First run (2026-09-25, SDK 0.6.0, default `jev-latest`)

| Route | Recipes | Correct |
| --- | --- | --- |
| prefill | 15 | 15 |
| suggest_no_match | 3 | 3 |
| review | 2 | 2 |

- Shortlist coverage was 20/20.
- The two `review` cases are the hardest ones in the fixture set. "Pozole" gave 0.91 to grande and 0.07 to chico, and the size could only be told from quantities. "Bistec marinado" gave 0.83 to none and 0.17 to tacos de bistec; it is a prep component.
- 21.4k input and 1.6k output tokens across 20 requests. Median latency 183 ms, max 322 ms, with 4 requests at a time.

These 20 cases were written for this test, so they show the approach works but say nothing reliable about accuracy. Before using this for real, run it on actual Luma/POS Lite recipe exports and set `PREFILL_CONFIDENCE` from those results.

## Known gaps

- **One recipe, several items:** a recipe that serves several variants (both pozole sizes) gets only one link. The domain model needs to decide whether a recipe version may link to several items.
- **Shortlist on real menus:** real menus have about 300 items. Check coverage there. The number of options can go up to 255, so a whole category can be sent when the shortlist misses.
- **Ingredient units:** unit normalization is not part of matching; it stays in the recipe import.
