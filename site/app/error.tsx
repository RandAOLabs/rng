"use client";

import { SiteFooter, SiteHeader } from "../components/site-header";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="shell compact-page">
      <SiteHeader />
      <section className="page-intro container">
        <h1>This page could not load</h1>
        <button type="button" className="button" onClick={reset}>Try again</button>
      </section>
      <SiteFooter />
    </main>
  );
}
