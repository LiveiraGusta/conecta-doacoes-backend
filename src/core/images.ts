import sharp from 'sharp';
import { AppError } from './errors';

export type FileKind = 'pdf' | 'jpg' | 'png' | 'webp';

export const MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/** Identifica o tipo pelos primeiros bytes, nunca pela extensão ou pelo Content-Type enviado. */
export function detectFileKind(buf: Buffer): FileKind | null {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp'; // RIFF....WEBP
  return null;
}

/**
 * Valida e normaliza uma foto de item: só JPG/PNG/WEBP, aplica a rotação EXIF,
 * limita o maior lado a 1600 px e converte para webp q80 sem metadados.
 */
export async function toWebp(buf: Buffer): Promise<Buffer> {
  const kind = detectFileKind(buf);
  if (kind !== 'jpg' && kind !== 'png' && kind !== 'webp') throw new AppError('INVALID_PHOTO');
  try {
    return await sharp(buf, { failOn: 'error' })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new AppError('INVALID_PHOTO');
  }
}
