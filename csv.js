// Minimal CSV reading/writing, enough for a class roster and a gradebook.
// Written by hand rather than pulled in as a dependency: the format we need is
// small and well defined, and this keeps the project install-free.

// Picks the delimiter by counting candidates outside quoted sections in the
// first line. Russian-locale Excel writes ";", most other tools write ",".
function detectDelimiter(firstLine) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return counts[best] > 0 ? best : ",";
}

// Parses CSV text into rows of strings. Handles quoted fields, escaped quotes
// ("" inside a quoted field), CRLF, and a leading UTF-8 BOM.
function parseCsv(text) {
  let input = String(text || "");
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1); // strip BOM
  if (input.trim() === "") return [];

  const firstLineEnd = input.search(/\r?\n/);
  const delimiter = detectDelimiter(
    firstLineEnd === -1 ? input : input.slice(0, firstLineEnd)
  );

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  row.push(field);
  rows.push(row);

  // Drop trailing blank lines
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function escapeCell(value, delimiter) {
  const text = value === null || value === undefined ? "" : String(value);
  const needsQuotes =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r");
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

// Builds CSV text. Defaults to ";" and a BOM because the usual destination is
// Excel in a Russian locale, which splits on ";" and needs the BOM to read
// Cyrillic as UTF-8. Google Sheets detects the delimiter on its own.
function toCsv(rows, { delimiter = ";", bom = true } = {}) {
  const body = rows
    .map((row) => row.map((cell) => escapeCell(cell, delimiter)).join(delimiter))
    .join("\r\n");
  return (bom ? "﻿" : "") + body + "\r\n";
}

module.exports = { parseCsv, toCsv, detectDelimiter };
