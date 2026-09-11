"use strict";

const TRIAL_TYPES = Object.freeze({ FREE: "FREE", PAID: "PAID" });

function validateTrialPayment(input = {}, { allowLegacyDefault = true } = {}) {
  const rawType = input.trialType == null && allowLegacyDefault ? TRIAL_TYPES.FREE : String(input.trialType || "").toUpperCase();
  if (!Object.values(TRIAL_TYPES).includes(rawType)) {
    return { error: "Выберите тип пробного урока" };
  }
  if (rawType === TRIAL_TYPES.FREE) {
    return { value: { trialType: rawType, trialAmount: 0, receipt: null } };
  }
  const amount = Number(input.trialAmount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Укажите сумму платного пробного урока больше 0" };
  if (!input.receiptDataUrl) return { error: "Прикрепите чек платного пробного урока" };
  return {
    value: {
      trialType: rawType,
      trialAmount: Math.round(amount * 100) / 100,
      receipt: { dataUrl: input.receiptDataUrl, originalName: String(input.receiptName || "receipt") },
    },
  };
}

module.exports = { TRIAL_TYPES, validateTrialPayment };
