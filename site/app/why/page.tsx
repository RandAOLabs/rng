import { SiteFooter, SiteHeader } from "../../components/site-header";

const failures = [
  ["01", "Nodes disagree", "Runtime seeds and clocks produce different state on every replay."],
  ["02", "Senders grind", "A predictable local result can be retried until the sender likes it."],
  ["03", "Committees leak", "A known round is useless if requests can still bind themselves to it."],
];

const surfaces = [
  ["Local", "Replay-safe; sender-predictable."],
  ["Fast", "On-demand 2-of-3 threshold BLS; safe unless 2 of 3 operators collude."],
  ["Beacon", "Shared public rounds; free to read."],
  ["Any-Honest", "Live time-lock fairness with native proofs."],
  ["Proof", "Independent retained-round checks."],
];

export default function WhyPage() {
  return (
    <main className="shell compact-page">
      <SiteHeader active="why" />
      <section className="page-titlebar container"><div><h1>Fair randomness onchain</h1></div><p>A blockchain must replay exactly and resist whoever benefits from predicting the result.</p></section>
      <section className="why-board container">
        <div className="why-failures"><p className="board-label">Failure modes</p>{failures.map(([index, title, body]) => <article key={index}><span>{index}</span><div><h2>{title}</h2><p>{body}</p></div></article>)}</div>
        <div className="why-contract"><p className="board-label">RNG surfaces</p><div className="surface-ledger">{surfaces.map(([name, body]) => <div key={name}><b>{name}</b><span>{body}</span></div>)}</div><p className="trust-line"><b>The rule:</b> commit before reveal; verify after publication.</p></div>
      </section>
      <SiteFooter />
    </main>
  );
}
