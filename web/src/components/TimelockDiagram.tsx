// How a time-lock round works: three validators lock in puzzles, reveal
// them (one stays silent and is cracked by the others), and every answer is
// hashed into the round's value.
export function TimelockDiagram() {
  const lanes = [80, 150, 220];
  const col = { commit: 210, reveal: 420, combine: 640 };
  return (
    <figure className="tl-diagram">
      <svg viewBox="0 0 760 300" role="img" aria-label="A time-lock round: commit, reveal or crack, combine">
        <defs>
          <marker id="tld-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className="tld-ink-fill" />
          </marker>
        </defs>
        <text x="210" y="30" textAnchor="middle" className="tld-head">1. Commit</text>
        <text x="420" y="30" textAnchor="middle" className="tld-head">2. Reveal</text>
        <text x="640" y="30" textAnchor="middle" className="tld-head">3. Combine</text>
        <text x="210" y="48" textAnchor="middle" className="tld-sub">answer locked, still hidden</text>
        <text x="420" y="48" textAnchor="middle" className="tld-sub">checked on the node in ~1 ms</text>
        <text x="640" y="48" textAnchor="middle" className="tld-sub">one hash of every answer</text>

        {lanes.map((y, i) => (
          <g key={y}>
            <text x="24" y={y + 5} className="tld-label">Validator {i + 1}</text>
            <line x1="120" y1={y} x2={col.commit - 30} y2={y} className="tld-line" markerEnd="url(#tld-arrow)" />
            {/* commit: a locked puzzle */}
            <rect x={col.commit - 26} y={y - 18} width="52" height="36" rx="6" className="tld-box" />
            <path d={`M${col.commit - 7} ${y - 4} v-5 a7 7 0 0 1 14 0 v5`} className="tld-stroke" />
            <rect x={col.commit - 10} y={y - 4} width="20" height="14" rx="2" className="tld-ink-fill" />
            <line x1={col.commit + 30} y1={y} x2={col.reveal - 30} y2={y} className={i === 2 ? 'tld-line tld-dash' : 'tld-line'} markerEnd="url(#tld-arrow)" />
            {/* reveal or crack */}
            <rect x={col.reveal - 26} y={y - 18} width="52" height="36" rx="6" className={i === 2 ? 'tld-box tld-crack' : 'tld-box tld-ok'} />
            {i === 2
              ? <text x={col.reveal} y={y + 5} textAnchor="middle" className="tld-mark">cracked</text>
              : <path d={`M${col.reveal - 9} ${y} l6 6 l12 -12`} className="tld-check" />}
            <path d={`M${col.reveal + 30} ${y} C ${col.reveal + 110} ${y}, ${col.combine - 110} 150, ${col.combine - 42} 150`} className="tld-line" markerEnd="url(#tld-arrow)" />
          </g>
        ))}
        <rect x={col.combine - 40} y="118" width="80" height="64" rx="8" className="tld-box tld-value" />
        <text x={col.combine} y="146" textAnchor="middle" className="tld-label">round</text>
        <text x={col.combine} y="166" textAnchor="middle" className="tld-label">value</text>
        <text x={col.reveal} y={262} textAnchor="middle" className="tld-note">Validator 3 went silent: the others solve its puzzle the slow way</text>
        <text x={col.reveal} y={280} textAnchor="middle" className="tld-note">and post a short proof. It can delay the round, never change it.</text>
      </svg>
    </figure>
  );
}
