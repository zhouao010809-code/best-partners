import Database from 'better-sqlite3';
import {
  createHmac,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from 'node:crypto';
import { PublicApiError } from '../../shared/api/errors.js';
import type { z } from 'zod';
import {
  companyBootstrapRequestSchema,
  companyLoginRequestSchema,
  type companyRoleSchema,
  type companyUserSchema
} from '../../shared/api/company-auth.js';

const COMPANY_COOKIE_NAME = 'company_session';
const COMPANY_COOKIE_PATH = '/api/company';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 32;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CSRF_SECRET = randomBytes(32);

export type CompanyRole = z.infer<typeof companyRoleSchema>;
export type CompanyUser = z.infer<typeof companyUserSchema>;
export type CompanyPrincipal = CompanyUser;
export type CompanyBootstrapInput = z.input<typeof companyBootstrapRequestSchema>;
export type CompanyLoginInput = z.input<typeof companyLoginRequestSchema>;
export type CompanyPermission =
  | 'project:create'
  | 'project:confirm'
  | 'proposal:read'
  | 'proposal:approve'
  | 'workspace:path:update';

export interface CompanyAuthRequest {
  readonly headers?: {
    readonly cookie?: string | string[] | undefined;
    readonly [key: string]: unknown;
  };
}

export interface CompanyLoginResult {
  readonly user: CompanyPrincipal;
  readonly csrfToken: string;
  readonly setCookie: string;
}

export interface CompanyBootstrapResult {
  readonly users: readonly CompanyUser[];
}

export interface CompanyAuthService {
  readonly bootstrap: (input: CompanyBootstrapInput) => Promise<CompanyBootstrapResult>;
  readonly login: (input: CompanyLoginInput) => Promise<CompanyLoginResult>;
  readonly authenticate: (request: CompanyAuthRequest) => Promise<CompanyPrincipal | undefined>;
  readonly csrfToken: (request: CompanyAuthRequest) => Promise<string | undefined>;
  readonly verifyCsrf: (request: CompanyAuthRequest, token: string | undefined) => Promise<boolean>;
  readonly logout: (request: CompanyAuthRequest) => Promise<string | undefined>;
  readonly can: (user: CompanyPrincipal, permission: CompanyPermission) => boolean;
  readonly requireRole: (user: CompanyPrincipal, roles: readonly CompanyRole[]) => void;
}

export interface CompanyAuthOptions {
  readonly database: Database.Database;
  readonly workspace: {
    readonly id: string;
    readonly displayName: string;
    readonly rootPath: string;
  };
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly csrfSecret?: Buffer;
}

function publicUser(row: {
  id: string;
  display_name: string;
  role: CompanyRole;
}): CompanyUser {
  return { id: row.id, displayName: row.display_name, role: row.role };
}

function cookieValue(cookieHeader: string | string[] | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  const values = header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== COMPANY_COOKIE_NAME) return [];
    return [part.slice(separator + 1).trim()];
  });
  if (values.length !== 1 || !SESSION_ID_PATTERN.test(values[0]!)) return undefined;
  return values[0];
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

function csrfForSession(sessionId: string, secret: Buffer): string {
  return createHmac('sha256', secret)
    .update('xiaozhao-company-csrf\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest('base64url');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, PASSWORD_KEY_BYTES, {
      N: 16_384,
      r: 8,
      p: 1,
      maxmem: 32 * 1024 * 1024
    }, (error, derived) => {
      if (error !== null) reject(error);
      else resolve(Buffer.from(derived));
    });
  });
}

function publicCookie(sessionId: string): string {
  return `${COMPANY_COOKIE_NAME}=${sessionId}; Path=${COMPANY_COOKIE_PATH}; HttpOnly; SameSite=Strict`;
}

function clearCookie(): string {
  return `${COMPANY_COOKIE_NAME}=; Path=${COMPANY_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function requestCookie(request: CompanyAuthRequest): string | undefined {
  return cookieValue(request.headers?.cookie);
}

function unauthorized(): PublicApiError {
  return new PublicApiError('COMPANY_SESSION_REQUIRED', 'Company session required', 401);
}

export function createCompanyAuthService(options: CompanyAuthOptions): CompanyAuthService {
  const now = options.now ?? (() => new Date());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new Error('COMPANY_SESSION_TTL_INVALID');
  }
  const csrfSecret = options.csrfSecret ?? CSRF_SECRET;

  options.database.prepare(`
    INSERT INTO company_workspaces (id, display_name, root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
      root_path = excluded.root_path, updated_at = excluded.updated_at
  `).run(
    options.workspace.id,
    options.workspace.displayName,
    options.workspace.rootPath,
    now().toISOString(),
    now().toISOString()
  );

  const readUserByDisplayName = options.database.prepare(`
    SELECT id, display_name, role, password_salt, password_hash, disabled
    FROM company_users
    WHERE workspace_id = ? AND display_name = ?
  `);
  async function bootstrap(input: CompanyBootstrapInput): Promise<CompanyBootstrapResult> {
    const parsed = companyBootstrapRequestSchema.parse(input);
    if (parsed.operator.displayName === parsed.reviewer.displayName) {
      throw new PublicApiError('COMPANY_DISPLAY_NAME_CONFLICT', 'Company user display names must differ', 400);
    }
    const createdAt = now().toISOString();
    const records: Array<{ displayName: string; role: CompanyRole; password: string; id: string }> = [
      { id: randomBytes(16).toString('hex'), displayName: parsed.operator.displayName, role: 'operator', password: parsed.operator.password },
      { id: randomBytes(16).toString('hex'), displayName: parsed.reviewer.displayName, role: 'reviewer', password: parsed.reviewer.password }
    ];
    const derivedRecords = await Promise.all(records.map(async (record) => {
      const salt = randomBytes(PASSWORD_SALT_BYTES);
      const derived = await derivePassword(record.password, salt);
      return { ...record, salt, derived };
    }));
    const transaction = options.database.transaction(() => {
      const existing = options.database.prepare('SELECT COUNT(*) AS count FROM company_users').get() as { count: number };
      if (existing.count !== 0) {
        throw new PublicApiError('COMPANY_ALREADY_BOOTSTRAPPED', 'Company users already exist', 409);
      }
      const insert = options.database.prepare(`
        INSERT INTO company_users (
          id, workspace_id, display_name, role, password_salt, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const users: CompanyUser[] = [];
      for (const record of derivedRecords) {
        insert.run(
          record.id,
          options.workspace.id,
          record.displayName,
          record.role,
          record.salt.toString('base64url'),
          record.derived.toString('base64url'),
          createdAt,
          createdAt
        );
        users.push({ id: record.id, displayName: record.displayName, role: record.role });
      }
      return { users };
    });
    return transaction();
  }

  async function login(input: CompanyLoginInput): Promise<CompanyLoginResult> {
    const parsed = companyLoginRequestSchema.parse(input);
    const row = readUserByDisplayName.get(options.workspace.id, parsed.displayName) as {
      id: string;
      display_name: string;
      role: CompanyRole;
      password_salt: string;
      password_hash: string;
      disabled: number;
    } | undefined;
    const invalid = () => {
      throw new PublicApiError('COMPANY_CREDENTIALS_INVALID', 'Company credentials invalid', 401);
    };
    if (row === undefined || row.disabled === 1) return invalid();
    const expected = Buffer.from(row.password_hash, 'base64url');
    const actual = await derivePassword(parsed.password, Buffer.from(row.password_salt, 'base64url'));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return invalid();

    const sessionId = randomBytes(32).toString('base64url');
    const timestamp = now().toISOString();
    options.database.prepare(`
      INSERT INTO company_sessions (id_hash, user_id, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      hashSessionId(sessionId),
      row.id,
      new Date(now().getTime() + sessionTtlMs).toISOString(),
      timestamp,
      timestamp
    );
    return {
      user: publicUser(row),
      csrfToken: csrfForSession(sessionId, csrfSecret),
      setCookie: publicCookie(sessionId)
    };
  }

  async function authenticate(request: CompanyAuthRequest): Promise<CompanyPrincipal | undefined> {
    const sessionId = requestCookie(request);
    if (sessionId === undefined) return undefined;
    const row = options.database.prepare(`
      SELECT u.id, u.display_name, u.role, u.disabled, s.expires_at
      FROM company_sessions s
      JOIN company_users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND u.workspace_id = ?
    `).get(hashSessionId(sessionId), options.workspace.id) as {
      id: string;
      display_name: string;
      role: CompanyRole;
      disabled: number;
      expires_at: string;
    } | undefined;
    const expiresAt = row === undefined ? Number.NaN : Date.parse(row.expires_at);
    if (row === undefined || row.disabled === 1 || !Number.isFinite(expiresAt) || expiresAt <= now().getTime()) {
      options.database.prepare('DELETE FROM company_sessions WHERE id_hash = ?').run(hashSessionId(sessionId));
      return undefined;
    }
    options.database.prepare('UPDATE company_sessions SET last_seen_at = ? WHERE id_hash = ?')
      .run(now().toISOString(), hashSessionId(sessionId));
    return publicUser(row);
  }

  async function csrfToken(request: CompanyAuthRequest): Promise<string | undefined> {
    const sessionId = requestCookie(request);
    return sessionId === undefined || await authenticate(request) === undefined
      ? undefined
      : csrfForSession(sessionId, csrfSecret);
  }

  async function verifyCsrf(request: CompanyAuthRequest, token: string | undefined): Promise<boolean> {
    if (token === undefined) return false;
    const sessionId = requestCookie(request);
    if (sessionId === undefined || await authenticate(request) === undefined) return false;
    return constantTimeTextEqual(token, csrfForSession(sessionId, csrfSecret));
  }

  async function logout(request: CompanyAuthRequest): Promise<string | undefined> {
    const sessionId = requestCookie(request);
    if (sessionId === undefined) return undefined;
    options.database.prepare('DELETE FROM company_sessions WHERE id_hash = ?').run(hashSessionId(sessionId));
    return clearCookie();
  }

  function can(user: CompanyPrincipal, permission: CompanyPermission): boolean {
    if (user.role === 'owner') return true;
    if (user.role === 'operator') {
      return permission !== 'proposal:approve';
    }
    return permission === 'proposal:read' || permission === 'proposal:approve';
  }

  function requireRole(user: CompanyPrincipal, roles: readonly CompanyRole[]): void {
    if (!roles.includes(user.role)) {
      throw new PublicApiError('COMPANY_FORBIDDEN', 'Company role is not permitted', 403);
    }
  }

  return {
    bootstrap,
    login,
    authenticate,
    csrfToken,
    verifyCsrf,
    logout,
    can,
    requireRole
  };
}

export function requireCompanyUser(
  auth: Pick<CompanyAuthService, 'authenticate'>,
  request: CompanyAuthRequest
): Promise<CompanyPrincipal> {
  return auth.authenticate(request).then((user) => {
    if (user === undefined) throw unauthorized();
    return user;
  });
}
