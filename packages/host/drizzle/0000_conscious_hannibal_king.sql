CREATE TABLE `agent_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`role` text,
	`alias` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`think` integer,
	`num_ctx` integer,
	`chars_per_token` real,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`handle` text NOT NULL,
	`type` text NOT NULL,
	`round` integer NOT NULL,
	`author` text NOT NULL,
	`created_at` text NOT NULL,
	`supersedes` text,
	`status` text NOT NULL,
	`content` text NOT NULL,
	`parents_json` text NOT NULL,
	`payload_json` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entries_run_seq` ON `entries` (`run_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `entries_run_handle` ON `entries` (`run_id`,`handle`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`at` text NOT NULL,
	`round` integer,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_run_seq` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`round` integer,
	`role` text NOT NULL,
	`model_id` text NOT NULL,
	`billing` text NOT NULL,
	`at` text NOT NULL,
	`outcome` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`cost_usd` real,
	`estimate_chars` integer,
	`estimate_chars_per_token` real,
	`estimate_tokens` integer,
	`actual_input_tokens` integer,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`max_output_tokens` integer,
	`system` text,
	`prompt` text,
	`response_json` text,
	`error` text,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'trace' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_calls_billing_at` ON `model_calls` (`billing`,`at`);--> statement-breakpoint
CREATE INDEX `model_calls_model_billing_at` ON `model_calls` (`model_id`,`billing`,`at`);--> statement-breakpoint
CREATE INDEX `model_calls_run_at` ON `model_calls` (`run_id`,`at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`problem_content` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`profile_name` text,
	`config_json` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`rounds` integer DEFAULT 0 NOT NULL,
	`entries` integer DEFAULT 0 NOT NULL,
	`elapsed_ms` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL
);
