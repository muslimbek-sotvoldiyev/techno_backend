CREATE TYPE "BunkerPosition" AS ENUM ('LEFT', 'RIGHT');
ALTER TABLE "Order" ADD COLUMN "bunkerPosition" "BunkerPosition";
