/** The approved original PNG is shared by marketing, POS and public ordering.
 * Compact POS headers reveal its symbol through a CSS viewport; no second mark.
 */
export function BrandLogo() {
  return (
    <div className="brand-logo">
      <img
        src="/brand/green-monkey-logo-v1.png"
        alt="Green Monkey"
        width={2161}
        height={728}
        decoding="async"
      />
    </div>
  );
}
