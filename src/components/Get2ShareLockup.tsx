/**
 * The Get2Share type lockup: "Get2" in electric blue, "Share" in white,
 * Archivo Expanded Black. Size it with a text-size class.
 */
export default function Get2ShareLockup({ className = '' }: { className?: string }) {
  return (
    <span
      aria-label="Get2Share"
      className={`font-expanded font-black tracking-[-0.01em] text-white leading-none ${className}`}
    >
      <span aria-hidden="true">
        <span className="text-g2-blue">Get2</span>Share
      </span>
    </span>
  );
}
