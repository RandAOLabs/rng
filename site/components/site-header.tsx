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
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="RNG Labs home">
        <Image className="brand-logo" src="/rng.png" width={48} height={48} alt="" priority unoptimized />
        <span className="brand-copy"><strong>RNG_LABS</strong></span>
      </a>
      <nav className="nav-rail" aria-label="Main navigation">
        {navigation.map((item) => (
          <a key={item.key} href={item.href} className={active === item.key ? "active" : undefined} aria-current={active === item.key ? "page" : undefined}>
            <strong>{item.label}</strong>
          </a>
        ))}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer"><strong>RNG_LABS // CIPHERPLAY_INC</strong><span>HYPERBEAM_RNG_V3 :: MAINNET</span></footer>
  );
}
