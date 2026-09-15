"use strict";

const number = (value) => Number(value || 0);
const roundMoney = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;

function latestRate(rows, ownerKey, ownerId, date, dayKey) {
  return (rows || [])
    .filter((row) => row[ownerKey] === ownerId && dayKey(row.effectiveAt) <= date)
    .sort((a, b) => String(b.effectiveAt).localeCompare(String(a.effectiveAt)))[0] || null;
}

function financeVisibility({ db, actor, hasPermission }) {
  const ids = new Set();
  if (hasPermission(actor, "finance.own")) ids.add(actor.id);
  if (hasPermission(actor, "finance.team") && actor.teamId) {
    for (const employee of db.users) if (employee.teamId === actor.teamId) ids.add(employee.id);
  }
  if (hasPermission(actor, "finance.allManagers")) for (const employee of db.users) if (employee.role === "MANAGER") ids.add(employee.id);
  if (hasPermission(actor, "finance.allClosers")) for (const employee of db.users) if (employee.role === "CLOSER") ids.add(employee.id);
  return ids;
}

function financeReport({ db, actor, hasPermission, dayKey, filters = {} }) {
  const today = dayKey(new Date()), from = filters.from || today, to = filters.to || today;
  const dateType = filters.dateType === "created" ? "created" : "payment";
  const showRefunds = filters.showRefunds === true || filters.showRefunds === "true";
  const visibleEmployeeIds = financeVisibility({ db, actor, hasPermission });
  const canViewCompanyTotals = hasPermission(actor, "finance.companyTurnover");
  const canViewAllPayments = hasPermission(actor, "finance.allPayments");
  const selectedUserId = filters.userId && visibleEmployeeIds.has(filters.userId) ? filters.userId : null;
  const activePayments = db.payments.filter((payment) => !payment.voidedAt);
  const paidByClient = new Map();
  for (const payment of activePayments) paidByClient.set(payment.clientId, number(paidByClient.get(payment.clientId)) + number(payment.amount));
  const users = new Map(db.users.map((row) => [row.id, row]));
  const clients = new Map(db.clients.map((row) => [row.id, row]));
  const methods = new Map(db.paymentMethods.map((row) => [row.id, row]));
  const statuses = new Map(db.statuses.map((row) => [row.id, row]));
  const rows = [], summaryRows = [];

  for (const payment of activePayments) {
    const client = clients.get(payment.clientId); if (!client) continue;
    const managerVisible = visibleEmployeeIds.has(payment.managerAttributionId), closerVisible = visibleEmployeeIds.has(payment.closerAttributionId);
    if (!canViewCompanyTotals && !canViewAllPayments && !managerVisible && !closerVisible) continue;
    if (selectedUserId && payment.managerAttributionId !== selectedUserId && payment.closerAttributionId !== selectedUserId) continue;
    const filterDate = dateType === "created" ? dayKey(client.createdAt) : payment.paymentDate;
    if (filterDate < from || filterDate > to) continue;
    const refund = Boolean(statuses.get(client.currentStatusId)?.isRefund);
    if (refund && !showRefunds) continue;
    const dealTotal = number(client.totalDealAmount), received = number(paidByClient.get(client.id));
    const eligible = dealTotal > 0 ? received >= dealTotal : true;
    const bankRate = latestRate(db.paymentMethodCommissionHistory, "paymentMethodId", payment.paymentMethodId, payment.paymentDate, dayKey);
    const managerRate = latestRate(db.employeeCompensationHistory, "userId", payment.managerAttributionId, payment.paymentDate, dayKey);
    const closerRate = latestRate(db.employeeCompensationHistory, "userId", payment.closerAttributionId, payment.paymentDate, dayKey);
    const gross = number(payment.amount), bankPercent = number(bankRate?.bankCommissionPercent), bankCommission = roundMoney(gross * bankPercent / 100), net = roundMoney(gross - bankCommission);
    const managerPercent = number(managerRate?.salesCommissionPercent), closerPercent = number(closerRate?.salesCommissionPercent);
    const managerEarning = eligible && (canViewCompanyTotals || canViewAllPayments || managerVisible) ? roundMoney(net * managerPercent / 100) : 0;
    const closerEarning = eligible && (canViewCompanyTotals || canViewAllPayments || closerVisible) ? roundMoney(net * closerPercent / 100) : 0;
    const row = {
      id: payment.id, clientId: client.id, clientName: client.name, gross, paymentMethodId: payment.paymentMethodId,
      paymentMethod: methods.get(payment.paymentMethodId)?.name || "—", bankCommissionPercent: bankPercent,
      bankCommission, net, managerRatePercent: managerPercent, closerRatePercent: closerPercent,
      managerRateEffectiveAt: managerRate?.effectiveAt || null, closerRateEffectiveAt: closerRate?.effectiveAt || null,
      managerEarning, closerEarning, totalSalary: roundMoney(managerEarning + closerEarning),
      managerId: payment.managerAttributionId, managerName: users.get(payment.managerAttributionId)?.name || "Удалённый сотрудник",
      closerId: payment.closerAttributionId, closerName: users.get(payment.closerAttributionId)?.name || "Удалённый сотрудник",
      managerActive: users.get(payment.managerAttributionId)?.active !== false, closerActive: users.get(payment.closerAttributionId)?.active !== false,
      paymentDate: payment.paymentDate, clientCreatedAt: client.createdAt, eligible, waitingForBalance: !eligible,
      dealTotal: dealTotal || null, received, refund,
    };
    summaryRows.push(row);
    if (canViewAllPayments || managerVisible || closerVisible) rows.push(row);
  }

  const qualifying = new Set((db.financeTrialBonusStatuses || []).map((row) => row.statusId)), trials = [], summaryTrials = [];
  if (hasPermission(actor, "finance.allTrials") || visibleEmployeeIds.size) for (const trial of db.trials) {
    if (!trial.resultAt || !trial.resultStatusId || !qualifying.has(trial.resultStatusId)) continue;
    if (!canViewCompanyTotals && !hasPermission(actor, "finance.allTrials") && !visibleEmployeeIds.has(trial.closerId)) continue;
    if (selectedUserId && trial.closerId !== selectedUserId) continue;
    const resultDate = dayKey(trial.resultAt); if (resultDate < from || resultDate > to) continue;
    const rate = latestRate(db.employeeCompensationHistory, "userId", trial.closerId, resultDate, dayKey);
    const trialRow = { id: trial.id, clientId: trial.clientId, clientName: clients.get(trial.clientId)?.name || "—", closerId: trial.closerId,
      closerName: users.get(trial.closerId)?.name || "Удалённый сотрудник", closerActive: users.get(trial.closerId)?.active !== false,
      resultAt: trial.resultAt, statusId: trial.resultStatusId, statusName: statuses.get(trial.resultStatusId)?.name || "—",
      rate: number(rate?.conductedTrialAmount), rateEffectiveAt: rate?.effectiveAt || null, bonus: number(rate?.conductedTrialAmount) };
    summaryTrials.push(trialRow);
    if (hasPermission(actor, "finance.allTrials") || visibleEmployeeIds.has(trial.closerId)) trials.push(trialRow);
  }

  const grossTurnover = roundMoney(summaryRows.reduce((sum, row) => sum + row.gross, 0));
  const bankCommissions = roundMoney(summaryRows.reduce((sum, row) => sum + row.bankCommission, 0));
  const salesSalary = roundMoney(summaryRows.reduce((sum, row) => sum + row.totalSalary, 0));
  const trialBonus = roundMoney(summaryTrials.reduce((sum, row) => sum + row.bonus, 0));
  return {
    filters: { from, to, dateType, userId: selectedUserId || "", showRefunds },
    employees: db.users.filter((employee) => visibleEmployeeIds.has(employee.id)).map((employee) => ({ id:employee.id,name:employee.name,role:employee.role,active:employee.active,teamId:employee.teamId })),
    rows, trials,
    summary: { grossTurnover, bankCommissions, net:roundMoney(grossTurnover-bankCommissions), fullyPaidDeals:new Set(summaryRows.filter((row)=>row.eligible).map((row)=>row.clientId)).size,
      prepayments:roundMoney(summaryRows.filter((row)=>row.waitingForBalance).reduce((sum,row)=>sum+row.gross,0)), waitingForBalance:new Set(summaryRows.filter((row)=>row.waitingForBalance).map((row)=>row.clientId)).size,
      salesSalary, trialBonus, salary:roundMoney(salesSalary+trialBonus), conductedTrials:summaryTrials.length },
  };
}

module.exports = { financeReport, financeVisibility, latestRate };
