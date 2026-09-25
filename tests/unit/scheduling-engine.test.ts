import { describe, expect, it } from "vitest";
import { findAvailableSlots, isSlotAvailable, type SlotSearchInput } from "@/server/scheduling/engine";
import { intersect, subtract, normalize } from "@/server/scheduling/intervals";

const tz = "Europe/Amsterdam";
const d = (iso: string) => new Date(iso);
const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "08:00", end: "18:00" }));

function base(overrides: Partial<SlotSearchInput> = {}): SlotSearchInput {
  return {
    timezone: tz,
    // Mon 16 Sep 2024 (CEST, UTC+2)
    from: d("2024-09-16T00:00:00+02:00"),
    to: d("2024-09-17T00:00:00+02:00"),
    now: d("2024-09-10T12:00:00Z"),
    durationMinutes: 60,
    granularityMinutes: 60,
    bufferMinutes: 0,
    minLeadMinutes: 0,
    openingHours: weekdays,
    closures: [],
    instructors: [
      { id: "i1", rules: [{ isRecurring: true, weekday: 1, start: "09:00", end: "12:00" }], exceptions: [], busy: [] },
    ],
    vehicles: [{ id: "v1", busy: [] }],
    requireVehicle: true,
    studentBusy: [],
    ...overrides,
  };
}

const times = (slots: { start: Date }[]) =>
  slots.map((s) => s.start.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }));

describe("interval helpers", () => {
  it("merges, intersects and subtracts", () => {
    expect(normalize([{ start: 5, end: 10 }, { start: 0, end: 6 }])).toEqual([{ start: 0, end: 10 }]);
    expect(intersect([{ start: 0, end: 10 }], [{ start: 5, end: 15 }])).toEqual([{ start: 5, end: 10 }]);
    expect(subtract([{ start: 0, end: 10 }], [{ start: 3, end: 4 }])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 10 },
    ]);
  });
});

describe("findAvailableSlots", () => {
  it("offers slots inside instructor availability and opening hours", () => {
    expect(times(findAvailableSlots(base()))).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("clips instructor availability to school opening hours", () => {
    const slots = findAvailableSlots(
      base({ openingHours: [{ weekday: 1, start: "10:00", end: "18:00" }] }),
    );
    expect(times(slots)).toEqual(["10:00", "11:00"]);
  });

  it("never double-books the instructor", () => {
    const slots = findAvailableSlots(
      base({
        instructors: [
          {
            id: "i1",
            rules: [{ isRecurring: true, weekday: 1, start: "09:00", end: "12:00" }],
            exceptions: [],
            busy: [{ start: d("2024-09-16T10:00:00+02:00"), end: d("2024-09-16T11:00:00+02:00") }],
          },
        ],
      }),
    );
    expect(times(slots)).toEqual(["09:00", "11:00"]);
  });

  it("applies the buffer around existing lessons", () => {
    const slots = findAvailableSlots(
      base({
        granularityMinutes: 15,
        bufferMinutes: 15,
        instructors: [
          {
            id: "i1",
            rules: [{ isRecurring: true, weekday: 1, start: "09:00", end: "12:00" }],
            exceptions: [],
            busy: [{ start: d("2024-09-16T10:00:00+02:00"), end: d("2024-09-16T11:00:00+02:00") }],
          },
        ],
        distinctTimes: true,
      }),
    );
    // Busy 10:00-11:00 plus 15 min buffer blocks 09:45-11:15; neither 09:00-09:45 nor 11:15-12:00 fits 60 minutes.
    expect(times(slots)).toEqual([]);
  });

  it("never double-books the vehicle and falls back to another free vehicle", () => {
    const busyVehicle = { id: "v1", busy: [{ start: d("2024-09-16T09:00:00+02:00"), end: d("2024-09-16T12:00:00+02:00") }] };
    expect(findAvailableSlots(base({ vehicles: [busyVehicle] }))).toEqual([]);
    const slots = findAvailableSlots(base({ vehicles: [busyVehicle, { id: "v2", busy: [] }] }));
    expect(slots.map((s) => s.vehicleId)).toEqual(["v2", "v2", "v2"]);
  });

  it("respects vehicle maintenance windows", () => {
    const slots = findAvailableSlots(
      base({ vehicles: [{ id: "v1", busy: [], blocked: [{ start: d("2024-09-16T09:30:00+02:00"), end: d("2024-09-16T10:30:00+02:00") }] }] }),
    );
    expect(times(slots)).toEqual(["11:00"]);
  });

  it("never double-books the student", () => {
    const slots = findAvailableSlots(
      base({ studentBusy: [{ start: d("2024-09-16T09:00:00+02:00"), end: d("2024-09-16T10:00:00+02:00") }] }),
    );
    expect(times(slots)).toEqual(["10:00", "11:00"]);
  });

  it("filters by student preferred availability when set", () => {
    const slots = findAvailableSlots(base({ studentPreferences: [{ weekday: 1, start: "10:30", end: "12:00" }] }));
    expect(times(slots)).toEqual(["11:00"]);
  });

  it("skips closure days and honours unavailable exceptions", () => {
    expect(findAvailableSlots(base({ closures: [{ startsOn: "2024-09-16", endsOn: "2024-09-16" }] }))).toEqual([]);
    const slots = findAvailableSlots(
      base({
        instructors: [
          {
            id: "i1",
            rules: [{ isRecurring: true, weekday: 1, start: "09:00", end: "12:00" }],
            exceptions: [{ kind: "unavailable", start: d("2024-09-16T09:00:00+02:00"), end: d("2024-09-16T11:00:00+02:00") }],
            busy: [],
          },
        ],
      }),
    );
    expect(times(slots)).toEqual(["11:00"]);
  });

  it("supports one-off availability and 'available' exceptions", () => {
    const slots = findAvailableSlots(
      base({
        instructors: [
          {
            id: "i1",
            rules: [{ isRecurring: false, specificDate: "2024-09-16", start: "14:00", end: "15:00" }],
            exceptions: [{ kind: "available", start: d("2024-09-16T16:00:00+02:00"), end: d("2024-09-16T17:00:00+02:00") }],
            busy: [],
          },
        ],
      }),
    );
    expect(times(slots)).toEqual(["14:00", "16:00"]);
  });

  it("enforces minimum booking lead time", () => {
    const slots = findAvailableSlots(base({ now: d("2024-09-16T08:30:00+02:00"), minLeadMinutes: 120 }));
    expect(times(slots)).toEqual(["11:00"]);
  });

  it("interprets local rules correctly across DST", () => {
    // Monday 28 Oct 2024 is after the DST change (CET, UTC+1): 09:00 local = 08:00Z.
    const slots = findAvailableSlots(
      base({ from: d("2024-10-28T00:00:00+01:00"), to: d("2024-10-29T00:00:00+01:00") }),
    );
    expect(slots[0]!.start.toISOString()).toBe("2024-10-28T08:00:00.000Z");
  });

  it("prefers the student's primary instructor and dedupes by time", () => {
    const rule = [{ isRecurring: true, weekday: 1, start: "09:00", end: "10:00" }];
    const slots = findAvailableSlots(
      base({
        instructors: [
          { id: "a", rules: rule, exceptions: [], busy: [] },
          { id: "b", rules: rule, exceptions: [], busy: [] },
        ],
        vehicles: [{ id: "v1", busy: [] }, { id: "v2", busy: [] }],
        preferredInstructorId: "b",
        distinctTimes: true,
      }),
    );
    expect(slots).toHaveLength(1);
    expect(slots[0]!.instructorId).toBe("b");
  });

  it("isSlotAvailable re-validates a specific slot", () => {
    const input = base();
    const [slot] = findAvailableSlots(input);
    expect(isSlotAvailable(input, slot!)).toBe(true);
    const taken = { ...input, studentBusy: [{ start: slot!.start, end: slot!.end }] };
    expect(isSlotAvailable(taken, slot!)).toBe(false);
  });
});
