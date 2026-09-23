/*
 * GRAMMAR §8's `slot after ./custom/Ticker.tsx` — an author's own component.
 * It reads the theme it is handed, as any escape-hatch component should, so
 * the verify-build run can see tokens reach custom code (ROADMAP M3).
 */
export default function Ticker({ theme }: { theme: { color: Record<string, string> } }) {
  return (
    <p className="fixture-ticker" style={{ color: theme.color.accent }}>
      Forty pairs this month — twelve left.
    </p>
  );
}
