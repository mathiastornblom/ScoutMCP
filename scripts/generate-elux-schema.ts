/**
 * Generator: parses the checked-in markdown transcriptions of the eLux terminal.ini and
 * kioskmode.ini reference documentation and emits schema/elux-config.json.
 *
 * Source files (input, hand-transcribed from PDFs, checked into the repo):
 *   docs/reference/terminal-ini-source.md
 *   docs/reference/kioskmode-ini-source.md
 *
 * Output (generated, never hand-edited):
 *   schema/elux-config.json
 *
 * Run with: npx tsx scripts/generate-elux-schema.ts
 *
 * Reproducibility: re-running this script against an unchanged source markdown produces
 * byte-identical output. To refresh the schema after a documentation update, edit the
 * markdown source files (not the JSON) and re-run this script.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const TERMINAL_INI_SOURCE = join(REPO_ROOT, 'docs/reference/terminal-ini-source.md');
const KIOSKMODE_INI_SOURCE = join(REPO_ROOT, 'docs/reference/kioskmode-ini-source.md');
const OUTPUT_PATH = join(REPO_ROOT, 'schema/elux-config.json');

// ── Output schema shape ─────────────────────────────────────────────────────────

/** A single key/value range entry in the generated elux-config.json schema. */
interface EluxConfigEntry {
  section: string;
  key: string;
  /** The documented default value, or the literal string "unset" if the source has no default. */
  default: unknown;
  /** Either a flat array of allowed literal values, {min,max}, or a free-text type hint string. */
  range: unknown;
  /** Semver-ish version string the key has existed since, or null if unknown/unversioned. */
  sinceVersion: string | null;
  /** Whether the source PDF marks this key Publish=yes. */
  publish: boolean;
  /** Free-text notes, folding in source Description / Datamodel Object / honesty-flag context. */
  notes: string;
  /**
   * True when the parameter name was not directly legible in the source PDF and was instead
   * inferred from context (sibling rows, naming convention) rather than cross-checked against
   * the secondary reference document. Entries with `inferred: true` are NOT emitted by default;
   * pass --include-inferred to include them.
   */
  inferred?: true;
}

// ── Markdown table row parsing ──────────────────────────────────────────────────

interface RawRow {
  cells: string[];
}

/** Strips a leading/trailing markdown table pipe and splits a row into cells. */
function parseTableRow(line: string): RawRow | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  // Drop leading/trailing pipe, split on unescaped pipes.
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|').map((c) => c.trim());
  return { cells };
}

/** True for markdown table separator rows like `|---|---|---|`. */
function isSeparatorRow(row: RawRow): boolean {
  return row.cells.every((c) => /^:?-+:?$/.test(c) || c === '');
}

/** True for the standard 7-column header row used throughout both source docs. */
function isHeaderRow(row: RawRow): boolean {
  return row.cells[0]?.toLowerCase() === 'parameter';
}

// ── Per-document parsing ─────────────────────────────────────────────────────────

interface ParsedEntry {
  section: string;
  parameter: string;
  defaultValue: string;
  valueRange: string;
  description: string;
  publish: string;
  datamodelObject: string;
  sinceVersion: string;
}

/**
 * Returns true if a parameter-name cell represents an excluded/placeholder row rather than a
 * real key: blank, a `!` continuation marker, or a parenthesized honesty-flag placeholder like
 * "(unnamed boolean row, no description)".
 */
function isExcludedParameterCell(cell: string): boolean {
  const c = cell.trim();
  if (c === '' || c === '!') return true;
  if (c.startsWith('(') && c.endsWith(')')) return true;
  return false;
}

/**
 * Parses one markdown source file into a flat list of (section, parameter, ...) rows.
 * Section headers are lines of the form `## [SectionName]` (one or more bracketed names per
 * heading are supported, e.g. `## [Browser<1-N>]`). Table rows are standard 7- or 5-column
 * pipe-delimited markdown tables; this parser tolerates either width.
 */
function parseMarkdownSource(filePath: string): ParsedEntry[] {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');

  const entries: ParsedEntry[] = [];
  let currentSection: string | null = null;
  let inTable = false;
  let headerSeen = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+\[(.+?)\]/);
    if (headingMatch) {
      currentSection = headingMatch[1]!;
      inTable = false;
      headerSeen = false;
      continue;
    }

    if (!line.trim().startsWith('|')) {
      // Blank line, prose, or blockquote — table has ended for this run.
      inTable = false;
      headerSeen = false;
      continue;
    }

    const row = parseTableRow(line);
    if (!row) continue;

    if (isHeaderRow(row)) {
      headerSeen = true;
      inTable = true;
      continue;
    }
    if (isSeparatorRow(row)) {
      continue;
    }
    if (!headerSeen || !inTable || !currentSection) {
      // Pipe-containing line outside a recognised table (e.g. a stray inline code span) — skip.
      continue;
    }

    const [parameter = '', defaultValue = '', valueRange = '', description = '', publish = '', datamodelObject = '', sinceVersion = ''] =
      row.cells;

    if (isExcludedParameterCell(parameter)) continue;

    entries.push({
      section: currentSection,
      parameter: parameter.trim(),
      defaultValue: defaultValue.trim(),
      valueRange: valueRange.trim(),
      description: description.trim(),
      publish: publish.trim(),
      datamodelObject: datamodelObject.trim(),
      sinceVersion: sinceVersion.trim(),
    });
  }

  return entries;
}

// ── Value normalisation ──────────────────────────────────────────────────────────

/** Parses a Publish? cell into a boolean. Source uses "yes"/"no"/"?"/blank. */
function parsePublish(cell: string): boolean {
  return cell.toLowerCase() === 'yes';
}

/** Parses a "...since version?" cell into a sinceVersion string, or null if not specified. */
function parseSinceVersion(cell: string): string | null {
  if (!cell) return null;
  // Take the first semver-ish token if the cell has commentary attached (e.g. "6.2302.3, removed in eLux7").
  const match = cell.match(/\d+(\.\d+){1,3}/);
  return match ? match[0] : cell;
}

/** Parses a Default Value cell into a JSON-friendly default, or the string "unset". */
function parseDefault(cell: string): unknown {
  if (!cell || cell === '(unset)' || cell.toLowerCase() === 'empty' || cell === '""' || cell === "''") {
    return 'unset';
  }
  if (cell === 'true') return true;
  if (cell === 'false') return false;
  if (/^-?\d+$/.test(cell)) return Number(cell);
  return cell;
}

/**
 * Parses a Value Range cell into either an array of enum literals (when the cell is a short
 * comma-separated list of simple tokens), or the raw string as a free-text type hint otherwise.
 */
function parseRange(cell: string): unknown {
  if (!cell) return null;
  // Simple comma-separated enum, e.g. "true,false" or "0,1,2,3,5,6,7,10,11,12,13,14,15"
  if (/^[\w.\-]+(,[\w.\-]+)*$/.test(cell) && cell.includes(',')) {
    return cell.split(',').map((v) => {
      if (v === 'true') return true;
      if (v === 'false') return false;
      if (/^-?\d+$/.test(v)) return Number(v);
      return v;
    });
  }
  if (cell === 'true,false' || cell === 'false,true') return [true, false];
  return cell;
}

// ── Entry construction ───────────────────────────────────────────────────────────

function toConfigEntry(row: ParsedEntry): EluxConfigEntry {
  const noteParts: string[] = [];
  if (row.description) noteParts.push(row.description);
  if (row.datamodelObject) noteParts.push(`Datamodel Object: ${row.datamodelObject}`);

  return {
    section: row.section,
    key: row.parameter,
    default: parseDefault(row.defaultValue),
    range: parseRange(row.valueRange),
    sinceVersion: parseSinceVersion(row.sinceVersion),
    publish: parsePublish(row.publish),
    notes: noteParts.join(' | '),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────────

function main(): void {
  const includeInferred = process.argv.includes('--include-inferred');

  const terminalEntries = parseMarkdownSource(TERMINAL_INI_SOURCE).map(toConfigEntry);
  const kioskEntries = parseMarkdownSource(KIOSKMODE_INI_SOURCE).map(toConfigEntry);

  let all = [...terminalEntries, ...kioskEntries];

  if (!includeInferred) {
    all = all.filter((e) => !e.inferred);
  }

  // Deduplicate by section.key, keeping the first occurrence (source files are read in priority
  // order: terminal.ini sections first, kioskmode.ini sections second; within terminal.ini the
  // file already reflects the "newer doc wins" resolution from authoring time).
  const seen = new Set<string>();
  const deduped: EluxConfigEntry[] = [];
  for (const entry of all) {
    const id = `${entry.section}.${entry.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(entry);
  }

  deduped.sort((a, b) => (a.section === b.section ? a.key.localeCompare(b.key) : a.section.localeCompare(b.section)));

  writeFileSync(OUTPUT_PATH, JSON.stringify(deduped, null, 2) + '\n', 'utf8');

  console.log(`Wrote ${deduped.length} entries to ${OUTPUT_PATH}`);
  console.log(`  terminal.ini source rows parsed: ${terminalEntries.length}`);
  console.log(`  kioskmode.ini source rows parsed: ${kioskEntries.length}`);
  if (!includeInferred) {
    const inferredCount = all.filter((e) => e.inferred).length;
    if (inferredCount > 0) {
      console.log(`  (${inferredCount} inferred entries excluded — pass --include-inferred to include them)`);
    }
  }
}

main();
