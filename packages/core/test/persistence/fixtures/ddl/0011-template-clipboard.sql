
ALTER TABLE templates ADD COLUMN deny_clipboard_writes INTEGER NOT NULL DEFAULT 0 CHECK (deny_clipboard_writes IN (0,1));
