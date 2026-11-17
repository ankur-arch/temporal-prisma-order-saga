import { env } from '../env';
import { createDb } from '../prisma/db';

const db = createDb(env.databaseUrl);

const product = await db.orm.public.Product.upsert({
  create: { sku: 'KEYBOARD-01', name: 'Mechanical keyboard', stock: 10 },
  update: { stock: 10 },
});
console.log(`Seeded ${product.sku} with stock ${product.stock}`);

await db.close();
