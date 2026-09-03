## v0.5.3 metric help

Employer view now uses the same accessible information icons as Portfolio view. Hover, focus or click an **i** icon to see a plain-language definition and calculation for the measure. The glossary covers the executive summary, score and drivers, KPIs, funnel, outcomes, value, debt, EWA, stress, ratings, risk, opportunities and separate chat metrics.

Portfolio view retains employer multi-select filtering, metric-definition tooltips, null-safe rankings and scale-aware currency formatting.

# empower-fin Dashboard Portal

Version 0.5.3 / source contract 2.6

The empower-fin Dashboard Portal is the core multi-tenant financial-wellness dashboard. Channel partners are configured inside the portal and can have their own name, logo, colours, users and employer assignments. Optimise is a channel partner configuration; it is not the product name.

## Data sources

The core employer data integration supports the same 10 canonical datasets through:

- HTTPS API pull
- Direct read-only SQL views (PostgreSQL, Microsoft SQL Server, MySQL/MariaDB)
- CSV/XLSX/JSON file import

Core datasets:

1. employers
2. workforce_snapshots
3. employees
4. platform_users
5. journeys
6. debt_accounts
7. policies
8. ratings
9. referrals
10. salary_advances

Chat/voice-of-employee data is intentionally excluded from the core source contract because it is supplied by a separate system.

## Railway deployment

Railway uses the checked-in `railway.json` and Railpack. The deployment runs in three stages:

1. Build: `npm run build`
2. Pre-deploy database schema step: `npm run db:deploy`
3. Start: `npm start`

The web start command no longer runs `prisma db push`. This prevents the application healthcheck from waiting behind a database schema operation.

The current schema is migration-compatible with the earlier pre-live database: newly introduced `updatedAt` fields have database defaults and legacy employee links on cached chat/EWA rows are nullable. New EWA imports still resolve and store the employee relation.

## First deployment variables

Required:

```env
DATABASE_URL=postgresql://...
ADMIN_EMAIL=you@company.com
ADMIN_PASSWORD=choose-a-strong-password
COOKIE_SECURE=true
```

Railway supplies `PORT` automatically.

## External SQL source

Configure from **Administration > Live Data Integration** or environment variables. The source database account must be read-only and expose the 10 canonical views:

```text
v_employers
v_workforce_snapshots
v_employees
v_platform_users
v_journeys
v_debt_accounts
v_policies
v_ratings
v_referrals
v_salary_advances
```

The browser never receives source SQL credentials. The server queries each view using `source_updated_at` incremental windows and passes all rows through the same contract validation and commit path used by API/file imports.

## System email and scheduled reports

Administrators configure outbound email under **Administration > System Email & Scheduled Reports**. The SMTP connection can be saved in the portal or overridden by the `SMTP_*` environment variables documented in `.env.example`. Use **Send test email** before enabling scheduled reporting.

From an employer dashboard, **Schedule report** captures the selected reporting window, site and income filters plus a once/daily/weekly/monthly frequency, send time and timezone. Schedules and delivery logs are stored in PostgreSQL and survive deployments/restarts. Rolling windows are recalculated at send time. Scheduled emails use the employer's channel-partner branding when configured.

See `SCHEDULED_REPORTS.md` for setup and operating details.

## Channel partners

Administrators can create channel partners and configure:

- display name
- logo
- primary colour
- accent colour
- deep/navy colour
- tagline
- assigned users
- assigned employers

Users without a partner use the default empower-fin brand. Users assigned to a partner receive the partner theme after login. A partner-branded login can also use `/login?partner=<partner-slug>`.

## Useful endpoints

```text
GET /health
GET /version
GET /dashboard
GET /admin
GET /users
```

`/version` should report `empower-fin Dashboard Portal`, version `0.5.3`, contract `2.6`, `coreSourceFeeds: 10`, and channel-partner support.

## Optional Docker deployment

A Dockerfile is included at `deploy/Dockerfile`. It is deliberately not at the repository root so Railway uses the Railpack configuration above. For another container platform, build it with `docker build -f deploy/Dockerfile .`. Run `npm run db:deploy` as a release/pre-deploy step before starting the container.
