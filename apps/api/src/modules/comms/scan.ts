// Virus scanning for inbound attachments — pluggable like the KBA vendor.
// ClamAV clamd INSTREAM over TCP when CLAMAV_HOST is configured (self-hosted,
// approved-vendor-safe: bytes never leave the box); otherwise scans record
// 'skipped'. Quarantine + the staff confirm tap gate filing either way — an
// 'infected' verdict additionally hard-blocks filing.

import { Socket } from 'node:net';
import type { Config } from '../../config.ts';

export type ScanVerdict = { status: 'clean' | 'infected' | 'skipped'; detail: string | null };

export async function scanBuffer(config: Config, buffer: Buffer): Promise<ScanVerdict> {
  if (!config.CLAMAV_HOST) return { status: 'skipped', detail: 'no scanner configured' };
  try {
    const response = await clamdInstream(config.CLAMAV_HOST, config.CLAMAV_PORT, buffer);
    if (/\bOK$/.test(response)) return { status: 'clean', detail: null };
    const found = response.match(/: (.+) FOUND/);
    return { status: 'infected', detail: found?.[1] ?? response.slice(0, 120) };
  } catch (err) {
    // Scanner down ≠ attachment lost: it stays quarantined as 'skipped' with
    // the failure noted; staff review is the gate that always stands.
    return { status: 'skipped', detail: `scanner unreachable: ${(err as Error).message.slice(0, 80)}` };
  }
}

function clamdInstream(host: string, port: number, buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    const chunks: Buffer[] = [];
    sock.setTimeout(20_000, () => { sock.destroy(); reject(new Error('clamd timeout')); });
    sock.on('error', reject);
    sock.on('data', (d) => chunks.push(d));
    sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').replaceAll('\0', '').trim()));
    sock.connect(port, host, () => {
      sock.write('zINSTREAM\0');
      const CHUNK = 64 * 1024;
      for (let off = 0; off < buffer.length; off += CHUNK) {
        const part = buffer.subarray(off, Math.min(off + CHUNK, buffer.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length, 0);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    });
  });
}
