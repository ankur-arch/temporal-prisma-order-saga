import { env } from '../env';
import { createDb } from '../prisma/db';

// Reads the rows back from Prisma Postgres. Pass an order ID to show one
// order, or no argument to show the ten most recent ones.
const orderId = process.argv[2];
const db = createDb(env.databaseUrl);

const orders = orderId
  ? await db.orm.public.Order.where({ id: orderId }).all()
  : await db.orm.public.Order.orderBy((o) => o.createdAt.desc()).limit(10).all();

for (const order of orders) {
  const [reservations, payments, shipments] = await Promise.all([
    db.orm.public.InventoryReservation.where({ orderId: order.id }).all(),
    db.orm.public.Payment.where({ orderId: order.id }).all(),
    db.orm.public.Shipment.where({ orderId: order.id }).all(),
  ]);

  console.log(`\nOrder ${order.id}: ${order.status}${order.failureReason ? ` (${order.failureReason})` : ''}`);
  const rows = [
    ...reservations.map((r) => ({ table: 'InventoryReservation', status: r.status, detail: `${r.quantity} x ${r.sku}` })),
    ...payments.map((p) => ({ table: 'Payment', status: p.status, detail: `${p.amountCents} cents` })),
    ...shipments.map((s) => ({ table: 'Shipment', status: 'created', detail: s.trackingNumber })),
  ];
  if (rows.length > 0) {
    console.table(rows);
  } else {
    console.log('  no reservation, payment or shipment rows');
  }
}

const products = await db.orm.public.Product.select('sku', 'stock').orderBy((p) => p.sku.asc()).limit(50).all();
console.log('\nStock');
console.table(products);

await db.close();
