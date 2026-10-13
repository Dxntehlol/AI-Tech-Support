import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { loadKnowledge, validatePmChecklists, MIN_PM_ITEMS_PER_TEMPLATE } from "./loader.ts";
import { PM_TEMPLATE_IDS, evaluate, findTemplate, nameplateOf, parseVoltageRange, suggestPmTemplate, templateItemCount, templateSummary } from "./pm.ts";
import type { PmChecklists, PmTemplate, UnitRow } from "../types.ts";

const kb = loadKnowledge(join(PROJECT_ROOT, "knowledge"), { strict: false });

describe("pm checklists pack", () => {
  test("ships every template in DESIGN.md with ≥ 10 items, unique ids and sources", () => {
    assert.ok(kb.pm, "pm pack loaded");
    assert.deepEqual(
      kb.pm!.templates.map((t) => t.id).sort(),
      [...PM_TEMPLATE_IDS].sort(),
    );
    assert.ok(kb.pm!.sources.length >= 5);
    for (const t of kb.pm!.templates) {
      assert.ok(templateItemCount(t) >= MIN_PM_ITEMS_PER_TEMPLATE, `${t.id} has ${templateItemCount(t)} items`);
      const ids = new Set<string>();
      for (const s of t.sections) for (const i of s.items) {
        assert.ok(!ids.has(i.id), `${t.id}: duplicate ${i.id}`);
        ids.add(i.id);
      }
    }
    const rtu = findTemplate(kb.pm, "RTU_GAS")!;
    assert.equal(rtu.id, "rtu_gas");
    assert.ok(rtu.sections.some((s) => /gas heat/i.test(s.title)));
    assert.ok(templateItems(rtu).some((i) => i.nameplateCompare === "volts"));
    assert.ok(templateItems(rtu).some((i) => i.nameplateCompare === "capacitor_uf"));
    assert.ok(templateItems(rtu).some((i) => /CO air-free/i.test(i.label)));
    const chiller = findTemplate(kb.pm, "chiller_water_cooled")!;
    assert.ok(templateItems(chiller).some((i) => /approach/i.test(i.label) && /tube/i.test(i.hint ?? "")));
    assert.ok(templateItems(findTemplate(kb.pm, "ice_machine")!).some((i) => /6 months/.test(i.hint ?? "")));
    assert.ok(templateItems(findTemplate(kb.pm, "mau_exhaust")!).some((i) => /lockout/i.test(i.label)));
    assert.ok(templateItems(findTemplate(kb.pm, "boiler")!).some((i) => /low-water cutoff/i.test(i.label)));
    const summary = templateSummary(rtu);
    assert.equal(summary.itemCount, templateItemCount(rtu));
    assert.ok(summary.sections.length >= 4);
  });

  test("validatePmChecklists catches shape problems", () => {
    const problems: string[] = [];
    const bad = {
      version: "1",
      sources: [],
      templates: [
        { id: "Bad Id", name: "x", appliesTo: "y", sections: [{ title: "s", items: [{ id: "a", label: "l", kind: "check" }, { id: "a", label: "l2", kind: "weird", nameplateCompare: "volts" }] }] },
        { id: "bad_id", name: "", appliesTo: "y", sections: [] },
        { id: "bad_id", name: "dup", appliesTo: "y", sections: [{ title: "s", items: [{ id: "n", label: "l", kind: "text", asFoundAsLeft: true }] }] },
      ],
    } as unknown as PmChecklists;
    validatePmChecklists(bad, problems);
    const text = problems.join("\n");
    assert.match(text, /sources\[\]/);
    assert.match(text, /snake_case/);
    assert.match(text, /duplicate item id "a"/);
    assert.match(text, /kind must be check\|number\|text/);
    assert.match(text, /nameplateCompare only applies to number items/);
    assert.match(text, /duplicate template id/);
    assert.match(text, /sections\[\] required/);
    assert.match(text, /asFoundAsLeft only applies to number items/);
    assert.match(text, /spec minimum is 10/);
    const ok: string[] = [];
    validatePmChecklists(kb.pm, ok);
    assert.deepEqual(ok, []);
  });
});

function templateItems(t: PmTemplate) {
  return t.sections.flatMap((s) => s.items);
}

describe("nameplate references", () => {
  test("parseVoltageRange + nameplateOf", () => {
    assert.deepEqual(parseVoltageRange("208-230/3/60"), { min: 208, max: 230 });
    assert.deepEqual(parseVoltageRange("460/3/60"), { min: 460, max: 460 });
    assert.deepEqual(parseVoltageRange("575"), { min: 575, max: 575 });
    assert.equal(parseVoltageRange("unknown"), undefined);
    assert.equal(parseVoltageRange(null), undefined);
    const np = nameplateOf({ voltage: "208-230/3/60", nameplate_json: JSON.stringify({ mca: 38, mop: 50, RLA_1: "14.2", lra_1: 91, run_cap_uf: 45 }) });
    assert.deepEqual(np, { voltageMinV: 208, voltageMaxV: 230, rlaA: 14.2, capacitorUf: 45 });
    assert.deepEqual(nameplateOf({ voltage: null, nameplate_json: "not json" }), {});
  });
  test("parseVoltageRange: slash-first nameplate formats keep both voltages (208/230-3-60, 208/230/3/60)", () => {
    assert.deepEqual(parseVoltageRange("208/230-3-60"), { min: 208, max: 230 });
    assert.deepEqual(parseVoltageRange("208/230/3/60"), { min: 208, max: 230 });
    assert.deepEqual(parseVoltageRange("208-230-1-60"), { min: 208, max: 230 });
    assert.deepEqual(parseVoltageRange("460V 3PH 60HZ"), { min: 460, max: 460 });
    // 236 V on a 208/230-3-60 unit is inside the nameplate range, not 13 % over 208
    const rtu = findTemplate(kb.pm, "rtu_gas")!;
    const s = evaluate(rtu, { supply_volts: { value: 236 } }, nameplateOf({ voltage: "208/230-3-60", nameplate_json: null }));
    const volts = s.items.find((i) => i.id === "supply_volts")!;
    assert.equal(volts.status, "pass");
    assert.equal(volts.reference, "nameplate 208–230 V ±10 %");
  });
  test("nameplateOf reads blower / fan motor FLA keys", () => {
    const np = nameplateOf({ voltage: null, nameplate_json: JSON.stringify({ RLA: 14.2, "Blower FLA": 4.1, ofm_fla: 1.2 }) });
    assert.deepEqual(np, { rlaA: 14.2, blowerFlaA: 4.1, fanFlaA: 1.2 });
  });
});

describe("evaluate", () => {
  const rtu = findTemplate(kb.pm, "rtu_gas")!;
  const nameplate = { voltageMinV: 208, voltageMaxV: 230, rlaA: 14.2 };

  test("pass / fail / na per item kind; nameplate comparisons volts ±10 %, amps ≤ 110 % RLA, capacitor ±6 % (rated on the result)", () => {
    const s = evaluate(rtu, {
      filters: { value: "2× 20x25x2" },
      belt_condition: { checked: true },
      condensate: { checked: false },
      supply_volts: { value: 198 },
      comp_amps: { asFound: 16.2, asLeft: 15.9 },
      run_capacitor: { value: 41.5, rated: 45 },
      superheat: { asFound: 18, asLeft: 11 },
      co_air_free: { value: 32 },
      hx_inspection: { checked: true },
      notes: { note: "customer declined coil cleaning" },
      econ_actuator: { pass: false, note: "actuator stripped" },
    }, nameplate);
    const by = Object.fromEntries(s.items.map((i) => [i.id, i]));
    assert.equal(by.filters!.status, "pass");
    assert.equal(by.belt_condition!.status, "pass");
    assert.equal(by.condensate!.status, "fail", "unchecked safety item fails");
    assert.equal(by.evap_coil!.status, "na", "nothing recorded");
    assert.equal(by.supply_volts!.status, "pass", "198 V is within 208 − 10 %");
    assert.equal(by.supply_volts!.reference, "nameplate 208–230 V ±10 %");
    assert.equal(by.supply_volts!.deviationPct, -4.8);
    assert.equal(by.comp_amps!.status, "fail", "15.9 A as-left > 110 % of 14.2 A");
    assert.equal(by.comp_amps!.flagged, true);
    assert.equal(by.comp_amps!.asLeft, 15.9);
    assert.equal(by.run_capacitor!.status, "fail", "41.5 vs 45 µF = −7.8 %");
    assert.equal(by.run_capacitor!.deviationPct, -7.8);
    assert.equal(by.run_capacitor!.flagged, true);
    assert.equal(by.superheat!.status, "pass");
    assert.equal(by.co_air_free!.status, "pass");
    assert.equal(by.notes!.status, "pass", "a note on a text item counts as recorded");
    assert.equal(by.econ_actuator!.status, "fail", "explicit pass=false wins");
    assert.equal(by.econ_actuator!.note, "actuator stripped");
    assert.deepEqual(s.flagged, ["comp_amps", "run_capacitor"]);
    assert.deepEqual(s.fails, ["condensate", "econ_actuator", "comp_amps", "run_capacitor"]);
    assert.deepEqual(s.safetyFails, ["condensate"]);
    assert.equal(s.total, templateItemCount(rtu));
    assert.equal(s.pass + s.fail + s.na, s.total);
    assert.equal(s.templateName, rtu.name);
  });

  test("volts outside ±10 % fail; no nameplate reference → recorded numbers pass without a flag; explicit pass overrides a deviation", () => {
    const low = evaluate(rtu, { supply_volts: { value: 185 } }, nameplate);
    assert.equal(low.items.find((i) => i.id === "supply_volts")!.status, "fail");
    const high = evaluate(rtu, { supply_volts: { value: 254 } }, nameplate);
    assert.equal(high.items.find((i) => i.id === "supply_volts")!.status, "fail");
    const edge = evaluate(rtu, { supply_volts: { value: 253 } }, nameplate);
    assert.equal(edge.items.find((i) => i.id === "supply_volts")!.status, "pass");
    const noRef = evaluate(rtu, { supply_volts: { value: 185 }, comp_amps: { value: 99 } }, {});
    assert.equal(noRef.items.find((i) => i.id === "supply_volts")!.status, "pass");
    assert.equal(noRef.items.find((i) => i.id === "comp_amps")!.flagged, false);
    const forced = evaluate(rtu, { supply_volts: { value: 185, pass: true } }, nameplate);
    assert.equal(forced.items.find((i) => i.id === "supply_volts")!.status, "pass");
    assert.equal(forced.items.find((i) => i.id === "supply_volts")!.flagged, true, "the deviation is still flagged");
    const empty = evaluate(rtu, null, nameplate);
    assert.equal(empty.na, empty.total);
    const strNum = evaluate(rtu, { comp_amps: { value: "13.1" } }, nameplate);
    assert.equal(strNum.items.find((i) => i.id === "comp_amps")!.status, "pass");
    assert.equal(strNum.items.find((i) => i.id === "comp_amps")!.value, 13.1);
  });
});

describe("evaluate: blower / fan amps never use the compressor RLA", () => {
  const rtu = findTemplate(kb.pm, "rtu_gas")!;
  test("blower amps with only a compressor RLA on file → n/a asking for the motor FLA (not a pass/fail vs 14.2 A RLA)", () => {
    const s = evaluate(rtu, { blower_amps: { value: 15.8 }, comp_amps: { value: 13.1 } }, { rlaA: 14.2 });
    const blower = s.items.find((i) => i.id === "blower_amps")!;
    assert.equal(blower.status, "na");
    assert.match(blower.reference ?? "", /enter motor FLA/);
    assert.equal(blower.flagged, false);
    assert.equal(s.items.find((i) => i.id === "comp_amps")!.reference, "RLA/FLA 14.2 A (fail above 110 %)");
  });
  test("blower amps compare with the per-item rated FLA or the nameplate blower_fla (nameplateKey)", () => {
    const rated = evaluate(rtu, { blower_amps: { value: 5, rated: 4.1 } }, { rlaA: 14.2 });
    const b1 = rated.items.find((i) => i.id === "blower_amps")!;
    assert.equal(b1.status, "fail", "5 A > 110 % of 4.1 A FLA");
    assert.equal(b1.reference, "RLA/FLA 4.1 A (fail above 110 %)");
    const keyed = evaluate(rtu, { blower_amps: { value: 4 } }, { rlaA: 14.2, blowerFlaA: 4.1 });
    assert.equal(keyed.items.find((i) => i.id === "blower_amps")!.status, "pass");
    assert.equal(keyed.items.find((i) => i.id === "blower_amps")!.reference, "RLA/FLA 4.1 A (fail above 110 %)");
  });
  test("exhaust fan_motor_amps uses fan_fla, never the compressor RLA", () => {
    const t = kb.pm!.templates.find((x) => x.sections.some((sec) => sec.items.some((i) => i.id === "fan_motor_amps")))!;
    const none = evaluate(t, { fan_motor_amps: { value: 3 } }, { rlaA: 14.2 });
    assert.equal(none.items.find((i) => i.id === "fan_motor_amps")!.status, "na");
    const fan = evaluate(t, { fan_motor_amps: { value: 3 } }, { rlaA: 14.2, fanFlaA: 2.5 });
    assert.equal(fan.items.find((i) => i.id === "fan_motor_amps")!.status, "fail");
  });
});

describe("suggestPmTemplate", () => {
  const unit = (over: Partial<UnitRow>, decoded?: Record<string, unknown>): Pick<UnitRow, "heat_type" | "decoded_json" | "model" | "manufacturer"> => ({
    heat_type: null,
    decoded_json: decoded ? JSON.stringify(decoded) : null,
    model: null,
    manufacturer: null,
    ...over,
  });
  const decode = (productType: string, family = "", attrs: Record<string, string> = {}) => ({ model: [{ productType, family, attributes: attrs }] });
  test("maps product types and heat types", () => {
    assert.equal(suggestPmTemplate(unit({ heat_type: "gas" }, decode("packaged_rtu", "48TC"))).templateId, "rtu_gas");
    assert.equal(suggestPmTemplate(unit({}, decode("packaged_rtu", "48TC", { heat_type: "Natural gas" }))).templateId, "rtu_gas");
    assert.equal(suggestPmTemplate(unit({ heat_type: "electric" }, decode("packaged_rtu"))).templateId, "rtu_electric_or_cooling_only");
    assert.equal(suggestPmTemplate(unit({}, decode("packaged_rtu"))).templateId, "rtu_electric_or_cooling_only");
    assert.equal(suggestPmTemplate(unit({ heat_type: "heat pump" }, decode("packaged_rtu"))).templateId, "heat_pump");
    assert.equal(suggestPmTemplate(unit({}, decode("split_condensing_unit"))).templateId, "split_ac");
    assert.equal(suggestPmTemplate(unit({}, decode("split_heat_pump"))).templateId, "heat_pump");
    assert.equal(suggestPmTemplate(unit({}, decode("water_source_hp"))).templateId, "heat_pump");
    assert.equal(suggestPmTemplate(unit({}, decode("chiller", "CGAM air-cooled scroll chiller"))).templateId, "chiller_air_cooled");
    assert.equal(suggestPmTemplate(unit({}, decode("chiller", "CVHE CenTraVac centrifugal water-cooled"))).templateId, "chiller_water_cooled");
    assert.equal(suggestPmTemplate(unit({}, decode("refrigeration_condensing_unit"))).templateId, "walk_in_cooler");
    assert.equal(suggestPmTemplate(unit({}, decode("refrigeration_condensing_unit", "low-temp condensing unit"))).templateId, "walk_in_freezer");
    assert.equal(suggestPmTemplate(unit({}, decode("furnace"))).templateId, "rtu_gas");
    assert.equal(suggestPmTemplate(unit({ manufacturer: "Hoshizaki", model: "KM-660MAJ" })).templateId, "ice_machine");
    assert.equal(suggestPmTemplate(unit({ heat_type: "gas" })).templateId, "rtu_gas");
    const none = suggestPmTemplate(unit({}));
    assert.equal(none.templateId, null);
    assert.match(none.reason, /pick the equipment type/);
    assert.equal(suggestPmTemplate(unit({ decoded_json: "{bad" })).templateId, null);
  });
});
