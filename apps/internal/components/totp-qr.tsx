'use client';

/*
 * THE ENROLMENT QR CODE (Brian, 2026-09-27, R76). The otpauth URI the API returns at MFA setup, drawn as
 * a QR code an authenticator app scans; the text secret stays beneath it as the fallback. Drawn in the
 * browser by qrcode-generator (2.0.4, pinned; no network): the secret never leaves the page, and no
 * image service is asked to draw it. A canvas, so the harness can read the pixels back and decode them.
 */
import { useEffect, useRef } from 'react';
import qrcode from 'qrcode-generator';

const CELL = 6;
const QUIET = 4; // the quiet zone the QR standard asks for, in modules

export function TotpQr({ uri }: { uri: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !uri) return;
    const qr = qrcode(0, 'M');
    qr.addData(uri, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const size = (n + QUIET * 2) * CELL;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + QUIET) * CELL, (r + QUIET) * CELL, CELL, CELL);
      }
    }
  }, [uri]);
  return (
    <canvas
      ref={ref}
      data-testid="totp-qr"
      role="img"
      aria-label="QR code for your authenticator app"
      style={{ width: 200, height: 200, imageRendering: 'pixelated', display: 'block', margin: '8px 0' }}
    />
  );
}
