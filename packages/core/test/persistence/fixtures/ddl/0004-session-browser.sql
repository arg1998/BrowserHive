
ALTER TABLE sessions ADD COLUMN sandboxed INTEGER CHECK (sandboxed IN (0,1));
ALTER TABLE sessions ADD COLUMN browser_version TEXT;
