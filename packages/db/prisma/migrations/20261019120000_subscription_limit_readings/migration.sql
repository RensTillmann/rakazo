-- CreateTable
CREATE TABLE "subscription_limit_readings" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "five_hour_util" DOUBLE PRECISION,
    "five_hour_reset_at" TIMESTAMP(3),
    "seven_day_util" DOUBLE PRECISION,
    "seven_day_reset_at" TIMESTAMP(3),
    "status" TEXT,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_limit_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscription_limit_readings_provider_observed_at_idx" ON "subscription_limit_readings"("provider", "observed_at");
