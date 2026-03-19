/**
 * Smart CSV cleaner that detects and normalises columns for:
 *   Guest, Name, Email, Phone
 *
 * Strategy
 * ─────────
 * 1. Score every header against known aliases for each target field.
 * 2. Pick the best-scoring header per field (no column used twice).
 * 3. Name detection priority:
 *    a. "Guest Name" (or similar full-name column) → split into Guest + Name
 *    b. Explicit "First Name" + "Last Name" columns → use directly
 *    c. Any other full-name-like column → split
 * 4. Drop all other columns.
 * 5. Preserve row count — blank values stay blank.
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** Key used in `detectedColumns` when a full-name column is split. */
export const FULL_NAME_SPLIT_KEY = "Full Name (split)" as const;

/** Score bonus applied to exact alias matches so they always beat fuzzy matches. */
const EXACT_MATCH_BONUS = 10;

// ── Types ──────────────────────────────────────────────────────────────────

export interface CleanedRow {
  Guest: string;
  Name: string;
  Email: string;
  Phone: string;
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
  detectedColumns: Record<string, string>;
  usedHeaders: Set<string>;
  warnings: string[];
}

// ── Alias lists ────────────────────────────────────────────────────────────

const ALIASES: Record<string, RegExp[]> = {
  // Explicit first-name columns only (must look unambiguously like "first name")
  firstName: [
    /^first[\s_-]?name$/i,
    /^first$/i,
    /^fname$/i,
    /^f[\s_-]?name$/i,
    /^given[\s_-]?name$/i,
    /^forename$/i,
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
    /^guest[\s_-]?name$/i,        // highest priority
    /^(full[\s_-]?)?name$/i,
    /^contact[\s_-]?name$/i,
    /^client[\s_-]?name$/i,
    /^customer[\s_-]?name$/i,
    /^prospect[\s_-]?name$/i,
    /^lead[\s_-]?name$/i,
    /^display[\s_-]?name$/i,
    /^member[\s_-]?name$/i,
    /^guest$/i,
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
 *  - fullName fuzzy:  header ends with "name" or equals "name"
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
      // Header ends with "name" (e.g. "guest name", "full name") or is exactly "name"
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
  if (firstNameCol) { usedHeaders.add(firstNameCol); detectedColumns["Guest"] = firstNameCol; }

  const lastNameCol = bestMatch(headers, "lastName", usedHeaders);
  if (lastNameCol) { usedHeaders.add(lastNameCol); detectedColumns["Name"] = lastNameCol; }

  // Step 2: look for a full-name column when at least one of first/last is missing
  let fullNameCol: string | null = null;
  if (!firstNameCol || !lastNameCol) {
    fullNameCol = bestMatch(headers, "fullName", usedHeaders);
    if (fullNameCol) {
      usedHeaders.add(fullNameCol);
      detectedColumns[FULL_NAME_SPLIT_KEY] = fullNameCol;
    }
  }

  // Step 3: email & phone
  const emailCol = bestMatch(headers, "email", usedHeaders);
  if (emailCol) { usedHeaders.add(emailCol); detectedColumns["Email"] = emailCol; }
  else warnings.push("No email column detected.");

  const phoneCol = bestMatch(headers, "phone", usedHeaders);
  if (phoneCol) { usedHeaders.add(phoneCol); detectedColumns["Phone"] = phoneCol; }
  else warnings.push("No phone column detected.");

  if (!firstNameCol && !lastNameCol && !fullNameCol) {
    warnings.push("No name column detected.");
  }

  return { firstNameCol, lastNameCol, fullNameCol, emailCol, phoneCol, detectedColumns, usedHeaders, warnings };
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
  const { firstNameCol, lastNameCol, fullNameCol, emailCol, phoneCol, detectedColumns, usedHeaders, warnings } =
    detectColumns(headers);

  const rows: CleanedRow[] = rawRows.map((raw) => {
    let guest = getCell(raw, firstNameCol);
    let name  = getCell(raw, lastNameCol);

    if (fullNameCol) {
      const val = getCell(raw, fullNameCol);
      if (val) {
        const split = splitName(val);
        if (!guest) guest = split.first;
        if (!name)  name  = split.last;
      }
    }

    return {
      Guest: guest,
      Name: name,
      Email: getCell(raw, emailCol),
      Phone: normalisePhone(getCell(raw, phoneCol)),
    };
  });

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
