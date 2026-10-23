import { Images, LayoutDashboard } from 'lucide-react';

/**
 * Hosts switch between the event's gallery and the Host Console without leaving the page.
 * Guests never see this.
 */
export default function HostTabs({
  active, onGallery, onConsole, className = '',
}: {
  active: 'gallery' | 'console';
  onGallery: () => void;
  onConsole: () => void;
  className?: string;
}) {
  const tab = (key: 'gallery' | 'console', label: string, Icon: typeof Images, onClick: () => void) => (
    <button
      type="button"
      onClick={active === key ? undefined : onClick}
      aria-current={active === key ? 'page' : undefined}
      className={`h-9 px-4 rounded-full inline-flex items-center gap-1.5 text-[13px] font-bold transition-colors cursor-pointer ${
        active === key ? 'bg-white text-g2-page' : 'text-g2-secondary hover:text-white'
      }`}
    >
      <Icon className="w-4 h-4" aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <nav aria-label="Host" className={`inline-flex p-1 gap-1 rounded-full border border-white/10 bg-black/40 ${className}`}>
      {tab('gallery', 'Gallery', Images, onGallery)}
      {tab('console', 'Console', LayoutDashboard, onConsole)}
    </nav>
  );
}
