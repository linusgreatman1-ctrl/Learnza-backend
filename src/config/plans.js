// Server-side source of truth for plan pricing. The frontend only ever sends a
// plan name ("MONTHLY" | "YEARLY") -- never an amount -- so a tampered client
// request can never change what gets charged.
const PLANS = {
  MONTHLY: { label: 'Monthly', amountNaira: 10000, amountKobo: 1000000, days: 30 },
  YEARLY: { label: 'Yearly', amountNaira: 105000, amountKobo: 10500000, days: 365 },
};

function getPlan(plan) {
  const found = PLANS[plan];
  if (!found) throw new Error(`Unknown plan: ${plan}`);
  return found;
}

module.exports = { PLANS, getPlan };
