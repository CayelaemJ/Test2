# Validation Report

**Review date:** 12 August 2026  
**Package:** Optimise dated integration contract v2

## Checks completed

- Strict semantic TypeScript check across all application source files using local declarations for unavailable third-party modules.
- TypeScript syntax/transpile check across 12 source and contract-test files.
- JavaScript syntax check of the dashboard inline script.
- Structural Prisma schema audit: balanced blocks, unique models/enums/fields, valid relation field/reference targets and valid index/unique field references.
- Contract/sample execution through the delivered parser and validator: all 11 CSV sample feeds pass.
- Manual trace of the portal's employer, historical-period, site, income and portfolio query paths.
- Route-order check: all API routes are registered before the listener opens.
- Static safety check for destructive Prisma flags, inconsistent lock files and silent production demo substitution.

## Results

| Check | Result |
|---|---|
| Strict TypeScript semantic check | Pass |
| TypeScript transpile check | Pass — 12 files |
| Dashboard JavaScript syntax | Pass |
| Prisma structural audit | Pass — 27 models, 11 enums, 335 fields |
| Contract and samples | Pass — 11 reports, 11 feeds |
| Route registration order | Pass |
| Destructive `--accept-data-loss` startup | Not present |
| Inconsistent v1 `package-lock.json` | Removed |
| Silent live-to-demo merge | Removed; demo requires `?demo=1` |

## Environment limitation

A full `npm install && npm run build` could not be executed in the review container because the npm registry was unavailable and the required packages were not present in the local cache. The strict check used local declaration stubs, so the target build environment must still generate the real Prisma client and resolve the pinned package ranges.

## Required deployment gate

Run in a normal connected staging environment:

```bash
npm install
npm run build
npm run check:contract
```

Then apply the Prisma schema to a staging PostgreSQL database and execute the reconciliation tests in `MIGRATION_V1_TO_V2.md`. Do not promote until at least three closed months and the current month-to-date view reconcile to source.
