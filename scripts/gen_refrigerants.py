#!/usr/bin/env python3
"""Generate saturated pressure-temperature tables for knowledge/refrigerants/.

Requires CoolProp (pip install CoolProp). Output: one JSON per refrigerant with
bubble (saturated liquid) and dew (saturated vapor) pressures in psig at sea level,
from -60 F to 160 F in 1 F steps (clipped just below the critical temperature), plus
_generated_meta.json describing how each table was produced. index.json (safety
class, GWP, service notes) is maintained by hand and merges these compositions.

Blends that CoolProp does not ship as predefined mixtures are built from their
ASHRAE mass-fraction compositions (converted to mole fractions). Where CoolProp lacks
binary interaction parameters for a pair, a linear mixing rule is applied and the
table is flagged approximate.
"""
import json
import math
import os
import sys

try:
    import CoolProp.CoolProp as CP
except ImportError:  # pragma: no cover
    sys.exit("CoolProp is required: pip install CoolProp")

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "knowledge", "refrigerants")
PSI_PER_PA = 1 / 6894.757293168
ATM_PSI = 14.695949
T_MIN_F, T_MAX_F = -60, 160

# Predefined fluids/mixtures in CoolProp (name -> CoolProp fluid string)
PURE = {
    "R-22": "R22", "R-410A": "R410A", "R-134a": "R134a", "R-407C": "R407C", "R-404A": "R404A",
    "R-507A": "R507A", "R-32": "R32", "R-1234yf": "R1234yf", "R-1234ze(E)": "R1234ze(E)",
    "R-290": "R290", "R-600a": "R600a", "R-717": "R717", "R-744": "R744", "R-123": "R123",
    "R-11": "R11", "R-12": "R12", "R-1233zd(E)": "R1233zd(E)", "R-245fa": "R245fa", "R-152a": "R152A",
    "R-23": "R23",
}
KIND = {"R-410A": "zeotrope", "R-407C": "zeotrope", "R-404A": "zeotrope", "R-507A": "azeotrope"}
# ASHRAE 34: 400-series = zeotrope, 500-series = azeotrope (type is by designation, not by measured glide)
BLEND_TCRIT_F = {  # published critical temperatures, °F (manufacturer / ASHRAE data)
    "R-454B": 172.3, "R-448A": 181.6, "R-449A": 180.0, "R-407A": 180.1, "R-407F": 180.1, "R-452A": 167.2,
    "R-513A": 205.5, "R-422D": 174.9, "R-438A": 183.9, "R-417A": 191.5, "R-421A": 180.3, "R-422B": 183.0,
    "R-427A": 186.8, "R-434A": 175.1, "R-454A": 189.5, "R-454C": 187.9, "R-455A": 185.4, "R-450A": 220.5,
    "R-515B": 226.4, "R-502": 179.9, "R-500": 221.9, "R-408A": 182.5, "R-402A": 167.2, "R-401A": 226.0, "R-409A": 224.4,
}

# Blends built from mass fractions (ASHRAE 34 nominal compositions)
BLENDS = {
    "R-454B": [("R32", 68.9), ("R1234yf", 31.1)],
    "R-448A": [("R32", 26.0), ("R125", 26.0), ("R1234yf", 20.0), ("R134a", 21.0), ("R1234ze(E)", 7.0)],
    "R-449A": [("R32", 24.3), ("R125", 24.7), ("R1234yf", 25.3), ("R134a", 25.7)],
    "R-407A": [("R32", 20.0), ("R125", 40.0), ("R134a", 40.0)],
    "R-407F": [("R32", 30.0), ("R125", 30.0), ("R134a", 40.0)],
    "R-452A": [("R32", 11.0), ("R125", 59.0), ("R1234yf", 30.0)],
    "R-513A": [("R1234yf", 56.0), ("R134a", 44.0)],
    "R-422D": [("R125", 65.1), ("R134a", 31.5), ("R600a", 3.4)],
    "R-438A": [("R32", 8.5), ("R125", 45.0), ("R134a", 41.0), ("R600", 1.7), ("R601a", 0.6)],
    "R-417A": [("R125", 46.6), ("R134a", 50.0), ("R600", 3.4)],
    "R-421A": [("R125", 58.0), ("R134a", 42.0)],
    "R-422B": [("R125", 55.0), ("R134a", 42.0), ("R600a", 3.0)],
    "R-427A": [("R32", 15.0), ("R125", 25.0), ("R143a", 10.0), ("R134a", 50.0)],
    "R-434A": [("R125", 63.2), ("R143a", 18.0), ("R134a", 16.0), ("R600a", 2.8)],
    "R-454A": [("R32", 35.0), ("R1234yf", 65.0)],
    "R-454C": [("R32", 21.5), ("R1234yf", 78.5)],
    "R-455A": [("CO2", 3.0), ("R32", 21.5), ("R1234yf", 75.5)],
    "R-450A": [("R134a", 42.0), ("R1234ze(E)", 58.0)],
    "R-515B": [("R1234ze(E)", 91.1), ("R227ea", 8.9)],
    "R-502": [("R22", 48.8), ("R115", 51.2)],
    "R-500": [("R12", 73.8), ("R152A", 26.2)],
    "R-408A": [("R125", 7.0), ("R143a", 46.0), ("R22", 47.0)],
    "R-402A": [("R125", 60.0), ("R290", 2.0), ("R22", 38.0)],
    "R-401A": [("R22", 53.0), ("R152A", 13.0), ("R124", 34.0)],
    "R-409A": [("R22", 60.0), ("R124", 25.0), ("R142b", 15.0)],
}


def f_to_k(f):
    return (f - 32.0) * 5.0 / 9.0 + 273.15


def k_to_f(k):
    return (k - 273.15) * 9.0 / 5.0 + 32.0


def pa_to_psig(pa):
    return pa * PSI_PER_PA - ATM_PSI


def mole_fractions(comp):
    ms = [w / CP.PropsSI("molemass", f) for f, w in comp]
    s = sum(ms)
    return [m / s for m in ms]


def blend_string(comp):
    x = mole_fractions(comp)
    return "HEOS::" + "&".join(f"{f}[{xi:.8f}]" for (f, _), xi in zip(comp, x))


def try_props(fluid):
    """Return True if bubble/dew evaluate at 40 F."""
    T = f_to_k(40)
    CP.PropsSI("P", "T", T, "Q", 0, fluid)
    CP.PropsSI("P", "T", T, "Q", 1, fluid)
    return True


def pair_ok(a, b):
    try:
        CP.PropsSI("P", "T", f_to_k(40), "Q", 0, f"HEOS::{a}[0.5]&{b}[0.5]")
        return True
    except Exception as e:
        return "binary pair" not in str(e)


def prepare_blend(name, comp):
    """Return (fluid string, list of pairs that needed an approximate mixing rule)."""
    approx = []
    names = [f for f, _ in comp]
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            if not pair_ok(a, b):
                try:
                    CP.apply_simple_mixing_rule(a, b, "linear")
                    approx.append(f"{a}/{b}")
                except Exception as e:  # pragma: no cover
                    print(f"  {name}: could not apply mixing rule for {a}/{b}: {str(e)[:80]}", file=sys.stderr)
    fluid = blend_string(comp)
    try_props(fluid)
    return fluid, approx


def _sat_point(fluid, tf, guess_pb=None, guess_pd=None):
    """Bubble/dew psig at tf (°F). Tries T,Q first; on failure for mixtures, bisects on pressure with P,Q → T."""
    T = f_to_k(tf)
    try:
        pb = pa_to_psig(CP.PropsSI("P", "T", T, "Q", 0, fluid))
        pd = pa_to_psig(CP.PropsSI("P", "T", T, "Q", 1, fluid))
        if math.isfinite(pb) and math.isfinite(pd):
            return pb, pd
    except Exception:
        pass
    if guess_pb is None:
        return None

    def solve(q, guess):
        lo, hi = guess * 0.98, guess * 1.15
        try:
            for _ in range(60):
                mid = 0.5 * (lo + hi)
                t = k_to_f(CP.PropsSI("T", "P", (mid + ATM_PSI) / PSI_PER_PA, "Q", q, fluid))
                if abs(t - tf) < 0.01:
                    return mid
                if t < tf:
                    lo = mid
                else:
                    hi = mid
            return 0.5 * (lo + hi)
        except Exception:
            return None

    pb = solve(0, guess_pb)
    pd = solve(1, guess_pd)
    if pb is None or pd is None:
        return None
    return pb, pd


def sat_table(fluid, is_blend):
    tcrit_f = None
    tmax = T_MAX_F
    if not is_blend:
        tcrit_f = k_to_f(CP.PropsSI("Tcrit", fluid))
        tmax = min(T_MAX_F, math.floor(tcrit_f) - 1)
    temps, bub, dew = [], [], []
    extrapolated_above = None
    for tf in range(T_MIN_F, tmax + 1):
        pt = _sat_point(fluid, tf, bub[-1] if bub else None, dew[-1] if dew else None)
        if pt is None:
            if temps and tf > 100:
                break
            continue
        pb, pd = pt
        if pb < pd - 0.05 or (temps and (pb <= bub[-1] or pd <= dew[-1])):
            if temps and tf > 100:
                break
            continue
        temps.append(tf)
        bub.append(round(pb, 2))
        dew.append(round(pd, 2))
    # Extrapolate blends that stopped short of 150 F with a Clausius-Clapeyron fit (ln P vs 1/T) of the last 10 points.
    if is_blend and temps and temps[-1] < 150:
        extrapolated_above = temps[-1]
        n = min(10, len(temps))
        xs = [1.0 / f_to_k(t) for t in temps[-n:]]
        for col in (bub, dew):
            ys = [math.log(p + ATM_PSI) for p in col[-n:]]
            mx, my = sum(xs) / n, sum(ys) / n
            slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
            col.append(slope)  # stash slope temporarily
        sb, sd = bub.pop(), dew.pop()
        ib = math.log(bub[-1] + ATM_PSI) - sb / f_to_k(temps[-1])
        idd = math.log(dew[-1] + ATM_PSI) - sd / f_to_k(temps[-1])
        for tf in range(temps[-1] + 1, 151):
            invT = 1.0 / f_to_k(tf)
            temps.append(tf)
            bub.append(round(math.exp(sb * invT + ib) - ATM_PSI, 2))
            dew.append(round(math.exp(sd * invT + idd) - ATM_PSI, 2))
    return temps, bub, dew, tcrit_f, extrapolated_above


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = []
    targets = [(n, f, None) for n, f in PURE.items()] + [(n, None, c) for n, c in BLENDS.items()]
    for name, fluid, comp in targets:
        approx = []
        kind = "pure"
        try:
            if comp is not None:
                fluid, approx = prepare_blend(name, comp)
                kind = "azeotrope" if name.startswith("R-5") else "zeotrope"
            elif name in KIND:
                kind = KIND[name]
            temps, bub, dew, tcrit_f, extrapolated_above = sat_table(fluid, comp is not None)
        except Exception as e:
            print(f"SKIP {name}: {str(e)[:120]}", file=sys.stderr)
            continue
        if len(temps) < 50:
            print(f"SKIP {name}: only {len(temps)} points", file=sys.stderr)
            continue
        # glide at 40 F evaporating (dew temp at bubble pressure minus 40 F)
        glide = None
        try:
            i = temps.index(40)
            pb = bub[i]
            Td = CP.PropsSI("T", "P", (pb + ATM_PSI) / PSI_PER_PA, "Q", 1, fluid)
            glide = round(k_to_f(Td) - 40.0, 1)
        except Exception:
            pass
        if tcrit_f is None and name in BLEND_TCRIT_F:
            tcrit_f = BLEND_TCRIT_F[name]
        table = {"id": name, "tempF": temps, "bubblePsig": bub, "dewPsig": dew}
        fname = name.replace("(", "").replace(")", "").replace("/", "-") + ".json"
        with open(os.path.join(OUT, fname), "w") as fh:
            json.dump(table, fh, separators=(",", ":"))
        entry = {
            "id": name,
            "file": fname,
            "type": kind,
            "criticalTempF": round(tcrit_f, 1) if tcrit_f is not None else None,
            "glideF": glide,
            "points": len(temps),
            "coolprop": fluid if comp is None else "mass-fraction mixture",
        }
        if comp is not None:
            entry["composition"] = [{"component": c, "massPercent": w} for c, w in comp]
        if approx:
            entry["approximate"] = True
            entry["approximatePairs"] = approx
        if extrapolated_above is not None:
            entry["extrapolatedAboveF"] = extrapolated_above
        entry["tableSource"] = "coolprop_predefined" if comp is None else ("coolprop_mixture_approx" if approx else "coolprop_mixture")
        meta.append(entry)
        flag = " (approx)" if approx else ""
        print(f"{name}: {len(temps)} pts, 40F bubble {bub[temps.index(40)] if 40 in temps else '-'} psig, glide {glide}{flag}")
    with open(os.path.join(OUT, "_generated_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print(f"wrote {len(meta)} tables to {OUT}")


if __name__ == "__main__":
    main()
