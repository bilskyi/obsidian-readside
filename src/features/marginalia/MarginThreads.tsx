import type { Color } from '../../lib/types';
import { threadPath } from './marginLayout';

export interface ThreadSpec {
  id: string;
  /** The anchor highlight's colour; null for a pin or page thought (a pencil thread, an ink pin). */
  color: Color | null;
  /** The note's left edge, by its label. */
  from: { x: number; y: number };
  /** The spot: a highlight's first-line end, or the pin just inside the page edge. */
  to: { x: number; y: number };
  /** Hovered or focused: the thread draws in again, stronger. */
  hot: boolean;
  /** Created moments ago: the thread draws in and the pin drops. */
  fresh: boolean;
  /** Its spot is estimated (the page is re-rendering): drawn faint. */
  estimated: boolean;
}

/** Room kept above and below the band of threads. */
const BAND_PAD = 16;

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/**
 * The threads from margin notes to their spots (spec §5.2), never hit-tested. One SVG covering only the
 * band the mounted notes occupy (a few pages around the reader), not the whole book: it sits at the band's
 * top and shifts its content back up, so every path keeps the scroller's content coordinates.
 */
export function MarginThreads({ threads, width }: { threads: readonly ThreadSpec[]; width: number }) {
  if (threads.length === 0) return null;
  const ys = threads.flatMap((t) => [t.from.y, t.to.y]);
  const top = Math.max(0, Math.min(...ys) - BAND_PAD);
  const bottom = Math.max(...ys) + BAND_PAD;
  return (
    <svg
      className="margin-threads"
      width={Math.max(0, width)}
      height={bottom - top}
      style={{ transform: `translateY(${top}px)` }}
      aria-hidden="true"
      focusable="false"
    >
      <g transform={`translate(0 ${-top})`}>
        {threads.map((t) => (
          <g
            key={t.id}
            className={cx(
              'margin-thread',
              t.color ? `thread-${t.color}` : 'thread-pin',
              t.hot && 'is-hot',
              t.fresh && 'is-new',
              t.estimated && 'is-estimated',
            )}
            data-thought-id={t.id}
          >
            <path d={threadPath(t.from, t.to)} pathLength={1} />
            <circle className="margin-pin" cx={t.to.x} cy={t.to.y} r={t.color ? 2.5 : 3.5} />
          </g>
        ))}
      </g>
    </svg>
  );
}
