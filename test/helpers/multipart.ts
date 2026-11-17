import { randomUUID } from 'node:crypto';

export interface FilePart {
  field: string;
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** Monta um corpo multipart/form-data para app.inject(). */
export function multipart(fields: Record<string, string | undefined>, files: FilePart[] = []) {
  const boundary = `----teste${randomUUID()}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
