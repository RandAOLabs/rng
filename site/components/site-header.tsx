/* eslint-disable @next/next/no-html-link-for-pages -- full reloads avoid broken Vinext client navigation */
import Image from "next/image";

type ActivePage = "why" | "how" | "try" | "dao" | "validators" | "docs";
type Props = { active?: ActivePage };

const navigation: Array<{ key: ActivePage; label: string; href: string }> = [
  { key: "why", label: "Overview", href: "/why" },
  { key: "how", label: "Protocol", href: "/how" },
  { key: "try", label: "Console", href: "/try" },
  { key: "dao", label: "DAO", href: "/dao" },
  { key: "validators", label: "Validators", href: "/validators" },
  { key: "docs", label: "Docs", href: "/docs" },
];

export function SiteHeader({ active }: Props) {
  const links = navigation.map((item) => (
    <a key={item.key} href={item.href} className={active === item.key ? "active" : undefined} aria-current={active === item.key ? "page" : undefined}>
      <strong>{item.label}</strong>
    </a>
  ));
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="RNG Labs home">
        <Image className="brand-logo" src="/rng.png" width={48} height={48} alt="" priority unoptimized />
        <span className="brand-copy"><strong>RNG Labs</strong></span>
      </a>
      <nav className="nav-rail" aria-label="Main navigation">{links}</nav>
      <button type="button" className="site-menu" popoverTarget="site-drawer" aria-label="Open navigation">
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
      </button>
      <div id="site-drawer" popover="auto" aria-label="Site menu">
        <div className="drawer-heading"><strong>RNG Labs</strong><button type="button" popoverTarget="site-drawer" popoverTargetAction="hide" aria-label="Close navigation">×</button></div>
        <nav aria-label="Menu">{links}</nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer"><strong>RNG Labs · CipherPlay</strong><span>HyperBEAM RNG v3 · Mainnet</span></footer>
  );
}
