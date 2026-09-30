import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import * as XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';

await Actor.init();

const supabaseUrl =
    process.env.SUPABASE_URL
    || 'https://ongqhvokcwceqgnetonq.supabase.co';

const supabaseServiceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = supabaseServiceRoleKey
    ? createClient(
        supabaseUrl,
        supabaseServiceRoleKey,
        {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
            },
        },
    )
    : null;

const CENTRAL_TIME_ZONE = 'America/Chicago';

/**
 * Establishment codes prefix the names in Revel's location tree,
 * for example "42 | Leander".
 */
const ESTABLISHMENT_CODES = {
    Lampasas: '41',
    Leander: '42',
    'Marble Falls': '29',
};

/**
 * Options offered by the report's aggregation dropdown.
 */
const REPORT_VIEWS = ['Hourly', '15 Min', 'Grouped'];

/**
 * Inclusion keys accepted by the Actor input mapped to the label
 * text Revel renders next to each Inclusions checkbox. Labels are
 * matched as a case-insensitive substring so Revel can extend the
 * wording without breaking the run.
 */
const INCLUSION_LABELS = {
    open: 'Open',
    unpaid: 'Unpaid',
    irregular: 'Irregular',
    discounts: 'Discounts',
    service_fees: 'Service Fee',
    taxes: 'Taxes',
    web_orders: 'Web Orders',
    dining_options: 'Dining Opt',
};

/**
 * Report columns mapped to the header spellings Revel has used in
 * its Hourly Sales export. Matching is case-insensitive.
 */
const COLUMN_ALIASES = {
    transactions: ['# transactions', 'transactions'],
    items: ['# items', 'items'],
    avg_sales_per_check: [
        'avg. sales/check',
        'avg sales/check',
        'average sales/check',
    ],
    sales: ['sales', 'net sales'],
    sales_percent: ['% sales', 'sales %', '% of sales'],
};

/**
 * Capture a screenshot and save it in the run's
 * default key-value store.
 */
async function saveScreenshot(page, key) {
    const screenshot = await page.screenshot({
        fullPage: true,
    });

    await Actor.setValue(key, screenshot, {
        contentType: 'image/png',
    });

    log.info(`Saved screenshot: ${key}`);
}

function validateDate(value, fieldName) {
    const datePattern =
        /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/\d{4}$/;

    if (!datePattern.test(value)) {
        throw new Error(
            `${fieldName} must use MM/DD/YYYY format. `
            + `Received: ${value}`,
        );
    }
}

function validateTime(value, fieldName) {
    const timePattern = /^(0?[1-9]|1[0-2]):[0-5]\d$/;

    if (!timePattern.test(value)) {
        throw new Error(
            `${fieldName} must use HH:MM 12-hour format. `
            + `Received: ${value}`,
        );
    }
}

function normalizeMeridiem(value, fieldName) {
    const meridiem = String(value ?? '').trim().toUpperCase();

    if (meridiem !== 'AM' && meridiem !== 'PM') {
        throw new Error(
            `${fieldName} must be AM or PM. Received: ${value}`,
        );
    }

    return meridiem;
}

/**
 * Calendar date for a moment in US Central Time.
 */
function getCentralDateParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CENTRAL_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);

    const lookup = Object.fromEntries(
        parts
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, Number(part.value)]),
    );

    return {
        year: lookup.year,
        month: lookup.month,
        day: lookup.day,
    };
}

function formatDateParts({ year, month, day }) {
    const monthText = String(month).padStart(2, '0');
    const dayText = String(day).padStart(2, '0');

    return `${monthText}/${dayText}/${year}`;
}

/**
 * Yesterday in US Central Time, MM/DD/YYYY. Hourly Sales defaults
 * to a single completed business day.
 */
function calculateDefaultDate(today = new Date()) {
    const { year, month, day } = getCentralDateParts(today);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));

    calendarDate.setUTCDate(calendarDate.getUTCDate() - 1);

    return formatDateParts({
        year: calendarDate.getUTCFullYear(),
        month: calendarDate.getUTCMonth() + 1,
        day: calendarDate.getUTCDate(),
    });
}

/**
 * Convert MM/DD/YYYY into YYYY-MM-DD.
 */
function toIsoDate(value) {
    const [month, day, year] = value.split('/');

    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Turn Revel's display values ("$1,234.56", "12%", "-") into
 * numbers. Anything that is not numeric becomes null.
 */
function toNumber(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (value === null || value === undefined) return null;

    const text = String(value).replace(/[$%,\s]/g, '');

    if (text === '' || text === '-') return null;

    const parsed = Number(text);

    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Split "06:00 AM - 06:14 AM" into 24-hour start and end times.
 * Returns null for rows that are not intervals, such as totals.
 */
function parseIntervalLabel(label) {
    const match = String(label ?? '').match(
        /(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i,
    );

    if (!match) return null;

    const to24Hour = (hour, minute, meridiem) => {
        const base = Number(hour) % 12;
        const shifted = meridiem.toUpperCase() === 'PM'
            ? base + 12
            : base;

        return `${String(shifted).padStart(2, '0')}:${minute}`;
    };

    return {
        start: to24Hour(match[1], match[2], match[3]),
        end: to24Hour(match[4], match[5], match[6]),
    };
}

function findColumnValue(record, aliases) {
    const entry = Object.entries(record).find(
        ([header]) => aliases.includes(
            String(header).trim().toLowerCase(),
        ),
    );

    return entry ? entry[1] : null;
}

/**
 * Read a worksheet as a header row plus one record per data row.
 * Blank leading headers become positional names so the interval
 * column, which Revel exports unlabelled, still has a key.
 */
function worksheetToRecords(worksheet) {
    const grid = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: null,
        raw: true,
        blankrows: false,
    });

    if (grid.length < 2) {
        return { headers: [], records: [] };
    }

    const headers = (grid[0] ?? []).map((header, index) => {
        const text = header === null || header === undefined
            ? ''
            : String(header).trim();

        if (text !== '') return text;

        return index === 0 ? 'Interval' : `Column ${index + 1}`;
    });

    const records = grid
        .slice(1)
        .filter((row) => row.some(
            (cell) => cell !== null && String(cell).trim() !== '',
        ))
        .map((row) => Object.fromEntries(
            headers.map((header, index) => [
                header,
                row[index] ?? null,
            ]),
        ));

    return { headers, records };
}

/**
 * Flatten every worksheet of the export into dataset rows keyed by
 * establishment, business date and interval.
 */
function buildIntervalRows({
    sheets,
    location,
    businessDate,
    reportView,
}) {
    const rows = [];

    for (const [sheetName, { headers, records }] of Object.entries(sheets)) {
        const intervalHeader = headers[0];

        for (const record of records) {
            const intervalLabel = intervalHeader
                ? String(record[intervalHeader] ?? '').trim()
                : '';

            const interval = parseIntervalLabel(intervalLabel);

            rows.push({
                id: `${businessDate}_${location}_${sheetName}`
                    + `_${intervalLabel || 'total'}`,
                location,
                business_date: businessDate,
                report_view: reportView,
                revenue_center: sheetName,

                interval_label: intervalLabel,
                interval_start: interval?.start ?? null,
                interval_end: interval?.end ?? null,
                is_total: interval === null,

                transactions: toNumber(
                    findColumnValue(record, COLUMN_ALIASES.transactions),
                ),
                items: toNumber(
                    findColumnValue(record, COLUMN_ALIASES.items),
                ),
                avg_sales_per_check: toNumber(
                    findColumnValue(
                        record,
                        COLUMN_ALIASES.avg_sales_per_check,
                    ),
                ),
                sales: toNumber(
                    findColumnValue(record, COLUMN_ALIASES.sales),
                ),
                sales_percent: toNumber(
                    findColumnValue(record, COLUMN_ALIASES.sales_percent),
                ),

                // Preserve every column from the source report.
                raw_data: record,

                extracted_at: new Date().toISOString(),
            });
        }
    }

    return rows;
}

/**
 * Wait until Revel has no visible loading indicator left inside the
 * report area. Hidden loaders stay in the DOM permanently, so this
 * checks visibility instead of waiting for detachment.
 */
async function waitForReportToSettle(page) {
    await page.waitForFunction(
        () => {
            const reportArea =
                document.querySelector('.report-content')
                ?? document.querySelector('.report-container')
                ?? document.querySelector('.reports-content')
                ?? document.body;

            const loadingElements = reportArea.querySelectorAll([
                '.loading',
                '.loader',
                '.spinner',
                '.loading-mask',
                '.blockUI',
                '.fa-spinner',
                '.icon-spinner',
                '[class*="loading-indicator"]',
            ].join(','));

            return [...loadingElements].every((element) => {
                const style = window.getComputedStyle(element);
                const bounds = element.getBoundingClientRect();

                return (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || style.opacity === '0'
                    || bounds.width === 0
                    || bounds.height === 0
                );
            });
        },
        undefined,
        {
            timeout: 90_000,
            polling: 500,
        },
    );

    /*
     * Give computed totals and charts a brief opportunity to settle
     * after the loading indicator disappears.
     */
    await page.waitForTimeout(1_500);
}

/**
 * The Filters panel. Its wrapper collapses to zero height because
 * the panel is absolutely positioned, so Playwright reads the
 * wrapper as hidden even while the panel is on screen. The form
 * that owns `ul.form-wrapper` is the anchor that actually has a
 * bounding box.
 */
function filterForm(page) {
    return page.locator('form:has(ul.form-wrapper)').first();
}

/**
 * Locate one column of the Filters panel. Revel gives most columns
 * a class, but not all of them (Inclusions has a bare `li`), so the
 * heading text is the fallback.
 */
function filterSection(page, className, heading) {
    return filterForm(page)
        .locator(
            `ul.form-wrapper > li.${className}, `
            + `ul.form-wrapper > li:has(div.heading:text-is("${heading}"))`,
        )
        .first();
}

/**
 * Resolve a Filters column, failing loudly rather than silently
 * leaving the report on whatever Revel had saved for the account.
 */
async function requireSection(page, className, heading) {
    const section = filterSection(page, className, heading);

    if (await section.count() === 0) {
        throw new Error(
            `The "${heading}" column was not found in the Filters `
            + 'panel. Revel may have changed its markup.',
        );
    }

    return section;
}

function filtersToggle(page) {
    return page
        .getByText('Filters', { exact: true })
        .locator('visible=true')
        .first();
}

async function openFilterPanel(page) {
    const form = filterForm(page);

    if (!await form.isVisible().catch(() => false)) {
        const toggle = filtersToggle(page);

        await toggle.waitFor({
            state: 'visible',
            timeout: 20_000,
        });

        await toggle.click();

        await form.waitFor({
            state: 'visible',
            timeout: 20_000,
        });
    }

    /*
     * Log the columns Revel rendered. When a selector drifts, this
     * line shows exactly what the panel looked like at the time.
     */
    const headings = await form
        .locator('ul.form-wrapper > li div.heading')
        .allInnerTexts();

    log.info(
        `Filters panel open with columns: `
        + `${headings.map((text) => text.trim()).join(', ')}`,
    );
}

/**
 * Revel hides the native inputs and styles a sibling span, so the
 * label is the clickable surface.
 */
async function setControl(inputLocator, shouldBeChecked) {
    const isChecked = await inputLocator.isChecked();

    if (isChecked === shouldBeChecked) return false;

    await inputLocator
        .locator('xpath=ancestor::label[1]')
        .click();

    return true;
}

/**
 * Select the "All (Default)" radio of a Filters column.
 */
async function selectAllRadio(page, className, heading, inputName) {
    const section = await requireSection(page, className, heading);

    const allRadio = section
        .locator(`input[type="radio"][name="${inputName}"][value=""]`)
        .first();

    if (await allRadio.count() === 0) {
        throw new Error(
            `The "${heading}" column has no `
            + `"${inputName}" default radio to select.`,
        );
    }

    const changed = await setControl(allRadio, true);

    log.info(
        `"${heading}" set to All (Default).`
        + `${changed ? ' Selection changed.' : ''}`,
    );

    return changed;
}

/**
 * Clear every Day of the Week checkbox, which makes Revel report on
 * all days.
 */
async function clearDayOfWeek(page) {
    const section = await requireSection(
        page,
        'day-of-week',
        'Day of the Week',
    );

    const checkboxes = section.locator('input[type="checkbox"]');
    const total = await checkboxes.count();

    let changed = false;

    for (let index = 0; index < total; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        const didChange = await setControl(
            checkboxes.nth(index),
            false,
        );

        changed = changed || didChange;
    }

    log.info(
        `"Day of the Week" cleared (${total} checkboxes).`
        + `${changed ? ' Selection changed.' : ''}`,
    );

    return changed;
}

/**
 * Tick the "All" root node of a Fancytree column such as Product
 * Class. A selected root renders the ico-f-checked-filled glyph.
 */
async function selectAllTreeNodes(page, className, heading) {
    const section = await requireSection(page, className, heading);

    const rootNode = section
        .locator('.controls-tree span.fancytree-node')
        .first();

    if (await rootNode.count() === 0) {
        throw new Error(
            `The "${heading}" column has no tree to select.`,
        );
    }

    const checkbox = rootNode
        .locator('span.fancytree-checkbox')
        .first();

    const glyph = await checkbox.getAttribute('class') ?? '';

    if (glyph.includes('ico-f-checked-filled')) {
        log.info(`"${heading}" already has All selected.`);

        return false;
    }

    await checkbox.click();

    log.info(`"${heading}" set to All.`);

    return true;
}

/**
 * Apply the requested Inclusions and untick the rest.
 */
async function applyInclusions(page, inclusions) {
    const section = await requireSection(
        page,
        'inclusions',
        'Inclusions',
    );

    const requested = new Set(inclusions);

    let changed = false;

    for (const [key, label] of Object.entries(INCLUSION_LABELS)) {
        const checkbox = section
            .locator('label')
            .filter({ hasText: label })
            .first()
            .locator('input[type="checkbox"]');

        // eslint-disable-next-line no-await-in-loop
        if (await checkbox.count() === 0) {
            log.warning(`Inclusion "${label}" was not found.`);

            // eslint-disable-next-line no-continue
            continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const didChange = await setControl(
            checkbox,
            requested.has(key),
        );

        changed = changed || didChange;
    }

    log.info(
        `Inclusions set to: ${inclusions.join(', ') || 'none'}.`
        + `${changed ? ' Selection changed.' : ''}`,
    );

    return changed;
}

async function isApplyEnabled(applyButton) {
    const classes = await applyButton.getAttribute('class') ?? '';

    return !classes.includes('disabled');
}

/**
 * Revel enables Apply from its own change handlers, which can land
 * after our click has already returned. Poll instead of reading the
 * class once, so a slow handler cannot make the run skip the click
 * and silently report on the previous filters.
 */
async function waitForApplyEnabled(applyButton, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        if (await isApplyEnabled(applyButton)) return true;

        // eslint-disable-next-line no-await-in-loop
        await applyButton.page().waitForTimeout(250);
    }

    return false;
}

/**
 * Commit the Filters panel. Revel keeps Apply disabled while the
 * form still matches the applied report, so a run that needed no
 * changes closes the panel instead of clicking a dead button.
 */
async function applyFilters(page, expectChanges) {
    const applyButton = filterForm(page)
        .locator('.actions .button-update')
        .first();

    await applyButton.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    const canApply = expectChanges
        ? await waitForApplyEnabled(applyButton)
        : await isApplyEnabled(applyButton);

    if (canApply) {
        log.info('Applying the Filters panel selections.');

        await applyButton.click();
    } else {
        if (expectChanges) {
            log.warning(
                'Filter selections changed but Revel left Apply '
                + 'disabled. Closing the panel without applying.',
            );
        } else {
            log.info(
                'No filter changes were needed and Apply is '
                + 'disabled. Closing the Filters panel.',
            );
        }

        await filtersToggle(page).click();
    }

    await filterForm(page)
        .waitFor({
            state: 'hidden',
            timeout: 30_000,
        })
        .catch(() => {
            log.warning(
                'The Filters panel stayed open after Apply.',
            );
        });

    await waitForReportToSettle(page);
}

const escapeRegExp = (value) => value.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
);

/**
 * The report's aggregation dropdown, rendered with Select2 v3. Revel
 * labels it with the active aggregation plus a "View" suffix, for
 * example "Hourly View" or "15 Min View". Matching on "View" keeps
 * this away from the Select2 widgets inside the Filters panel.
 */
function reportViewControl(page) {
    return page
        .locator('.select2-container a.select2-choice:visible')
        .filter({ hasText: /view/i })
        .first();
}

/**
 * Revel re-renders the control while the report reloads, so a read
 * can land on a detached node. Treat that as "unknown" rather than
 * letting it abort the caller's polling loop.
 */
async function readReportView(page) {
    try {
        return (await reportViewControl(page).innerText()).trim();
    } catch {
        return '';
    }
}

const matchesView = (label, viewLabel) => label
    .toLowerCase()
    .startsWith(viewLabel.toLowerCase());

/**
 * Work out which buckets the rendered table uses. Hourly rows end at
 * :59, so a row ending at :14, :29 or :44 is the only reliable
 * signal that the 15-minute view is really in effect. Quarter-hour
 * tables also contain :59 rows, so that test has to come first.
 */
async function readReportGranularity(page) {
    return page.evaluate(() => {
        const text = document.body.innerText;

        if (/\d{1,2}:(14|29|44)\s*(AM|PM)/i.test(text)) return 'quarter';
        if (/\d{1,2}:59\s*(AM|PM)/i.test(text)) return 'hourly';

        return 'unknown';
    });
}

const VIEW_GRANULARITY = {
    Hourly: 'hourly',
    '15 Min': 'quarter',
};

/**
 * A view is only applied when the control agrees *and* the table is
 * bucketed accordingly. The label alone proves nothing: Select2
 * relabels itself the moment its value is set, even when Revel never
 * reloads the report.
 */
async function waitForReportView(page, viewLabel, timeoutMs) {
    const expected = VIEW_GRANULARITY[viewLabel] ?? null;
    const deadline = Date.now() + timeoutMs;

    let label = '';
    let granularity = 'unknown';

    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        label = await readReportView(page);
        // eslint-disable-next-line no-await-in-loop
        granularity = await readReportGranularity(page).catch(
            () => 'unknown',
        );

        const labelAgrees = matchesView(label, viewLabel);
        const tableAgrees = !expected || granularity === expected;

        if (labelAgrees && tableAgrees) return true;

        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(500);
    }

    log.warning(
        `Report view not confirmed: the control reads "${label}" `
        + `and the table is bucketed "${granularity}" `
        + `(wanted "${viewLabel}"/"${expected ?? 'any'}").`,
    );

    return false;
}

/**
 * Revel keeps the entire report state in the URL fragment as JSON
 * with only its quotes and spaces percent-encoded:
 *
 *   #{%22aggregate_format%22:%22hours%22,%22show_discounts%22:%221%22,
 *     %22range_from%22:%2209/01/2026%2000:00:00%22, ...}
 *
 * encodeURIComponent would also escape the braces, colons and commas
 * that Revel leaves literal, so the encoding is reproduced by hand.
 */
const encodeReportState = (state) => JSON.stringify(state)
    .replace(/"/g, '%22')
    .replace(/ /g, '%20');

async function readReportState(page) {
    return page.evaluate(() => {
        const raw = window.location.hash.replace(/^#/, '');

        if (!raw) return null;

        try {
            return JSON.parse(decodeURIComponent(raw));
        } catch {
            return null;
        }
    });
}

/**
 * The aggregate_format token Revel uses for each view, read from the
 * <select> that Select2 wraps rather than hardcoded.
 */
async function readViewTokens(page, knownViews) {
    return page.evaluate((known) => {
        const textOf = (option) => (option.textContent ?? '').trim();

        const select = [...document.querySelectorAll('select')].find(
            (candidate) => {
                const labels = [...candidate.options].map(textOf);

                return known.filter(
                    (label) => labels.includes(label),
                ).length >= 2;
            },
        );

        if (!select) return null;

        return Object.fromEntries(
            [...select.options].map(
                (option) => [textOf(option), option.value],
            ),
        );
    }, knownViews);
}

/**
 * Rewrite aggregate_format in the URL fragment and reload. The
 * fragment carries the dates and filter selections too, so this has
 * to run after the filters are applied.
 */
async function setReportViewByState(page, token) {
    const state = await readReportState(page);

    if (!state) {
        log.warning(
            'Could not read the report state from the URL fragment.',
        );

        return false;
    }

    log.info(
        `Rewriting the report state: aggregate_format `
        + `"${state.aggregate_format}" -> "${token}".`,
    );

    await page.evaluate(
        (encoded) => { window.location.hash = `#${encoded}`; },
        encodeReportState({ ...state, aggregate_format: token }),
    );

    await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
    });

    await waitForReportToSettle(page);

    return true;
}

/**
 * Close any open Select2 list before a fresh attempt, so clicking
 * the control opens the list rather than dismissing it.
 */
async function dismissViewDropdown(page) {
    const dropdown = page.locator('#select2-drop');

    if (await dropdown.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
        await dropdown
            .waitFor({ state: 'hidden', timeout: 5_000 })
            .catch(() => {});
    }
}

/**
 * Pick the view with the keyboard. Select2 v3 sets its highlight on
 * the arrow keys and commits it on Enter, which runs the same
 * handler chain as a real click without depending on mouse events.
 */
async function setReportViewByKeyboard(page, viewLabel) {
    await dismissViewDropdown(page);
    await reportViewControl(page).click();

    const dropdown = page.locator('#select2-drop');

    await dropdown.waitFor({ state: 'visible', timeout: 20_000 });
    await saveScreenshot(page, 'REVEL_VIEW_DROPDOWN_OPEN');

    const wanted = new RegExp(
        `^\\s*${escapeRegExp(viewLabel)}\\s*$`,
        'i',
    );

    const highlighted = dropdown.locator('.select2-highlighted').first();

    for (let step = 0; step < 12; step += 1) {
        // eslint-disable-next-line no-await-in-loop
        const current = await highlighted
            .innerText()
            .catch(() => '');

        if (wanted.test(current.trim())) {
            // eslint-disable-next-line no-await-in-loop
            await page.keyboard.press('Enter');

            // eslint-disable-next-line no-await-in-loop
            await dropdown
                .waitFor({ state: 'hidden', timeout: 10_000 })
                .catch(() => {});

            // eslint-disable-next-line no-await-in-loop
            await waitForReportToSettle(page);

            return true;
        }

        // eslint-disable-next-line no-await-in-loop
        await page.keyboard.press('ArrowDown');
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(150);
    }

    log.warning(
        `Never highlighted "${viewLabel}" in the view dropdown.`,
    );

    await page.keyboard.press('Escape');

    return false;
}

/**
 * Click the option, the way this originally worked.
 *
 * Select2 v3 commits whichever option its own mousemove handler
 * highlighted, not the one under the mouseup, and it ignores
 * mousemoves that do not change coordinates. The pointer is moved
 * twice to force a change and given a moment before the button goes
 * down. Even so this only works intermittently, so callers retry it.
 */
async function setReportViewByClick(page, viewLabel) {
    await dismissViewDropdown(page);
    await reportViewControl(page).click();

    const dropdown = page.locator('#select2-drop');

    await dropdown.waitFor({ state: 'visible', timeout: 20_000 });

    const option = dropdown
        .locator('.select2-result-label')
        .filter({
            hasText: new RegExp(
                `^\\s*${escapeRegExp(viewLabel)}\\s*$`,
                'i',
            ),
        })
        .first();

    const box = await option.boundingBox().catch(() => null);

    if (!box) {
        log.warning(`The view dropdown does not show "${viewLabel}".`);
        await page.keyboard.press('Escape');

        return false;
    }

    await page.mouse.move(box.x + 4, box.y + 4);
    await page.mouse.move(
        box.x + (box.width / 2),
        box.y + (box.height / 2),
    );
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.up();

    await dropdown
        .waitFor({ state: 'hidden', timeout: 10_000 })
        .catch(() => {});

    await waitForReportToSettle(page);

    return true;
}

/**
 * Switch the report's aggregation dropdown.
 *
 * Select2 v3 makes this unreliable: the same single click succeeded
 * in one run and silently selected nothing in the next. So several
 * routes are tried in turn, and each is verified by how the table is
 * bucketed rather than by the control's label.
 */
async function selectReportView(page, viewLabel) {
    await reportViewControl(page).waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    if (await waitForReportView(page, viewLabel, 1_000)) {
        log.info(`Report view is already "${viewLabel}".`);

        return;
    }

    log.info(
        `Switching the report view from `
        + `"${await readReportView(page)}" to "${viewLabel}".`,
    );

    const tokens = await readViewTokens(page, REPORT_VIEWS);

    if (tokens) {
        log.info(
            `Revel's aggregate_format tokens: ${Object.entries(tokens)
                .map(([label, token]) => `${label}=${token}`)
                .join(', ')}`,
        );
    } else {
        log.warning(
            'Could not find the view <select>, so the '
            + 'aggregate_format token is unknown.',
        );
    }

    const token = tokens?.[viewLabel];

    const routes = [
        {
            name: 'keyboard',
            timeoutMs: 30_000,
            run: () => setReportViewByKeyboard(page, viewLabel),
        },
        ...(token
            ? [{
                name: 'report state rewrite',
                timeoutMs: 45_000,
                run: () => setReportViewByState(page, token),
            }]
            : []),
        ...[1, 2, 3].map((attempt) => ({
            name: `dropdown click ${attempt} of 3`,
            timeoutMs: 30_000,
            run: () => setReportViewByClick(page, viewLabel),
        })),
    ];

    for (const { name, timeoutMs, run } of routes) {
        log.info(`Trying the ${name} route.`);

        // eslint-disable-next-line no-await-in-loop
        const attempted = await run().catch((error) => {
            log.warning(`The ${name} route threw: ${error.message}`);

            return false;
        });

        if (attempted
            // eslint-disable-next-line no-await-in-loop
            && await waitForReportView(page, viewLabel, timeoutMs)) {
            log.info(
                `Report view is now "${viewLabel}" `
                + `via the ${name} route.`,
            );

            return;
        }

        log.warning(`The ${name} route did not switch the view.`);
    }

    throw new Error(
        `Unable to switch the report view to "${viewLabel}" after `
        + `${routes.length} attempts. The control reads `
        + `"${await readReportView(page)}" and the table is bucketed `
        + `"${await readReportGranularity(page)}".`,
    );
}

/**
 * Read the rendered report table. Used when the Excel export is
 * unavailable so a run still produces data.
 */
async function scrapeReportTable(page) {
    const table = await page.evaluate(() => {
        const cleanup = (value) => (value ?? '')
            .replace(/\s+/g, ' ')
            .trim();

        const element = [...document.querySelectorAll('table')]
            .find((candidate) => candidate.querySelectorAll('tr').length > 2);

        if (!element) return null;

        const rows = [...element.querySelectorAll('tr')]
            .map((row) => [...row.querySelectorAll('th, td')]
                .map((cell) => cleanup(cell.textContent)));

        return rows.filter((row) => row.length > 0);
    });

    if (!table || table.length < 2) {
        throw new Error(
            'Unable to read the rendered Hourly Sales table.',
        );
    }

    const headers = table[0].map((header, index) => {
        if (header !== '') return header;

        return index === 0 ? 'Interval' : `Column ${index + 1}`;
    });

    const records = table
        .slice(1)
        .filter((row) => row.some((cell) => cell !== ''))
        .map((row) => Object.fromEntries(
            headers.map((header, index) => [
                header,
                row[index] ?? null,
            ]),
        ));

    return { 'Rendered table': { headers, records } };
}

let exitCode = 0;
let statusMessage;

try {
    log.info('Reading Actor input.');

    const input = await Actor.getInput();

    const {
        url = 'https://laynes.revelup.com/reports/hourly_sales/',
        username,
        password,
        establishment = 'Leander',
        override_flag: overrideFlag = false,
        override_startDate: overrideStartDate,
        override_endDate: overrideEndDate,
        startTime = '12:00',
        startMeridiem = 'AM',
        endTime = '11:59',
        endMeridiem = 'PM',
        reportView = '15 Min',
        inclusions = ['discounts'],
        supabaseTable = '',
    } = input ?? {};

    let startDate;
    let endDate;

    if (overrideFlag) {
        if (!overrideStartDate || !overrideEndDate) {
            throw new Error(
                'override_startDate and override_endDate are required '
                + 'when override_flag is true.',
            );
        }

        startDate = overrideStartDate;
        endDate = overrideEndDate;
    } else {
        const defaultDate = calculateDefaultDate();

        startDate = defaultDate;
        endDate = defaultDate;
    }

    log.info('Actor input loaded.', {
        hasUsername: Boolean(username),
        hasPassword: Boolean(password),
        establishment,
        override_flag: overrideFlag,
        startDate,
        startTime,
        startMeridiem,
        endDate,
        endTime,
        endMeridiem,
        reportView,
        inclusions,
        supabaseTable: supabaseTable || '(disabled)',
    });

    if (!username || !password) {
        throw new Error('Both username and password are required.');
    }

    const establishmentCode = ESTABLISHMENT_CODES[establishment];

    if (!establishmentCode) {
        throw new Error(
            `Unknown establishment: ${establishment}. `
            + `Supported: ${Object.keys(ESTABLISHMENT_CODES).join(', ')}`,
        );
    }

    validateDate(startDate, 'startDate');
    validateDate(endDate, 'endDate');
    validateTime(startTime, 'startTime');
    validateTime(endTime, 'endTime');

    const normalizedStartMeridiem = normalizeMeridiem(
        startMeridiem,
        'startMeridiem',
    );

    const normalizedEndMeridiem = normalizeMeridiem(
        endMeridiem,
        'endMeridiem',
    );

    if (!REPORT_VIEWS.includes(reportView)) {
        throw new Error(
            `Unknown reportView: ${reportView}. `
            + `Supported: ${REPORT_VIEWS.join(', ')}`,
        );
    }

    if (!Array.isArray(inclusions)) {
        throw new Error(
            'inclusions must be an array of inclusion keys.',
        );
    }

    const unknownInclusions = inclusions.filter(
        (key) => !(key in INCLUSION_LABELS),
    );

    if (unknownInclusions.length > 0) {
        throw new Error(
            `Unknown inclusions: ${unknownInclusions.join(', ')}`,
        );
    }

    if (supabaseTable && !supabase) {
        throw new Error(
            'supabaseTable is set but SUPABASE_SERVICE_ROLE_KEY is '
            + 'not configured.',
        );
    }

    const targetEstablishment = establishment;
    const establishmentTitle = `${establishmentCode} | ${establishment}`;
    const reportPath = new URL(url).pathname;

    /*
     * Crawlee swallows request errors once failedRequestHandler has
     * run, so the failure is re-raised after crawler.run() to keep
     * the Actor's exit code meaningful.
     */
    let requestFailure = null;

    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 1,
        maxRequestRetries: 0,
        requestHandlerTimeoutSecs: 420,

        async requestHandler({ page, request }) {
            log.info(`Opening Revel portal: ${request.url}`);

            await page.goto(request.url, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
            });

            await saveScreenshot(page, 'REVEL_LOGIN_START');

            const usernameField = page.locator('#username');

            await usernameField.waitFor({
                state: 'visible',
                timeout: 15_000,
            });

            await usernameField.fill(username);

            log.info('Username entered. Clicking Continue.');

            await page
                .getByRole('button', {
                    name: 'Continue',
                    exact: true,
                })
                .click();

            const passwordField = page.locator(
                'input[type="password"]',
            );

            await passwordField.waitFor({
                state: 'visible',
                timeout: 20_000,
            });

            log.info('Password field appeared.');

            await saveScreenshot(page, 'REVEL_PASSWORD_STEP');

            await passwordField.fill(password);

            const loginButton = page
                .locator(
                    'button[type="submit"]:visible, '
                    + 'input[type="submit"]:visible',
                )
                .last();

            await loginButton.waitFor({
                state: 'visible',
                timeout: 15_000,
            });

            const buttonText =
                (await loginButton.textContent())?.trim()
                || (await loginButton.getAttribute('value'))
                || 'Submit';

            log.info(`Clicking final login button: ${buttonText}`);

            await loginButton.click();

            await passwordField.waitFor({
                state: 'hidden',
                timeout: 30_000,
            });

            await page.waitForLoadState('domcontentloaded');

            log.info(`Login completed. Current URL: ${page.url()}`);

            if (!page.url().includes(reportPath)) {
                log.info(`Navigating to report URL: ${url}`);

                await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                });
            }

            const establishmentText = page.locator(
                '[data-cy="header-establishment-text"]',
            );

            await establishmentText.waitFor({
                state: 'visible',
                timeout: 20_000,
            });

            const currentEstablishment =
                (await establishmentText.textContent())?.trim()
                || 'Unknown';

            log.info(
                `Current establishment before selection: `
                + `${currentEstablishment}`,
            );

            if (currentEstablishment !== targetEstablishment) {
                await establishmentText.click();

                log.info('Clicked the establishment name.');

                const establishmentOption = page
                    .locator('span.fancytree-title')
                    .filter({
                        hasText: establishmentTitle,
                    })
                    .first();

                await establishmentOption.waitFor({
                    state: 'visible',
                    timeout: 30_000,
                });

                log.info('Establishment panel opened.');

                await saveScreenshot(
                    page,
                    'REVEL_ESTABLISHMENT_LIST',
                );

                log.info(
                    `Selecting establishment: ${targetEstablishment}`,
                );

                await establishmentOption.click();
            }

            const selectedHeader = page
                .locator('[data-cy="header-establishment-text"]')
                .filter({
                    hasText: new RegExp(
                        `^\\s*${targetEstablishment}\\s*$`,
                    ),
                })
                .first();

            await selectedHeader.waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            const selectedEstablishment =
                (await selectedHeader.textContent())?.trim();

            if (selectedEstablishment !== targetEstablishment) {
                throw new Error(
                    `Expected establishment "${targetEstablishment}", `
                    + `but found "${selectedEstablishment}".`,
                );
            }

            log.info(
                `Establishment selected successfully: `
                + `${selectedEstablishment}`,
            );

            const reportDateRow = page
                .locator('.report-date-row')
                .first();

            await reportDateRow.waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            await saveScreenshot(
                page,
                'REVEL_HOURLY_SALES_LOADED',
            );

            const dateRangeDropdown = page
                .locator('.report-date-row .ico-f-to-down')
                .first();

            await dateRangeDropdown.waitFor({
                state: 'visible',
                timeout: 20_000,
            });

            log.info('Opening the Hourly Sales date-range dropdown.');

            await dateRangeDropdown.click();

            const visibleDatePicker = page
                .locator('.daterangepicker:visible')
                .first();

            await visibleDatePicker.waitFor({
                state: 'visible',
                timeout: 20_000,
            });

            await saveScreenshot(
                page,
                'REVEL_DATE_RANGE_OPEN',
            );

            log.info(
                `Setting internal report range: `
                + `${startDate} ${startTime} `
                + `${normalizedStartMeridiem} through `
                + `${endDate} ${endTime} `
                + `${normalizedEndMeridiem}.`,
            );

            const pickerResult = await page.evaluate(
                ({
                    startDateValue,
                    startTimeValue,
                    startMeridiemValue,
                    endDateValue,
                    endTimeValue,
                    endMeridiemValue,
                }) => {
                    const $ = window.jQuery;
                    const moment = window.moment;

                    if (!$) {
                        throw new Error(
                            'jQuery is not available on the page.',
                        );
                    }

                    if (!moment) {
                        throw new Error(
                            'Moment.js is not available on the page.',
                        );
                    }

                    const candidates = $('*').filter(
                        function findPicker() {
                            return Boolean(
                                $(this).data('daterangepicker'),
                            );
                        },
                    );

                    if (candidates.length === 0) {
                        throw new Error(
                            'Unable to locate Revel '
                            + 'daterangepicker instance.',
                        );
                    }

                    let picker = null;

                    candidates.each(
                        function selectVisiblePicker() {
                            const candidate =
                                $(this).data('daterangepicker');

                            if (
                                !picker
                                && candidate?.container
                                && candidate.container.is(':visible')
                            ) {
                                picker = candidate;
                            }
                        },
                    );

                    if (!picker) {
                        picker = $(candidates[0])
                            .data('daterangepicker');
                    }

                    const startDateTime = moment(
                        `${startDateValue} `
                        + `${startTimeValue} `
                        + `${startMeridiemValue}`,
                        'MM/DD/YYYY hh:mm A',
                        true,
                    );

                    const endDateTime = moment(
                        `${endDateValue} `
                        + `${endTimeValue} `
                        + `${endMeridiemValue}`,
                        'MM/DD/YYYY hh:mm A',
                        true,
                    );

                    if (!startDateTime.isValid()) {
                        throw new Error(
                            'The requested start date/time is invalid.',
                        );
                    }

                    if (!endDateTime.isValid()) {
                        throw new Error(
                            'The requested end date/time is invalid.',
                        );
                    }

                    if (endDateTime.isBefore(startDateTime)) {
                        throw new Error(
                            'The report end date/time cannot be '
                            + 'before the start date/time.',
                        );
                    }

                    if (
                        typeof picker.setStartDate !== 'function'
                        || typeof picker.setEndDate !== 'function'
                    ) {
                        throw new Error(
                            'The Revel daterangepicker does not '
                            + 'expose its date-setting methods.',
                        );
                    }

                    picker.setStartDate(startDateTime);
                    picker.setEndDate(endDateTime);

                    if (typeof picker.updateView === 'function') {
                        picker.updateView();
                    }

                    if (
                        typeof picker.updateCalendars === 'function'
                    ) {
                        picker.updateCalendars();
                    }

                    if (
                        typeof picker.updateFormInputs === 'function'
                    ) {
                        picker.updateFormInputs();
                    }

                    return {
                        startDate: picker.startDate.format(
                            'MM/DD/YYYY hh:mm A',
                        ),
                        endDate: picker.endDate.format(
                            'MM/DD/YYYY hh:mm A',
                        ),
                        hasClickApply:
                            typeof picker.clickApply === 'function',
                    };
                },
                {
                    startDateValue: startDate,
                    startTimeValue: startTime,
                    startMeridiemValue:
                        normalizedStartMeridiem,
                    endDateValue: endDate,
                    endTimeValue: endTime,
                    endMeridiemValue:
                        normalizedEndMeridiem,
                },
            );

            log.info(
                `Internal picker range: `
                + `${pickerResult.startDate} through `
                + `${pickerResult.endDate}`,
            );

            if (!pickerResult.hasClickApply) {
                throw new Error(
                    'The Revel daterangepicker does not expose '
                    + 'its Apply method.',
                );
            }

            await saveScreenshot(
                page,
                'REVEL_DATE_RANGE_POPULATED',
            );

            log.info(
                'Applying the date range through the picker API.',
            );

            await page.evaluate(() => {
                const $ = window.jQuery;

                if (!$) {
                    throw new Error(
                        'jQuery is not available during Apply.',
                    );
                }

                const candidates = $('*').filter(
                    function findPicker() {
                        return Boolean(
                            $(this).data('daterangepicker'),
                        );
                    },
                );

                let picker = null;

                candidates.each(
                    function selectVisiblePicker() {
                        const candidate =
                            $(this).data('daterangepicker');

                        if (
                            !picker
                            && candidate?.container
                            && candidate.container.is(':visible')
                        ) {
                            picker = candidate;
                        }
                    },
                );

                if (!picker && candidates.length > 0) {
                    picker = $(candidates[0])
                        .data('daterangepicker');
                }

                if (!picker) {
                    throw new Error(
                        'Unable to locate the daterangepicker '
                        + 'during Apply.',
                    );
                }

                if (typeof picker.clickApply !== 'function') {
                    throw new Error(
                        'The Revel daterangepicker does not '
                        + 'expose clickApply().',
                    );
                }

                picker.clickApply();
            });

            await visibleDatePicker.waitFor({
                state: 'hidden',
                timeout: 30_000,
            });

            log.info(
                'Date picker closed. Waiting for Revel to refresh '
                + 'the report.',
            );

            /*
             * Do not rely on a fixed delay here. Revel updates the date
             * label before/while it asynchronously rebuilds the report,
             * and slower requests can otherwise export the prior period.
             */
            await page.waitForFunction(
                ({
                    expectedStartDate,
                    expectedEndDate,
                }) => {
                    const normalizeDate = (value) => {
                        const match = String(value).match(
                            /(\d{1,2})\/(\d{1,2})\/(\d{4})/,
                        );

                        if (!match) return null;

                        const [, month, day, year] = match;

                        return `${month.padStart(2, '0')}/`
                            + `${day.padStart(2, '0')}/${year}`;
                    };

                    const dateRow = document.querySelector(
                        '.report-date-row',
                    );

                    if (!dateRow) return false;

                    const displayedDates = (
                        dateRow.textContent ?? ''
                    )
                        .match(/\d{1,2}\/\d{1,2}\/\d{4}/g)
                        ?.map(normalizeDate);

                    if (!displayedDates || displayedDates.length < 2) {
                        return false;
                    }

                    return (
                        displayedDates[0]
                            === normalizeDate(expectedStartDate)
                        && displayedDates[1]
                            === normalizeDate(expectedEndDate)
                    );
                },
                {
                    expectedStartDate: startDate,
                    expectedEndDate: endDate,
                },
                {
                    timeout: 90_000,
                    polling: 500,
                },
            );

            const displayedRange = (
                await reportDateRow.innerText()
            ).replace(/\s+/g, ' ').trim();

            log.info(
                `Revel displays the requested report range: `
                + `${displayedRange}`,
            );

            await waitForReportToSettle(page);

            /*
             * Filters panel: everything stays on its "All" default
             * except the Inclusions checkboxes.
             */
            log.info('Opening the Filters panel.');

            await openFilterPanel(page);

            await saveScreenshot(page, 'REVEL_FILTERS_OPEN');

            const filterChanges = [
                await selectAllRadio(
                    page,
                    'employees',
                    'Employees',
                    'employee',
                ),
                await clearDayOfWeek(page),
                await selectAllRadio(
                    page,
                    'pos-stations',
                    'Pos Stations',
                    'posstation',
                ),
                await selectAllRadio(
                    page,
                    'dining-options',
                    'Dining Options',
                    'dining_option',
                ),
                await selectAllTreeNodes(
                    page,
                    'product-class',
                    'Product Class',
                ),
                await applyInclusions(page, inclusions),
            ];

            const filtersChanged = filterChanges.some(Boolean);

            await saveScreenshot(page, 'REVEL_FILTERS_SELECTED');

            await applyFilters(page, filtersChanged);

            log.info(
                filtersChanged
                    ? 'Filters applied.'
                    : 'Filters already matched the request.',
            );

            await selectReportView(page, reportView);

            /*
             * One view route reloads the page, so re-confirm what
             * Revel is reporting on before trusting the numbers.
             */
            const establishmentNow = (
                await page
                    .locator('[data-cy="header-establishment-text"]')
                    .textContent()
            )?.trim() || 'Unknown';

            if (!establishmentNow.includes(selectedEstablishment)) {
                throw new Error(
                    `Revel is now on establishment `
                    + `"${establishmentNow}" but the report view `
                    + `switch expected "${selectedEstablishment}".`,
                );
            }

            const rangeNow = (await reportDateRow.innerText())
                .replace(/\s+/g, ' ')
                .trim();

            if (rangeNow !== displayedRange) {
                throw new Error(
                    `The report range became "${rangeNow}" during the `
                    + `report view switch; expected `
                    + `"${displayedRange}".`,
                );
            }

            await saveScreenshot(page, 'REVEL_REPORT_READY');

            log.info(
                `Hourly Sales is ready in the "${reportView}" view.`,
            );

            /*
             * Prefer the Excel export: it carries the same columns as
             * the table without the rendering truncation.
             */
            let sheets;
            let source;
            let sourceSizeBytes = null;
            let sheetNames = [];

            try {
                const exportMenuButton = page
                    .locator('.header-more .button-more:visible')
                    .first();

                await exportMenuButton.waitFor({
                    state: 'visible',
                    timeout: 20_000,
                });

                log.info('Opening the report export menu.');

                await exportMenuButton.click();

                const excelExportLink = page
                    .locator('[data-exporttype="excel"]:visible')
                    .first();

                await excelExportLink.waitFor({
                    state: 'visible',
                    timeout: 20_000,
                });

                await saveScreenshot(page, 'REVEL_EXPORT_MENU_OPEN');

                log.info('Downloading the Hourly Sales Excel report.');

                const downloadPromise = page.waitForEvent('download', {
                    timeout: 60_000,
                });

                await excelExportLink.click();

                const download = await downloadPromise;
                const downloadFailure = await download.failure();

                if (downloadFailure) {
                    throw new Error(
                        `Excel download failed: ${downloadFailure}`,
                    );
                }

                const temporaryFilePath = await download.path();

                if (!temporaryFilePath) {
                    throw new Error(
                        'Playwright did not provide a path '
                        + 'for the downloaded file.',
                    );
                }

                const excelBuffer = await readFile(temporaryFilePath);

                const workbook = XLSX.read(excelBuffer, {
                    type: 'buffer',
                    cellDates: false,
                });

                sheets = Object.fromEntries(
                    workbook.SheetNames.map((sheetName) => [
                        sheetName,
                        worksheetToRecords(workbook.Sheets[sheetName]),
                    ]),
                );

                source = 'excel-export';
                sourceSizeBytes = excelBuffer.length;
                sheetNames = workbook.SheetNames;
            } catch (exportError) {
                log.warning(
                    `Excel export unavailable, falling back to the `
                    + `rendered table: ${exportError.message}`,
                );

                sheets = await scrapeReportTable(page);
                source = 'rendered-table';
                sheetNames = Object.keys(sheets);
            }

            const businessDate = toIsoDate(startDate);

            const intervalRows = buildIntervalRows({
                sheets,
                location: selectedEstablishment,
                businessDate,
                reportView,
            });

            if (intervalRows.length === 0) {
                throw new Error(
                    'The Hourly Sales report produced no rows.',
                );
            }

            const intervalCount = intervalRows.filter(
                (row) => !row.is_total,
            ).length;

            log.info(
                `Parsed ${intervalRows.length} rows `
                + `(${intervalCount} intervals) from ${source}.`,
            );

            if (supabaseTable) {
                const { error: supabaseError } = await supabase
                    .from(supabaseTable)
                    .upsert(intervalRows, { onConflict: 'id' })
                    .select();

                if (supabaseError) {
                    throw new Error(
                        `Unable to write hourly sales to Supabase: `
                        + `${supabaseError.message}`,
                    );
                }

                log.info(
                    `Supabase upsert complete: ${intervalRows.length} `
                    + `rows into "${supabaseTable}".`,
                );
            } else {
                log.info(
                    'supabaseTable is empty; skipping the Supabase '
                    + 'upsert.',
                );
            }

            await Actor.pushData(intervalRows);

            await Actor.setValue('RUN_SUMMARY', {
                status: 'success',
                portalUrl: page.url(),
                pageTitle: await page.title(),
                establishment: selectedEstablishment,
                report: 'Hourly Sales',
                reportView,
                inclusions,
                startDate,
                startTime,
                startMeridiem: normalizedStartMeridiem,
                endDate,
                endTime,
                endMeridiem: normalizedEndMeridiem,
                displayedRange,
                source,
                sheetNames,
                sourceSizeBytes,
                rowCount: intervalRows.length,
                intervalCount,
                supabaseTable: supabaseTable || null,
                timestamp: new Date().toISOString(),
            });
        },

        async failedRequestHandler({ page, request }, error) {
            requestFailure = error;

            log.error(`Revel extraction failed: ${error.message}`);

            if (page) {
                try {
                    await saveScreenshot(
                        page,
                        'REVEL_EXTRACTION_FAILURE',
                    );
                } catch (screenshotError) {
                    log.warning(
                        `Unable to save failure screenshot: `
                        + `${screenshotError.message}`,
                    );
                }
            }

            await Actor.setValue('RUN_SUMMARY', {
                status: 'failed',
                portalUrl: page
                    ? page.url()
                    : request.url,
                pageTitle: page
                    ? await page.title().catch(() => '')
                    : '',
                establishment: targetEstablishment,
                report: 'Hourly Sales',
                reportView,
                inclusions,
                startDate,
                startTime,
                startMeridiem: normalizedStartMeridiem,
                endDate,
                endTime,
                endMeridiem: normalizedEndMeridiem,
                timestamp: new Date().toISOString(),
                message: error.message,
            });
        },
    });

    await crawler.run([url]);

    if (requestFailure) throw requestFailure;
} catch (error) {
    const failure = error instanceof Error
        ? error
        : new Error(String(error));

    exitCode = 1;
    statusMessage = failure.message;
    log.exception(failure, failure.message);
} finally {
    await Actor.exit({
        exitCode,
        ...(statusMessage ? { statusMessage } : {}),
    });
}
