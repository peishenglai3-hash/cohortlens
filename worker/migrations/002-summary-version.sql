-- 迁移：给 submissions 加 summary_version（已存在的库用这个，新库用 schema.sql 即可）
--
-- 背景：审阅摘要派生自提交正文，但为了列表页不必读正文而被存了下来。摘要形状一旦演进，
-- 旧行读出来就缺字段——第一次撞上时表现为**详情页白屏**（`reading 'map'`），而列表页正常，
-- 很容易被当成界面 bug。
--
-- 现在把形状版本单独存成一列：列表查询靠它就能判断"这行要不要重建"，而不必把 payload 也读出来
-- （不读 payload 正是存摘要的全部理由）。读到时发现版本落后就用正文重建并回写，旧行因此自愈。
--
-- 用法：
--   npx wrangler d1 execute cohortlens-reviews --remote --file=worker/migrations/002-summary-version.sql
--
-- 幂等性：SQLite 没有 ADD COLUMN IF NOT EXISTS，重复执行会报 "duplicate column name"。
-- 那说明迁移已经做过了，可以忽略该错误——但它**不会**损坏任何数据。

ALTER TABLE submissions ADD COLUMN summary_version INTEGER NOT NULL DEFAULT 1;
