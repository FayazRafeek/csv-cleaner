"use client";

import { useCallback, useRef, useState } from "react";
import Papa from "papaparse";
import { read, utils } from "xlsx";
import {
  Box,
  Button,
  Card,
  Dialog,
  Flex,
  Heading,
  Text,
  Badge,
  Separator,
  Table,
  ScrollArea,
  Callout,
} from "@radix-ui/themes";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileSpreadsheet,
  GitMerge,
  HelpCircle,
  Loader2,
  Scissors,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { cleanCsvData, CleanResult, FULL_NAME_SPLIT_KEY } from "@/lib/csvCleaner";

// ── Constants ──────────────────────────────────────────────────────────────

const OUTPUT_COLUMNS = ["First Name", "Last Name", "Email", "Phone"] as const;
type OutputColumn = (typeof OUTPUT_COLUMNS)[number];

const PREVIEW_LIMIT = 5;
const MIN_SPINNER_MS = 800;
const XLSX_FILE_RE = /\.xlsx?$/i;
const ACCEPTED_EXTENSIONS = ".csv,.xlsx,.xls";
const SPIN_KEYFRAMES = "@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }";

// ── Types ──────────────────────────────────────────────────────────────────

type Stage = "idle" | "converting" | "processing" | "done" | "error";

interface MappingRow {
  output: OutputColumn;
  source: string;
  note?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseToRows(source: string | File): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(source as File, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => resolve(r.data),
      error: (e) => reject(new Error(e.message)),
    });
  });
}

async function loadFileAsRows(
  file: File,
  onStage: (s: "converting" | "processing") => void,
): Promise<Record<string, string>[]> {
  if (XLSX_FILE_RE.test(file.name)) {
    onStage("converting");
    const buffer = await file.arrayBuffer();
    const wb = read(buffer);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const csvStr = utils.sheet_to_csv(ws, { blankrows: false });
    onStage("processing");
    return parseToRows(csvStr);
  }
  onStage("processing");
  return parseToRows(file);
}

function buildMappingRows(detected: Record<string, string>): MappingRow[] {
  const splitSrc = detected[FULL_NAME_SPLIT_KEY];
  return OUTPUT_COLUMNS.flatMap<MappingRow>((output) => {
    if (detected[output]) return [{ output, source: detected[output] }];
    if (splitSrc && (output === "First Name" || output === "Last Name")) return [{ output, source: splitSrc, note: "split" }];
    return [];
  });
}

function getDownloadColumns(result: CleanResult): string[] {
  const cols = [...OUTPUT_COLUMNS] as string[];
  if (result.stats.detectedColumns["Visit Date"]) cols.push("Visit Date");
  if (result.stats.detectedColumns["Visit time"]) cols.push("Visit time");
  return cols;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SpinnerPanel({ message }: { message: React.ReactNode }) {
  return (
    <Flex direction="column" align="center" gap="3" py="8">
      <Loader2 size={30} color="var(--indigo-9)" style={{ animation: "spin 1s linear infinite" }} />
      <Text size="3" color="gray">{message}</Text>
    </Flex>
  );
}

function DropZone({ onDrop, onClick }: {
  onDrop: React.DragEventHandler<HTMLDivElement>;
  onClick: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <Flex
      direction="column" align="center" justify="center" gap="3" py="9"
      onClick={onClick}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); onDrop(e); }}
      style={{
        border: `2px dashed ${over ? "var(--indigo-9)" : "var(--gray-6)"}`,
        borderRadius: "var(--radius-3)",
        cursor: "pointer",
        background: over ? "var(--indigo-2)" : "var(--gray-1)",
        transition: "all 0.15s",
      }}
    >
      <FileSpreadsheet size={42} strokeWidth={1.4}
        color={over ? "var(--indigo-9)" : "var(--indigo-8)"} />
      <Flex direction="column" align="center" gap="1">
        <Text size="3" weight="medium">Drop your file here</Text>
        <Text size="2" color="gray">or click to browse</Text>
      </Flex>
      <Flex gap="2">
        <Badge color="gray" variant="surface" size="1">.csv</Badge>
        <Badge color="gray" variant="surface" size="1">.xlsx</Badge>
        <Badge color="gray" variant="surface" size="1">.xls</Badge>
      </Flex>
    </Flex>
  );
}

function StepPill({ n, label, active, done }: {
  n: number; label: string; active: boolean; done: boolean;
}) {
  return (
    <Flex align="center" gap="2">
      <Flex align="center" justify="center" style={{
        width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
        background: done ? "var(--indigo-9)" : active ? "var(--indigo-3)" : "var(--gray-3)",
        color:      done ? "white"           : active ? "var(--indigo-11)" : "var(--gray-9)",
        fontSize: 13, fontWeight: 600,
      }}>
        {done ? <CheckCircle2 size={15} strokeWidth={2.5} /> : n}
      </Flex>
      <Text size="2" weight={active ? "bold" : "regular"} color={active ? undefined : "gray"}>
        {label}
      </Text>
    </Flex>
  );
}

function StepLine({ done }: { done: boolean }) {
  return (
    <Box style={{
      flex: 1, height: 2, borderRadius: 1,
      background: done ? "var(--indigo-9)" : "var(--gray-4)",
      transition: "background 0.3s",
    }} />
  );
}

function HelpDialog() {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <button
          aria-label="How to use"
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: "var(--indigo-9)",
            color: "white",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
            zIndex: 100,
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--indigo-10)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--indigo-9)")}
        >
          <HelpCircle size={22} strokeWidth={2} />
        </button>
      </Dialog.Trigger>

      <Dialog.Content maxWidth="560px" style={{ padding: "28px 32px" }}>
        <Dialog.Title mb="1">How to Use — Campaign Data Cleaner</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="5">
          A quick guide for the operations team.
        </Dialog.Description>

        {/* What it does */}
        <Section label="What does this tool do?">
          <Text size="2" as="p">
            This tool takes a messy contact file from any source and outputs a clean, standardised CSV
            with exactly four columns: <strong>First Name</strong>, <strong>Last Name</strong>,{" "}
            <strong>Email</strong>, and <strong>Phone</strong>. All other columns are automatically removed.
          </Text>
        </Section>

        <Separator size="4" my="4" />

        {/* Where files come from */}
        <Section label="Where do the input files come from?">
          <Flex direction="column" gap="2">
            <SourceRow
              source="OpenTable"
              hint="Export the guest list from the Reservations or Marketing tab as a .csv or .xlsx file."
            />
            <SourceRow
              source="Yelp"
              hint="Download contacts from Yelp for Business as a CSV export."
            />
            <SourceRow
              source="Client direct"
              hint="Files sent directly by the client — could be a spreadsheet in any format (.csv, .xlsx, .xls)."
            />
          </Flex>
        </Section>

        <Separator size="4" my="4" />

        {/* Input columns */}
        <Section label="What columns are in the input file?">
          <Text size="2" color="gray" as="p" mb="3">
            The tool is smart — it doesn&apos;t require exact column names. It will recognise variations like:
          </Text>
          <Flex direction="column" gap="2">
            <ColRow output="First Name" examples={["Guest", "First Name", "First", "Given Name", "fname"]} />
            <ColRow output="Last Name"  examples={["Name (when Guest is also present)", "Last Name", "Last", "Surname"]} />
            <ColRow output="Email"      examples={["Email", "Email Address", "Work Email", "Contact Email"]} />
            <ColRow output="Phone"      examples={["Phone", "Mobile", "Cell", "Telephone", "Ph Num"]} />
          </Flex>
          <Text size="2" color="gray" as="p" mt="3">
            If the file only has a single <strong>Guest Name</strong> or <strong>Full Name</strong> column,
            the tool will automatically split it into First Name and Last Name.
          </Text>
        </Section>

        <Separator size="4" my="4" />

        {/* Steps */}
        <Section label="Step-by-step">
          <Flex direction="column" gap="2">
            {[
              "Export or save the file from OpenTable, Yelp, or wherever the client sent it.",
              "Click the upload area (or drag-and-drop) and select the file.",
              "Wait a moment — the tool converts and cleans it automatically.",
              "Click \"Download Cleaned CSV\" to save the output file.",
              "Optionally open \"View Processed Info\" to see exactly which columns were used and which were ignored.",
            ].map((step, i) => (
              <Flex key={i} gap="3" align="start">
                <Flex align="center" justify="center" flexShrink="0" style={{
                  width: 22, height: 22, borderRadius: "50%",
                  background: "var(--indigo-3)", color: "var(--indigo-11)",
                  fontSize: 11, fontWeight: 700, marginTop: 1,
                }}>
                  {i + 1}
                </Flex>
                <Text size="2">{step}</Text>
              </Flex>
            ))}
          </Flex>
        </Section>

        <Separator size="4" my="4" />

        {/* Tip */}
        <Callout.Root color="indigo" size="1">
          <Callout.Icon><AlertTriangle size={14} /></Callout.Icon>
          <Callout.Text size="2">
            The row count is always preserved — every contact in the original file appears in the output,
            even if some fields (like phone) are blank.
          </Callout.Text>
        </Callout.Root>

        <Flex justify="end" mt="5">
          <Dialog.Close>
            <Button variant="soft">Got it</Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Small labelled section wrapper used inside HelpDialog. */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text size="2" weight="bold" as="div" mb="2">{label}</Text>
      {children}
    </Box>
  );
}

/** A single source row in the "where files come from" list. */
function SourceRow({ source, hint }: { source: string; hint: string }) {
  return (
    <Flex gap="3" align="start">
      <Badge color="indigo" variant="soft" size="1" style={{ marginTop: 1, flexShrink: 0 }}>
        {source}
      </Badge>
      <Text size="2" color="gray">{hint}</Text>
    </Flex>
  );
}

/** One row in the column-recognition table. */
function ColRow({ output, examples }: { output: string; examples: string[] }) {
  return (
    <Flex gap="3" align="start">
      <Badge color="green" variant="soft" size="1" style={{ marginTop: 1, flexShrink: 0, minWidth: 72, justifyContent: "center" }}>
        {output}
      </Badge>
      <Text size="2" color="gray">{examples.join(", ")}</Text>
    </Flex>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function Home() {
  const [stage, setStage] = useState<Stage>("idle");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<CleanResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const spinnerStartMs = useRef(0);

  const processFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setResult(null);
    setErrorMsg("");
    setInfoOpen(false);

    try {
      const rows = await loadFileAsRows(file, (s) => {
        setStage(s);
        if (s === "processing") spinnerStartMs.current = Date.now();
      });

      const cleaned = cleanCsvData(rows);

      const elapsed = Date.now() - spinnerStartMs.current;
      const remaining = Math.max(0, MIN_SPINNER_MS - elapsed);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));

      setResult(cleaned);
      setStage("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
      setStage("error");
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && /\.(csv|xlsx?)$/i.test(file.name)) processFile(file);
  };

  const handleDownload = () => {
    if (!result) return;
    const csv = Papa.unparse(result.rows, { columns: getDownloadColumns(result) });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/\.(csv|xlsx?)$/i, "")}_cleaned.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setStage("idle");
    setResult(null);
    setFileName("");
    setErrorMsg("");
    setInfoOpen(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const isActive = (s: Stage) => stage === s;
  const pastProcessing = stage === "done" || stage === "error";
  const previewRows = result?.rows.slice(0, PREVIEW_LIMIT) ?? [];
  const mappingRows = result ? buildMappingRows(result.stats.detectedColumns) : [];

  return (
    <Flex
      direction="column"
      align="center"
      justify="start"
      style={{ minHeight: "100vh", padding: "48px 16px", background: "var(--gray-2)" }}
    >
      <Box mb="6" style={{ textAlign: "center" }}>
        <Heading size="7" mb="1">Campaign Data Cleaner</Heading>
        <Text color="gray" size="3">
          Upload a CSV or Excel file — we&apos;ll extract First Name, Last Name, Email &amp; Phone.
        </Text>
      </Box>

      <Card style={{ width: "100%", maxWidth: 680 }}>
        {/* Step indicators */}
        <Flex align="center" gap="2" mb="5">
          <StepPill n={1} label="Upload"   active={isActive("idle")} done={stage !== "idle"} />
          <StepLine done={isActive("processing") || pastProcessing} />
          <StepPill
            n={2}
            label={isActive("converting") ? "Converting" : "Process"}
            active={isActive("converting") || isActive("processing")}
            done={pastProcessing}
          />
          <StepLine done={pastProcessing} />
          <StepPill n={3} label="Download" active={isActive("done")} done={false} />
        </Flex>

        <Separator size="4" mb="5" />

        {stage === "idle" && (
          <DropZone onDrop={handleDrop} onClick={() => fileInputRef.current?.click()} />
        )}

        {stage === "converting" && (
          <SpinnerPanel message={<>Converting <strong>{fileName}</strong> to CSV…</>} />
        )}

        {stage === "processing" && (
          <SpinnerPanel message={<>Cleaning <strong>{fileName}</strong>…</>} />
        )}

        {stage === "error" && (
          <Flex direction="column" gap="4">
            <Callout.Root color="red">
              <Callout.Icon><X size={15} /></Callout.Icon>
              <Callout.Text>{errorMsg}</Callout.Text>
            </Callout.Root>
            <Button variant="soft" onClick={handleReset}>
              <Upload size={14} /> Try another file
            </Button>
          </Flex>
        )}

        {stage === "done" && result && (
          <Flex direction="column" gap="4">
            <Button size="3" variant="classic" onClick={handleDownload} style={{ width: "100%" }}>
              <Download size={17} /> Download Cleaned CSV
            </Button>

            <Button size="1" variant="ghost" color="gray" onClick={handleReset} style={{ width: "100%" }} mt="5">
              <Upload size={14} /> Upload New File
            </Button>

            <Separator size="4" />

            {/* Collapsible info panel */}
            <Box>
              <Flex
                align="center" justify="between"
                onClick={() => setInfoOpen((o) => !o)}
                style={{ cursor: "pointer", userSelect: "none" }}
                py="1"
              >
                <Text size="2" weight="medium" color="gray">View Processed Info</Text>
                {infoOpen
                  ? <ChevronUp  size={15} color="var(--gray-9)" />
                  : <ChevronDown size={15} color="var(--gray-9)" />
                }
              </Flex>

              {infoOpen && (
                <Flex direction="column" gap="4" mt="3">

                  {result.stats.warnings.length > 0 && (
                    <Callout.Root color="amber" size="1">
                      <Callout.Icon><AlertTriangle size={14} /></Callout.Icon>
                      <Callout.Text size="2">{result.stats.warnings.join(" · ")}</Callout.Text>
                    </Callout.Root>
                  )}

                  <Separator size="4" />

                  {/* Row counts */}
                  <Flex align="center" gap="4">
                    <Box>
                      <Text size="1" color="gray" as="div" mb="1">Input rows</Text>
                      <Text size="5" weight="bold">{result.stats.inputRows}</Text>
                    </Box>
                    <ArrowRight size={16} color="var(--gray-7)" style={{ marginTop: 14 }} />
                    <Box>
                      <Text size="1" color="gray" as="div" mb="1">Output rows</Text>
                      <Text size="5" weight="bold">{result.stats.outputRows}</Text>
                    </Box>
                  </Flex>

                  <Separator size="4" />

                  {/* Column mapping */}
                  <Box>
                    <Flex align="center" gap="2" mb="3">
                      <GitMerge size={14} color="var(--gray-9)" />
                      <Text size="2" weight="medium">Column Mapping</Text>
                    </Flex>
                    <Flex direction="column" gap="2">
                      {mappingRows.map(({ output, source, note }) => (
                        <Flex key={output} align="center" gap="2">
                          <Badge color="indigo" variant="soft" size="1"
                            style={{ minWidth: 52, justifyContent: "center" }}>
                            {output}
                          </Badge>
                          <ArrowRight size={12} color="var(--gray-7)" />
                          <Text size="2">
                            <span style={{
                              fontFamily: "monospace",
                              background: "var(--gray-3)",
                              padding: "1px 6px",
                              borderRadius: 4,
                            }}>
                              {source}
                            </span>
                          </Text>
                          {note && (
                            <Flex align="center" gap="1">
                              <Scissors size={11} color="var(--gray-8)" />
                              <Text size="1" color="gray">{note}</Text>
                            </Flex>
                          )}
                        </Flex>
                      ))}
                    </Flex>
                  </Box>

                  {/* Ignored columns */}
                  {result.stats.ignoredColumns.length > 0 && (
                    <Box>
                      <Flex align="center" gap="2" mb="2">
                        <Trash2 size={14} color="var(--gray-9)" />
                        <Text size="2" weight="medium">
                          Ignored Columns{" "}
                          <Text color="gray" size="1">({result.stats.ignoredColumns.length})</Text>
                        </Text>
                      </Flex>
                      <Flex gap="2" wrap="wrap">
                        {result.stats.ignoredColumns.map((col) => (
                          <Badge key={col} color="gray" variant="surface" size="1"
                            style={{ fontFamily: "monospace", textDecoration: "line-through", opacity: 0.6 }}>
                            {col}
                          </Badge>
                        ))}
                      </Flex>
                    </Box>
                  )}

                  <Separator size="4" />

                  {/* Preview table */}
                  <Box>
                    <Text size="2" weight="medium" as="div" mb="2">
                      Preview{" "}
                      <Text color="gray" size="1">(first {previewRows.length} of {result.rows.length} rows)</Text>
                    </Text>
                    <ScrollArea scrollbars="horizontal">
                      <Table.Root variant="surface" size="1">
                        <Table.Header>
                          <Table.Row>
                            {OUTPUT_COLUMNS.map((col) => (
                              <Table.ColumnHeaderCell key={col}>{col}</Table.ColumnHeaderCell>
                            ))}
                          </Table.Row>
                        </Table.Header>
                        <Table.Body>
                          {previewRows.map((row, i) => (
                            <Table.Row key={i}>
                              <Table.Cell>{row["First Name"] || <Text color="gray">—</Text>}</Table.Cell>
                              <Table.Cell>{row["Last Name"]  || <Text color="gray">—</Text>}</Table.Cell>
                              <Table.Cell>{row.Email || <Text color="gray">—</Text>}</Table.Cell>
                              <Table.Cell>{row.Phone || <Text color="gray">—</Text>}</Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Root>
                    </ScrollArea>
                  </Box>

                </Flex>
              )}
            </Box>
          </Flex>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </Card>

      {/* Fixed help button + dialog */}
      <HelpDialog />

      <style>{SPIN_KEYFRAMES}</style>
    </Flex>
  );
}
