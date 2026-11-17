// Types and constants shared by the workflow, the activities and the client.
// This file must stay free of Node.js and Prisma imports because the workflow
// bundle includes it.

export const TASK_QUEUE = 'order-saga';

export type SagaStep =
  | 'reserveInventory'
  | 'chargePayment'
  | 'createShipment'
  | 'releaseInventory'
  | 'refundPayment';

/** Failure switches for the demo and the tests. Leave empty for a normal order. */
export interface Simulation {
  /**
   * Steps that commit their database write and then throw on the first
   * attempt, as if the worker died before it could report the result.
   * Temporal retries the activity, which is the case idempotency protects.
   */
  crashAfterCommit?: SagaStep[];
  /** Make the carrier reject the shipment with a non-retryable failure. */
  rejectShipment?: boolean;
}

export interface OrderInput {
  orderId: string;
  customerEmail: string;
  sku: string;
  quantity: number;
  amountCents: number;
  simulate?: Simulation;
}

export interface OrderResult {
  orderId: string;
  status: 'completed' | 'compensated';
  trackingNumber?: string;
  failureReason?: string;
}

/** One key per order and step. Every attempt of a step computes the same key. */
export function idempotencyKey(orderId: string, step: SagaStep): string {
  return `${orderId}:${step}`;
}
