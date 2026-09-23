/*
 * GRAMMAR §8's page-level `raw ./custom/Badge.tsx` — an author's own
 * component, placed in the page's flow and given the site's theme.
 */
export default function Badge({ theme }: { theme: { color: Record<string, string> } }) {
  return (
    <span className="fixture-badge" style={{ background: theme.color.surface, color: theme.color.text }}>
      Handmade in the studio
    </span>
  );
}
