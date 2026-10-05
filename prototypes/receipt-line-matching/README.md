# Prototype: receipt line → ingredient matching

Throwaway prototype for the second row of the TypeSafe judgment-assist table in [the feature matrix](../../docs/FEATURE_MATRIX.md). A supplier receipt has already been turned into text lines; each line must become a stock receipt against a catalog ingredient, a new ingredient, or a non-inventory item (fee, deposit, supply).

It is not application code and writes nothing to a database. Getting text off a photo or PDF is out of scope.

## How it works

1. **Shortlist (code).** `src/candidates.ts` expands common supplier abbreviations (QSO → queso, HNA → harina) and ranks catalog ingredients by trigram and token similarity. It keeps the top 8.
2. **Judgment (TypeSafe).** `src/match.ts` sends one request per line. The state holds the supplier's name and what it sells, plus the line's raw text, expanded text, quantity, and unit. One Choice question picks among the 8 candidates, `new_ingredient`, and `not_inventory`.
3. **Routing (code).** Confidence ≥ 0.9 pre-selects the answer on the receiving screen (`prefill`, `suggest_new`, or `suggest_not_inventory`). Anything lower goes to `review` with nothing pre-selected. An operator confirms every line.
4. **Stock quantity (code).** `src/units.ts` reads the pack count (C/24, PQ/20) and content size (20L, 1KG, 360G) from the text and converts the line into the ingredient's stock unit. If it can't, for example avocados bought by the piece but stocked by kg, the operator enters the quantity. The model is never asked for numbers.

The fixtures in `src/fixtures.ts` are fictional: 6 suppliers, a 32-ingredient catalog, and 24 lines. They include abbreviations, brand names (Corona, 1-2-3, Maseca), the same word from two suppliers ("PIERNA" from a poultry supplier and from a butcher), look-alike products (fresh vs canned jalapeño, brown vs standard sugar, corn flour vs tortillas), and non-stock lines (delivery fee, bottle deposit, bleach, discount).

## Run

```sh
npm install
npm run match:dry   # shortlists and conversions only, no API calls
npm run match       # calls TypeSafe; reads TYPESAFE_API_KEY from ../../.env
npm run typecheck
```

A `TYPESAFE_API_KEY` already exported in the shell takes precedence over `.env`. If it holds a placeholder you'll get a 401; run `env -u TYPESAFE_API_KEY npm run match`.

## Results (2026-09-25, SDK 0.6.0, default `jev-latest`)

**Run 1, raw text only:** 22/24 correct. Both misses had low confidence and went to `review`, so nothing wrong was pre-selected:

- "CHILE JALAPEÑO" from the produce supplier: canned jalapeño 0.57, new ingredient 0.42.
- "MASECA 20KG": maíz pozolero 0.50, new 0.35, tortilla de maíz 0.15. The model doesn't recognize the corn-flour brand.
- "QSO FCO" was right but unsure (0.65). The model never saw the abbreviation expansion the shortlist used.

**Run 2, expanded text added to the state:** 24/24 correct.

| Route | Lines | Correct |
| --- | --- | --- |
| prefill | 16 | 16 |
| suggest_new | 1 | 1 |
| suggest_not_inventory | 4 | 4 |
| review | 3 | 3 |

- "QSO FCO" rose to 1.00.
- "CHILE JALAPEÑO" (0.56) and "MASECA" (0.37) flipped to the right answer but are still close to a coin flip. That is noise, not a fix, and review is the right outcome for them.
- Shortlist coverage was 24/24. Unit conversions came out as expected on all 17 matched lines; 1 needs operator entry.
- 21.1k input and 2.6k output tokens across 24 requests. Median latency 176 ms, max 313 ms, with 4 requests at a time.

As with the recipe prototype, these hand-written cases show the approach works but say nothing reliable about accuracy. Before using this for real, run it on actual supplier receipts and set `PREFILL_CONFIDENCE` from those results.

## Known gaps

- **Brands:** brand names are the weak spot. "CORONA" only just made the shortlist, and the model didn't know "MASECA". A per-supplier table remembering past confirmed matches (line text → ingredient) would handle repeat purchases in code before any model call. It is probably the biggest practical win.
- **Supplier context:** the model gets the supplier's name and product kind. POS Lite supplier records may not have a kind; check what exists.
- **Non-inventory lines:** these may belong in expenses. Where they go (expense category, deposit tracking) is a separate decision.
- **Pack parsing:** it covers the patterns in the fixtures. Real receipts will need more formats, such as "24/355ML" or "BTO 25KG".
