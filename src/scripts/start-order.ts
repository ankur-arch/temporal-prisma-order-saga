import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client, Connection } from '@temporalio/client';
import { env } from '../env';
import { TASK_QUEUE, type OrderInput, type OrderResult } from '../shared';

const { values } = parseArgs({
  options: {
    sku: { type: 'string', default: 'KEYBOARD-01' },
    quantity: { type: 'string', default: '1' },
    // Commit each write, then fail the first attempt so Temporal retries it.
    'crash-after-commit': { type: 'boolean', default: false },
    // Reject the shipment so the saga compensates.
    'reject-shipment': { type: 'boolean', default: false },
  },
});

const quantity = Number(values.quantity);
const order: OrderInput = {
  orderId: randomUUID(),
  customerEmail: 'ada@example.com',
  sku: values.sku,
  quantity,
  amountCents: 12_900 * quantity,
  simulate: {
    crashAfterCommit: values['crash-after-commit']
      ? ['reserveInventory', 'chargePayment', 'createShipment', 'releaseInventory', 'refundPayment']
      : [],
    rejectShipment: values['reject-shipment'],
  },
};

const connection = await Connection.connect({ address: env.temporalAddress });
const client = new Client({ connection, namespace: env.temporalNamespace });

// The workflow ID is derived from the order ID, so Temporal never runs two
// Workflow Executions for the same order at the same time.
const handle = await client.workflow.start('orderSaga', {
  taskQueue: TASK_QUEUE,
  workflowId: `order-${order.orderId}`,
  args: [order],
});
console.log(`Started workflow ${handle.workflowId}`);

const result: OrderResult = await handle.result();
console.log(result);

await connection.close();
