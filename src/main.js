import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
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
 * Report columns mapped to the field names Revel has used across
 * its JSON export and its rendered table. Aliases are stored in the
 * normalized form produced by normalizeKey().
 */
const COLUMN_ALIASES = {
    transactions: [
        'transactions',
        'numtransactions',
        'transactioncount',
    ],
    items: ['items', 'numitems', 'itemcount'],
    avg_sales_per_check: [
        'avgsalescheck',
        'avgsalespercheck',
        'averagesalescheck',
    ],
    sales: ['sales', 'netsales', 'totalsales'],
    sales_percent: [
        'pctsales',
        'salespct',
        'salespercent',
        'percentsales',
        'pctofsales',
    ],
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

/**
 * Reduce a field name to letters and digits so "# Transactions",
 * "transactions" and "num_transactions" all compare equal. "%" is
 * spelled out first, otherwise "% Sales" and "Sales" would collide.
 */
function normalizeKey(value) {
    return String(value)
        .toLowerCase()
        .replace(/%/g, 'pct')
        .replace(/[^a-z0-9]/g, '');
}

function findColumnValue(record, aliases) {
    const entry = Object.entries(record).find(
        ([key]) => aliases.includes(normalizeKey(key)),
    );

    return entry ? entry[1] : null;
}

/**
 * Revel labels the interval column differently between its export
 * and its rendered table, so the field is found by the shape of its
 * values rather than by name.
 */
function findIntervalField(records) {
    const keys = records.length > 0 ? Object.keys(records[0]) : [];

    const match = keys.find((key) => records.some(
        (record) => parseIntervalLabel(record[key]) !== null,
    ));

    return match ?? keys[0] ?? null;
}

/**
 * Turn a header row plus data rows into records. Blank leading
 * headers become positional names so the interval column, which
 * Revel leaves unlabelled, still has a key.
 */
function rowsToRecords(grid) {
    if (grid.length < 2) return [];

    const headers = (grid[0] ?? []).map((header, index) => {
        const text = header === null || header === undefined
            ? ''
            : String(header).trim();

        if (text !== '') return text;

        return index === 0 ? 'Interval' : `Column ${index + 1}`;
    });

    return grid
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
}

const isPlainObject = (value) => (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
);

/**
 * Find the row collections inside Revel's JSON export. The payload
 * shape is undocumented and differs per report, so every array of
 * objects is treated as one record set keyed by its path, and
 * arrays of arrays are read as a header row plus data rows.
 */
function collectRecordSets(payload) {
    const sets = {};

    const visit = (value, path) => {
        if (Array.isArray(value)) {
            if (value.length === 0) return;

            if (value.every(isPlainObject)) {
                sets[path || 'root'] = value;

                return;
            }

            if (value.every(Array.isArray)) {
                const records = rowsToRecords(value);

                if (records.length > 0) {
                    sets[path || 'root'] = records;
                }

                return;
            }

            value.forEach(
                (entry, index) => visit(entry, `${path}[${index}]`),
            );

            return;
        }

        if (isPlainObject(value)) {
            for (const [key, nested] of Object.entries(value)) {
                visit(nested, path ? `${path}.${key}` : key);
            }
        }
    };

    visit(payload, '');

    return sets;
}

/**
 * Flatten every record set of the export into dataset rows keyed by
 * establishment, business date and interval.
 */
function buildIntervalRows({
    recordSets,
    location,
    businessDate,
    reportView,
}) {
    const rows = [];

    for (const [setName, records] of Object.entries(recordSets)) {
        const intervalField = findIntervalField(records);

        for (const record of records) {
            const intervalLabel = intervalField
                ? String(record[intervalField] ?? '').trim()
                : '';

            const interval = parseIntervalLabel(intervalLabel);

            rows.push({
                id: `${businessDate}_${location}_${setName}`
                    + `_${intervalLabel || 'total'}`,
                location,
                business_date: businessDate,
                report_view: reportView,
                revenue_center: setName,

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

async function waitForReportViewLabel(page, viewLabel, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let label = '';

    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        label = await readReportView(page);

        if (matchesView(label, viewLabel)) return true;

        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(250);
    }

    log.warning(
        `The report view control still reads "${label}" `
        + `instead of "${viewLabel}".`,
    );

    return false;
}

/**
 * Drive the aggregation dropdown through the <select> that Select2
 * keeps in the DOM.
 *
 * Clicking the rendered list is unreliable here: Select2 v3 commits
 * whichever option its own mousemove handler highlighted, so a
 * synthetic click can close the list without changing the value,
 * leaving the report on its previous aggregation.
 */
async function setReportViewByValue(page, viewLabel, knownViews) {
    return page.evaluate(
        ({ target, known }) => {
            const textOf = (option) => (option.textContent ?? '').trim();

            /*
             * Identify the control by its option set. Revel
             * regenerates element ids per render, but the three view
             * names are stable.
             */
            const select = [...document.querySelectorAll('select')].find(
                (candidate) => {
                    const labels = [...candidate.options].map(textOf);

                    return labels.includes(target) && known.some(
                        (label) => label !== target
                            && labels.includes(label),
                    );
                },
            );

            if (!select) {
                return { ok: false, reason: 'no-select', options: [] };
            }

            const options = [...select.options].map(textOf);
            const option = [...select.options].find(
                (candidate) => textOf(candidate) === target,
            );

            if (!option) {
                return { ok: false, reason: 'no-option', options };
            }

            const jq = window.jQuery ?? window.$;

            /*
             * Select2 v3 exposes a "val" setter whose third argument
             * fires the change event Revel listens on.
             */
            if (jq && jq.fn && jq.fn.select2) {
                jq(select).select2('val', option.value, true);

                return { ok: true, reason: 'select2-api', options };
            }

            select.value = option.value;

            if (jq) {
                jq(select).trigger('change');

                return { ok: true, reason: 'jquery-change', options };
            }

            select.dispatchEvent(new Event('change', { bubbles: true }));

            return { ok: true, reason: 'native-change', options };
        },
        { target: viewLabel, known: knownViews },
    );
}

/**
 * Fallback for when Select2 is attached to something other than a
 * <select>. Hovering first gives Select2's highlight handler a
 * chance to run before the mouse goes down.
 */
async function clickReportView(page, viewLabel) {
    await reportViewControl(page).click();

    const dropdown = page.locator('#select2-drop');

    await dropdown.waitFor({ state: 'visible', timeout: 20_000 });

    const optionLabels = dropdown.locator('.select2-result-label');

    await optionLabels.first().waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    const offered = (await optionLabels.allInnerTexts())
        .map((text) => text.trim());

    log.info(`Report view options offered: ${offered.join(', ')}`);

    await saveScreenshot(page, 'REVEL_VIEW_DROPDOWN_OPEN');

    const option = optionLabels
        .filter({
            hasText: new RegExp(
                `^\\s*${escapeRegExp(viewLabel)}\\s*$`,
                'i',
            ),
        })
        .first();

    if (await option.count() === 0) {
        await page.keyboard.press('Escape');

        return false;
    }

    await option.hover();
    await page.waitForTimeout(150);
    await option.click();

    await dropdown
        .waitFor({ state: 'hidden', timeout: 20_000 })
        .catch(() => {
            log.warning('The report view dropdown stayed open.');
        });

    return waitForReportViewLabel(page, viewLabel);
}

async function selectReportView(page, viewLabel) {
    const control = reportViewControl(page);

    await control.waitFor({ state: 'visible', timeout: 20_000 });

    const currentLabel = (await control.innerText()).trim();

    if (matchesView(currentLabel, viewLabel)) {
        log.info(`Report view is already "${currentLabel}".`);

        return;
    }

    log.info(
        `Switching the report view from "${currentLabel}" `
        + `to "${viewLabel}".`,
    );

    const result = await setReportViewByValue(
        page,
        viewLabel,
        REPORT_VIEWS,
    );

    log.info(
        `Aggregation select update: ${result.reason}. `
        + `Options found: ${result.options.join(', ') || 'none'}`,
    );

    let switched = result.ok
        && await waitForReportViewLabel(page, viewLabel);

    if (!switched) {
        log.warning(
            'Falling back to clicking the report view dropdown.',
        );

        switched = await clickReportView(page, viewLabel);
    }

    if (!switched) {
        throw new Error(
            `Unable to switch the report view to "${viewLabel}". `
            + `The control still reads "${await readReportView(page)}".`,
        );
    }

    log.info(`Report view is now "${await readReportView(page)}".`);

    await waitForReportToSettle(page);
}

/**
 * Confirm the rendered table really uses 15-minute buckets. Hourly
 * rows always end at :59, so a row ending at :14, :29 or :44 is the
 * distinguishing signal.
 */
async function waitForQuarterHourRows(page) {
    await page
        .waitForFunction(
            () => /\d{1,2}:(14|29|44)\s*(AM|PM)/i.test(
                document.body.innerText,
            ),
            undefined,
            {
                timeout: 60_000,
                polling: 500,
            },
        )
        .catch(() => {
            throw new Error(
                'The report view control reads 15 Min but the table '
                + 'still shows hourly rows, so Revel did not reload '
                + 'the report.',
            );
        });
}

/**
 * Request the JSON export from the report's three-dot menu.
 *
 * Revel posts `#export-form` with `target="_blank"`, so the export
 * arrives either as a download or as a new tab rendering the JSON.
 * Both are handled; whichever settles first wins.
 */
async function fetchReportJson(page) {
    const exportMenuButton = page
        .locator('.header-more .button-more:visible')
        .first();

    await exportMenuButton.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    log.info('Opening the report export menu.');

    await exportMenuButton.click();

    const jsonExportLink = page
        .locator(
            '#exp_json:visible, '
            + 'a[data-exporttype="JSON"]:visible, '
            + 'a[data-exporttype="json"]:visible',
        )
        .first();

    await jsonExportLink.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    await saveScreenshot(page, 'REVEL_EXPORT_MENU_OPEN');

    log.info('Requesting the Hourly Sales JSON export.');

    const downloadPromise = page
        .waitForEvent('download', { timeout: 60_000 })
        .then((download) => ({ kind: 'download', download }))
        .catch(() => null);

    const popupPromise = page
        .context()
        .waitForEvent('page', { timeout: 60_000 })
        .then((popup) => ({ kind: 'popup', popup }))
        .catch(() => null);

    await jsonExportLink.click();

    const delivery = await Promise.race([
        downloadPromise,
        popupPromise,
    ]);

    if (!delivery) {
        throw new Error(
            'Revel did not deliver the JSON export as a download '
            + 'or in a new tab.',
        );
    }

    if (delivery.kind === 'download') {
        const failure = await delivery.download.failure();

        if (failure) {
            throw new Error(`JSON download failed: ${failure}`);
        }

        const temporaryFilePath = await delivery.download.path();

        if (!temporaryFilePath) {
            throw new Error(
                'Playwright did not provide a path '
                + 'for the downloaded export.',
            );
        }

        return {
            text: await readFile(temporaryFilePath, 'utf8'),
            source: 'json-download',
        };
    }

    const { popup } = delivery;

    await popup.waitForLoadState('domcontentloaded');

    /*
     * Chromium renders a JSON response inside a <pre>. Fall back to
     * the body in case Revel serves it as an HTML document.
     */
    const text = await popup.evaluate(
        () => document.querySelector('pre')?.innerText
            ?? document.body.innerText,
    );

    await popup.close();

    return { text, source: 'json-tab' };
}

/**
 * Read the rendered report table. Used when the JSON export is
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

    return { 'Rendered table': rowsToRecords(table) };
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

            if (reportView === '15 Min') {
                await waitForQuarterHourRows(page);
            }

            await saveScreenshot(page, 'REVEL_REPORT_READY');

            log.info(
                `Hourly Sales is ready in the "${reportView}" view.`,
            );

            let recordSets;
            let source;
            let rawSizeBytes = null;

            try {
                const { text, source: jsonSource } =
                    await fetchReportJson(page);

                /*
                 * Keep the untouched payload. Revel's JSON shape is
                 * undocumented, so this is the reference for fixing
                 * any field that maps to null.
                 */
                await Actor.setValue(
                    'REVEL_HOURLY_SALES_RAW',
                    text,
                    { contentType: 'application/json' },
                );

                rawSizeBytes = Buffer.byteLength(text);

                let payload;

                try {
                    payload = JSON.parse(text);
                } catch (parseError) {
                    throw new Error(
                        `The export was not valid JSON `
                        + `(${parseError.message}). First 200 chars: `
                        + `${text.slice(0, 200)}`,
                    );
                }

                recordSets = collectRecordSets(payload);

                if (Object.keys(recordSets).length === 0) {
                    throw new Error(
                        'The JSON export contained no row '
                        + 'collections. See REVEL_HOURLY_SALES_RAW.',
                    );
                }

                source = jsonSource;
            } catch (exportError) {
                log.warning(
                    `JSON export unavailable, falling back to the `
                    + `rendered table: ${exportError.message}`,
                );

                recordSets = await scrapeReportTable(page);
                source = 'rendered-table';
            }

            const recordSetNames = Object.keys(recordSets);

            log.info(
                `Export read from ${source}. Record sets: `
                + `${recordSetNames.map((name) => (
                    `${name} (${recordSets[name].length})`
                )).join(', ')}`,
            );

            const businessDate = toIsoDate(startDate);

            const intervalRows = buildIntervalRows({
                recordSets,
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
                + `(${intervalCount} intervals).`,
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
                recordSetNames,
                rawSizeBytes,
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
