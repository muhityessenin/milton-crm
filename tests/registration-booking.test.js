"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const booking = require("../public/registration-booking");

const slot = (overrides = {}) => ({
  id:"slot_16", closerId:"closer_a", status:"FREE", startAt:"2026-09-12T11:00:00.000Z", ...overrides,
});

test("a visible free slot remains the exact backend slot selection", () => {
  assert.equal(booking.reconcileSelection("slot_16", [slot()], "closer_a", "2026-09-12"), "slot_16");
});

test("changing closer or date clears a stale slot selection", () => {
  assert.equal(booking.reconcileSelection("slot_16", [slot()], "closer_b", "2026-09-12"), null);
  assert.equal(booking.reconcileSelection("slot_16", [slot()], "closer_a", "2026-09-13"), null);
});

test("an availability refresh clears a slot that became occupied", () => {
  assert.equal(booking.reconcileSelection("slot_16", [slot({ status:"BOOKED", bookedTrialId:"trial_other" })], "closer_a", "2026-09-12"), null);
});

test("late availability responses cannot replace the latest closer/date", () => {
  const gate=booking.createResponseGate(),oldRequest=gate.begin("closer_a","2026-09-12"),latest=gate.begin("closer_b","2026-09-13");
  assert.equal(gate.accepts(oldRequest,"closer_b","2026-09-13"),false);
  assert.equal(gate.accepts(latest,"closer_b","2026-09-13"),true);
});

test("PostgreSQL conflict metadata remains readable in old and new response shapes", () => {
  assert.equal(booking.conflictDetails({data:{details:{code:"SLOT_UNAVAILABLE"}}}).code,"SLOT_UNAVAILABLE");
  assert.equal(booking.conflictDetails({data:{code:"DUPLICATE_PHONE",clientId:"cl_1"}}).clientId,"cl_1");
});

test("registration is schedule-first but keeps revealed client fields during schedule changes", () => {
  assert.deepEqual(booking.registrationVisibility("NOW", false, false), { showSchedule:true, showClientFields:false });
  assert.deepEqual(booking.registrationVisibility("NOW", true, false), { showSchedule:true, showClientFields:true });
  assert.deepEqual(booking.registrationVisibility("NOW", false, true), { showSchedule:true, showClientFields:true });
});

test("unassigned registration skips schedule and immediately shows client fields", () => {
  assert.deepEqual(booking.registrationVisibility("LATER", false, false), { showSchedule:false, showClientFields:true });
});
