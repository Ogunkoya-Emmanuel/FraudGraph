/** Ring gauge for the 0-100 risk score. Colour comes from the account's risk level. */
export function ScoreDial({ value = 0, level = 'low', size = 148 }) {
  const stroke = 12
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const sweep = 0.75 // 270 degrees
  const clamped = Math.max(0, Math.min(100, Number(value) || 0))
  const track = c * sweep
  const fill = track * (clamped / 100)
  const rotate = 135 // gap at the bottom

  return (
    <div className="dial" data-risk={level} style={{ width: size, height: size }} role="img" aria-label={`Risk score ${clamped} out of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ink-100)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${track} ${c}`}
          transform={`rotate(${rotate} ${size / 2} ${size / 2})`}
        />
        {clamped > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--risk)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${fill} ${c}`}
            transform={`rotate(${rotate} ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div className="dial__center">
        <span className="dial__value num" style={{ color: 'var(--risk-ink)' }}>
          {Number.isInteger(clamped) ? clamped : clamped.toFixed(1)}
        </span>
        <span className="dial__of">out of 100</span>
      </div>
    </div>
  )
}

/** Labelled 0-100 bar used for the ML and anomaly scores. */
export function Meter({ label, value = 0, hint, color }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <div className="meter">
      <div className="meter__top">
        <span className="meter__label">{label}</span>
        <span className="meter__value num">{v.toFixed(1)}</span>
      </div>
      <div className="meter__track" role="presentation">
        <div className="meter__fill" style={{ width: `${v}%`, '--meter': color }} />
      </div>
      {hint && <span className="meter__hint">{hint}</span>}
    </div>
  )
}

/** Compact inline bar for table cells. */
export function MiniMeter({ value = 0, color }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  return (
    <span className="mini-meter">
      <span className="mini-meter__track">
        <span className="mini-meter__fill" style={{ width: `${v}%`, '--meter': color }} />
      </span>
      <span className="mini-meter__num num">{v.toFixed(0)}</span>
    </span>
  )
}
