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
6. Switches the report to the **15 Min** view, retrying across
   several mechanisms because the dropdown is unreliable — see
   "Switching the view" below. Verifies the table really rendered
   quarter-hour buckets, and that the establishment and date range
   survived, before reading anything.
7. Exports the report as JSON through the three-dot menu
   (`a#exp_json`). Revel posts its export form with `target="_blank"`,
   so the payload arrives either as a download or as a new tab; both
   are handled. If the export is unavailable the Actor falls back to
   scraping the rendered table so the run still produces data.

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

Each dataset row represents one interval of one record set in the
export:

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

Revel's JSON shape is undocumented, so field mapping is best-effort:
`transactions`, `items`, `avg_sales_per_check`, `sales` and
`sales_percent` are matched against a list of known field-name
spellings, and `raw_data` always carries the untouched record. The
interval column is identified by the *shape* of its values rather than
its name, since Revel labels it differently between the export and the
rendered table.

The run's key-value store holds:

- `REVEL_HOURLY_SALES_RAW` — the unmodified JSON payload. Check this
  first if a mapped field comes back `null`; add the real field name to
  `COLUMN_ALIASES` in `src/main.js`.
- `RUN_SUMMARY` — status, the resolved date range, `source`
  (`json-tab`, `json-download` or `rendered-table`), and row counts.
- Step-by-step screenshots (`REVEL_LOGIN_START`,
  `REVEL_FILTERS_SELECTED`, `REVEL_REPORT_READY`, and so on), which are
  the fastest way to diagnose a selector that Revel has changed.

## Switching the view

Worth reading before touching `selectReportView`. This dropdown is
Select2 v3 and it is the flakiest part of the Actor.

**A plain click on an option works only intermittently.** The same
code switched the view successfully in one run and silently failed in
the next. Select2's `mouseup` handler calls `selectHighlighted()`,
which acts on whichever option carries the `select2-highlighted`
class — set by a *separate* `mousemove` handler that filters events by
coordinate. When no highlight is set, `selectHighlighted()` takes a
branch that just closes the list, selecting nothing. Whether a
synthetic click's mousemove survives that filter is a race.

**Checking the control's label proves nothing.** Select2 updates its
own label the instant its value is set, so the label can read
`15 Min View` while Revel still serves hourly data. One run reported
success on that basis and then timed out. Verify by the table's
buckets instead: hourly rows always end at `:59`, so a row ending at
`:14`, `:29` or `:44` is the only real evidence the 15-minute view is
in effect. Test for quarter-hours first, since a quarter-hour table
also contains `:59` rows.

**Do not set the underlying `<select>` directly.** Neither
`select.value = …` nor Select2's own `val` setter with `triggerChange`
notifies Revel. The widget relabels itself, Revel reverts it, and the
report keeps its previous aggregation.

`selectReportView` therefore tries several routes and verifies the
table after each:

1. **Keyboard.** Arrow keys set Select2's highlight and `Enter`
   commits it, running the same handler chain as a real click without
   depending on mousemove filtering.
2. **Report state rewrite.** Revel stores the whole report state as
   percent-encoded JSON in the URL fragment:

   ```
   #{%22aggregate_format%22:%22hours%22,%22show_discounts%22:%221%22,
     %22range_from%22:%2209/01/2026%2000:00:00%22, ...}
   ```

   Rewriting `aggregate_format` and reloading is the only
   deterministic route. It carries the dates and filters along with
   it, so it must run *after* the filters are applied. Reproduce the
   encoding by hand — `encodeURIComponent` would also escape the
   braces, colons and commas Revel leaves literal. The token for each
   view is read from the dropdown's `<option>` values rather than
   hardcoded.
3. **Clicking, retried three times**, with the pointer moved twice to
   force a coordinate change. This is the route that has actually
   worked in production; the retries are what turn a coin flip into
   near-certainty.

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
