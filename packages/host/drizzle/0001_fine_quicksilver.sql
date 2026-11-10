ALTER TABLE `entries` ADD `reasoning_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_calls` ADD `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `reasoning_tokens` integer DEFAULT 0 NOT NULL;