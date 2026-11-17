# Order saga with Temporal, Prisma ORM and Prisma Postgres

This sample runs an order fulfilment saga as a Temporal Workflow written with the TypeScript SDK. The Activities store their state in [Prisma Postgres](https://www.prisma.io/postgres?utm_source=temporal&utm_medium=docs&utm_campaign=temporal_code_exchange) through [Prisma ORM](https://www.prisma.io/docs?utm_source=temporal&utm_medium=docs&utm_campaign=temporal_code_exchange).

It shows three things that come up as soon as an Activity writes to a database.

1. **Idempotent Activities.** Temporal runs an Activity at least once. Each write carries an idempotency key backed by a unique constraint, so a retried Activity finds the row of the earlier attempt and does not write it again.
2. **Compensation.** When a later step fails, the Workflow undoes the earlier steps in reverse order. The compensations are idempotent too.
3. **Where the database client lives.** Workflow code runs in a deterministic sandbox and cannot open connections. The Prisma ORM client is created once in the Worker and only the Activities use it.

## How the saga works

The Workflow in [`src/workflows.ts`](src/workflows.ts) calls five Activities from [`src/activities.ts`](src/activities.ts).

| Step | Activity | Write | Compensation |
| --- | --- | --- | --- |
| 1 | `createOrder` | Inserts the `Order` row with status `pending` | None, the order is kept as a record |
| 2 | `reserveInventory` | Decrements `Product.stock` and inserts an `InventoryReservation` in one transaction | `releaseInventory` |
| 3 | `chargePayment` | Inserts a `Payment` with status `charged` | `refundPayment` |
| 4 | `createShipment` | Inserts a `Shipment` and returns the tracking number | None, it is the last step that can fail |
| 5 | `completeOrder` | Sets the order to `completed` | |

If a step fails for good, the Workflow runs the registered compensations, most recent first, then sets the order to `compensated` and stores the reason. It returns `{ status: 'compensated', failureReason }` instead of failing, because a compensated order is a normal business outcome.

### Idempotency

Every step computes the same key on every attempt, `<orderId>:<step>`, and the `InventoryReservation`, `Payment` and `Shipment` tables have a unique constraint on `idempotencyKey`. The data model is in [`src/prisma/contract.prisma`](src/prisma/contract.prisma).

`chargePayment` and `createShipment` use a conditional create. Prisma ORM sends one `INSERT ... ON CONFLICT` statement and returns the stored row whether it was inserted now or by an earlier attempt:

```ts
await db.orm.public.Payment.upsert({
  create: { idempotencyKey: key, orderId: order.orderId, amountCents: order.amountCents, status: 'charged' },
  update: {},
  conflictOn: { idempotencyKey: key },
});
```

`reserveInventory` changes two tables, so it runs in a transaction. It locks the product row, returns early if the reservation already exists, and otherwise decrements the stock and inserts the reservation. A second attempt for the same order waits for the lock and then sees the committed reservation.

The compensations use a guarded update, a single `UPDATE` statement with the expected status in its `WHERE` clause. `refundPayment` only matches a payment that is still `charged`, and `releaseInventory` only matches a reservation that is still `reserved`, so the stock is returned once. The sample uses `updateAll` and `updateAndCount` for this, because `update` first selects the row and then updates it by primary key, which leaves a gap between the check and the write. Both compensations do nothing when the row does not exist. That matters because the Workflow registers each compensation before it runs the step: if an Activity commits and then times out, the Workflow cannot know whether the write happened, and the compensation has to be safe in both cases.

The workflow ID is `order-<orderId>`, so Temporal never runs two Workflow Executions for the same order at the same time.

### Simulated failures

The order input has an optional `simulate` field so you can watch both behaviours without stopping processes by hand. `crashAfterCommit` makes a step commit its write and then throw on the first attempt, as if the Worker died before reporting the result. `rejectShipment` makes `createShipment` throw a non-retryable `ApplicationFailure`. Remove the field and the `simulateCrashAfterCommit` helper when you adapt the code.

## Prerequisites

You need Node.js 22 or later and the [Temporal CLI](https://docs.temporal.io/cli#install) for the local development server. You do not need a Prisma account: `create-db` creates a temporary Prisma Postgres database that you can claim later.

## Install

```bash
npm install
```

## Set up the database

Create a Prisma Postgres database. The command writes `DATABASE_URL` to `.env`, together with a `CLAIM_URL` you can open to keep the database for longer than 24 hours.

```bash
npx create-db@latest --env .env
```

Apply the migration in [`migrations/`](migrations) and add one product with a stock of 10. A database that was created a few seconds ago can refuse the first connection, so run the command again if that happens.

```bash
npx prisma db migrate
npm run db:seed
```

[`.env.example`](.env.example) lists every variable the sample reads. `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` default to `localhost:7233` and `default`, which is what the development server uses.

## Run it locally

Start the Temporal development server in one terminal. The Web UI is at http://localhost:8233.

```bash
temporal server start-dev
```

Start the Worker in a second terminal.

```bash
npm run worker
```

Start orders from a third terminal. Each command starts one Workflow Execution, waits for it and prints the result.

```bash
# Happy path
npm run order

# Every step commits, fails its first attempt and is retried
npm run order -- --crash-after-commit

# The shipment is rejected, so the reservation and the payment are undone
npm run order -- --reject-shipment

# More units than there are in stock
npm run order -- --quantity 50
```

Read the rows back from Prisma Postgres:

```bash
npm run orders
```

```text
Order 99be0c8e-15a0-4ec3-b62c-18b6851877ee: compensated (ShipmentRejected: Carrier rejected the shipment)
┌─────────┬────────────────────────┬────────────┬───────────────────┐
│ (index) │ table                  │ status     │ detail            │
├─────────┼────────────────────────┼────────────┼───────────────────┤
│ 0       │ 'InventoryReservation' │ 'released' │ '1 x KEYBOARD-01' │
│ 1       │ 'Payment'              │ 'refunded' │ '12900 cents'     │
└─────────┴────────────────────────┴────────────┴───────────────────┘

Order 572974a8-c820-42b4-b1f8-78eb465007bc: completed
┌─────────┬────────────────────────┬────────────┬───────────────────┐
│ (index) │ table                  │ status     │ detail            │
├─────────┼────────────────────────┼────────────┼───────────────────┤
│ 0       │ 'InventoryReservation' │ 'reserved' │ '2 x KEYBOARD-01' │
│ 1       │ 'Payment'              │ 'charged'  │ '25800 cents'     │
│ 2       │ 'Shipment'             │ 'created'  │ 'TRK-18994AF8'    │
└─────────┴────────────────────────┴────────────┴───────────────────┘
```

The second order above ran with `--crash-after-commit`. Its event history in the Web UI shows `reserveInventory`, `chargePayment` and `createShipment` completing on attempt 2, and the database still has one row for each.

## Tests

```bash
npm test
```

The tests in [`test/order-saga.test.ts`](test/order-saga.test.ts) start a local Temporal test server with `@temporalio/testing`, run a real Worker and write to the database in `DATABASE_URL`. The first run downloads the test server. Every test creates its own product and order and removes them at the end. They cover:

- the happy path, with every row read back;
- a retry of each step after its write committed, where the Activity runs twice and the row count stays at one;
- a rejected shipment, where the reservation is released, the payment is refunded and the stock is back at its starting value;
- a retry of each compensation, where the stock is returned once;
- an out of stock order, where nothing is charged;
- several attempts of the same Activity running at the same time, for the reservation, the release and the payment.

`npm run typecheck` and `npm run lint` check the code.

## Changing the data model

Edit [`src/prisma/contract.prisma`](src/prisma/contract.prisma), then regenerate the typed contract, plan a migration and apply it:

```bash
npx prisma contract emit
npx prisma migration plan --name <change>
npx prisma db migrate
```

## Which connection string to use

Prisma Postgres gives you a direct connection on `db.prisma.io` and a pooled one on `pooled.db.prisma.io`. A Worker is a long-running process with its own connection pool, so use the direct connection. That is what `create-db` writes to `.env` and what this sample is tested with.

The Prisma ORM client opens connections when Activities need them, keeps at most 10, and closes the ones that have been idle for 30 seconds, so an idle Worker holds no database connections. A Worker runs up to 100 Activities at the same time by default. If your Activities are slow enough to queue for a connection, lower `maxConcurrentActivityTaskExecutions` in [`src/worker.ts`](src/worker.ts).

The pooled connection is meant for many short-lived processes, such as serverless functions. With the Prisma ORM release candidate used here, `postgres({ url })` cannot connect to the pooled host, because the client sends session settings at connection start that the pooler does not accept. If you need the pooler, create a `pg.Pool` yourself and pass it as `postgres({ contract, pg: pool })`.

`pg` prints a warning about `sslmode=require` when it connects. Changing the parameter in `DATABASE_URL` to `sslmode=verify-full` removes the warning.

## Project layout

```text
src/
  workflows.ts          The orderSaga Workflow. Imports Activity types only.
  activities.ts         Activities that read and write through Prisma ORM.
  worker.ts             Creates the Prisma ORM client and runs the Worker.
  shared.ts             Types shared by the Workflow, the Activities and the client.
  prisma/
    contract.prisma     The data model.
    contract.json       Generated by `prisma contract emit`.
    contract.d.ts       Generated by `prisma contract emit`.
    db.ts               Builds the Prisma ORM client.
  scripts/
    seed.ts             Adds the demo product.
    start-order.ts      Starts a Workflow Execution and waits for the result.
    list-orders.ts      Reads the rows back.
migrations/             The initial migration.
test/                   Workflow and Activity tests.
```

## Versions

Tested with Node.js 24, Temporal TypeScript SDK 1.25, Temporal CLI 1.10 and Prisma ORM 8.0.0-rc.23 (`@prisma/orm-postgres`) on Prisma Postgres. Prisma ORM 8 is a release candidate, so the package versions are pinned in `package.json`.
