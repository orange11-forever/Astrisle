import type { Budget, Commission } from '../../contracts/src/index';

export function validBudget(value: Budget): boolean {
  return (
    !!value &&
    Number.isInteger(value.maxSteps) &&
    value.maxSteps >= 1 &&
    value.maxSteps <= 10000 &&
    Number.isFinite(value.maxMinutes) &&
    value.maxMinutes >= 1 &&
    value.maxMinutes <= 1440 &&
    Number.isInteger(value.maxRework) &&
    value.maxRework >= 0 &&
    value.maxRework <= 20
  );
}

export function budgetExhausted(
  commission: Commission,
  elapsed = commission.activeMilliseconds ?? 0,
): boolean {
  return (
    commission.stepsUsed >= commission.budget.maxSteps ||
    elapsed >= commission.budget.maxMinutes * 60000
  );
}
