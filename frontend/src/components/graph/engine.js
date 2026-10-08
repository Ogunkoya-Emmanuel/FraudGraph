import { Simulation, hash01 } from './forceLayout'

export const RISK_COLORS = { low: '#2fbf92', medium: '#f5b73b', high: '#f27a3a', critical: '#ed3f68' }
const ELEVATED = new Set(['medium', 'high', 'critical'])
const EDGE_BASE = 'rgba(133,170,208,0.34)'
const EDGE_HOT = 'rgba(255,150,96,0.78)'
const EDGE_SEL = 'rgba(143,208,255,0.95)'
const EDGE_DEVICE = 'rgba(176,148,255,0.5)'
const LABEL = 'rgba(205,222,240,0.92)'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export const shortId = (id) => (id.length > 8 ? `…${id.slice(-6)}` : id)

export class GraphEngine {
  /**
   * callbacks: onSelect(id|null), onHover(info|null, x, y), onOpen(node)
   */
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.cb = callbacks
    this.w = 300
    this.h = 300
    this.dpr = 1
    this.view = { x: 0, y: 0, k: 1 }
    this.nodes = []
    this.edges = []
    this.byId = new Map()
    this.nbrs = new Map()
    this.centerId = null
    this.selected = null
    this.hover = null
    this.sim = null
    this.wheelNeedsModifier = true
    this.reduceMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    this._raf = 0
    this._anim = null
    this._drag = null
    this._bind()
  }

  /* ----------------------------- data ----------------------------- */

  setModel({ nodes, edges, centerId }) {
    const prev = this.byId
    const reuse = nodes.filter((n) => prev.has(n.id)).length
    const warm = prev.size > 0 && reuse >= nodes.length * 0.5

    this.centerId = centerId
    this.byId = new Map()
    this.nodes = nodes.map((n) => {
      const old = prev.get(n.id)
      const node = {
        id: n.id,
        type: n.type,
        risk: n.risk_level || 'low',
        x: old ? old.x : 0,
        y: old ? old.y : 0,
        vx: 0,
        vy: 0,
        fx: n.id === centerId ? (old ? old.x : 0) : null,
        fy: n.id === centerId ? (old ? old.y : 0) : null,
        deg: 0,
        placed: Boolean(old),
      }
      this.byId.set(n.id, node)
      return node
    })

    this.edges = []
    const keys = new Set(edges.filter((e) => e.type === 'transaction').map((e) => `${e.source}>${e.target}`))
    for (const e of edges) {
      const s = this.byId.get(e.source)
      const t = this.byId.get(e.target)
      if (!s || !t || s === t) continue
      s.deg += 1
      t.deg += 1
      const weight = e.weight ?? 0
      this.edges.push({
        s,
        t,
        type: e.type,
        weight,
        count: e.txn_count ?? 0,
        recip: e.type === 'transaction' && keys.has(`${e.target}>${e.source}`),
        width: e.type === 'transaction' ? clamp(0.7 + Math.log10(weight + 1) * 0.28, 0.8, 3.2) : 1,
        hot: e.type === 'transaction' && ELEVATED.has(s.risk) && ELEVATED.has(t.risk),
      })
    }

    this.nbrs = new Map(this.nodes.map((n) => [n.id, new Set()]))
    for (const e of this.edges) {
      this.nbrs.get(e.s.id).add(e.t.id)
      this.nbrs.get(e.t.id).add(e.s.id)
    }
    for (const n of this.nodes) n.r = this.centerId === n.id ? 13 : clamp(4.5 + Math.sqrt(n.deg) * 1.35, 5, 12)

    this._placeNewNodes()

    const count = this.nodes.length
    const links = this.edges.map((e) => ({ source: e.s, target: e.t }))
    this.sim = new Simulation(this.nodes, links, {
      charge: -clamp(5200 / Math.sqrt(Math.max(count, 1)), 34, 300),
      linkDistance: clamp(78 - count / 18, 26, 78),
      gravity: count > 200 ? 0.07 : 0.04,
    })

    if (warm) {
      // keep the existing layout, let new nodes settle, and re-frame the camera around what is left
      this.sim.alpha = 0.45
      this._refitOnSettle = true
    } else {
      this.sim.run(this.reduceMotion ? 600 : 320, this.reduceMotion ? 900 : 380)
      this.sim.alpha = this.reduceMotion ? 0 : Math.min(this.sim.alpha, 0.06)
      this.fit(false)
    }
    if (this.selected && !this.byId.has(this.selected)) this.selected = null
    this._kick()
  }

  /** Breadth-first rings around the centre so the first frame already looks like a neighbourhood. */
  _placeNewNodes() {
    const center = this.byId.get(this.centerId) || this.nodes[0]
    if (!center) return
    const depth = new Map([[center.id, 0]])
    const queue = [center.id]
    while (queue.length) {
      const id = queue.shift()
      for (const nb of this.nbrs.get(id) || []) {
        if (!depth.has(nb)) {
          depth.set(nb, depth.get(id) + 1)
          queue.push(nb)
        }
      }
    }
    for (const n of this.nodes) {
      if (n.placed) continue
      const d = depth.get(n.id) ?? 1
      const a = hash01(n.id) * Math.PI * 2
      const radius = d * 90 + hash01(`${n.id}r`) * 40
      n.x = d === 0 ? 0 : Math.cos(a) * radius
      n.y = d === 0 ? 0 : Math.sin(a) * radius
    }
  }

  setSelected(id) {
    this.selected = id
    this._kick()
  }

  /* ------------------------------ view ----------------------------- */

  resize(w, h, dpr) {
    const firstSize = this.w === 300 && this.h === 300
    this.w = Math.max(w, 10)
    this.h = Math.max(h, 10)
    this.dpr = dpr || 1
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    if (firstSize && this.nodes.length) this.fit(false)
    this._kick()
  }

  fit(animate = true) {
    if (!this.nodes.length) return
    this._refitOnSettle = false
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x - n.r)
      y0 = Math.min(y0, n.y - n.r)
      x1 = Math.max(x1, n.x + n.r)
      y1 = Math.max(y1, n.y + n.r)
    }
    const pad = 56
    const bw = Math.max(x1 - x0, 40)
    const bh = Math.max(y1 - y0, 40)
    const k = clamp(Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh), 0.1, 1.6)
    const target = {
      k,
      x: this.w / 2 - ((x0 + x1) / 2) * k,
      y: this.h / 2 - ((y0 + y1) / 2) * k,
    }
    this._moveTo(target, animate)
  }

  zoomBy(factor, cx = this.w / 2, cy = this.h / 2) {
    this._refitOnSettle = false
    const k = clamp(this.view.k * factor, 0.1, 4)
    const f = k / this.view.k
    this._moveTo({ k, x: cx - (cx - this.view.x) * f, y: cy - (cy - this.view.y) * f }, false)
  }

  _moveTo(target, animate) {
    if (!animate || this.reduceMotion) {
      this.view = { ...target }
      this._anim = null
    } else {
      this._anim = { from: { ...this.view }, to: target, t0: performance.now(), dur: 320 }
    }
    this._kick()
  }

  /* ---------------------------- rendering -------------------------- */

  _kick() {
    if (!this._raf && typeof requestAnimationFrame !== 'undefined') this._raf = requestAnimationFrame(() => this._frame())
  }

  _frame() {
    this._raf = 0
    let busy = false
    if (this.sim && (!this.sim.settled || this._drag?.node)) {
      this.sim.tick()
      busy = true
    }
    if (this._anim) {
      const a = this._anim
      const p = clamp((performance.now() - a.t0) / a.dur, 0, 1)
      const e = 1 - Math.pow(1 - p, 3)
      this.view = {
        k: a.from.k + (a.to.k - a.from.k) * e,
        x: a.from.x + (a.to.x - a.from.x) * e,
        y: a.from.y + (a.to.y - a.from.y) * e,
      }
      if (p >= 1) this._anim = null
      else busy = true
    }
    if (this._refitOnSettle && this.sim?.settled && !this._anim) {
      this._refitOnSettle = false
      this.fit(true)
      busy = true
    }
    this.draw()
    if (busy) this._kick()
  }

  _shouldLabel(n, big, focus) {
    if (n.id === this.centerId || n.id === this.selected || n.id === this.hover?.id) return true
    if (focus && focus.has(n.id) && this.nodes.length <= 120) return true
    if (big) return false
    if (this.nodes.length <= 30) return true
    return (n.risk === 'high' || n.risk === 'critical') && this.nodes.length <= 150 && this.view.k > 0.7
  }

  draw() {
    const { ctx, w, h, dpr, view } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // dotted evidence-board grid (moves with the view)
    const gap = 30 * clamp(view.k, 0.5, 2)
    ctx.fillStyle = 'rgba(120,160,205,0.13)'
    for (let x = ((view.x % gap) + gap) % gap; x < w; x += gap) {
      for (let y = ((view.y % gap) + gap) % gap; y < h; y += gap) ctx.fillRect(x, y, 1.4, 1.4)
    }

    const big = this.nodes.length > 400
    const sel = this.selected
    const focus = sel ? this.nbrs.get(sel) : null
    const dimmed = (id) => sel && id !== sel && !focus?.has(id)

    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.scale(view.k, view.k)

    // edges
    const arrows = this.edges.length < 1500 && view.k > 0.35
    for (const e of this.edges) {
      const incident = sel && (e.s.id === sel || e.t.id === sel)
      const faded = sel && !incident
      let color = e.type === 'device_link' ? EDGE_DEVICE : e.hot ? EDGE_HOT : EDGE_BASE
      if (incident) color = e.type === 'device_link' ? 'rgba(196,174,255,0.95)' : EDGE_SEL
      ctx.globalAlpha = faded ? 0.1 : big ? 0.6 : 1
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = (incident ? e.width + 0.8 : e.width) / Math.sqrt(view.k) ** 0.6
      ctx.setLineDash(e.type === 'device_link' ? [4, 4] : [])
      this._drawEdge(e, arrows && e.type === 'transaction' && !faded, big)
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // nodes
    const glow = !big
    for (const n of this.nodes) {
      const color = RISK_COLORS[n.risk] || RISK_COLORS.low
      ctx.globalAlpha = dimmed(n.id) ? 0.22 : 1
      const hot = n.risk === 'high' || n.risk === 'critical'
      if (glow && hot && !dimmed(n.id)) {
        ctx.shadowColor = color
        ctx.shadowBlur = 16
      }
      ctx.lineWidth = 1.6
      ctx.strokeStyle = '#0a1a2c'
      if (n.type === 'device') {
        const d = n.r * 1.25
        ctx.beginPath()
        ctx.moveTo(n.x, n.y - d)
        ctx.lineTo(n.x + d, n.y)
        ctx.lineTo(n.x, n.y + d)
        ctx.lineTo(n.x - d, n.y)
        ctx.closePath()
        ctx.fillStyle = '#10304f'
        ctx.fill()
        ctx.shadowBlur = 0
        ctx.lineWidth = 2.2
        ctx.strokeStyle = color
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        ctx.shadowBlur = 0
        ctx.stroke()
      }
      ctx.shadowBlur = 0
      if (n.id === this.centerId) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth = 2
        ctx.stroke()
      }
      if (n.id === sel || n.id === this.hover?.id) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r + (n.id === this.centerId ? 9 : 5), 0, Math.PI * 2)
        ctx.strokeStyle = n.id === sel ? '#8fd0ff' : 'rgba(255,255,255,0.55)'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
    ctx.restore()

    // labels in screen space (stay crisp and constant-size)
    ctx.font = '500 10.5px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const n of this.nodes) {
      if (!this._shouldLabel(n, big, focus)) continue
      const sx = n.x * view.k + view.x
      const sy = n.y * view.k + view.y
      if (sx < -40 || sx > w + 40 || sy < -20 || sy > h + 20) continue
      const text = n.id === this.centerId || n.id === sel || n.id === this.hover?.id ? n.id : shortId(n.id)
      ctx.globalAlpha = dimmed(n.id) ? 0.25 : 1
      const ty = sy + (n.r + 7) * view.k
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(10,26,44,0.85)'
      ctx.strokeText(text, sx, ty)
      ctx.fillStyle = LABEL
      ctx.fillText(text, sx, ty)
    }
    ctx.globalAlpha = 1
  }

  _edgeGeometry(e) {
    const { s, t } = e
    const dx = t.x - s.x
    const dy = t.y - s.y
    const len = Math.hypot(dx, dy) || 1
    const curve = e.recip && this.nodes.length <= 500 ? len * 0.2 : 0
    // control point offset perpendicular to the direction of travel
    const mx = (s.x + t.x) / 2 + (dy / len) * curve
    const my = (s.y + t.y) / 2 - (dx / len) * curve
    return { dx, dy, len, curve, mx, my }
  }

  _drawEdge(e, arrow, big) {
    const { ctx } = this
    const { len, curve, mx, my } = this._edgeGeometry(e)
    const { s, t } = e
    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    if (curve) ctx.quadraticCurveTo(mx, my, t.x, t.y)
    else ctx.lineTo(t.x, t.y)
    ctx.stroke()
    if (!arrow || big || len < t.r + s.r + 6) return

    // arrow head sits on the target's rim, pointing along the curve's end tangent
    const from = curve ? { x: mx, y: my } : s
    const ang = Math.atan2(t.y - from.y, t.x - from.x)
    const tip = { x: t.x - Math.cos(ang) * (t.r + 2), y: t.y - Math.sin(ang) * (t.r + 2) }
    const size = 5 + e.width * 1.2
    ctx.beginPath()
    ctx.moveTo(tip.x, tip.y)
    ctx.lineTo(tip.x - Math.cos(ang - 0.42) * size, tip.y - Math.sin(ang - 0.42) * size)
    ctx.lineTo(tip.x - Math.cos(ang + 0.42) * size, tip.y - Math.sin(ang + 0.42) * size)
    ctx.closePath()
    ctx.fill()
  }

  /* --------------------------- interaction ------------------------- */

  _toWorld(sx, sy) {
    return { x: (sx - this.view.x) / this.view.k, y: (sy - this.view.y) / this.view.k }
  }

  _nodeAt(sx, sy) {
    const p = this._toWorld(sx, sy)
    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      const n = this.nodes[i]
      const reach = Math.max(n.r * (n.type === 'device' ? 1.25 : 1), 7 / this.view.k) + 2 / this.view.k
      if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= reach * reach) return n
    }
    return null
  }

  _edgeAt(sx, sy) {
    if (this.edges.length > 700) return null
    const p = this._toWorld(sx, sy)
    const tol = 6 / this.view.k
    let best = null
    let bestD = tol
    for (const e of this.edges) {
      const { curve, mx, my } = this._edgeGeometry(e)
      const pts = curve
        ? [e.s, { x: 0.25 * e.s.x + 0.5 * mx + 0.25 * e.t.x, y: 0.25 * e.s.y + 0.5 * my + 0.25 * e.t.y }, e.t]
        : [e.s, e.t]
      for (let i = 0; i < pts.length - 1; i += 1) {
        const d = segDist(p, pts[i], pts[i + 1])
        if (d < bestD) {
          bestD = d
          best = e
        }
      }
    }
    return best
  }

  _bind() {
    const c = this.canvas
    this._onDown = (ev) => {
      const r = c.getBoundingClientRect()
      const sx = ev.clientX - r.left
      const sy = ev.clientY - r.top
      const node = this._nodeAt(sx, sy)
      c.setPointerCapture?.(ev.pointerId)
      this._anim = null
      this._refitOnSettle = false
      this._drag = { node, sx, sy, vx: this.view.x, vy: this.view.y, moved: false }
      if (node) {
        node.fx = node.x
        node.fy = node.y
      }
    }
    this._onMove = (ev) => {
      const r = c.getBoundingClientRect()
      const sx = ev.clientX - r.left
      const sy = ev.clientY - r.top
      const d = this._drag
      if (d) {
        const dist = Math.hypot(sx - d.sx, sy - d.sy)
        if (dist > 3) d.moved = true
        if (!d.moved) return
        if (d.node) {
          const p = this._toWorld(sx, sy)
          d.node.fx = p.x
          d.node.fy = p.y
          this.sim?.reheat(0.3)
          this.hover = null
          this.cb.onHover?.(null)
        } else {
          this.view = { ...this.view, x: d.vx + (sx - d.sx), y: d.vy + (sy - d.sy) }
        }
        this._kick()
        return
      }
      const node = this._nodeAt(sx, sy)
      if (node) {
        this._setHover({ kind: 'node', id: node.id, node }, sx, sy)
      } else {
        const edge = this._edgeAt(sx, sy)
        this._setHover(edge ? { kind: 'edge', edge } : null, sx, sy)
      }
    }
    this._onUp = () => {
      const d = this._drag
      this._drag = null
      if (!d) return
      if (d.node && d.moved) {
        // keep the focus account where it was dropped; everything else rejoins the simulation
        if (d.node.id !== this.centerId) {
          d.node.fx = null
          d.node.fy = null
        }
        this.sim?.reheat(0.25)
      } else if (d.node) {
        if (d.node.id !== this.centerId) {
          d.node.fx = null
          d.node.fy = null
        }
        this.selected = d.node.id === this.selected ? null : d.node.id
        this.cb.onSelect?.(this.selected)
      } else if (!d.moved) {
        this.selected = null
        this.cb.onSelect?.(null)
      }
      this._kick()
    }
    this._onLeave = () => {
      if (!this._drag) this._setHover(null)
    }
    this._onDbl = (ev) => {
      const r = c.getBoundingClientRect()
      const node = this._nodeAt(ev.clientX - r.left, ev.clientY - r.top)
      if (node) this.cb.onOpen?.(node)
    }
    this._onWheel = (ev) => {
      if (this.wheelNeedsModifier && !(ev.ctrlKey || ev.metaKey)) return // let the page scroll
      ev.preventDefault()
      const r = c.getBoundingClientRect()
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0016))
      this.zoomBy(factor, ev.clientX - r.left, ev.clientY - r.top)
    }
    c.addEventListener('pointerdown', this._onDown)
    c.addEventListener('pointermove', this._onMove)
    c.addEventListener('pointerup', this._onUp)
    c.addEventListener('pointercancel', this._onUp)
    c.addEventListener('pointerleave', this._onLeave)
    c.addEventListener('dblclick', this._onDbl)
    c.addEventListener('wheel', this._onWheel, { passive: false })
  }

  _setHover(info, sx, sy) {
    const prev = this.hover?.id
    this.hover = info?.kind === 'node' ? info : null
    this.canvas.style.cursor = info ? 'pointer' : 'grab'
    this.cb.onHover?.(info, sx, sy)
    if (prev !== this.hover?.id) this._kick()
  }

  destroy() {
    const c = this.canvas
    c.removeEventListener('pointerdown', this._onDown)
    c.removeEventListener('pointermove', this._onMove)
    c.removeEventListener('pointerup', this._onUp)
    c.removeEventListener('pointercancel', this._onUp)
    c.removeEventListener('pointerleave', this._onLeave)
    c.removeEventListener('dblclick', this._onDbl)
    c.removeEventListener('wheel', this._onWheel)
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
  }
}

function segDist(p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
  t = clamp(t, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
