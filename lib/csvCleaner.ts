/**
 * Smart CSV cleaner that detects and normalises columns for:
 *   First Name, Last Name, Email, Phone
 *
 * Strategy
 * ─────────
 * 1. Score every header against known aliases for each target field.
 * 2. Pick the best-scoring header per field (no column used twice).
 * 3. Name detection priority:
 *    a. Explicit "First Name" + "Last Name" columns → use directly.
 *    b. A bare "Guest" column → First Name. If found, also look for a bare
 *       "Name" column as Last Name (only when Guest is present).
 *    c. "Guest Name" or any other full-name column → split into First + Last.
 * 4. If a restaurant marketing opt-in column exists, keep only rows with an
 *    affirmative Yes (word or clear yes token; see isAffirmativeOptInValue).
 * 5. Drop all other columns.
 * 6. Preserve row count for unfiltered output — filtered runs have fewer rows.
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** Key used in `detectedColumns` when a full-name column is split. */
export const FULL_NAME_SPLIT_KEY = "Full Name (split)" as const;

/** Key when rows are filtered by restaurant marketing opt-in (Yes only). */
export const MARKETING_OPT_IN_FILTER_KEY = "Marketing opt-in (Yes only)" as const;

/** Score bonus applied to exact alias matches so they always beat fuzzy matches. */
const EXACT_MATCH_BONUS = 10;

// ── Types ──────────────────────────────────────────────────────────────────

export interface CleanedRow {
  "First Name": string;
  "Last Name": string;
  Email: string;
  Phone: string;
  /** If present in input, passed through without trimming/normalization. */
  "Visit Date"?: string;
  /** If present in input, passed through without trimming/normalization. */
  "Visit time"?: string;
}

export interface CleanStats {
  inputRows: number;
  outputRows: number;
  /** Maps an output field name (or FULL_NAME_SPLIT_KEY) to the original header. */
  detectedColumns: Record<string, string>;
  /** Input headers that were not mapped to any output column. */
  ignoredColumns: string[];
  warnings: string[];
}

export interface CleanResult {
  rows: CleanedRow[];
  stats: CleanStats;
}

interface ColumnDetection {
  firstNameCol: string | null;
  lastNameCol: string | null;
  fullNameCol: string | null;
  emailCol: string | null;
  phoneCol: string | null;
  visitDateCol: string | null;
  visitTimeCol: string | null;
  detectedColumns: Record<string, string>;
  usedHeaders: Set<string>;
  warnings: string[];
}

// ── Alias lists ────────────────────────────────────────────────────────────

/** Trailing export labels, e.g. "(Restricted PII)", on otherwise standard headers */
const HDR_SFX = String.raw`(?:\s*\([^)]*\))*\s*`;

const ALIASES: Record<string, RegExp[]> = {
  // Explicit first-name columns only (must look unambiguously like "first name")
  // Also includes bare "Guest" — treated as a first-name column when present.
  firstName: [
    /^first[\s_-]?name$/i,
    /^first$/i,
    /^fname$/i,
    /^f[\s_-]?name$/i,
    /^given[\s_-]?name$/i,
    /^forename$/i,
    /^guest$/i,           // bare "Guest" column → First Name
  ],
  // Explicit last-name columns only
  lastName: [
    /^last[\s_-]?name$/i,
    /^last$/i,
    /^lname$/i,
    /^l[\s_-]?name$/i,
    /^surname$/i,
    /^family[\s_-]?name$/i,
  ],
  // Full / combined name columns — "Guest Name" is highest priority
  fullName: [
    new RegExp(`^guest[\\s_-]?name${HDR_SFX}$`, "i"),
    new RegExp(`^(full[\\s_-]?)?name${HDR_SFX}$`, "i"),
    new RegExp(`^contact[\\s_-]?name${HDR_SFX}$`, "i"),
    new RegExp(`^client[\\s_-]?name${HDR_SFX}$`, "i"),
    new RegExp(`^customer[\\s_-]?name${HDR_SFX}$`, "i"),
    new RegExp(`^prospect[\\s_-]?name${HDR_SFX}$`, "i"),
    new RegExp(`^lead[\\s_-]?name${HDR_SFX}$`, "i"),
    new RegExp(`^display[\\s_-]?name${HDR_SFX}$`, "i"),
    new RegExp(`^member[\\s_-]?name${HDR_SFX}$`, "i"),
  ],
  email: [
    /^e[\s_-]?mail(s|[\s_-]?address(es)?)?$/i,
    /^email$/i,
    /^mail$/i,
    /^contact[\s_-]?email$/i,
    /^primary[\s_-]?email$/i,
    /^work[\s_-]?email$/i,
    /^business[\s_-]?email$/i,
  ],
  phone: [
    /^phone([\s_-]?number(s)?)?$/i,
    /^phones?$/i,
    /^tel(ephone)?([\s_-]?number(s)?)?$/i,
    /^mobile([\s_-]?number(s)?)?$/i,
    /^cell([\s_-]?number(s)?)?$/i,
    /^contact[\s_-]?number$/i,
    /^ph$/i,
    /^ph[\s_-]?num$/i,
    /^work[\s_-]?phone$/i,
    /^office[\s_-]?phone$/i,
  ],
};

// ── Scoring ────────────────────────────────────────────────────────────────

/**
 * Returns a positive score if `header` matches `patterns`, otherwise 0.
 * Higher score = better match. Earlier patterns in the list beat later ones.
 *
 * Fuzzy fallback rules are intentionally strict:
 *  - firstName fuzzy: "first" must appear right before "name" (or alone)
 *  - lastName fuzzy:  "last"  must appear right before "name" (or alone as "surname")
 *    → prevents "Last Trans. Date" from accidentally matching
 *  - fullName fuzzy:  "full name" phrase, or header ends with "name", or equals "name"
 *  - email fuzzy:     "email" anywhere
 *  - phone fuzzy:     "phone" / "mobile" / "cell" anywhere
 */
function scoreHeader(header: string, field: keyof typeof ALIASES): number {
  const h = header.trim();
  const patterns = ALIASES[field];

  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(h)) return patterns.length - i + EXACT_MATCH_BONUS;
  }

  const lower = h.toLowerCase();

  switch (field) {
    case "email":
      return lower.includes("email") ? 1 : 0;

    case "phone":
      return lower.includes("phone") || lower.includes("mobile") || lower.includes("cell") ? 1 : 0;

    case "firstName":
      return /\bfirst[\s_-]?name\b/i.test(h) || /^first$/i.test(h) ? 1 : 0;

    case "lastName":
      // Require "last" adjacent to "name" — prevents "Last Trans. Date", "Last Updated", etc.
      return /\blast[\s_-]?name\b/i.test(h) || /^last$/i.test(h) || /^surname$/i.test(h) ? 1 : 0;

    case "fullName":
      if (/\bfull[\s_-]+name\b/i.test(h)) return 1;
      if (/\bguest[\s_-]+name\b/i.test(h)) return 1;
      return /\bname$/i.test(h) ? 1 : 0;

    default:
      return 0;
  }
}

function bestMatch(
  headers: string[],
  field: keyof typeof ALIASES,
  exclude: Set<string>,
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const h of headers) {
    if (exclude.has(h)) continue;
    const score = scoreHeader(h, field);
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

// ── Column detection ───────────────────────────────────────────────────────

function detectColumns(headers: string[]): ColumnDetection {
  const detectedColumns: Record<string, string> = {};
  const usedHeaders = new Set<string>();
  const warnings: string[] = [];

  // Step 1: look for explicit first / last name columns
  const firstNameCol = bestMatch(headers, "firstName", usedHeaders);
  if (firstNameCol) { usedHeaders.add(firstNameCol); detectedColumns["First Name"] = firstNameCol; }

  let lastNameCol = bestMatch(headers, "lastName", usedHeaders);
  if (lastNameCol) { usedHeaders.add(lastNameCol); detectedColumns["Last Name"] = lastNameCol; }

  // Step 2: if first name came from a bare "Guest" column and no last name was
  // found yet, try a bare "Name" column as the last name before falling back to
  // full-name splitting. This handles the common pattern: Guest | Name | Email.
  if (firstNameCol && /^guest$/i.test(firstNameCol.trim()) && !lastNameCol) {
    const nameHeader = headers.find(
      (h) => /^name$/i.test(h.trim()) && !usedHeaders.has(h),
    );
    if (nameHeader) {
      lastNameCol = nameHeader;
      usedHeaders.add(nameHeader);
      detectedColumns["Last Name"] = nameHeader;
    }
  }

  // Step 3: look for a full-name column when at least one of first/last is still missing
  let fullNameCol: string | null = null;
  if (!firstNameCol || !lastNameCol) {
    fullNameCol = bestMatch(headers, "fullName", usedHeaders);
    if (fullNameCol) {
      usedHeaders.add(fullNameCol);
      detectedColumns[FULL_NAME_SPLIT_KEY] = fullNameCol;
    }
  }

  // Step 4: email & phone
  const emailCol = bestMatch(headers, "email", usedHeaders);
  if (emailCol) { usedHeaders.add(emailCol); detectedColumns["Email"] = emailCol; }
  else warnings.push("No email column detected.");

  const phoneCol = bestMatch(headers, "phone", usedHeaders);
  if (phoneCol) { usedHeaders.add(phoneCol); detectedColumns["Phone"] = phoneCol; }
  else warnings.push("No phone column detected.");

  // Step 5: optional passthrough columns (keep as-is when present)
  const visitDateCol =
    headers.find((h) => new RegExp(`^visit\\s*date${HDR_SFX}$`, "i").test(h.trim())) ?? null;
  if (visitDateCol && !usedHeaders.has(visitDateCol)) {
    usedHeaders.add(visitDateCol);
    detectedColumns["Visit Date"] = visitDateCol;
  }

  const visitTimeCol =
    headers.find((h) => new RegExp(`^visit\\s*time${HDR_SFX}$`, "i").test(h.trim())) ?? null;
  if (visitTimeCol && !usedHeaders.has(visitTimeCol)) {
    usedHeaders.add(visitTimeCol);
    detectedColumns["Visit time"] = visitTimeCol;
  }

  if (!firstNameCol && !lastNameCol && !fullNameCol) {
    warnings.push("No name column detected.");
  }

  return {
    firstNameCol,
    lastNameCol,
    fullNameCol,
    emailCol,
    phoneCol,
    visitDateCol,
    visitTimeCol,
    detectedColumns,
    usedHeaders,
    warnings,
  };
}

// ── Name splitting ─────────────────────────────────────────────────────────

function splitName(full: string): { first: string; last: string } {
  const trimmed = full.trim();
  if (!trimmed) return { first: "", last: "" };

  // "Last, First" format
  if (trimmed.includes(",")) {
    const [rawLast, ...rest] = trimmed.split(",");
    return { first: rest.join(",").trim(), last: rawLast.trim() };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  if (parts.length === 2) return { first: parts[0], last: parts[1] };

  // 3+ parts — last word is last name, rest is first/middle
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

// ── Phone normalisation ────────────────────────────────────────────────────

function normalisePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

// ── Cell accessor ──────────────────────────────────────────────────────────

function getCell(raw: Record<string, string>, col: string | null): string {
  return col ? (raw[col] ?? "").trim() : "";
}

function getCellAsIs(raw: Record<string, string>, col: string | null): string {
  return col ? (raw[col] ?? "") : "";
}

// ── Restaurant marketing opt-in filter ─────────────────────────────────────

function scoreMarketingOptInHeader(header: string): number {
  const h = header.trim();
  const exact = new RegExp(
    `^opted[\\s-]?in\\s+to\\s+restaurant\\s+marketing${HDR_SFX}$`,
    "i",
  );
  if (exact.test(h)) return 100;
  if (
    /\brestaurant\b/i.test(h) &&
    /\bmarketing\b/i.test(h) &&
    /opted|opt[\s_-]?in/i.test(h)
  ) {
    return 50;
  }
  return 0;
}

function detectMarketingOptInColumn(headers: string[]): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const h of headers) {
    const s = scoreMarketingOptInHeader(h);
    if (s > bestScore) {
      bestScore = s;
      best = h;
    }
  }
  return bestScore > 0 ? best : null;
}

/** True when the cell clearly indicates opt-in Yes (flexible phrasing, not substring traps like "eyes"). */
export function isAffirmativeOptInValue(raw: string): boolean {
  const v = raw.trim();
  if (!v) return false;
  if (/\byes\b/i.test(v)) return true;
  const compact = v.replace(/\s+/g, "").toLowerCase();
  if (compact === "y" || compact === "yes") return true;
  if (/^y(es)?[^a-z]*$/i.test(v.trim())) return true;
  const lower = v.toLowerCase();
  if (/\byeah\b|\byep\b|\byup\b/i.test(lower)) return true;
  return false;
}

// ── Main export ────────────────────────────────────────────────────────────

export function cleanCsvData(rawRows: Record<string, string>[]): CleanResult {
  if (rawRows.length === 0) {
    return {
      rows: [],
      stats: {
        inputRows: 0,
        outputRows: 0,
        detectedColumns: {},
        ignoredColumns: [],
        warnings: ["Input file is empty."],
      },
    };
  }

  const headers = Object.keys(rawRows[0]);
  const {
    firstNameCol,
    lastNameCol,
    fullNameCol,
    emailCol,
    phoneCol,
    visitDateCol,
    visitTimeCol,
    detectedColumns,
    usedHeaders,
    warnings,
  } = detectColumns(headers);

  const marketingOptInCol = detectMarketingOptInColumn(headers);
  let rowsToClean = rawRows;
  if (marketingOptInCol) {
    usedHeaders.add(marketingOptInCol);
    detectedColumns[MARKETING_OPT_IN_FILTER_KEY] = marketingOptInCol;
    const before = rawRows.length;
    rowsToClean = rawRows.filter((raw) =>
      isAffirmativeOptInValue(getCell(raw, marketingOptInCol)),
    );
    const removed = before - rowsToClean.length;
    if (removed > 0) {
      if (rowsToClean.length === 0) {
        warnings.push(
          "Marketing opt-in: no rows had an affirmative Yes; output is empty.",
        );
      } else {
        warnings.push(
          `Marketing opt-in: kept rows with an affirmative Yes only (removed ${removed}).`,
        );
      }
    }
  }

  const rowsUnfiltered: CleanedRow[] = rowsToClean.map((raw) => {
    let first = getCell(raw, firstNameCol);
    let last  = getCell(raw, lastNameCol);

    if (fullNameCol) {
      const val = getCell(raw, fullNameCol);
      if (val) {
        const split = splitName(val);
        if (!first) first = split.first;
        if (!last)  last  = split.last;
      }
    }

    const out: CleanedRow = {
      "First Name": first,
      "Last Name": last,
      Email: getCell(raw, emailCol),
      Phone: normalisePhone(getCell(raw, phoneCol)),
    };

    if (visitDateCol) out["Visit Date"] = getCellAsIs(raw, visitDateCol);
    if (visitTimeCol) out["Visit time"] = getCellAsIs(raw, visitTimeCol);

    return out;
  });

  const rows = rowsUnfiltered.filter((r) => {
    const hasEmail = r.Email.trim().length > 0;
    const hasPhone = r.Phone.trim().length > 0;
    return hasEmail || hasPhone;
  });

  const removedNoContact = rowsUnfiltered.length - rows.length;
  if (removedNoContact > 0) {
    if (rows.length === 0) {
      warnings.push("Contact info: no rows had either email or phone; output is empty.");
    } else {
      warnings.push(`Contact info: removed ${removedNoContact} row(s) with neither email nor phone.`);
    }
  }

  return {
    rows,
    stats: {
      inputRows: rawRows.length,
      outputRows: rows.length,
      detectedColumns,
      ignoredColumns: headers.filter((h) => !usedHeaders.has(h)),
      warnings,
    },
  };
}
