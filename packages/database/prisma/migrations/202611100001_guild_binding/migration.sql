BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "arcade"."AuthSession"
  ADD COLUMN "guildId" VARCHAR(40),
  ADD COLUMN "instanceId" VARCHAR(200);
COMMIT;
