import type { FastifyRequest } from 'fastify';
import { AppError, type ErrorCode } from './errors';

export interface UploadedFile {
  fieldname: string;
  filename: string;
  buffer: Buffer;
}

export interface MultipartResult {
  fields: Record<string, string>;
  files: UploadedFile[];
}

export interface ReadMultipartOptions {
  maxFiles: number;
  maxFileBytes: number;
  /** Erro quando chegam mais arquivos que maxFiles. */
  onTooManyFiles: ErrorCode;
  /** Erro quando um arquivo passa de maxFileBytes. */
  onFileTooLarge: ErrorCode;
}

/**
 * Lê um corpo multipart inteiro em memória (no máximo maxFiles × maxFileBytes).
 * Upload não passa pelo validador Zod do Fastify: quem chama valida `fields` com o DTO via .parse().
 */
export async function readMultipart(req: FastifyRequest, opts: ReadMultipartOptions): Promise<MultipartResult> {
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];

  try {
    const parts = req.parts({ limits: { files: opts.maxFiles, fileSize: opts.maxFileBytes, fields: 10 } });
    for await (const part of parts) {
      if (part.type === 'file') {
        files.push({ fieldname: part.fieldname, filename: part.filename, buffer: await part.toBuffer() });
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FST_FILES_LIMIT') throw new AppError(opts.onTooManyFiles);
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(opts.onFileTooLarge);
    throw err;
  }

  return { fields, files };
}
