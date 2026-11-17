import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities } from './activities';
import { env } from './env';
import { createDb } from './prisma/db';
import { TASK_QUEUE } from './shared';

// One Prisma ORM client for the lifetime of the worker. Its connection pool is
// shared by every activity execution.
const db = createDb(env.databaseUrl);
const connection = await NativeConnection.connect({ address: env.temporalAddress });

try {
  const worker = await Worker.create({
    connection,
    namespace: env.temporalNamespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
    activities: createActivities(db),
  });

  console.log(`Worker started on task queue "${TASK_QUEUE}" (${env.temporalAddress}). Press Ctrl+C to stop.`);
  // Resolves after SIGINT or SIGTERM, once running activities have finished.
  await worker.run();
} finally {
  await connection.close();
  await db.close();
}
