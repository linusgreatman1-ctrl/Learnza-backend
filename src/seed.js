require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('./db');

// The only thing seeded is the platform's SUPER_ADMIN, which is how the first school
// gets onboarded (everything else is created from the /admin panel). Idempotent: runs
// on every boot, does nothing once the account exists, and never overwrites a password
// that has since been changed. Deliberately has no default credentials -- if the env vars
// aren't set, no super admin is created rather than creating one with a guessable
// password.
async function main() {
  const email = (process.env.SEED_SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  const fullName = process.env.SEED_SUPER_ADMIN_NAME || 'Platform Owner';

  if (!email || !password) {
    console.log('SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD not set -- skipping super admin seed.');
    return;
  }
  if (password.length < 8) {
    console.error('SEED_SUPER_ADMIN_PASSWORD must be at least 8 characters -- skipping super admin seed.');
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log('Super admin already exists, skipping seed.');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: { fullName, email, passwordHash, role: 'SUPER_ADMIN', status: 'ACTIVE' },
  });
  console.log(`Super admin created: ${email}`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

module.exports = main;
