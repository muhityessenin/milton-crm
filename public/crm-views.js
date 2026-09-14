"use strict";

(function initCrmViews(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MiltonCrmViews = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCrmViews() {
  const TODAY = "date:today";
  const PLANNED = "date:planned";

  function configuredStatuses(statuses = []) {
    return [...statuses].sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  }

  function activeStatuses(statuses = []) {
    return configuredStatuses(statuses).filter((status) => status.active !== false);
  }

  function statusById(statuses, id) {
    return configuredStatuses(statuses).find((status) => status.id === id) || null;
  }

  function paymentStatus(statuses) {
    return activeStatuses(statuses).find((status) => status.actionType === "REQUIRE_PAYMENT")
      || configuredStatuses(statuses).find((status) => status.actionType === "REQUIRE_PAYMENT")
      || null;
  }

  function hasMainCoursePayment(client) {
    return Number(client?.paymentTotal || 0) > 0;
  }

  function effectiveStatus(client, statuses) {
    // paymentTotal contains course payments only. Paid-trial money lives in
    // activeTrial.trialAmount and must never move a card to the payment column.
    if (hasMainCoursePayment(client)) return paymentStatus(statuses) || statusById(statuses, client.currentStatusId) || client.status || null;
    return statusById(statuses, client?.currentStatusId) || client?.status || null;
  }

  function trialDate(client) {
    const trial = client?.activeTrial;
    if (trial?.preferredDate) return trial.preferredDate;
    return trial?.scheduledAt ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date(trial.scheduledAt)) : null;
  }

  function isNeutralActiveTrial(client, status) {
    const trial = client?.activeTrial;
    return Boolean(trial && !trial.pendingReschedule && status && status.actionType === "NONE" && trial.statusAtBookingId === status.id);
  }

  function boardColumnKey(client, statuses, businessToday) {
    const status = effectiveStatus(client, statuses);
    if (hasMainCoursePayment(client)) return status ? `status:${status.id}` : "status:unknown";
    if (isNeutralActiveTrial(client, status)) {
      const date = trialDate(client);
      if (date === businessToday) return TODAY;
      if (!date || date > businessToday) return PLANNED;
    }
    return status ? `status:${status.id}` : "status:unknown";
  }

  function boardColumns(clients, statuses, businessToday) {
    const configured = configuredStatuses(statuses);
    const configuredIds = new Set(configured.map((status) => status.id));
    const legacyStatuses = clients.map((client) => effectiveStatus(client, statuses)).filter((status) => status?.id && !configuredIds.has(status.id));
    const uniqueLegacyStatuses = [...new Map(legacyStatuses.map((status) => [status.id, status])).values()];
    const definitions = [
      { key: TODAY, title: "Сегодняшние", color: "#14a06f", status: null },
      { key: PLANNED, title: "Запланированные", color: "#3157d5", status: null },
      ...configured.map((status) => ({ key: `status:${status.id}`, title: status.name, color: status.color || "#7c879e", status })),
      ...uniqueLegacyStatuses.map((status) => ({ key: `status:${status.id}`, title: status.name || "Другой статус", color: status.color || "#7c879e", status })),
    ];
    if (clients.some((client) => boardColumnKey(client, statuses, businessToday) === "status:unknown")) {
      definitions.push({ key: "status:unknown", title: "Без статуса", color: "#7c879e", status: null });
    }
    return definitions.map((column) => ({ ...column, clients: clients.filter((client) => boardColumnKey(client, statuses, businessToday) === column.key) }));
  }

  function groupKey(client, groupBy, statuses) {
    if (groupBy === "manager") return client.manager?.name || "Менеджер не назначен";
    if (groupBy === "closer") return client.currentCloserId ? (client.closer?.name || "Клоузер не назначен") : "Клоузер не назначен";
    if (groupBy === "date") return trialDate(client) || "Дата не указана";
    if (groupBy === "source") return client.leadSource?.name || "Источник не указан";
    return effectiveStatus(client, statuses)?.name || "Статус не указан";
  }

  function groupClients(clients, groupBy, statuses) {
    const groups = new Map();
    for (const client of clients) {
      const key = groupKey(client, groupBy, statuses);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(client);
    }
    return [...groups.entries()].map(([title, items]) => ({ title, clients: items }));
  }

  return { TODAY, PLANNED, configuredStatuses, activeStatuses, effectiveStatus, hasMainCoursePayment, trialDate, boardColumnKey, boardColumns, groupClients };
});
