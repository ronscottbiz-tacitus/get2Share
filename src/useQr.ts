import { useEffect, useState } from 'react';

/** A QR code image (data URL) for `text`, black on white. */
export function useQr(text: string | null, size = 360) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!text) { setUrl(''); return; }
    let live = true;
    import('qrcode') // loaded only on screens that draw a QR code
      .then((m) => m.default.toDataURL(text, { margin: 1, width: size, color: { dark: '#000000', light: '#ffffff' } }))
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrl(''));
    return () => { live = false; };
  }, [text, size]);
  return url;
}
