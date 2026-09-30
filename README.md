# Layne's Revel Hourly Sales

Apify Actor that signs into the Layne's Revel portal, runs the
[Hourly Sales report](https://laynes.revelup.com/reports/hourly_sales),
and returns one dataset row per reporting interval for a given start
and end date.

## What the run does

1. Signs in with the supplied Revel credentials (username step, then
   password step).
2. Selects the requested establishment from the location tree, for
   example `42 | Leander`.
3. Opens the report's date-range dropdown and drives the underlying
   `daterangepicker` instance directly, then waits until the report
   header actually displays the requested range.
4. Opens the **Filters** panel and sets:
   - **Employees** → `All (Default)`
   - **Day of the Week** → all checkboxes cleared (every day)
   - **Pos Stations** → `All (Default)`
   - **Online orders** → left on its default
   - **Dining Options** → `All (Default)`
   - **Product Class** → `All`
   - **Inclusions** → whatever the `inclusions` input lists; every
     other inclusion is unticked
5. Clicks **Apply** (skipped when Revel has it disabled because the
   report already matches the form).
6. Switches the view dropdown to **15 Min** and verifies the table
   really rendered quarter-hour buckets before reading it.
7. Exports the report to Excel through the three-dot menu and parses
   every worksheet. If the export is unavailable the Actor falls back
   to scraping the rendered table so the run still produces data.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `url` | `https://laynes.revelup.com/reports/hourly_sales/` | Report to open. |
| `username`, `password` | — | Revel credentials. Marked secret. |
| `establishment` | `Leander` | `Lampasas`, `Leander` or `Marble Falls`. |
| `override_flag` | `false` | When `false`, both dates default to yesterday in US Central Time. |
| `override_startDate`, `override_endDate` | — | `MM/DD/YYYY`. Required when `override_flag` is `true`. |
| `startTime` / `startMeridiem` | `12:00` / `AM` | `HH:MM` 12-hour plus `AM`/`PM`. |
| `endTime` / `endMeridiem` | `11:59` / `PM` | `HH:MM` 12-hour plus `AM`/`PM`. |
| `reportView` | `15 Min` | `Hourly`, `15 Min` or `Grouped`. |
| `inclusions` | `["discounts"]` | Any of `open`, `unpaid`, `irregular`, `discounts`, `service_fees`, `taxes`, `web_orders`, `dining_options`. |
| `supabaseTable` | `""` | Empty skips the Supabase upsert. |

## Output

Each dataset row represents one interval of one worksheet:

```json
{
    "id": "2026-09-01_Leander_All revenue centers_06:00 AM - 06:14 AM",
    "location": "Leander",
    "business_date": "2026-09-01",
    "report_view": "15 Min",
    "revenue_center": "All revenue centers",
    "interval_label": "06:00 AM - 06:14 AM",
    "interval_start": "06:00",
    "interval_end": "06:14",
    "is_total": false,
    "transactions": 35,
    "items": 213,
    "avg_sales_per_check": 22.72,
    "sales": 795.12,
    "sales_percent": 12,
    "raw_data": { "...": "every column from the source report" },
    "extracted_at": "2026-09-02T11:04:12.331Z"
}
```

Rows that Revel emits as report totals rather than intervals keep
`is_total: true` and null interval times.

A `RUN_SUMMARY` record plus step-by-step screenshots
(`REVEL_LOGIN_START`, `REVEL_FILTERS_SELECTED`, `REVEL_REPORT_READY`,
and so on) land in the run's key-value store, which is the fastest way
to diagnose a selector that Revel has changed.

## Supabase

The upsert is optional. Set `supabaseTable` to the destination table
and provide `SUPABASE_SERVICE_ROLE_KEY` (and optionally `SUPABASE_URL`)
as environment variables. The table needs a unique `id` column, since
rows are upserted with `onConflict: 'id'`. Leaving `supabaseTable`
empty skips the write entirely and the dataset is still populated.

## Local development

```bash
npm install
npx playwright install chromium
npm start
```

Pull or push the Actor with the [Apify CLI](https://docs.apify.com/cli):

```bash
apify pull <ActorId>
apify push
```
