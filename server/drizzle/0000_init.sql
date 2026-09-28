CREATE TYPE "public"."juno_coin_format" AS ENUM('post', 'reel');--> statement-breakpoint
CREATE TYPE "public"."juno_plan_cadence" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TABLE "juno_claims" (
	"tx_hash" varchar(66) NOT NULL,
	"log_index" integer NOT NULL,
	"kind" varchar(8) NOT NULL,
	"curve" varchar(42) NOT NULL,
	"token" varchar(42) NOT NULL,
	"account" varchar(42),
	"amount" numeric(78, 0) NOT NULL,
	"token_amount" numeric(78, 0),
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"chain_id" integer NOT NULL,
	CONSTRAINT "juno_claims_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "juno_curves" (
	"token" varchar(42) PRIMARY KEY NOT NULL,
	"curve" varchar(42) NOT NULL,
	"creator" varchar(42) NOT NULL,
	"quote" varchar(42),
	"quote_symbol" varchar(8) NOT NULL,
	"quote_decimals" smallint NOT NULL,
	"preset" smallint NOT NULL,
	"feed" varchar(42),
	"ref_symbol" varchar(16),
	"band_bps" integer DEFAULT 0 NOT NULL,
	"supply" numeric(78, 0) NOT NULL,
	"curve_supply" numeric(78, 0) NOT NULL,
	"p0" numeric(78, 0) NOT NULL,
	"cap_fp" numeric(78, 0) NOT NULL,
	"pool" varchar(42) NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" varchar(66) NOT NULL,
	"block_number" bigint NOT NULL,
	"format" "juno_coin_format" DEFAULT 'post' NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"metadata_uri" text NOT NULL,
	"description" text,
	"media_url" text,
	"poster_url" text,
	"media_mime" text,
	"media_width" integer,
	"media_height" integer,
	"metadata_fetched" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "juno_follows" (
	"follower_wallet" varchar(42) NOT NULL,
	"target_wallet" varchar(42) NOT NULL,
	"chain_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "juno_follows_follower_wallet_target_wallet_chain_id_pk" PRIMARY KEY("follower_wallet","target_wallet","chain_id")
);
--> statement-breakpoint
CREATE TABLE "juno_graduations" (
	"tx_hash" varchar(66) NOT NULL,
	"log_index" integer NOT NULL,
	"curve" varchar(42) NOT NULL,
	"token" varchar(42) NOT NULL,
	"pool" varchar(42) NOT NULL,
	"position_id" numeric(78, 0) NOT NULL,
	"token_liquidity" numeric(78, 0) NOT NULL,
	"quote_liquidity" numeric(78, 0) NOT NULL,
	"burned" numeric(78, 0) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"chain_id" integer NOT NULL,
	CONSTRAINT "juno_graduations_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "juno_index_cursor" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "juno_plans" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"token" varchar(42) NOT NULL,
	"chain_id" integer NOT NULL,
	"amount" double precision NOT NULL,
	"cadence" "juno_plan_cadence" NOT NULL,
	"target" double precision,
	"contributed" double precision DEFAULT 0 NOT NULL,
	"fills" integer DEFAULT 0 NOT NULL,
	"last_filled_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "juno_posts" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"author_wallet" varchar(42) NOT NULL,
	"chain_id" integer NOT NULL,
	"body" text NOT NULL,
	"token" varchar(42),
	"media_url" text,
	"media_mime" text,
	"parent_id" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "juno_trades" (
	"tx_hash" varchar(66) NOT NULL,
	"log_index" integer NOT NULL,
	"curve" varchar(42) NOT NULL,
	"token" varchar(42) NOT NULL,
	"trader" varchar(42) NOT NULL,
	"is_buy" boolean NOT NULL,
	"quote_amount" numeric(78, 0) NOT NULL,
	"token_amount" numeric(78, 0) NOT NULL,
	"fee_creator" numeric(78, 0) NOT NULL,
	"fee_protocol" numeric(78, 0) NOT NULL,
	"price_after" numeric(78, 0) NOT NULL,
	"sold_after" numeric(78, 0) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"chain_id" integer NOT NULL,
	CONSTRAINT "juno_trades_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "juno_watchlist" (
	"wallet" varchar(42) NOT NULL,
	"token" varchar(42) NOT NULL,
	"chain_id" integer NOT NULL,
	"alert_price" double precision,
	"alert_set_at_price" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "juno_watchlist_wallet_token_chain_id_pk" PRIMARY KEY("wallet","token","chain_id")
);
--> statement-breakpoint
CREATE INDEX "juno_claims_curve_idx" ON "juno_claims" USING btree ("curve");--> statement-breakpoint
CREATE UNIQUE INDEX "juno_curves_curve_idx" ON "juno_curves" USING btree ("curve");--> statement-breakpoint
CREATE INDEX "juno_curves_chain_created_idx" ON "juno_curves" USING btree ("chain_id","created_at");--> statement-breakpoint
CREATE INDEX "juno_curves_creator_idx" ON "juno_curves" USING btree ("chain_id","creator");--> statement-breakpoint
CREATE INDEX "juno_curves_ref_idx" ON "juno_curves" USING btree ("chain_id","ref_symbol");--> statement-breakpoint
CREATE INDEX "juno_follows_target_idx" ON "juno_follows" USING btree ("chain_id","target_wallet");--> statement-breakpoint
CREATE INDEX "juno_follows_follower_idx" ON "juno_follows" USING btree ("chain_id","follower_wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "juno_graduations_curve_idx" ON "juno_graduations" USING btree ("curve");--> statement-breakpoint
CREATE INDEX "juno_plans_wallet_idx" ON "juno_plans" USING btree ("chain_id","wallet");--> statement-breakpoint
CREATE INDEX "juno_plans_token_idx" ON "juno_plans" USING btree ("chain_id","token");--> statement-breakpoint
CREATE INDEX "juno_posts_chain_created_idx" ON "juno_posts" USING btree ("chain_id","created_at");--> statement-breakpoint
CREATE INDEX "juno_posts_author_idx" ON "juno_posts" USING btree ("author_wallet");--> statement-breakpoint
CREATE INDEX "juno_posts_token_idx" ON "juno_posts" USING btree ("token");--> statement-breakpoint
CREATE INDEX "juno_posts_parent_idx" ON "juno_posts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "juno_trades_curve_time_idx" ON "juno_trades" USING btree ("curve","block_time");--> statement-breakpoint
CREATE INDEX "juno_trades_trader_idx" ON "juno_trades" USING btree ("chain_id","trader");--> statement-breakpoint
CREATE INDEX "juno_trades_chain_time_idx" ON "juno_trades" USING btree ("chain_id","block_time");--> statement-breakpoint
CREATE INDEX "juno_watchlist_wallet_idx" ON "juno_watchlist" USING btree ("chain_id","wallet");--> statement-breakpoint
CREATE INDEX "juno_watchlist_token_idx" ON "juno_watchlist" USING btree ("chain_id","token");