import { describe, expect, it, vi } from "vitest";
import { createProject } from "../src/core/project";
import { useProject } from "../src/core/store";
import { parseSI } from "../src/core/units";
import {
  createApplier, createEditSession, defaultRange, nextInSeries, rangePoints, SERIES, sliderMax, sliderToValue, snapToSeries,
  stepValue, toStored, valueToSlider, withEnds,
} from "../src/editor/tune";

describe("E-series stepping", () => {
  it("has the standard table sizes", () => {
    expect(SERIES.E12).toHaveLength(12);
    expect(SERIES.E24).toHaveLength(24);
    expect(SERIES.E96).toHaveLength(96);
  });
  it("steps resistors on E24 and capacitors / inductors on E12", () => {
    expect(stepValue(4700, 1, "Ω")).toBe(5100);
    expect(stepValue(4700, -1, "Ω")).toBe(4300);
    expect(stepValue(4.7e-6, 1, "F")).toBe(5.6e-6);
    expect(stepValue(1e-3, -1, "H")).toBe(8.2e-4);
  });
  it("crosses decade boundaries both ways", () => {
    expect(stepValue(8200, 1, "F")).toBe(10000);
    expect(stepValue(1000, -1, "Ω")).toBe(910);
    expect(nextInSeries(9.1e-9, 1, "E24")).toBe(1e-8);
    expect(nextInSeries(1e-9, -1, "E12")).toBe(8.2e-10);
  });
  it("steps from where an off-series value really is", () => {
    expect(stepValue(5000, 1, "Ω")).toBe(5100);
    expect(stepValue(5000, -1, "Ω")).toBe(4700);
    expect(stepValue(parseSI("4.7k"), 1, "Ω")).toBe(5100); // parse noise does not skip a value
  });
  it("Shift steps on E96, Ctrl by decades", () => {
    expect(stepValue(1000, 1, "Ω", { shift: true })).toBe(1020);
    expect(stepValue(1000, -1, "F", { shift: true })).toBe(976);
    expect(stepValue(4.7e-6, 1, "F", { ctrl: true })).toBe(4.7e-5);
    expect(stepValue(4.7e-6, -1, "F", { ctrl: true })).toBe(4.7e-7);
    expect(stepValue(12, 1, "V", { ctrl: true })).toBe(120);
  });
  it("uses 1-2-5 increments for other units and clamps to min / max", () => {
    expect(stepValue(5, 1, "V")).toBe(5.5);
    expect(stepValue(12, 1, "V")).toBe(13);
    expect(stepValue(1000, -1, "Hz")).toBe(900);
    expect(stepValue(1000, 1, "Hz", { shift: true })).toBe(1010);
    expect(stepValue(0, -1, "V")).toBe(-1);
    expect(stepValue(0.5, -1, "V", {}, 0)).toBe(0.45);
    expect(stepValue(0, -1, "Ω", {}, 0)).toBe(0);
    expect(stepValue(98, 1, "%", {}, 0, 100)).toBe(100);
    expect(stepValue(50, 1, "%")).toBe(55);
    expect(stepValue(50, -1, "%", { shift: true })).toBe(49);
    expect(stepValue(52, 1, "%")).toBe(55); // off-grid values go to the next grid point
  });
  it("snaps to the nearest preferred value", () => {
    expect(snapToSeries(4900, "E12")).toBe(4700);
    expect(snapToSeries(9.6, "E12")).toBe(10);
  });
});

describe("stored text", () => {
  it("is compact SI that parses back to the same number", () => {
    expect(toStored(4700)).toBe("4.7k");
    expect(toStored(2.2e-5)).toBe("22u");
    expect(toStored(1e6)).toBe("1M");
    expect(toStored(0.5)).toBe("500m");
    expect(toStored(-12)).toBe("-12");
    expect(toStored(0)).toBe("0");
    for (const v of [4700, 2.2e-5, 1e6, 0.5, 8.2e-10, 1.02e3]) expect(parseSI(toStored(v))).toBeCloseTo(v, 15);
  });
});

describe("tune slider", () => {
  it("spans ÷10 to ×10 on preferred values", () => {
    const r = defaultRange(10e-6, "F");
    expect(r).toMatchObject({ kind: "series", series: "E12", lo: 1e-6, hi: 1e-4 });
    const pts = rangePoints(r);
    expect(pts[0]).toBe(1e-6);
    expect(pts[pts.length - 1]).toBe(1e-4);
    expect(pts).toHaveLength(25);
    expect(sliderMax(r)).toBe(24);
  });
  it("maps positions to values and back", () => {
    const r = defaultRange(4700, "Ω");
    const i = valueToSlider(r, 4700);
    expect(sliderToValue(r, i)).toBe(4700);
    expect(sliderToValue(r, i + 1)).toBe(5100);
    expect(sliderToValue(r, -5)).toBe(r.lo);
    expect(sliderToValue(r, 999)).toBe(r.hi);
    expect(valueToSlider(r, 5000)).toBe(i + 1); // nearest on a log scale
  });
  it("is linear for % and for zero or negative values", () => {
    const pct = defaultRange(35, "%", 0);
    expect(pct).toMatchObject({ kind: "linear", lo: 0, hi: 100 });
    expect(sliderToValue(pct, valueToSlider(pct, 35))).toBe(35);
    const v = defaultRange(0, "V");
    expect(v).toMatchObject({ kind: "linear", lo: -10, hi: 10 });
    expect(sliderToValue(v, 100)).toBe(0);
    expect(sliderToValue(v, 133)).toBe(3.3);
  });
  it("accepts edited ends only when they make sense", () => {
    const r = defaultRange(1e-6, "F");
    expect(withEnds(r, 1e-9, 1e-3)).toMatchObject({ lo: 1e-9, hi: 1e-3 });
    expect(withEnds(r, 0, 1e-3)).toBeNull();
    expect(withEnds(r, 2e-6, 1e-6)).toBeNull();
  });
});

describe("debounced apply", () => {
  const make = () => {
    const applied: string[] = [];
    const a = createApplier({ isValid: (t) => !Number.isNaN(parseSI(t)), apply: (t) => applied.push(t) });
    return { a, applied };
  };
  it("applies valid text 250 ms after the last keystroke", () => {
    vi.useFakeTimers();
    const { a, applied } = make();
    a.reset("1k");
    a.edit("4"); vi.advanceTimersByTime(100);
    a.edit("4."); vi.advanceTimersByTime(100);
    a.edit("4.7k"); vi.advanceTimersByTime(249);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual(["4.7k"]);
    vi.useRealTimers();
  });
  it("applies at once on flush, never applies invalid text and skips repeats", () => {
    vi.useFakeTimers();
    const { a, applied } = make();
    a.reset("1k");
    a.edit("4.7q");
    expect(a.flush()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual([]);
    a.edit("1k");
    expect(a.flush()).toBe(false); // already stored
    a.edit("2k");
    expect(a.flush()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(applied).toEqual(["2k"]);
    a.edit("3k"); a.cancel(); vi.advanceTimersByTime(1000);
    expect(applied).toEqual(["2k"]);
    vi.useRealTimers();
  });
});

describe("undo merging", () => {
  it("folds typing, steps and slider moves of one focus into one undo step", () => {
    const st = useProject.getState();
    const p = createProject();
    p.schematic.components.push({ id: "c1", type: "resistor", ref: "R1", position: { x: 0, y: 0 }, rotation: 0, props: { value: "1k" } });
    st.load(p);
    const before = useProject.getState().past.length;
    const s = createEditSession(() => useProject.getState().update);
    const set = (v: string) => s.commit("Edit R1 resistance", (d) => { d.schematic.components[0].props.value = v; });
    s.begin();
    set("4.7k"); set("5.1k"); set("5.6k");
    expect(useProject.getState().past.length).toBe(before + 1);
    s.begin();
    set("6.2k");
    expect(useProject.getState().past.length).toBe(before + 2);
    useProject.getState().undo();
    expect(useProject.getState().project.schematic.components[0].props.value).toBe("5.6k");
    useProject.getState().undo();
    expect(useProject.getState().project.schematic.components[0].props.value).toBe("1k");
  });
});
