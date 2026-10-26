// A round's 96-byte signature, one cell per byte, shaded by value. It redraws
// when a new round lands: the one piece of motion on the site.
type Props = { signature: string | null; round: number | null };

export function EntropyPlate({ signature, round }: Props) {
  const bytes = signature ? (signature.match(/../g) ?? []).slice(0, 96) : [];
  const cells = bytes.length ? bytes : Array.from({ length: 96 }, () => null);
  return (
    <figure className="plate" aria-label={round ? `Signature of round ${round}` : 'Waiting for the first round'}>
      <div className="plate-grid" key={round ?? 'empty'}>
        {cells.map((b, i) => {
          const v = b ? parseInt(b, 16) : 0;
          return (
            <span
              key={i}
              className={!b ? 'cell cell-empty' : v >= 128 ? 'cell cell-hi' : 'cell'}
              style={{ ['--v' as string]: (v / 255).toFixed(3), ['--i' as string]: i }}
            >
              {b ?? ''}
            </span>
          );
        })}
      </div>
    </figure>
  );
}
