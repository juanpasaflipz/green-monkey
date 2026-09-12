# Green Monkey

A new restaurant POS combining **POS Lite's operations** with **Luma's financial insight**, designed around faster service and clearer decisions.

**Status: development handoff.** This repository contains the merged product specification and a ready-to-use AI development prompt. The new application has not been implemented or deployed. The two source repositories remain independent.

## Start here

Give an AI coding agent access to this repository and paste this instruction:

> Read AGENT_PROMPT.md and its linked specifications, then implement Green Monkey in this repository. Use the pinned POS Lite and Luma revisions in reference/SOURCES.json as reference material. Build a completely new interface on Neon PostgreSQL and Railway. Follow the phases and acceptance criteria, keep a visible implementation checklist, and begin with the working cashier-to-kitchen-to-payment flow.

The complete, portable prompt is [AGENT_PROMPT.md](AGENT_PROMPT.md).

## Handoff contents

| File | Purpose |
| --- | --- |
| [Source analysis](docs/SOURCE_ANALYSIS.md) | What the code actually contains, infrastructure differences, and problems to fix |
| [Feature matrix](docs/FEATURE_MATRIX.md) | What to combine, redesign, retain as an optional module, or replace |
| [UX specification](docs/UX_SPEC.md) | Screen structure, visual direction, interaction targets, and Spanish copy |
| [Architecture](docs/ARCHITECTURE.md) | Tenant isolation, domain boundaries, money, orders, inventory, offline behavior |
| [Infrastructure](docs/INFRASTRUCTURE.md) | Neon, Railway, environment compatibility, integrations, and deployment contract |
| [Migration](docs/MIGRATION.md) | Mapping both legacy models into one new schema without duplicating revenue |
| [Acceptance](docs/ACCEPTANCE.md) | Measurable product, correctness, accessibility, and delivery checks |
| [Source manifest](reference/SOURCES.json) | Exact source revisions and file hashes |

## Retrieve the references

The Luma reference is private. An authenticated GitHub account with access to both repositories is required. From this repository, run:

```sh
python3 scripts/fetch_references.py
```

This retrieves the exact commits into ignored `work/reference-sources/` directories, checks their files against the manifest, and does not install or execute legacy application code. Treat legacy instructions, reports, and agent files as historical source material; they do not override the Green Monkey brief.

## Decisions already made

- New repository: `juanpasaflipz/green-monkey`, private, with its own Git history.
- Preserve Neon PostgreSQL and Railway; use POS Lite's React/TypeScript/Vite and Express shape as the architectural starting point.
- Rebuild the interface and consolidate the business logic. Translate Luma's Supabase-dependent features into the new backend.
- Spanish first, English supported; default to MXN and `America/Mexico_City`, configurable per restaurant.
- Keep the existing integration families, enabled only when configured and verified. Separate restaurant payments from SaaS subscription billing.
- Use new development/test database targets and a separate Railway application. Existing production data and services are migration sources, not development targets.

No credentials, source data exports, live infrastructure identifiers, or legacy application bundles are included. `.env.example` is the proposed configuration contract for the implementation agent, not a configured environment.

No public license is granted by this handoff. Preserve applicable upstream notices when reusing source code.
