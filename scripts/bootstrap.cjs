const { PrismaClient } = require('@prisma/client');
const { randomBytes, scryptSync } = require('node:crypto');
const db = new PrismaClient();
async function main() {
  const phone = process.env.ADMIN_PHONE;
  const password = process.env.ADMIN_PASSWORD;
  if (!phone || !password || password.length < 8) throw new Error('ADMIN_PHONE va kamida 8 belgili ADMIN_PASSWORD belgilang');
  if (await db.user.count({ where: { role: 'ADMIN' } })) { console.log('Admin mavjud. O‘zgartirilmadi.'); return; }
  const salt = randomBytes(16).toString('hex');
  const passwordHash = salt + ':' + scryptSync(password, salt, 64).toString('hex');
  await db.user.create({ data: { phone, name: 'Administrator', role: 'ADMIN', passwordHash } });
  console.log('Administrator yaratildi. Demo ma’lumotlar qo‘shilmadi.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
