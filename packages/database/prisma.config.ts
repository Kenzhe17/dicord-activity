import { defineConfig } from 'prisma/config';
const configured = process.env['ARCADE_DATABASE_URL'];
let datasource: { url: string } | undefined;
if (configured) {
  const url = new URL(configured);
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('Arcade requires PostgreSQL');
  // All migrations, including Prisma's journal, are scoped to the Arcade namespace.
  url.searchParams.set('schema', 'arcade');
  datasource = { url: url.toString() };
}
export default defineConfig({ schema: 'prisma/schema.prisma', migrations: { path: 'prisma/migrations' }, ...(datasource ? { datasource } : {}) });
