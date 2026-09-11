"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MiltonRegistrationBooking = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function slotDate(startAt) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date(startAt));
  }

  function isBookableSlot(slot, closerId, date) {
    return Boolean(slot && slot.status === "FREE" && slot.closerId === closerId && slotDate(slot.startAt) === date);
  }

  function reconcileSelection(selectedSlotId, slots, closerId, date) {
    return (slots || []).some((slot) => slot.id === selectedSlotId && isBookableSlot(slot, closerId, date))
      ? selectedSlotId
      : null;
  }

  function createResponseGate() {
    let sequence = 0;
    return {
      begin(closerId, date) { return { sequence: ++sequence, closerId, date }; },
      invalidate() { sequence += 1; },
      accepts(request, closerId, date) {
        return request.sequence === sequence && request.closerId === closerId && request.date === date;
      },
    };
  }

  function conflictDetails(error) {
    return { ...(error?.data?.details || {}), ...(error?.data || {}) };
  }

  return { slotDate, isBookableSlot, reconcileSelection, createResponseGate, conflictDetails };
});
