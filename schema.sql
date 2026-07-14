-- 加班打卡系统数据库 Schema (Cloudflare D1)

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    monthly_salary REAL DEFAULT 0,
    standard_on_time TEXT DEFAULT '09:00',
    standard_off_time TEXT DEFAULT '18:00',
    lunch_start TEXT DEFAULT '12:00',
    lunch_end TEXT DEFAULT '13:00',
    dinner_start TEXT DEFAULT '17:30',
    dinner_end TEXT DEFAULT '18:30',
    created_at TEXT DEFAULT (datetime('now'))
);

-- 会话表 (登录token)
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 加班记录表
CREATE TABLE IF NOT EXISTS overtime_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,              -- YYYY-MM-DD
    off_time TEXT NOT NULL,          -- HH:MM 下班时间
    work_start TEXT,                 -- HH:MM 上班时间(可选，周末全天加班时填)
    overtime_start TEXT,             -- HH:MM 加班开始时间(可选，如吃饭后开始加班)
    overtime_hours REAL NOT NULL,    -- 加班时长(小时)
    day_type TEXT NOT NULL,          -- workday/weekend/holiday
    rate REAL NOT NULL,              -- 1.5/2/3
    overtime_pay REAL NOT NULL,      -- 加班费
    status TEXT DEFAULT 'active',    -- active/comp_off(已调休)
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 调休记录表
CREATE TABLE IF NOT EXISTS comp_off_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    comp_off_date TEXT NOT NULL,     -- 调休的日期
    overtime_record_id TEXT NOT NULL, -- 配对的加班记录
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (overtime_record_id) REFERENCES overtime_records(id)
);

-- 节假日表
CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY,           -- YYYY-MM-DD
    name TEXT NOT NULL,              -- 节假日名称
    type TEXT NOT NULL               -- holiday(放假) / workday(调休补班)
);

-- 预置2026年法定节假日 (可根据国务院通知调整)
INSERT OR IGNORE INTO holidays (date, name, type) VALUES
-- 元旦
('2026-01-01', '元旦', 'holiday'),
-- 春节 (2026年2月17日除夕)
('2026-02-16', '春节', 'holiday'),
('2026-02-17', '春节', 'holiday'),
('2026-02-18', '春节', 'holiday'),
('2026-02-19', '春节', 'holiday'),
('2026-02-20', '春节', 'holiday'),
('2026-02-21', '春节', 'holiday'),
('2026-02-22', '春节', 'holiday'),
-- 春节调休补班
('2026-02-14', '春节调休补班', 'workday'),
('2026-02-28', '春节调休补班', 'workday'),
-- 清明节
('2026-04-04', '清明节', 'holiday'),
('2026-04-05', '清明节', 'holiday'),
('2026-04-06', '清明节', 'holiday'),
-- 劳动节
('2026-05-01', '劳动节', 'holiday'),
('2026-05-02', '劳动节', 'holiday'),
('2026-05-03', '劳动节', 'holiday'),
('2026-05-04', '劳动节', 'holiday'),
('2026-05-05', '劳动节', 'holiday'),
-- 劳动节调休补班
('2026-04-26', '劳动节调休补班', 'workday'),
-- 端午节
('2026-06-19', '端午节', 'holiday'),
('2026-06-20', '端午节', 'holiday'),
('2026-06-21', '端午节', 'holiday'),
-- 中秋节
('2026-09-25', '中秋节', 'holiday'),
('2026-09-26', '中秋节', 'holiday'),
('2026-09-27', '中秋节', 'holiday'),
-- 国庆节
('2026-10-01', '国庆节', 'holiday'),
('2026-10-02', '国庆节', 'holiday'),
('2026-10-03', '国庆节', 'holiday'),
('2026-10-04', '国庆节', 'holiday'),
('2026-10-05', '国庆节', 'holiday'),
('2026-10-06', '国庆节', 'holiday'),
('2026-10-07', '国庆节', 'holiday'),
-- 国庆调休补班
('2026-09-27', '国庆调休补班', 'workday'),
('2026-10-10', '国庆调休补班', 'workday');

-- 索引
CREATE INDEX IF NOT EXISTS idx_overtime_user_date ON overtime_records(user_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_compoff_user ON comp_off_records(user_id);
CREATE INDEX IF NOT EXISTS idx_compoff_overtime ON comp_off_records(overtime_record_id);
