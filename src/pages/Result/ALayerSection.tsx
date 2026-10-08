import type { ALayerProfile, AssessmentSession, Question } from '../../domain/schemas.ts'
import { formatPercent } from '../../utils/format.ts'

/**
 * A-layer profile section — A-layer V1.1.
 *
 * Six parts, each rendered as what it actually is (DSH-MIGRATION-V1.1 §5):
 *
 *   1. 自我声明的理论认同 (A0)      — the respondent's own words, quoted, with no score beside them
 *   2. 理论熟悉程度 (A1)            — correct/answered with an explicit low-sample notice
 *   3. 政治经济议题立场 (A2)        — the questions and the positions chosen
 *   4. 社会—政治议题立场 (A3)      — the same
 *   5. 实践取向 (A4)               — the same, for how they prefer to work
 *   6. 反身性 (A5)                 — a cautious summary, or an explicit "mixed / not enough material"
 *
 * The component is deliberately unable to show a number where none exists: A0 and A2-A4 render text
 * and cards only, and there is no field in `ALayerProfile` that could hold an A-layer total.
 */

export interface ALayerSectionProps {
  profile: ALayerProfile
  session: AssessmentSession
  questionById: Map<string, Question>
}

export function ALayerSection({ profile, session, questionById }: ALayerSectionProps) {
  const chosenText = (questionId: string): string => {
    const question = questionById.get(questionId)
    const optionId = session.answers[questionId]
    const option = question?.options.find((candidate) => candidate.id === optionId)
    return option?.text ?? '(未作答)'
  }

  return (
    <section className="card a-layer-section" data-testid="a-layer-section">
      <h2>A 层 · 思想认同与政治—理论画像</h2>
      <p className="hint">
        这一部分是自愿的政治—理论画像，用来呈现你自己说明的立场与取向。它不参与角色适配，不生成任何综合分。
      </p>
      <ul className="boundary-list" data-testid="a-layer-boundaries">
        {profile.boundaries.map((boundary) => (
          <li key={boundary}>{boundary}</li>
        ))}
      </ul>

      {/* 1 — A0 self-declared identity, quoted verbatim */}
      <div className="a-card" data-testid="a-card-A0_declared_identity">
        <h3>1 · 自我声明的理论认同（A0）</h3>
        <p className="hint">
          以下是你本人在题目中直接选择的自我描述，系统原样呈现，不从其他回答推断。
        </p>
        {profile.declaredIdentity.length === 0 ? (
          <p className="hint">本次问卷中 A0 题目未作答或未抽到。</p>
        ) : (
          <ul className="identity-list">
            {profile.declaredIdentity.map((item) => (
              <li key={item.questionId} data-testid={`a0-${item.questionId}`}>
                <p className="identity-prompt">
                  <strong>{item.questionId}</strong>{' '}
                  {questionById.get(item.questionId)?.prompt ?? ''}
                </p>
                <blockquote className="identity-quote">{item.selectedText}</blockquote>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 2 — A1 theory familiarity, always flagged low-sample */}
      <div className="a-card" data-testid="a-card-A1_theory_structure">
        <h3>2 · 理论熟悉程度（A1）</h3>
        {profile.theoryFamiliarity ? (
          <>
            <div className="profile-head">
              <span className="profile-label">概念题作答情况</span>
              <span className="profile-score" data-testid="a1-score">
                {profile.theoryFamiliarity.normalizedScore}
              </span>
            </div>
            <div className="profile-track" role="presentation">
              <div
                className="profile-fill"
                style={{ width: `${profile.theoryFamiliarity.normalizedScore}%` }}
              />
            </div>
            <p className="profile-meta">
              答对 {profile.theoryFamiliarity.correct} / {profile.theoryFamiliarity.answered} 题 ·
              区间：{profile.theoryFamiliarity.band} · 证据题{' '}
              {profile.theoryFamiliarity.evidenceQuestionIds.join('、')}
            </p>
            {profile.theoryFamiliarity.lowSample && (
              <p className="low-sample" data-testid="a1-low-sample">
                {profile.theoryFamiliarity.note}
              </p>
            )}
          </>
        ) : (
          <p className="hint">本次问卷未抽到 A1 题目，无法给出理论熟悉度。</p>
        )}
      </div>

      {/* 3-5 — issue positions and practice patterns, as cards */}
      <IssueCards
        index={3}
        title="政治经济议题立场（A2）"
        testId="a-card-A2_political_economy"
        cards={profile.politicalEconomy}
        chosenText={chosenText}
      />
      <IssueCards
        index={4}
        title="社会—政治议题立场（A3）"
        testId="a-card-A3_social_political"
        cards={profile.socialPolitical}
        chosenText={chosenText}
      />
      <IssueCards
        index={5}
        title="实践取向（A4）"
        testId="a-card-A4_practice_orientation"
        cards={profile.practiceOrientation}
        chosenText={chosenText}
      />

      {/* 6 — A5 reflexivity, only speaks when the two items agree */}
      <div className="a-card" data-testid="a-card-A5_reflexivity">
        <h3>6 · 反身性与修正方式（A5）</h3>
        <p className="reflexivity-state" data-testid="a5-state">
          {profile.reflexivity.state === 'aligned'
            ? '方向相对一致'
            : profile.reflexivity.state === 'mixed'
              ? '方向不一致（混合）'
              : '材料不足'}
          {profile.reflexivity.confidence > 0
            ? ` · 置信度 ${formatPercent(profile.reflexivity.confidence)}`
            : ''}
        </p>
        <p>{profile.reflexivity.summary}</p>
        {profile.reflexivity.evidenceQuestionIds.length > 0 && (
          <details className="evidence">
            <summary>相关原始作答</summary>
            <ul>
              {profile.reflexivity.evidenceQuestionIds.map((questionId) => (
                <li key={questionId} data-testid={`a5-evidence-${questionId}`}>
                  <p className="evidence-prompt">
                    <strong>{questionId}</strong> {questionById.get(questionId)?.prompt ?? ''}
                  </p>
                  <p className="evidence-answer">你的作答：{chosenText(questionId)}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  )
}

function IssueCards({
  index,
  title,
  testId,
  cards,
  chosenText,
}: {
  index: number
  title: string
  testId: string
  cards: { questionId: string; topic: string; prompt: string; selectedText: string }[]
  chosenText: (questionId: string) => string
}) {
  return (
    <div className="a-card" data-testid={testId}>
      <h3>
        {index} · {title}
      </h3>
      <p className="hint">本部分呈现你选择的原始立场，不折算成分数。</p>
      {cards.length === 0 ? (
        <p className="hint">本次问卷中该部分题目未作答或未抽到。</p>
      ) : (
        <ul className="position-list">
          {cards.map((card) => (
            <li key={card.questionId} data-testid={`card-${card.questionId}`}>
              <p className="position-topic">{card.topic}</p>
              <p className="position-prompt">
                <strong>{card.questionId}</strong> {card.prompt}
              </p>
              <p className="position-choice">你的选择：{chosenText(card.questionId)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
