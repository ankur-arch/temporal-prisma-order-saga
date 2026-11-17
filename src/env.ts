import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const env = {
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  temporalAddress: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233',
  temporalNamespace: process.env['TEMPORAL_NAMESPACE'] ?? 'default',
};
