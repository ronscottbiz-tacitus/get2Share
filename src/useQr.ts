import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** A QR code image (data URL) for `text`, black on white. */
export function useQr(text: string | null, size = 360) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!text) { setUrl(''); return; }
    QRCode.toDataURL(text, { margin: 1, width: size, color: { dark: '#000000', light: '#ffffff' } })
      .then(setUrl)
      .catch(() => setUrl(''));
  }, [text, size]);
  return url;
}
