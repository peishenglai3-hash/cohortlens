-- CohortLens 审阅台 —— D1 schema（Workers Free 计划友好）
--
-- 设计原则：
--   1. **数据量按"几十到几百份"设计**，因此所有列表查询都必须走索引。D1 免费版有每日
--      行读上限（5,000,000 行/天，自 2026-09-01 起超限直接报错），全表扫描会把额度烧在
--      无意义的地方：一个 SELECT * 在 500 行的表上就是 500 次行读，而带索引的分页查询是几十。
--   2. **提交正文整块存 JSON。** 提交物的形状会随题库换代演进，把它拆成关系表意味着每次
--      换代都要改 schema 并迁移历史数据；整块存 JSON 则让旧提交保持原样可读，版本信息本来
--      就在 payload 里。代价是无法按维度分数做 SQL 聚合——但审阅台本来就不需要，也不能
--      做"按分数排序挑人"这种事。
--   3. **邀请码表独立。** 提交记录只引用 code_id 并冗余一个人类可读的 label，不存明文码。
--      码是凭据，不该在每一行提交里再复制一遍。
--   4. **不存任何凭据。** 这张库里不会出现 API Key 字段；提交载荷在入口处已由白名单构造。

PRAGMA foreign_keys = ON;

-- 邀请码：控制谁可以作答，并给提交打上批次标签。
CREATE TABLE IF NOT EXISTS invite_codes (
  id          TEXT PRIMARY KEY,
  -- 明文码。唯一索引让校验走索引查找，而不是扫描。
  code        TEXT NOT NULL UNIQUE,
  -- 人类可读的批次名（例如 "2026春-社会学-第一批"），写进提交记录，方便日后归档。
  label       TEXT NOT NULL DEFAULT '',
  -- 0 表示不限次数。
  max_uses    INTEGER NOT NULL DEFAULT 0,
  uses        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  -- NULL 表示不过期。ISO 8601 字符串，比较按字典序即可。
  expires_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes (code);

-- 提交：一位作答者的一次测评。
CREATE TABLE IF NOT EXISTS submissions (
  id                TEXT PRIMARY KEY,
  -- 幂等键：客户端重试时用它去重，避免网络抖动产生两条一模一样的记录。
  client_submission_id TEXT NOT NULL,
  invite_code_id    TEXT,
  invite_label      TEXT NOT NULL DEFAULT '',
  contact_kind      TEXT NOT NULL,
  contact_value     TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  assessed_at       TEXT NOT NULL,
  question_pack_id  TEXT NOT NULL,
  question_pack_version TEXT NOT NULL,
  scoring_version   TEXT NOT NULL,
  role_model_version TEXT NOT NULL,
  -- 提交正文（session + result），JSON 文本。
  payload           TEXT NOT NULL,
  -- 服务端派生的审阅摘要，JSON 文本。存下来是为了让列表页不必解析每份完整正文：
  -- 列表一次读 20 行摘要，而不是读 20 份几百 KB 的正文。
  --
  -- 摘要形状一旦演进，旧行读出来就缺字段（第一次的表现是详情页白屏）。因此把形状版本单独存成
  -- 一列：列表查询靠它就能判断"这行要不要重建"，而不必把 payload 也读出来——那正是存摘要要
  -- 避免的开销。
  summary           TEXT NOT NULL,
  summary_version   INTEGER NOT NULL DEFAULT 1,
  -- 人工审阅结论。null 表示尚未审阅。
  decision_label    TEXT,
  decision_reason   TEXT,
  decision_at       TEXT,
  -- 软删除：作答者要求撤回时置 1，记录保留以便审计"确实删过"，但审阅台不再展示。
  withdrawn         INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (invite_code_id) REFERENCES invite_codes (id)
);

-- 幂等键唯一。这是重试安全的**唯一**保障点，不能只靠应用层判断（并发请求会同时通过判断）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_client_id
  ON submissions (client_submission_id);

-- 列表页主查询：未撤回、按接收时间倒序、分页。走这个索引，行读 = 页大小。
CREATE INDEX IF NOT EXISTS idx_submissions_received
  ON submissions (withdrawn, received_at DESC);

-- 按批次筛选。
CREATE INDEX IF NOT EXISTS idx_submissions_invite
  ON submissions (invite_code_id, received_at DESC);

-- 按审阅状态筛选（"还有谁没看"）。
CREATE INDEX IF NOT EXISTS idx_submissions_decision
  ON submissions (decision_label, received_at DESC);

-- 联系方式去重提示：同一个人重复提交时，审阅台应当能看出来。
CREATE INDEX IF NOT EXISTS idx_submissions_contact
  ON submissions (contact_kind, contact_value);
