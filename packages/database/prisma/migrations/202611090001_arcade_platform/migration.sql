-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "arcade";

-- CreateTable
CREATE TABLE "Player" (
    "discordId" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "username" VARCHAR(80) NOT NULL,
    "avatar" TEXT,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("discordId")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "tokenHash" CHAR(64) NOT NULL,
    "playerId" VARCHAR(40) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "hash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "RoomSnapshot" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'waiting',
    "inviteHash" CHAR(64),
    "inviteExpiresAt" TIMESTAMP(3),
    "activeMatchId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomMember" (
    "roomId" UUID NOT NULL,
    "playerId" VARCHAR(40) NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "RoomMember_pkey" PRIMARY KEY ("roomId","playerId")
);

-- CreateTable
CREATE TABLE "MatchSnapshot" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "gameId" VARCHAR(40) NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "result" JSONB,
    "status" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MatchSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchAction" (
    "matchId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "requestId" UUID NOT NULL,
    "actorId" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchAction_pkey" PRIMARY KEY ("matchId","sequence")
);

-- CreateTable
CREATE TABLE "MatchParticipant" (
    "matchId" UUID NOT NULL,
    "playerId" VARCHAR(40) NOT NULL,
    "outcome" VARCHAR(20),
    "ratingDelta" INTEGER,

    CONSTRAINT "MatchParticipant_pkey" PRIMARY KEY ("matchId","playerId")
);

-- CreateTable
CREATE TABLE "PlayerStatistic" (
    "playerId" VARCHAR(40) NOT NULL,
    "gameId" VARCHAR(40) NOT NULL,
    "played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "rating" INTEGER NOT NULL DEFAULT 1000,

    CONSTRAINT "PlayerStatistic_pkey" PRIMARY KEY ("playerId","gameId")
);

-- CreateTable
CREATE TABLE "RecoveryEvent" (
    "id" UUID NOT NULL,
    "playerId" VARCHAR(40),
    "roomId" UUID,
    "matchId" UUID,
    "kind" VARCHAR(40) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestReceipt" (
    "actorId" VARCHAR(40) NOT NULL,
    "requestId" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "resourceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestReceipt_pkey" PRIMARY KEY ("actorId","requestId")
);

-- CreateTable
CREATE TABLE "EconomyOperation" (
    "id" UUID NOT NULL,
    "idempotencyKey" VARCHAR(120) NOT NULL,
    "playerId" VARCHAR(40) NOT NULL,
    "matchId" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "externalReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthSession_playerId_expiresAt_idx" ON "AuthSession"("playerId", "expiresAt");

-- CreateIndex
CREATE INDEX "RoomSnapshot_status_lastActiveAt_idx" ON "RoomSnapshot"("status", "lastActiveAt");

-- CreateIndex
CREATE INDEX "RoomMember_playerId_leftAt_idx" ON "RoomMember"("playerId", "leftAt");

-- CreateIndex
CREATE INDEX "MatchSnapshot_status_createdAt_idx" ON "MatchSnapshot"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MatchAction_matchId_requestId_key" ON "MatchAction"("matchId", "requestId");

-- CreateIndex
CREATE INDEX "MatchParticipant_playerId_matchId_idx" ON "MatchParticipant"("playerId", "matchId");

-- CreateIndex
CREATE INDEX "PlayerStatistic_gameId_rating_idx" ON "PlayerStatistic"("gameId", "rating");

-- CreateIndex
CREATE INDEX "RecoveryEvent_roomId_occurredAt_idx" ON "RecoveryEvent"("roomId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyOperation_idempotencyKey_key" ON "EconomyOperation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EconomyOperation_playerId_createdAt_idx" ON "EconomyOperation"("playerId", "createdAt");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "RoomSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAction" ADD CONSTRAINT "MatchAction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "MatchSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "MatchSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchParticipant" ADD CONSTRAINT "MatchParticipant_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerStatistic" ADD CONSTRAINT "PlayerStatistic_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;
