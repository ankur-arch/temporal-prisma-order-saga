import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  log,
  proxyActivities,
} from '@temporalio/workflow';
// Type-only import. Workflow code runs in an isolated, deterministic sandbox
// and must never load the Prisma client or any other Node.js module.
import type { Activities } from './activities';
import type { OrderInput, OrderResult } from './shared';

const { createOrder, reserveInventory, chargePayment, createShipment, completeOrder } = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

// Compensations keep the default retry policy, which retries until they succeed.
const { releaseInventory, refundPayment, markOrderCompensated } = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
});

export async function orderSaga(order: OrderInput): Promise<OrderResult> {
  const compensations: Array<() => Promise<void>> = [];

  await createOrder(order);

  try {
    // Each compensation is registered before its step runs. If the step
    // commits and the activity then times out, the workflow cannot tell
    // whether the write happened, so the compensation has to run either way.
    // The compensations do nothing when there is nothing to undo.
    compensations.unshift(() => releaseInventory(order));
    await reserveInventory(order);

    compensations.unshift(() => refundPayment(order));
    await chargePayment(order);

    const trackingNumber = await createShipment(order);

    await completeOrder(order.orderId);
    return { orderId: order.orderId, status: 'completed', trackingNumber };
  } catch (err) {
    const failureReason = describeFailure(err);
    log.warn('Order failed, compensating', { orderId: order.orderId, failureReason });

    // Run the compensations in a scope that a workflow cancellation cannot
    // interrupt, most recent step first.
    await CancellationScope.nonCancellable(async () => {
      for (const compensate of compensations) {
        await compensate();
      }
      await markOrderCompensated(order.orderId, failureReason);
    });

    if (isCancellation(err)) {
      throw err;
    }
    return { orderId: order.orderId, status: 'compensated', failureReason };
  }
}

function describeFailure(err: unknown): string {
  if (isCancellation(err)) {
    return 'Order cancelled';
  }
  const cause = err instanceof ActivityFailure ? err.cause : err;
  if (cause instanceof ApplicationFailure) {
    return cause.type ? `${cause.type}: ${cause.message}` : (cause.message ?? 'Unknown failure');
  }
  return cause instanceof Error ? cause.message : String(cause);
}
