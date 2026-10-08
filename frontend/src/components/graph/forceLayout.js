/**
 * Small force-directed layout (no dependencies).
 *
 * Why not a naive O(n^2) simulation: GET /accounts/{id}/network at depth 2 or 3 can return
 * 300 to 1,000+ nodes and thousands of edges for an ordinary account, so repulsion uses a
 * Barnes-Hut quadtree (O(n log n)) and the pre-run is time-boxed.
 *
 * Node shape: { x, y, vx, vy, fx, fy, deg }.  Link shape: { source, target } (node objects).
 */

const jiggle = () => (Math.random() - 0.5) * 1e-3

function makeCell(x, y, size) {
  return { x, y, size, mass: 0, cx: 0, cy: 0, node: null, extra: null, kids: null }
}

function place(cell, node, depth) {
  const half = cell.size / 2
  const right = node.x >= cell.x + half ? 1 : 0
  const down = node.y >= cell.y + half ? 1 : 0
  const idx = down * 2 + right
  let kid = cell.kids[idx]
  if (!kid) {
    kid = makeCell(cell.x + right * half, cell.y + down * half, half)
    cell.kids[idx] = kid
  }
  insert(kid, node, depth + 1)
}

function insert(cell, node, depth) {
  cell.cx = (cell.cx * cell.mass + node.x) / (cell.mass + 1)
  cell.cy = (cell.cy * cell.mass + node.y) / (cell.mass + 1)
  cell.mass += 1

  if (cell.kids === null) {
    if (cell.node === null) {
      cell.node = node
      return
    }
    // Coincident (or too deep) bodies stay together in one leaf.
    if (depth >= 28 || (cell.node.x === node.x && cell.node.y === node.y)) {
      if (!cell.extra) cell.extra = []
      cell.extra.push(node)
      return
    }
    const old = cell.node
    cell.node = null
    cell.kids = [null, null, null, null]
    place(cell, old, depth)
  }
  place(cell, node, depth)
}

function buildTree(nodes) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x
    if (n.y < y0) y0 = n.y
    if (n.x > x1) x1 = n.x
    if (n.y > y1) y1 = n.y
  }
  const size = Math.max(x1 - x0, y1 - y0, 1) + 1
  const root = makeCell(x0, y0, size)
  for (const n of nodes) insert(root, n, 0)
  return root
}

function repel(root, n, strength, alpha, theta2, maxDist2, stack) {
  stack.length = 0
  stack.push(root)
  while (stack.length) {
    const c = stack.pop()
    if (!c || c.mass === 0) continue

    if (c.kids === null) {
      // leaf: one or more bodies, handled exactly
      const bodies = c.extra ? [c.node, ...c.extra] : [c.node]
      for (const b of bodies) {
        if (b === n) continue
        let dx = b.x - n.x
        let dy = b.y - n.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = jiggle()
          dy = jiggle()
          d2 = 1
        }
        if (d2 >= maxDist2) continue
        const k = (strength * alpha) / d2
        n.vx += dx * k
        n.vy += dy * k
      }
      continue
    }

    const dx = c.cx - n.x
    const dy = c.cy - n.y
    let d2 = dx * dx + dy * dy
    if ((c.size * c.size) / d2 < theta2) {
      // far enough away: treat the whole cell as one heavy body
      if (d2 < maxDist2) {
        if (d2 < 1) d2 = 1
        const k = (strength * alpha * c.mass) / d2
        n.vx += dx * k
        n.vy += dy * k
      }
    } else {
      for (let i = 0; i < 4; i += 1) if (c.kids[i]) stack.push(c.kids[i])
    }
  }
}

export class Simulation {
  constructor(nodes, links, { charge = -200, linkDistance = 64, gravity = 0.04, maxDistance = 700 } = {}) {
    this.nodes = nodes
    this.links = links
    this.charge = charge
    this.linkDistance = linkDistance
    this.gravity = gravity
    this.maxDist2 = maxDistance * maxDistance
    this.theta2 = 0.81 // theta = 0.9
    this.alpha = 1
    this.alphaMin = 0.004
    this.alphaDecay = 1 - Math.pow(this.alphaMin, 1 / 300)
    this.velocityDecay = 0.42
    this._stack = []

    // d3-style link bias/strength so hubs move less than leaves
    this._count = new Map()
    for (const n of nodes) this._count.set(n, 0)
    for (const l of links) {
      this._count.set(l.source, (this._count.get(l.source) || 0) + 1)
      this._count.set(l.target, (this._count.get(l.target) || 0) + 1)
    }
  }

  reheat(alpha = 0.35) {
    this.alpha = Math.max(this.alpha, alpha)
  }

  get settled() {
    return this.alpha < this.alphaMin
  }

  tick() {
    const { nodes, links } = this
    this.alpha += (0 - this.alpha) * this.alphaDecay
    const alpha = this.alpha

    // springs
    for (const l of links) {
      const s = l.source
      const t = l.target
      let x = t.x + t.vx - s.x - s.vx
      let y = t.y + t.vy - s.y - s.vy
      let len = Math.sqrt(x * x + y * y)
      if (len === 0) {
        x = jiggle()
        y = jiggle()
        len = Math.sqrt(x * x + y * y)
      }
      const cs = this._count.get(s) || 1
      const ct = this._count.get(t) || 1
      const strength = 1 / Math.min(cs, ct)
      const f = ((len - this.linkDistance) / len) * alpha * strength
      x *= f
      y *= f
      const bias = cs / (cs + ct)
      t.vx -= x * bias
      t.vy -= y * bias
      s.vx += x * (1 - bias)
      s.vy += y * (1 - bias)
    }

    // repulsion
    if (nodes.length > 1) {
      const root = buildTree(nodes)
      for (const n of nodes) repel(root, n, this.charge, alpha, this.theta2, this.maxDist2, this._stack)
    }

    // gravity toward the origin keeps disconnected clusters from drifting away
    const g = this.gravity * alpha
    for (const n of nodes) {
      n.vx -= n.x * g
      n.vy -= n.y * g
    }

    // integrate
    for (const n of nodes) {
      if (n.fx !== null && n.fx !== undefined) {
        n.x = n.fx
        n.vx = 0
      } else {
        n.vx *= 1 - this.velocityDecay
        n.x += n.vx
      }
      if (n.fy !== null && n.fy !== undefined) {
        n.y = n.fy
        n.vy = 0
      } else {
        n.vy *= 1 - this.velocityDecay
        n.y += n.vy
      }
    }
  }

  /** Runs ticks synchronously until settled, `maxTicks` is reached or the time budget is spent. */
  run(maxTicks = 300, budgetMs = 300) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
    let i = 0
    while (i < maxTicks && !this.settled) {
      this.tick()
      i += 1
      if ((i & 7) === 0) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
        if (now - start > budgetMs) break
      }
    }
    return i
  }
}

/** Deterministic 0..1 value from a string, so the same graph always starts from the same layout. */
export function hash01(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}
