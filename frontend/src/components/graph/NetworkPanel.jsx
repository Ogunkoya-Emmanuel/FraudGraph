import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { Link, useNavigate } from '../../lib/router'
import { useAsync } from '../../lib/useAsync'
import { fmtInt, fmtNaira, isDeviceId } from '../../lib/format'
import { RISK_LABEL } from '../../lib/meta'
import { RiskBadge } from '../Badges'
import { ErrorState } from '../States'
import Icon from '../Icon'
import { GraphEngine, RISK_COLORS } from './engine'

const BIG_GRAPH = 400

function useInspector(model, selectedId) {
  return useMemo(() => {
    if (!model || !selectedId) return null
    const node = model.nodes.find((n) => n.id === selectedId)
    if (!node) return null
    const out = []
    const inn = []
    const devices = []
    const users = []
    for (const e of model.edges) {
      if (e.type === 'transaction') {
        if (e.source === selectedId) out.push({ other: e.target, weight: e.weight, count: e.txn_count })
        if (e.target === selectedId) inn.push({ other: e.source, weight: e.weight, count: e.txn_count })
      } else if (e.source === selectedId) devices.push(e.target)
      else if (e.target === selectedId) users.push(e.source)
    }
    const sum = (list) => list.reduce((a, b) => a + (b.weight || 0), 0)
    const byWeight = (a, b) => b.weight - a.weight
    return {
      node,
      out: out.sort(byWeight),
      inn: inn.sort(byWeight),
      devices,
      users,
      volumeOut: sum(out),
      volumeIn: sum(inn),
    }
  }, [model, selectedId])
}

function Inspector({ info, centerId, onClose, onSelect }) {
  const { node } = info
  const isDevice = node.type === 'device'
  return (
    <aside className="board__inspector" aria-label="Selected node">
      <div className="board__inspector-head">
        <div style={{ minWidth: 0 }}>
          <div className="board__kind">{isDevice ? 'Device' : node.id === centerId ? 'Focus account' : 'Account'}</div>
          <div className="mono board__id">{node.id}</div>
        </div>
        <button type="button" className="board__btn" onClick={onClose} aria-label="Close details">
          <Icon name="x" size={15} />
        </button>
      </div>
      <div style={{ marginTop: 10 }}>
        <RiskBadge level={node.risk_level} />
      </div>

      {!isDevice && (
        <dl className="board__stats">
          <div>
            <dt>Received</dt>
            <dd className="num">{fmtNaira(info.volumeIn, { compact: true })}</dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd className="num">{fmtNaira(info.volumeOut, { compact: true })}</dd>
          </div>
        </dl>
      )}

      <div className="board__actions">
        {isDevice ? (
          <Link to={`/transactions?device_id=${encodeURIComponent(node.id)}`} className="btn btn--sm btn--dark">
            Transactions from this device
          </Link>
        ) : node.id !== centerId ? (
          <Link to={`/accounts/${encodeURIComponent(node.id)}`} className="btn btn--sm btn--dark">
            Open account
          </Link>
        ) : (
          <Link to={`/transactions?account_id=${encodeURIComponent(node.id)}`} className="btn btn--sm btn--dark">
            All transactions
          </Link>
        )}
      </div>

      <div className="board__lists">
        {isDevice && info.users.length > 0 && (
          <Group title={`Accounts using it (${info.users.length})`}>
            {info.users.map((id) => (
              <button key={id} type="button" onClick={() => onSelect(id)}>
                <span className="mono">{id}</span>
              </button>
            ))}
          </Group>
        )}
        {info.out.length > 0 && (
          <Group title={`Sent to (${info.out.length})`}>
            {info.out.map((r) => (
              <button key={r.other} type="button" onClick={() => onSelect(r.other)}>
                <span className="mono">{r.other}</span>
                <span className="num">
                  {fmtNaira(r.weight, { compact: true })} in {fmtInt(r.count)}
                </span>
              </button>
            ))}
          </Group>
        )}
        {info.inn.length > 0 && (
          <Group title={`Received from (${info.inn.length})`}>
            {info.inn.map((r) => (
              <button key={r.other} type="button" onClick={() => onSelect(r.other)}>
                <span className="mono">{r.other}</span>
                <span className="num">
                  {fmtNaira(r.weight, { compact: true })} in {fmtInt(r.count)}
                </span>
              </button>
            ))}
          </Group>
        )}
        {info.devices.length > 0 && (
          <Group title={`Devices used (${info.devices.length})`}>
            {info.devices.map((id) => (
              <button key={id} type="button" onClick={() => onSelect(id)}>
                <span className="mono">{id}</span>
              </button>
            ))}
          </Group>
        )}
      </div>
    </aside>
  )
}

function Group({ title, children }) {
  return (
    <div className="board__group">
      <div className="board__group-title">{title}</div>
      <div className="board__group-list">{children}</div>
    </div>
  )
}

/**
 * Transaction network around one account: GET /accounts/{id}/network?depth=1..3.
 * Nodes are coloured by the backend's `risk_level`; edges are aggregated transfers (weight = total
 * amount, txn_count = number of transfers) or device links.
 */
export default function NetworkPanel({ accountId }) {
  const navigate = useNavigate()
  const [depth, setDepth] = useState(1)
  const [showDevices, setShowDevices] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState(null)

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const tipRef = useRef(null)
  const engineRef = useRef(null)
  const navRef = useRef(navigate)
  navRef.current = navigate

  // remember which depth each response belongs to, so the subtitle never pairs old counts with a new depth
  const net = useAsync(
    (signal) => api.getAccountNetwork(accountId, depth, signal).then((d) => ({ ...d, loadedDepth: depth })),
    [accountId, depth],
  )

  const model = useMemo(() => {
    const d = net.data
    if (!d) return null
    const nodes = d.nodes.filter((n) => showDevices || n.type === 'account')
    const ids = new Set(nodes.map((n) => n.id))
    const edges = d.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
    return { nodes, edges, centerId: d.center_account }
  }, [net.data, showDevices])

  const info = useInspector(model, selected)

  // engine lifecycle
  useEffect(() => {
    const canvas = canvasRef.current
    const tip = tipRef.current
    const engine = new GraphEngine(canvas, {
      onSelect: setSelected,
      onOpen: (n) =>
        navRef.current(
          n.type === 'device' || isDeviceId(n.id)
            ? `/transactions?device_id=${encodeURIComponent(n.id)}`
            : `/accounts/${encodeURIComponent(n.id)}`,
        ),
      onHover: (hit, x, y) => {
        if (!hit) {
          tip.style.opacity = '0'
          return
        }
        tip.replaceChildren()
        const line = (text, cls) => {
          const el = document.createElement('div')
          if (cls) el.className = cls
          el.textContent = text
          tip.appendChild(el)
        }
        if (hit.kind === 'node') {
          line(hit.node.id, 'mono')
          line(`${hit.node.type === 'device' ? 'Device' : 'Account'}, ${RISK_LABEL[hit.node.risk] ?? hit.node.risk} risk`)
        } else {
          const e = hit.edge
          if (e.type === 'device_link') {
            line(`${e.s.id} used device`, 'mono')
            line(e.t.id, 'mono')
          } else {
            line(`${e.s.id} to`, 'mono')
            line(e.t.id, 'mono')
            line(`${fmtNaira(e.weight)} across ${fmtInt(e.count)} transfer${e.count === 1 ? '' : 's'}`)
          }
        }
        const wrap = wrapRef.current.getBoundingClientRect()
        const flip = x > wrap.width - 260
        tip.style.transform = `translate(${flip ? x - 14 : x + 14}px, ${y + 14}px) ${flip ? 'translateX(-100%)' : ''}`
        tip.style.opacity = '1'
      },
    })
    engineRef.current = engine

    const resize = () => {
      const r = wrapRef.current.getBoundingClientRect()
      engine.resize(r.width, r.height, window.devicePixelRatio || 1)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrapRef.current)
    return () => {
      ro.disconnect()
      engine.destroy()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    if (model && engineRef.current) engineRef.current.setModel(model)
  }, [model])

  useEffect(() => {
    engineRef.current?.setSelected(selected)
  }, [selected])

  useEffect(() => {
    if (engineRef.current) engineRef.current.wheelNeedsModifier = !expanded
    // the canvas changes size when expanding; the ResizeObserver refits the view
    const t = setTimeout(() => engineRef.current?.fit(false), 60)
    return () => clearTimeout(t)
  }, [expanded])

  useEffect(() => {
    setSelected(null)
  }, [accountId])

  useEffect(() => {
    if (!expanded) return undefined
    const onKey = (e) => e.key === 'Escape' && setExpanded(false)
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [expanded])

  const counts = model ? { nodes: model.nodes.length, edges: model.edges.length } : null
  const large = counts && counts.nodes > BIG_GRAPH

  return (
    <section className={`board ${expanded ? 'is-expanded' : ''}`} aria-label="Transaction network">
      <header className="board__head">
        <div>
          <h2>Transaction network</h2>
          <p className="board__sub">
            {counts
              ? `${fmtInt(counts.nodes)} nodes and ${fmtInt(counts.edges)} links within ${net.data.loadedDepth} hop${net.data.loadedDepth > 1 ? 's' : ''}`
              : 'Loading the neighbourhood'}
          </p>
        </div>
        <div className="board__controls">
          <div className="seg seg--dark" role="group" aria-label="Hops from this account">
            {[1, 2, 3].map((d) => (
              <button key={d} type="button" aria-pressed={depth === d} onClick={() => setDepth(d)} title={`${d} hop${d > 1 ? 's' : ''}`}>
                {d} hop{d > 1 ? 's' : ''}
              </button>
            ))}
          </div>
          <label className="board__check">
            <input type="checkbox" checked={showDevices} onChange={(e) => setShowDevices(e.target.checked)} />
            Devices
          </label>
          <button type="button" className="board__btn" onClick={() => setExpanded((v) => !v)} aria-label={expanded ? 'Exit full screen' : 'Full screen'} title={expanded ? 'Exit full screen (Esc)' : 'Full screen'}>
            <Icon name={expanded ? 'shrink' : 'expand'} size={16} />
          </button>
        </div>
      </header>

      <div className="board__stage" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="board__canvas"
          data-expanded={expanded}
          role="img"
          aria-label={`Network graph of ${counts?.nodes ?? 0} accounts and devices around account ${accountId}`}
        />
        <div className="board__tip" ref={tipRef} />

        {net.loading && !net.data && <div className="board__overlay">Loading network</div>}
        {net.error && (
          <div className="board__overlay board__overlay--error">
            <ErrorState error={net.error} onRetry={net.reload} title="Couldn’t load the network" />
          </div>
        )}
        {net.loading && net.data && <div className="board__busy">Updating</div>}

        <div className="board__zoom">
          <button type="button" className="board__btn" onClick={() => engineRef.current?.zoomBy(1.3)} aria-label="Zoom in">
            <Icon name="plus" size={16} />
          </button>
          <button type="button" className="board__btn" onClick={() => engineRef.current?.zoomBy(1 / 1.3)} aria-label="Zoom out">
            <Icon name="minus" size={16} />
          </button>
          <button type="button" className="board__btn" onClick={() => engineRef.current?.fit(true)} aria-label="Fit to view" title="Fit to view">
            <Icon name="fit" size={16} />
          </button>
        </div>

        <ul className="board__legend" aria-label="Legend">
          {Object.keys(RISK_COLORS).map((l) => (
            <li key={l}>
              <i style={{ background: RISK_COLORS[l] }} />
              {RISK_LABEL[l]}
            </li>
          ))}
          <li className="sep">
            <i className="dia" />
            Device
          </li>
          <li>
            <i className="line hot" />
            Transfers between flagged accounts
          </li>
        </ul>

        {info && (
          <Inspector
            info={info}
            centerId={model.centerId}
            onClose={() => setSelected(null)}
            onSelect={(id) => setSelected(id)}
          />
        )}
      </div>

      <footer className="board__foot">
        {large && (
          <span className="board__warn">
            Large neighbourhood. Labels are hidden; select a node, or lower the hops, to read it.
          </span>
        )}
        <span>
          {expanded ? 'Scroll to zoom. ' : 'Ctrl or ⌘ + scroll to zoom. '}Drag the background to pan, drag a node to move it,
          click to inspect, double-click to open.
        </span>
      </footer>
    </section>
  )
}
