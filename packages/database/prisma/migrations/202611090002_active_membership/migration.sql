BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE UNIQUE INDEX "RoomMember_one_active_player_idx"
ON "arcade"."RoomMember" ("playerId") WHERE "leftAt" IS NULL;
COMMIT;
