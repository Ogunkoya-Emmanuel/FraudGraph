import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { Link, useNavigate } from '../lib/router'
import { useAsync } from '../lib/useAsync'
import { usePageTitle } from '../lib/hooks'
import { fmtDateTime, fmtInt, fmtNaira, parseTs } from '../lib/format'
import { FEEDBACK_LABEL, FEEDBACK_OPTIONS, STATUS_LABEL, patternDesc, patternLabel } from '../lib/meta'
import { RiskBadge, StatusTag, TxnStatusTag } from '../components/Badges'
import { AccountLink, EntityLink, TxnLink } from '../components/EntityLinks'
import { ErrorState, SkeletonRows } from '../components/States'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'

const TXN_PREVIEW_LIMIT = 30
const OPEN_CASE = ['new', 'investigating']

function RelatedTransactions({ alert }) {
  const ids = alert.related_transactions
  const preview = useMemo(() => ids.slice(0, TXN_PREVIEW_LIMIT), [ids])
  const [showRest, setShowRest] = useState(false)

  // The alert only stores transaction IDs; fetch each one so the analyst sees amounts and times.
  const txns = useAsync(
    async (signal) => {
      const settled = await Promise.allSettled(preview.map((id) => api.getTransaction(id, signal)))
      return settled
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => parseTs(a.timestamp) - parseTs(b.timestamp))
    },
    [alert.alert_id, preview.length],
    { enabled: preview.length > 0 },
  )

  const rest = ids.slice(TXN_PREVIEW_LIMIT)

  return (
    <div className="panel">
      <div className="panel__head">
        <h2>Related transactions</h2>
        <span className="sub num">{fmtInt(ids.length)} in total, oldest first</span>
      </div>
      {ids.length === 0 ? (
        <p className="muted" style={{ padding: 20 }}>
          This alert has no linked transactions.
        </p>
      ) : txns.error ? (
        <ErrorState error={txns.error} onRetry={txns.reload} />
      ) : !txns.data ? (
        <SkeletonRows rows={Math.min(preview.length, 6)} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Transaction</th>
                <th>From</th>
                <th>To</th>
                <th className="right">Amount</th>
                <th>Time (UTC)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {txns.data.map((t) => (
                <tr key={t.txn_id}>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <TxnLink id={t.txn_id} />
                      {t.flagged && (
                        <span title={t.flagged_reason || 'Flagged'} style={{ color: 'var(--risk-high)', display: 'inline-flex' }}>
                          <Icon name="flag" size={14} />
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <AccountLink id={t.sender_account} />
                  </td>
                  <td>
                    <AccountLink id={t.receiver_account} />
                  </td>
                  <td className="right num nowrap">{fmtNaira(t.amount)}</td>
                  <td className="num nowrap">{fmtDateTime(t.timestamp, { seconds: true })}</td>
                  <td>
                    <TxnStatusTag status={t.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rest.length > 0 && (
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)' }}>
          <button type="button" className="btn btn--sm" onClick={() => setShowRest((v) => !v)}>
            {showRest ? 'Hide' : 'Show'} {fmtInt(rest.length)} more transaction IDs
          </button>
          {showRest && (
            <div className="chips" style={{ marginTop: 12 }}>
              {rest.map((id) => (
                <TxnLink key={id} id={id} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ReviewPanel({ alert, cases, onChanged }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(null)
  const [notes, setNotes] = useState('')
  const [caseError, setCaseError] = useState(null)

  const forAlert = (cases.data?.cases ?? []).filter((c) => c.alert_id === alert.alert_id)
  const openCase = forAlert.find((c) => OPEN_CASE.includes(c.status))

  const sendFeedback = async (value) => {
    setBusy(value)
    try {
      const res = await api.setAlertFeedback(alert.alert_id, value)
      toast({
        title: `Alert marked ${STATUS_LABEL[res.status]?.toLowerCase() ?? res.status}`,
        body: `Feedback recorded as “${FEEDBACK_LABEL[res.feedback] ?? res.feedback}”.`,
      })
      onChanged()
    } catch (err) {
      toast({ tone: 'error', title: 'Could not save feedback', body: err.message })
    } finally {
      setBusy(null)
    }
  }

  const createCase = async (e) => {
    e.preventDefault()
    setBusy('case')
    setCaseError(null)
    try {
      const created = await api.createCase(alert.alert_id, notes.trim())
      toast({ title: 'Case opened', body: `${created.case_id} is now tracking this alert.` })
      navigate(`/cases/${created.case_id}`)
    } catch (err) {
      if (err.status === 409) {
        const existing = /\((FG-[A-Z0-9]+)\)/.exec(err.message)?.[1]
        setCaseError({ message: err.message, caseId: existing })
        cases.reload()
      } else {
        setCaseError({ message: err.message })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <h2>Review this alert</h2>
      </div>
      <div className="panel__body stack">
        <div className="stack--tight stack">
          <span className="field__label">Analyst feedback</span>
          <div className="fb-grid" role="group" aria-label="Analyst feedback">
            {FEEDBACK_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className="fb"
                data-tone={o.tone}
                aria-pressed={alert.feedback === o.value}
                disabled={busy !== null}
                onClick={() => sendFeedback(o.value)}
              >
                <span className="fb__label">{o.label}</span>
                <span className="fb__hint">Sets status to {STATUS_LABEL[o.result].toLowerCase()}</span>
              </button>
            ))}
          </div>
        </div>

        <form className="stack stack--tight" onSubmit={createCase}>
          <label className="field__label" htmlFor="case-notes">
            Open a case
          </label>
          {openCase ? (
            <div className="notice">
              <Icon name="folder" size={16} />
              <div>
                Case{' '}
                <Link to={`/cases/${openCase.case_id}`} className="mono">
                  {openCase.case_id}
                </Link>{' '}
                is already open for this alert.
              </div>
            </div>
          ) : (
            <>
              <textarea
                id="case-notes"
                className="textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes for the investigation"
              />
              <button type="submit" className="btn btn--primary" disabled={busy !== null}>
                <Icon name="folder" size={16} /> {busy === 'case' ? 'Opening case' : 'Open case'}
              </button>
            </>
          )}
          {caseError && (
            <div className="notice notice--danger" role="alert">
              <Icon name="alert" size={16} />
              <div>
                {caseError.message}
                {caseError.caseId && (
                  <>
                    {' '}
                    <Link to={`/cases/${caseError.caseId}`}>Open that case</Link>
                  </>
                )}
              </div>
            </div>
          )}
        </form>

        {forAlert.length > 0 && (
          <div className="stack stack--tight">
            <span className="field__label">Cases for this alert</span>
            <ul className="minilist">
              {forAlert.map((c) => (
                <li key={c.case_id}>
                  <Link to={`/cases/${c.case_id}`} className="mono">
                    {c.case_id}
                  </Link>
                  <StatusTag status={c.status} />
                  <span className="muted num">{fmtDateTime(c.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

export default function AlertDetail({ id }) {
  const alert = useAsync((signal) => api.getAlert(id, signal), [id])
  const cases = useAsync((signal) => api.listCases({}, signal), [id])
  const a = alert.data
  usePageTitle(a ? `${patternLabel(a.pattern)} ${a.alert_id}` : 'Alert')

  if (alert.error) {
    return (
      <>
        <Link to="/alerts" className="backlink">
          <Icon name="chevron-left" size={16} /> Alerts
        </Link>
        <div className="panel">
          <ErrorState error={alert.error} onRetry={alert.reload} title="Alert not found" />
        </div>
      </>
    )
  }
  if (!a) {
    return (
      <div className="panel">
        <SkeletonRows rows={10} />
      </div>
    )
  }

  const refresh = () => {
    alert.reload()
    cases.reload()
  }

  return (
    <>
      <Link to="/alerts" className="backlink">
        <Icon name="chevron-left" size={16} /> Alerts
      </Link>

      <div className="page-head" data-risk={a.severity}>
        <div>
          <div className="row" style={{ gap: 10, marginBottom: 8 }}>
            <RiskBadge level={a.severity} large />
            <StatusTag status={a.status} large />
          </div>
          <h1>{patternLabel(a.pattern)}</h1>
          <p className="page-head__sub">
            <span className="mono">{a.alert_id}</span> on {a.entity_type === 'device' ? 'device' : 'account'}{' '}
            <EntityLink id={a.entity_id} type={a.entity_type} />
          </p>
        </div>
        {a.entity_type === 'account' && (
          <div className="page-head__actions">
            <Link to={`/accounts/${a.entity_id}`} className="btn">
              <Icon name="network" size={16} /> Open account and network
            </Link>
          </div>
        )}
      </div>

      <div className="cols cols--main-aside">
        <div className="stack">
          <div className="panel" data-risk={a.severity}>
            <div className="panel__head">
              <h2>Why this was flagged</h2>
              <span
                className="tag"
                data-status={a.explanation_source === 'gemini' ? 'investigating' : 'closed'}
                title={
                  a.explanation_source === 'gemini'
                    ? 'The wording was polished by Gemini. The facts come from the detectors.'
                    : 'Generated directly from the detector evidence.'
                }
              >
                <Icon name={a.explanation_source === 'gemini' ? 'info' : 'cpu'} size={13} />
                {a.explanation_source === 'gemini' ? 'Worded by Gemini' : 'Rule-based explanation'}
              </span>
            </div>
            <div className="panel__body">
              <p className="muted" style={{ marginBottom: 6 }}>
                {patternDesc(a.pattern)}
              </p>
              {a.explanation.length === 0 ? (
                <p className="muted">No explanation was recorded for this alert.</p>
              ) : (
                <ul className="reasons">
                  {a.explanation.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <RelatedTransactions alert={a} />

          <section className="section">
            <div className="section__head">
              <h2>Connected {a.entity_type === 'device' ? 'accounts' : 'entities'}</h2>
              <span className="sub num">{fmtInt(a.connected_entities.length)}</span>
            </div>
            {a.connected_entities.length === 0 ? (
              <p className="muted" style={{ padding: '14px 0' }}>
                No connected entities were recorded.
              </p>
            ) : (
              <div className="chips" style={{ paddingTop: 14 }}>
                {a.connected_entities.map((e) => (
                  <EntityLink key={e} id={e} />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          <ReviewPanel alert={a} cases={cases} onChanged={refresh} />

          <section className="section">
            <div className="section__head">
              <h2>Details</h2>
            </div>
            <dl className="kv" style={{ paddingTop: 14 }}>
              <dt>Entity</dt>
              <dd>
                <EntityLink id={a.entity_id} type={a.entity_type} />
              </dd>
              <dt>Detected</dt>
              <dd className="num">{fmtDateTime(a.detected_at, { seconds: true })} UTC</dd>
              <dt>Last updated</dt>
              <dd className="num">{a.updated_at ? `${fmtDateTime(a.updated_at, { seconds: true })} UTC` : 'Not yet reviewed'}</dd>
              <dt>Feedback</dt>
              <dd>{a.feedback ? FEEDBACK_LABEL[a.feedback] : 'None yet'}</dd>
              <dt>Transactions</dt>
              <dd className="num">{fmtInt(a.related_transactions.length)}</dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  )
}
