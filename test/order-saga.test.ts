import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockActivityEnvironment, TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { createActivities, type Activities } from '../src/activities';
import { env } from '../src/env';
import { createDb, type Db } from '../src/prisma/db';
import type { OrderInput, OrderResult, Simulation } from '../src/shared';

// These tests run real workflows on a local Temporal test server and write to
// the Prisma Postgres database in DATABASE_URL. Every test uses its own
// product and order, so they can run against a database that already has data.

const STOCK = 10;

let testEnv: TestWorkflowEnvironment;
let db: Db;
const skus: string[] = [];
const orderIds: string[] = [];

before(async () => {
  // The simulated failures are expected, so keep the worker logs quiet.
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  db = createDb(env.databaseUrl);
  testEnv = await TestWorkflowEnvironment.createLocal();
});

after(async () => {
  await testEnv?.teardown();
  if (orderIds.length > 0) {
    await db.orm.public.Shipment.where((s) => s.orderId.in(orderIds)).deleteAll();
    await db.orm.public.Payment.where((p) => p.orderId.in(orderIds)).deleteAll();
    await db.orm.public.InventoryReservation.where((r) => r.orderId.in(orderIds)).deleteAll();
    await db.orm.public.Order.where((o) => o.id.in(orderIds)).deleteAll();
  }
  if (skus.length > 0) {
    await db.orm.public.Product.where((p) => p.sku.in(skus)).deleteAll();
  }
  await db.close();
});

async function newOrder(overrides: Partial<OrderInput> = {}, simulate: Simulation = {}): Promise<OrderInput> {
  const sku = `TEST-${randomUUID()}`;
  skus.push(sku);
  await db.orm.public.Product.create({ sku, name: 'Test product', stock: STOCK });

  const order: OrderInput = {
    orderId: randomUUID(),
    customerEmail: 'test@example.com',
    sku,
    quantity: 2,
    amountCents: 5_000,
    simulate,
    ...overrides,
  };
  orderIds.push(order.orderId);
  return order;
}

/** Wraps the activities to count how many times Temporal invoked each one. */
function countCalls(activities: Activities) {
  const calls: Record<string, number> = {};
  const counted = Object.fromEntries(
    Object.entries(activities).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        calls[name] = (calls[name] ?? 0) + 1;
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as Activities;
  return { activities: counted, calls };
}

async function runSaga(order: OrderInput) {
  const taskQueue = `test-${randomUUID()}`;
  const { activities, calls } = countCalls(createActivities(db));
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
    activities,
  });

  const result: OrderResult = await worker.runUntil(
    testEnv.client.workflow.execute('orderSaga', {
      taskQueue,
      workflowId: `order-${order.orderId}`,
      args: [order],
    }),
  );
  return { result, calls };
}

async function readState(order: OrderInput) {
  const [orderRow, product, reservations, payments, shipments] = await Promise.all([
    db.orm.public.Order.first({ id: order.orderId }),
    db.orm.public.Product.first({ sku: order.sku }),
    db.orm.public.InventoryReservation.where({ orderId: order.orderId }).all(),
    db.orm.public.Payment.where({ orderId: order.orderId }).all(),
    db.orm.public.Shipment.where({ orderId: order.orderId }).all(),
  ]);
  return { orderRow, stock: product?.stock, reservations, payments, shipments };
}

describe('orderSaga', () => {
  it('completes an order and persists every step', async () => {
    const order = await newOrder();

    const { result } = await runSaga(order);
    const state = await readState(order);

    assert.equal(result.status, 'completed');
    assert.equal(state.orderRow?.status, 'completed');
    assert.equal(state.stock, STOCK - order.quantity);
    assert.deepEqual(state.reservations.map((r) => r.status), ['reserved']);
    assert.deepEqual(state.payments.map((p) => p.status), ['charged']);
    assert.equal(state.shipments.length, 1);
    assert.equal(state.shipments[0]?.trackingNumber, result.trackingNumber);
  });

  it('does not write twice when Temporal retries an activity that already committed', async () => {
    const order = await newOrder({}, { crashAfterCommit: ['reserveInventory', 'chargePayment', 'createShipment'] });

    const { result, calls } = await runSaga(order);
    const state = await readState(order);

    // Each step ran twice: the first attempt committed and then threw.
    assert.equal(calls.reserveInventory, 2);
    assert.equal(calls.chargePayment, 2);
    assert.equal(calls.createShipment, 2);

    // The database still holds one row per step and the stock was taken once.
    assert.equal(result.status, 'completed');
    assert.equal(state.reservations.length, 1);
    assert.equal(state.payments.length, 1);
    assert.equal(state.shipments.length, 1);
    assert.equal(state.stock, STOCK - order.quantity);
    assert.equal(state.shipments[0]?.trackingNumber, result.trackingNumber);
  });

  it('compensates the earlier steps when the shipment is rejected', async () => {
    const order = await newOrder({}, { rejectShipment: true });

    const { result, calls } = await runSaga(order);
    const state = await readState(order);

    assert.equal(result.status, 'compensated');
    assert.equal(result.failureReason, 'ShipmentRejected: Carrier rejected the shipment');
    // A non-retryable failure is not retried.
    assert.equal(calls.createShipment, 1);

    assert.equal(state.orderRow?.status, 'compensated');
    assert.equal(state.orderRow?.failureReason, 'ShipmentRejected: Carrier rejected the shipment');
    assert.deepEqual(state.reservations.map((r) => r.status), ['released']);
    assert.deepEqual(state.payments.map((p) => p.status), ['refunded']);
    assert.equal(state.shipments.length, 0);
    assert.equal(state.stock, STOCK);
  });

  it('returns the stock once when a compensation is retried', async () => {
    const order = await newOrder({}, { rejectShipment: true, crashAfterCommit: ['releaseInventory', 'refundPayment'] });

    const { result, calls } = await runSaga(order);
    const state = await readState(order);

    assert.equal(calls.releaseInventory, 2);
    assert.equal(calls.refundPayment, 2);

    assert.equal(result.status, 'compensated');
    assert.deepEqual(state.reservations.map((r) => r.status), ['released']);
    assert.deepEqual(state.payments.map((p) => p.status), ['refunded']);
    assert.equal(state.stock, STOCK);
  });

  it('compensates without charging when the product is out of stock', async () => {
    const order = await newOrder({ quantity: STOCK + 1 });

    const { result, calls } = await runSaga(order);
    const state = await readState(order);

    assert.equal(result.status, 'compensated');
    assert.match(result.failureReason ?? '', /^OutOfStock: /);
    assert.equal(calls.chargePayment, undefined);
    // The release compensation ran and found nothing to undo.
    assert.equal(calls.releaseInventory, 1);

    assert.equal(state.orderRow?.status, 'compensated');
    assert.equal(state.reservations.length, 0);
    assert.equal(state.payments.length, 0);
    assert.equal(state.stock, STOCK);
  });
});

describe('activities', () => {
  const ATTEMPTS = 5;

  /** Runs the same activity several times at once, the way overlapping retries would. */
  async function runConcurrently(activity: (order: OrderInput) => Promise<unknown>, order: OrderInput) {
    // Open the pooled connections first so the attempts really overlap.
    await Promise.all(Array.from({ length: ATTEMPTS }, () => db.orm.public.Product.first({ sku: order.sku })));
    await Promise.all(Array.from({ length: ATTEMPTS }, () => new MockActivityEnvironment().run(activity, order)));
  }

  it('reserves stock once when several attempts for the same order run at the same time', async () => {
    const order = await newOrder();
    const activities = createActivities(db);

    await runConcurrently(activities.reserveInventory, order);
    const state = await readState(order);

    assert.equal(state.reservations.length, 1);
    assert.equal(state.stock, STOCK - order.quantity);
  });

  it('returns stock once when several release attempts run at the same time', async () => {
    const order = await newOrder();
    const activities = createActivities(db);
    await new MockActivityEnvironment().run(activities.reserveInventory, order);

    await runConcurrently(activities.releaseInventory, order);
    const state = await readState(order);

    assert.deepEqual(state.reservations.map((r) => r.status), ['released']);
    assert.equal(state.stock, STOCK);
  });

  it('charges once when several attempts for the same order run at the same time', async () => {
    const order = await newOrder();
    const activities = createActivities(db);

    await runConcurrently(activities.chargePayment, order);
    const state = await readState(order);

    assert.equal(state.payments.length, 1);
  });
});
