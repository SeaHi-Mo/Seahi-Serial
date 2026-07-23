-- 错误主表（用于分组和去重）
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_version TEXT,
  os TEXT,
  error_hash TEXT UNIQUE,
  error_message TEXT,
  stack_trace TEXT,
  context TEXT,
  count INTEGER DEFAULT 1,
  first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 错误详情表（记录每次上报）
CREATE TABLE IF NOT EXISTS error_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  error_id INTEGER,
  app_version TEXT,
  os TEXT,
  error_message TEXT,
  stack_trace TEXT,
  context TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (error_id) REFERENCES errors(id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_errors_hash ON errors(error_hash);
CREATE INDEX IF NOT EXISTS idx_errors_last_seen ON errors(last_seen);
CREATE INDEX IF NOT EXISTS idx_error_details_error_id ON error_details(error_id);
