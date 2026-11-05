import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

function loadEnv() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(currentDir, '../../../.env'),
    path.resolve(currentDir, '../../.env'),
    path.resolve(currentDir, '../.env')
  ];

  for (const envPath of candidatePaths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
        break;
      } catch {}
    }
  }
}

loadEnv();

export const prisma = new PrismaClient();
