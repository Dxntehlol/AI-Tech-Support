import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectDelimiter, fieldForHeader, mapRowObject, normalizeHeader, parseImportText, tokenizeDelimited, IMPORT_ALIASES, IMPORT_FIELDS } from "./importParse.ts";

describe("header aliases", () => {
  test("every documented alias maps to its field, case-insensitively, with stray spacing and a trailing colon", () => {
    const expected: Record<string, string[]> = {
      model: ["model", "model number", "model #", "model_no"],
      serial: ["serial", "serial number", "serial #", "s/n", "sn"],
      manufacturer: ["manufacturer", "brand", "make", "mfr"],
      site: ["site", "location", "building", "customer site"],
      unit_tag: ["tag", "unit tag", "unit", "rtu", "name"],
      nickname: ["nickname"],
      customer: ["customer"],
      location_note: ["notes", "note", "location note"],
    };
    for (const [field, aliases] of Object.entries(expected)) {
      for (const a of aliases) {
        assert.equal(fieldForHeader(a), field, a);
        assert.equal(fieldForHeader(`  ${a.toUpperCase()} `), field, a.toUpperCase());
        assert.equal(fieldForHeader(`${a}:`), field, `${a}:`);
      }
    }
    assert.equal(fieldForHeader("Model   Number"), "model");
    assert.equal(fieldForHeader("model no"), "model");
    assert.equal(fieldForHeader("unit_tag"), "unit_tag");
    assert.equal(fieldForHeader("Location_Note"), "location_note");
    assert.equal(fieldForHeader("Tonnage"), null);
    assert.equal(fieldForHeader(""), null);
    assert.equal(normalizeHeader("﻿ Serial  # :"), "serial #");
  });

  test("alias table covers every field and no alias maps to two fields", () => {
    const seen = new Map<string, string>();
    for (const f of IMPORT_FIELDS) {
      assert.ok(IMPORT_ALIASES[f].length > 0, f);
      for (const a of IMPORT_ALIASES[f]) {
        const n = normalizeHeader(a);
        assert.equal(seen.get(n) ?? f, f, `${a} is ambiguous`);
        seen.set(n, f);
      }
    }
  });
});

describe("delimiter detection", () => {
  test("tab beats comma, comma beats semicolon, quoted delimiters do not count, none → whitespace", () => {
    assert.equal(detectDelimiter("model\tserial\tsite"), "\t");
    assert.equal(detectDelimiter("model,serial,site"), ",");
    assert.equal(detectDelimiter('"a,b,c"\tx'), "\t");
    assert.equal(detectDelimiter('"Pharmacy, North";x;y'), ";");
    assert.equal(detectDelimiter("\n\n  48TC 1523G\n"), "whitespace");
    assert.equal(detectDelimiter("﻿Model,Serial"), ",");
    assert.equal(detectDelimiter(""), "whitespace");
  });

  test("a semicolon inside whitespace lines does not make them semicolon-delimited", () => {
    assert.equal(detectDelimiter("48TC 123 Bldg;A RTU-1\n50XC 456 Main RTU-2"), "whitespace");
    const p = parseImportText("48TC 123 Bldg;A RTU-1\n50XC 456 Main RTU-2");
    assert.equal(p.delimiter, "whitespace");
    assert.deepEqual(p.rows.map((r) => r.values), [
      { model: "48TC", serial: "123", site: "Bldg;A", unit_tag: "RTU-1" },
      { model: "50XC", serial: "456", site: "Main", unit_tag: "RTU-2" },
    ]);
    // A recognized semicolon header, or consistently semicolon-separated lines, still use ";".
    assert.equal(detectDelimiter("Model;Serial;Site\n48TC;123;Main Street"), ";");
    assert.equal(detectDelimiter("48TC;123;Main Street;RTU-1\n50XC;456;Mall;RTU-2"), ";");
    assert.deepEqual(parseImportText("Model;Serial;Site\n48TC;123;Main Street").rows[0]!.values, { model: "48TC", serial: "123", site: "Main Street" });
  });
});

describe("RFC 4180 tokenizer", () => {
  test("quotes, escaped quotes, delimiters and newlines inside quotes, CRLF, BOM", () => {
    const text = '﻿a,"b, c","say ""hi"""\r\n"multi\r\nline",x,\r\n';
    const { records, unterminated } = tokenizeDelimited(text, ",");
    assert.equal(unterminated, false);
    assert.deepEqual(records, [
      { line: 1, cells: ["a", "b, c", 'say "hi"'] },
      { line: 2, cells: ["multi\r\nline", "x", ""] },
    ]);
  });

  test("bare CR line endings, final line without newline, quote in the middle of a field is literal", () => {
    const { records } = tokenizeDelimited('a,b\rc,d"e\rf', ",");
    assert.deepEqual(
      records.map((r) => r.cells),
      [["a", "b"], ["c", 'd"e'], ["f"]],
    );
    assert.deepEqual(
      records.map((r) => r.line),
      [1, 2, 3],
    );
  });

  test("spaces before an opening quote are tolerated", () => {
    const { records } = tokenizeDelimited('x, "Pharmacy, North" ,y', ",");
    assert.deepEqual(records[0]!.cells.map((c) => c.trim()), ["x", "Pharmacy, North", "y"]);
  });

  test("an unterminated quote is reported", () => {
    const { records, unterminated } = tokenizeDelimited('a,"oops\nb,c', ",");
    assert.equal(unterminated, true);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.cells[1], "oops\nb,c");
  });
});

describe("parseImportText", () => {
  test("CSV with header aliases, BOM, CRLF, quoted site, ignored and blank columns", () => {
    const text = '﻿Model #,S/N,Brand,Building,RTU,Tonnage,Notes\r\n48TCDA04A2A5-0A0A0,1523G12345,Carrier,"Pharmacy, North",RTU-7,3,roof hatch\r\n\r\n,,,,,,\r\nYCD150,N1J1234567,,Mall,RTU-8,,\r\n';
    const p = parseImportText(text);
    assert.equal(p.delimiter, ",");
    assert.equal(p.header, true);
    assert.deepEqual(p.columns, ["model", "serial", "manufacturer", "site", "unit_tag", null, "location_note"]);
    assert.deepEqual(p.ignoredColumns, ["Tonnage"]);
    assert.match(p.warnings.join(" "), /Ignored columns: Tonnage/);
    assert.equal(p.rows.length, 2);
    assert.deepEqual(p.rows[0], {
      line: 2,
      values: { model: "48TCDA04A2A5-0A0A0", serial: "1523G12345", manufacturer: "Carrier", site: "Pharmacy, North", unit_tag: "RTU-7", location_note: "roof hatch" },
    });
    assert.deepEqual(p.rows[1], { line: 5, values: { model: "YCD150", serial: "N1J1234567", site: "Mall", unit_tag: "RTU-8" } });
  });

  test("TSV pasted from a spreadsheet, header in any order and case", () => {
    const text = "SITE\tserial number\tMODEL NUMBER\tcustomer\tnickname\nWarehouse\tS1\tM1\tAcme\tBig one\nWarehouse\tS2\tM2\t\t\n";
    const p = parseImportText(text);
    assert.equal(p.delimiter, "\t");
    assert.equal(p.header, true);
    assert.deepEqual(p.rows.map((r) => r.values), [
      { site: "Warehouse", serial: "S1", model: "M1", customer: "Acme", nickname: "Big one" },
      { site: "Warehouse", serial: "S2", model: "M2" },
    ]);
  });

  test("a repeated column keeps the first one and warns", () => {
    const p = parseImportText("model,serial,model number\nA,1,B\n");
    assert.deepEqual(p.columns, ["model", "serial", null]);
    assert.deepEqual(p.rows[0]!.values, { model: "A", serial: "1" });
    assert.match(p.warnings.join(" "), /repeats model/);
  });

  test("headerless CSV is positional: model, serial, site, tag", () => {
    const p = parseImportText("48TCDA04A2A5-0A0A0,1523G12345,Pharmacy,RTU-7\nYCD150,N1J1234567\nZZZ,,Mall\n");
    assert.equal(p.header, false);
    assert.deepEqual(p.rows.map((r) => r.values), [
      { model: "48TCDA04A2A5-0A0A0", serial: "1523G12345", site: "Pharmacy", unit_tag: "RTU-7" },
      { model: "YCD150", serial: "N1J1234567" },
      { model: "ZZZ", site: "Mall" },
    ]);
  });

  test("a first row that only looks partly like a header is data", () => {
    // "Carrier" and the model are not aliases: no header.
    const p = parseImportText("48TC,1523G,Carrier\n");
    assert.equal(p.header, false);
    assert.equal(p.rows.length, 1);
  });

  test("plain whitespace lines: model serial [site] [tag], multi-word site", () => {
    const text = "  48TCDA04A2A5-0A0A0   1523G12345 \n\nYCD150 N1J1234567 Mall\nM3 S3 Mall RTU-3\nM4 S4 Pharmacy North Wing RTU-4\nM5\n";
    const p = parseImportText(text);
    assert.equal(p.delimiter, "whitespace");
    assert.equal(p.header, false);
    assert.deepEqual(p.rows.map((r) => [r.line, r.values]), [
      [1, { model: "48TCDA04A2A5-0A0A0", serial: "1523G12345" }],
      [3, { model: "YCD150", serial: "N1J1234567", site: "Mall" }],
      [4, { model: "M3", serial: "S3", site: "Mall", unit_tag: "RTU-3" }],
      [5, { model: "M4", serial: "S4", site: "Pharmacy North Wing", unit_tag: "RTU-4" }],
      [6, { model: "M5" }],
    ]);
  });

  test("whitespace header of single-word names is used; multi-word names are skipped with a warning", () => {
    const a = parseImportText("serial model\nS1 M1\n");
    assert.equal(a.header, true);
    assert.deepEqual(a.rows[0]!.values, { serial: "S1", model: "M1" });
    const single = parseImportText("Model\nM1\nM2\n");
    assert.equal(single.header, true);
    assert.deepEqual(single.rows.map((r) => r.values), [{ model: "M1" }, { model: "M2" }]);
    const b = parseImportText("Model Number Serial Number\nM1 S1\n");
    assert.equal(b.header, false);
    assert.deepEqual(b.rows.map((r) => r.values), [{ model: "M1", serial: "S1" }]);
    assert.match(b.warnings.join(" "), /commas or tabs/);
  });

  test("empty or blank input yields no rows; non-string input is treated as empty", () => {
    assert.equal(parseImportText("").rows.length, 0);
    assert.equal(parseImportText("\r\n \n\t\n").rows.length, 0);
    assert.equal(parseImportText("model,serial\n").rows.length, 0);
    assert.equal(parseImportText(undefined as unknown as string).rows.length, 0);
  });

  test("a wide export header with many unknown columns is still a header", () => {
    const text = "Site,Unit,Model,Serial,Tons,Volts,Refrigerant,Install Year,Filter Size\nAcme HQ,RTU-1,48TCED08A2A5,2309G12345,7.5,460,R-410A,2023,20x25\n";
    const p = parseImportText(text);
    assert.equal(p.header, true);
    assert.deepEqual(p.ignoredColumns, ["Tons", "Volts", "Refrigerant", "Install Year", "Filter Size"]);
    assert.deepEqual(p.rows.map((r) => [r.line, r.values]), [[2, { site: "Acme HQ", unit_tag: "RTU-1", model: "48TCED08A2A5", serial: "2309G12345" }]]);
    const short = parseImportText("Model,Serial,Tons,Volts,Refrigerant\n48TC,1234,3,230,R-410A\n");
    assert.equal(short.header, true);
    assert.deepEqual(short.rows.map((r) => r.values), [{ model: "48TC", serial: "1234" }]);
    // One known column is enough for a 1–2 cell row.
    assert.equal(parseImportText("Model,Tons\n48TC,3\n").header, true);
    // Data rows are not headers even when a cell happens to be an alias word.
    assert.equal(parseImportText("48TC,1234,Building,RTU-1\n").header, false);
    assert.equal(parseImportText("Model,2309G12345,7.5,460,R-410A\n").header, false);
  });

  test("whitespace header: a site column absorbs extra words; leftover values are warned about", () => {
    const p = parseImportText("model serial site tag\n48TC 1234 Main Street RTU-1\n50XC 99 Mall RTU-2\n");
    assert.equal(p.header, true);
    assert.deepEqual(p.rows.map((r) => r.values), [
      { model: "48TC", serial: "1234", site: "Main Street", unit_tag: "RTU-1" },
      { model: "50XC", serial: "99", site: "Mall", unit_tag: "RTU-2" },
    ]);
    assert.deepEqual(p.warnings, []);
    const reordered = parseImportText("tag site model\nRTU-1 North Wing East 48TC\n");
    assert.deepEqual(reordered.rows[0]!.values, { unit_tag: "RTU-1", site: "North Wing East", model: "48TC" });
    const single = parseImportText("Model Number\n48TC 123\n50XC\n");
    assert.equal(single.header, true);
    assert.deepEqual(single.rows.map((r) => r.values), [{ model: "48TC" }, { model: "50XC" }]);
    assert.match(single.warnings.join(" "), /Line 2 had more values than the header has columns/);
  });

  test("work is bounded: rows stop at maxRows, header columns and warnings are capped", () => {
    const n = 20_000;
    const wide = "model," + "tag,".repeat(n) + "\n" + "x\n".repeat(n);
    const t0 = Date.now();
    const p = parseImportText(wide, { maxRows: 200 });
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.equal(p.truncated, true);
    assert.equal(p.rows.length, 200);
    assert.equal(p.columns.length, 64);
    assert.ok(p.warnings.length <= 20, `${p.warnings.length} warnings`);
    assert.match(p.warnings.join(" "), /only the first 64 were read/);
    assert.match(p.warnings.join(" "), /more warnings/);
    const ws = parseImportText("model " + "tag ".repeat(n) + "\n" + "x\n".repeat(n), { maxRows: 200 });
    assert.equal(ws.truncated, true);
    assert.equal(ws.rows.length, 200);
    assert.ok(ws.columns.length <= 64);
    const exact = parseImportText("Model,Serial\n" + "M,S\n".repeat(200), { maxRows: 200 });
    assert.equal(exact.truncated, false);
    assert.equal(exact.rows.length, 200);
    assert.equal(parseImportText("M1 S1\nM2 S2\nM3 S3", { maxRows: 2 }).truncated, true);
    assert.equal(parseImportText("M1 S1\nM2 S2").truncated, false);
  });

  test("header-only identity requirement: a notes/site-only header is not a header", () => {
    const p = parseImportText("site,notes\nM1,S1\n");
    assert.equal(p.header, false);
    assert.equal(p.rows.length, 2);
  });
});

describe("mapRowObject", () => {
  test("maps alias keys, stringifies numbers, ignores unknown keys and non-scalars", () => {
    const m = mapRowObject({ "Model #": " 48TC ", "S/N": 1523, Brand: "Carrier", Tons: 3, tag: null, site: { x: 1 } });
    assert.deepEqual(m.values, { model: "48TC", serial: "1523", manufacturer: "Carrier" });
    assert.deepEqual(m.ignored.sort(), ["Tons", "site"]);
  });
});
