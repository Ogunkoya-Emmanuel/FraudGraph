import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Link, buildHref, useNavigate, useQueryState } from '../lib/router'
import { useAsync } from '../lib/useAsync'
import { usePageTitle } from '../lib/hooks'
import { fmtDateTime, fmtInt } from '../lib/format'
import { ALERT_STATUSES, STATUS_LABEL } from '../lib/meta'
import { StatusTag } from '../components/Badges'
import { EntityLink } from '../components/EntityLinks'
import { EmptyState, ErrorState, SkeletonRows } from '../components/States'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'

function CaseEditor({ id, onSaved }) {
  const toast = useToast()
  const { data: c, error, loading, reload } = useAsync((signal) => api.getCase(id, signal), [id])
  const [status, setStatus] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (c) {
      setStatus(c.status)
      setNotes(c.notes)
    }
  }, [c])

  if (error) return <ErrorState error={error} onRetry={reload} title="Case not found" />
  if (!c) return loading ? <SkeletonRows rows={8} /> : null

  const dirty = status !== c.status || notes !== c.notes

  const save = async (e) => {
    e.preventDefault()
    const patch = {}
    if (status !== c.status) patch.status = status
    if (notes !== c.notes) patch.notes = notes
    setSaving(true)
    try {
      await api.updateCase(id, patch)
      toast({ title: 'Case saved', body: patch.status ? `Status is now ${STATUS_LABEL[patch.status].toLowerCase()}.` : undefined })
      reload()
      onSaved()
    } catch (err) {
      toast({ tone: 'error', title: 'Could not save the case', body: err.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="stack">
      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <StatusTag status={c.status} large />
        </div>
        <h2 className="mono" style={{ fontSize: 20 }}>
          {c.case_id}
        </h2>
        <p className="page-head__sub">
          Opened from alert <Link to={`/alerts/${c.alert_id}`} className="mono">{c.alert_id}</Link>
        </p>
      </div>

      <div className="field">
        <label htmlFor="case-status">Status</label>
        <select id="case-status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          {ALERT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <span className="field-hint">Changing the case status also updates the linked alert.</span>
      </div>

      <div className="field">
        <label htmlFor="case-notes-edit">Notes</label>
        <textarea
          id="case-notes-edit"
          className="textarea"
          style={{ minHeight: 140 }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Findings, next steps, who you spoke to"
        />
      </div>

      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
          <Icon name="check" size={16} /> {saving ? 'Saving' : 'Save changes'}
        </button>
        {dirty && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setStatus(c.status)
              setNotes(c.notes)
            }}
          >
            Discard
          </button>
        )}
      </div>

      <section className="section">
        <div className="section__head">
          <h2>Related entities</h2>
          <span className="sub num">{fmtInt(c.related_entities.length)}</span>
        </div>
        {c.related_entities.length === 0 ? (
          <p className="muted" style={{ padding: '14px 0' }}>
            None recorded.
          </p>
        ) : (
          <div className="chips" style={{ paddingTop: 14 }}>
            {c.related_entities.map((e) => (
              <EntityLink key={e} id={e} />
            ))}
          </div>
        )}
      </section>

      <dl className="kv">
        <dt>Created</dt>
        <dd className="num">{fmtDateTime(c.created_at, { seconds: true })} UTC</dd>
        <dt>Last updated</dt>
        <dd className="num">{fmtDateTime(c.updated_at, { seconds: true })} UTC</dd>
      </dl>
    </form>
  )
}

export default function Cases({ id }) {
  usePageTitle(id ? `Case ${id}` : 'Cases')
  const navigate = useNavigate()
  const [q, setQ] = useQueryState()
  const { data, error, loading, reload } = useAsync((signal) => api.listCases({ status: q.status }, signal), [q.status])
  const cases = data?.cases ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cases</h1>
          <p className="page-head__sub">
            {data ? `${fmtInt(cases.length)} ${q.status ? STATUS_LABEL[q.status].toLowerCase() : ''} cases, newest first` : 'Loading cases'}
          </p>
        </div>
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="case-filter">Status</label>
          <select
            id="case-filter"
            className="select"
            value={q.status ?? ''}
            onChange={(e) => setQ({ status: e.target.value })}
          >
            <option value="">All statuses</option>
            {ALERT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={`cases ${id ? 'cases--selected' : ''}`}>
        <div className="panel cases__list" data-busy={loading && Boolean(data)}>
          {error ? (
            <ErrorState error={error} onRetry={reload} />
          ) : !data ? (
            <SkeletonRows rows={6} />
          ) : cases.length === 0 ? (
            <EmptyState icon="folder" title={q.status ? 'No cases with this status' : 'No cases yet'}
              action={<Link to="/alerts" className="btn btn--primary">Go to alerts</Link>}>
              Open a case from an alert to start tracking an investigation.
            </EmptyState>
          ) : (
            <ul className="caselist">
              {cases.map((c) => (
                <li key={c.case_id} data-status={c.status} className={c.case_id === id ? 'is-selected' : ''}>
                  <a
                    href={`#${buildHref(`/cases/${c.case_id}`, { status: q.status })}`}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(buildHref(`/cases/${c.case_id}`, { status: q.status }))
                    }}
                  >
                    <span className="caselist__top">
                      <span className="mono cell-title">{c.case_id}</span>
                      <StatusTag status={c.status} />
                    </span>
                    <span className="caselist__sub">
                      Alert <span className="mono">{c.alert_id}</span>
                      <span className="num">{fmtDateTime(c.created_at)} UTC</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel cases__detail">
          {id ? (
            <div className="panel__body">
              <Link to={buildHref('/cases', { status: q.status })} className="backlink cases__back">
                <Icon name="chevron-left" size={16} /> All cases
              </Link>
              <CaseEditor id={id} onSaved={reload} />
            </div>
          ) : (
            <EmptyState icon="folder" title="Select a case">
              Choose a case on the left to read its notes and change its status.
            </EmptyState>
          )}
        </div>
      </div>
    </>
  )
}
