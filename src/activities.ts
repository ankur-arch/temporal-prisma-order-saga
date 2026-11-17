import { randomUUID } from 'node:crypto';
import { ApplicationFailure, activityInfo, log } from '@temporalio/activity';
import type { Db } from './prisma/db';
import { idempotencyKey, type OrderInput, type SagaStep } from './shared';

/**
 * Activities run in the normal Node.js environment of the worker, so this is
 * the only place that talks to the database. The worker builds one Prisma ORM
 * client and passes it in here.
 *
 * Temporal runs an activity at least once. An attempt can commit its write and
 * still be retried, for example when the worker stops before the result reaches
 * the Temporal Service. Every activity below is written so that a second
 * attempt finds the work of the first one and does not repeat it.
 */
export function createActivities(db: Db) {
  return {
    /** Inserts the order, or returns the existing row when the insert already happened. */
    async createOrder(order: OrderInput): Promise<void> {
      await db.orm.public.Order.upsert({
        create: {
          id: order.orderId,
          customerEmail: order.customerEmail,
          sku: order.sku,
          quantity: order.quantity,
          amountCents: order.amountCents,
          status: 'pending',
        },
        update: {},
      });
    },

    /**
     * Takes stock and records the reservation in one transaction. The
     * reservation row carries a unique idempotency key, so the stock is taken
     * once no matter how often this activity runs.
     */
    async reserveInventory(order: OrderInput): Promise<void> {
      const key = idempotencyKey(order.orderId, 'reserveInventory');

      await db.transaction(async (tx) => {
        // Lock the product row first. A concurrent attempt for the same order
        // waits here and then sees the reservation written by this one.
        const product = await tx.orm.public.Product.where({ sku: order.sku }).forNoKeyUpdate().first();
        if (!product) {
          throw ApplicationFailure.nonRetryable(`Unknown product ${order.sku}`, 'UnknownProduct');
        }

        const existing = await tx.orm.public.InventoryReservation.first({ idempotencyKey: key });
        if (existing) {
          log.info('Inventory already reserved, skipping', { orderId: order.orderId });
          return;
        }

        if (product.stock < order.quantity) {
          throw ApplicationFailure.nonRetryable(
            `Only ${product.stock} of ${order.sku} in stock, ${order.quantity} requested`,
            'OutOfStock',
          );
        }

        await tx.orm.public.Product.where({ sku: order.sku }).update({ stock: product.stock - order.quantity });
        await tx.orm.public.InventoryReservation.create({
          idempotencyKey: key,
          orderId: order.orderId,
          sku: order.sku,
          quantity: order.quantity,
          status: 'reserved',
        });
      });

      simulateCrashAfterCommit(order, 'reserveInventory');
    },

    /**
     * Charges the customer. A real payment provider would receive the same
     * idempotency key. The insert is a conditional create on that key: the
     * second attempt gets the row of the first one back.
     */
    async chargePayment(order: OrderInput): Promise<void> {
      const key = idempotencyKey(order.orderId, 'chargePayment');

      await db.orm.public.Payment.upsert({
        create: {
          idempotencyKey: key,
          orderId: order.orderId,
          amountCents: order.amountCents,
          status: 'charged',
        },
        update: {},
        conflictOn: { idempotencyKey: key },
      });

      simulateCrashAfterCommit(order, 'chargePayment');
    },

    /** Books the shipment and returns its tracking number. */
    async createShipment(order: OrderInput): Promise<string> {
      if (order.simulate?.rejectShipment) {
        // A business failure that no retry can fix. Temporal fails the
        // activity at once and the workflow starts compensating.
        throw ApplicationFailure.nonRetryable('Carrier rejected the shipment', 'ShipmentRejected');
      }

      const key = idempotencyKey(order.orderId, 'createShipment');
      const shipment = await db.orm.public.Shipment.upsert({
        create: {
          idempotencyKey: key,
          orderId: order.orderId,
          // Only used when the row is inserted. A retry returns the stored number.
          trackingNumber: `TRK-${randomUUID().slice(0, 8).toUpperCase()}`,
        },
        update: {},
        conflictOn: { idempotencyKey: key },
      });

      simulateCrashAfterCommit(order, 'createShipment');
      return shipment.trackingNumber;
    },

    async completeOrder(orderId: string): Promise<void> {
      await db.orm.public.Order.where({ id: orderId, status: 'pending' }).updateAndCount({ status: 'completed' });
    },

    /**
     * Compensation for reserveInventory. The update is one statement that only
     * matches a reservation that is still `reserved`, so the stock goes back
     * once. When the reservation was never written the activity does nothing,
     * which lets the workflow register the compensation before the step runs.
     */
    async releaseInventory(order: OrderInput): Promise<void> {
      const key = idempotencyKey(order.orderId, 'reserveInventory');

      await db.transaction(async (tx) => {
        const [released] = await tx.orm.public.InventoryReservation.where({
          idempotencyKey: key,
          status: 'reserved',
        }).updateAll({ status: 'released' });
        if (!released) {
          return;
        }

        const product = await tx.orm.public.Product.where({ sku: released.sku }).forNoKeyUpdate().first();
        if (product) {
          await tx.orm.public.Product.where({ sku: released.sku }).update({
            stock: product.stock + released.quantity,
          });
        }
      });

      simulateCrashAfterCommit(order, 'releaseInventory');
    },

    /** Compensation for chargePayment. Refunds a payment that is still `charged`. */
    async refundPayment(order: OrderInput): Promise<void> {
      const key = idempotencyKey(order.orderId, 'chargePayment');

      await db.orm.public.Payment.where({ idempotencyKey: key, status: 'charged' }).updateAndCount({
        status: 'refunded',
      });

      simulateCrashAfterCommit(order, 'refundPayment');
    },

    async markOrderCompensated(orderId: string, failureReason: string): Promise<void> {
      await db.orm.public.Order.where({ id: orderId, status: 'pending' }).updateAndCount({
        status: 'compensated',
        failureReason,
      });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

/**
 * Throws once, on the first attempt, after the database write has committed.
 * This reproduces a worker that dies between the commit and the completion
 * report, and forces Temporal to run the activity again.
 */
function simulateCrashAfterCommit(order: OrderInput, step: SagaStep): void {
  if (order.simulate?.crashAfterCommit?.includes(step) && activityInfo().attempt === 1) {
    throw new Error(`Simulated crash after ${step} committed`);
  }
}
