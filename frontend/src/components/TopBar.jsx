import { useEffect, useState } from 'react'
import { api, API_BASE } from '../api/client'
import { NavLink, Link, useNavigate } from '../lib/router'
import Icon, { BrandMark } from './Icon'

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/alerts', label: 'Alerts', icon: 'alert' },
  { to: '/accounts', label: 'Accounts', icon: 'users' },
  { to: '/transactions', label: 'Transactions', icon: 'swap' },
  { to: '/cases', label: 'Cases', icon: 'folder' },
]

/** Polls GET /health (open endpoint) so analysts can see at a glance whether the API and DB are up. */
function useHealth() {
  const [state, setState] = useState({ state: 'checking', label: 'Checking API' })
  useEffect(() => {
    let cancelled = false
    let timer
    const check = async () => {
      try {
        const h = await api.health()
        if (cancelled) return
        if (h?.status === 'ok' && h?.database === 'ok') setState({ state: 'ok', label: 'API online' })
        else setState({ state: 'degraded', label: 'Database unreachable' })
      } catch {
        if (!cancelled) setState({ state: 'down', label: 'API offline' })
      }
      if (!cancelled) timer = setTimeout(check, 30000)
    }
    check()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])
  return state
}

export default function TopBar({ onOpenKey, keyActive }) {
  const navigate = useNavigate()
  const health = useHealth()
  const [term, setTerm] = useState('')

  const submit = (e) => {
    e.preventDefault()
    const q = term.trim()
    navigate(q ? `/accounts?search=${encodeURIComponent(q)}` : '/accounts')
    setTerm('')
  }

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <Link to="/" className="brand" aria-label="FraudGraph home">
          <BrandMark />
          <span>FraudGraph</span>
        </Link>

        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="nav__link">
              <Icon name={item.icon} size={17} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar__right">
          <form className="topbar__search" role="search" onSubmit={submit}>
            <Icon name="search" size={16} />
            <input
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Find an account by ID, name or phone"
              aria-label="Find an account by ID, name or phone"
            />
          </form>
          <span className="health" data-state={health.state} title={`API: ${API_BASE}`}>
            <span className="health__dot" />
            {health.label}
          </span>
          <button
            type="button"
            className="iconbtn"
            onClick={onOpenKey}
            data-active={keyActive}
            aria-label={keyActive ? 'API key is set. Change it' : 'Set API key'}
            title={keyActive ? 'API key is set' : 'Set API key'}
          >
            <Icon name="key" size={17} />
          </button>
        </div>
      </div>
    </header>
  )
}

