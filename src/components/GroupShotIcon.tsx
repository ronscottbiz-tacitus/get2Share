const Person = ({ className }: { className: string }) => (
  <g className={`group-icon-person ${className}`}>
    <circle cx="0" cy="-5" r="5" fill="#111114" stroke="#5C93FF" strokeWidth="2.6" />
    <path d="M-9.5 10 C-9.5 3.5 -5 0.8 0 0.8 C5 0.8 9.5 3.5 9.5 10" fill="#111114" stroke="#5C93FF" strokeWidth="2.6" strokeLinecap="round" />
  </g>
);

/** Group Shot: three people trading places as they gather for the photo. */
export default function GroupShotIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 36" fill="none" aria-hidden="true" className={`overflow-visible ${className}`}>
      <Person className="group-icon-a" />
      <Person className="group-icon-b" />
      <Person className="group-icon-c" />
    </svg>
  );
}
