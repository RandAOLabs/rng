import type { ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="page-section">
      <h2>{title}</h2>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Stats({ cols, children }: { cols?: 2 | 6; children: ReactNode }) {
  return <dl className={cols === 6 ? "stats six" : cols === 2 ? "stats two" : "stats"}>{children}</dl>;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
