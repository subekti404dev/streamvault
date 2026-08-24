CREATE TABLE `torrent_verdicts` (
	`infohash` text PRIMARY KEY NOT NULL,
	`verified` integer NOT NULL,
	`safe` integer NOT NULL,
	`reason` text,
	`name` text,
	`file_count` integer NOT NULL DEFAULT 0,
	`checked_at` text NOT NULL DEFAULT (datetime('now'))
);