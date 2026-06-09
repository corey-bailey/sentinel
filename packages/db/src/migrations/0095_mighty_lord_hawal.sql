ALTER TABLE "baselines" ADD COLUMN "median" real;--> statement-breakpoint
ALTER TABLE "baselines" ADD COLUMN "stddev" real;--> statement-breakpoint
ALTER TABLE "baselines" ADD COLUMN "sample_n" integer;--> statement-breakpoint
ALTER TABLE "baselines" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "baselines" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "baselines" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "regressions" ADD COLUMN "baseline_set_id" uuid;--> statement-breakpoint
ALTER TABLE "regressions" ADD COLUMN "delta_pct" real;--> statement-breakpoint
ALTER TABLE "regressions" ADD COLUMN "z_score" real;--> statement-breakpoint
ALTER TABLE "regressions" ADD COLUMN "flagged" boolean;--> statement-breakpoint
ALTER TABLE "regressions" ADD COLUMN "confidence" text;