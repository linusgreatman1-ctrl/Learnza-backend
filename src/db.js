const { PrismaClient } = require('@prisma/client');
const { AsyncLocalStorage } = require('async_hooks');

// Test/diagnostic only: LZ_QUERY_COUNT=1 makes every API response carry X-Query-Count (how many
// database operations that request ran) and X-Query-Ms (time spent in them). The performance
// test uses it to catch requests whose count grows with the amount of data (an N+1). Off in
// production, where the plain client is used untouched.
const counting = process.env.LZ_QUERY_COUNT === '1';
const requestStats = new AsyncLocalStorage();

// Transactions get 15 s (default 5 s): a slow moment on the database must not fail a sign-up halfway.
let prisma = new PrismaClient({ transactionOptions: { timeout: 15000, maxWait: 10000 } });

if (counting) {
  // A client extension runs inside the calling request's async context (Prisma's own query
  // events do not), so the per-request counter is reachable from it.
  prisma = prisma.$extends({
    query: {
      $allOperations: async ({ args, query }) => {
        const stats = requestStats.getStore();
        const started = Date.now();
        try {
          return await query(args);
        } finally {
          if (stats) { stats.queries += 1; stats.ms += Date.now() - started; }
        }
      },
    },
  });
}

module.exports = prisma;
module.exports.requestStats = requestStats;
module.exports.counting = counting;
