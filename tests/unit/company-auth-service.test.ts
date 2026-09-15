import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import {
  createCompanyAuthService,
  type CompanyAuthService
} from '../../src/server/company/company-auth-service.js';

const databases: Database.Database[] = [];

function fixture(): { db: Database.Database; auth: CompanyAuthService } {
  const db = new Database(':memory:');
  applyMigrations(db);
  databases.push(db);
  return {
    db,
    auth: createCompanyAuthService({
      database: db,
      workspace: {
        id: 'workspace-1',
        displayName: 'Test workspace',
        rootPath: '/srv/company-workspace'
      },
      now: () => new Date('2026-09-16T00:00:00.000Z'),
      sessionTtlMs: 60_000
    })
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('company auth service', () => {
  it('bootstraps exactly one operator and one reviewer, without returning password material', async () => {
    const { db, auth } = fixture();

    const result = await auth.bootstrap({
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    });

    expect(result.users).toEqual([
      { id: expect.any(String), displayName: 'Operator', role: 'operator' },
      { id: expect.any(String), displayName: 'Reviewer', role: 'reviewer' }
    ]);
    expect(JSON.stringify(result)).not.toContain('operator-secret');
    expect(JSON.stringify(result)).not.toContain('reviewer-secret');
    expect(db.prepare('SELECT COUNT(*) AS count FROM company_users').get()).toEqual({ count: 2 });
    const rows = db.prepare('SELECT role, password_salt, password_hash FROM company_users ORDER BY role').all() as Array<{
      role: string;
      password_salt: string;
      password_hash: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.password_salt).toHaveLength(22);
    expect(rows[1]?.password_salt).toHaveLength(22);
    expect(rows[0]?.password_salt).not.toBe(rows[1]?.password_salt);
    expect(rows[0]?.password_hash).toHaveLength(43);
    expect(rows[1]?.password_hash).toHaveLength(43);

    await expect(auth.bootstrap({
      operator: { displayName: 'Another operator', password: 'operator-secret' },
      reviewer: { displayName: 'Another reviewer', password: 'reviewer-secret' }
    })).rejects.toMatchObject({ code: 'COMPANY_ALREADY_BOOTSTRAPPED', statusCode: 409 });
  });

  it('allows only one winner when bootstrap requests race', async () => {
    const { db, auth } = fixture();
    const input = {
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    };
    const results = await Promise.allSettled([auth.bootstrap(input), auth.bootstrap(input)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'COMPANY_ALREADY_BOOTSTRAPPED', statusCode: 409 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM company_users').get()).toEqual({ count: 2 });
  });

  it('issues opaque hashed sessions and binds CSRF tokens to the session', async () => {
    const { db, auth } = fixture();
    await auth.bootstrap({
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    });

    const login = await auth.login({ displayName: 'Operator', password: 'operator-secret' });
    expect(login.user).toEqual({ id: expect.any(String), displayName: 'Operator', role: 'operator' });
    expect(login.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(login.setCookie).toMatch(/^company_session=[A-Za-z0-9_-]{43}; Path=\/api\/company; HttpOnly; SameSite=Strict$/u);
    expect(JSON.stringify(login)).not.toContain('operator-secret');
    const cookieValue = login.setCookie.split(';', 1)[0]!.slice('company_session='.length);
    expect(cookieValue).not.toContain('.');
    const sessionRows = db.prepare('SELECT id_hash FROM company_sessions').all() as Array<{ id_hash: string }>;
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.id_hash).toHaveLength(64);
    expect(sessionRows[0]?.id_hash).not.toBe(cookieValue);
    const request = { headers: { cookie: login.setCookie.split(';', 1)[0] } };
    expect(await auth.authenticate(request)).toEqual(login.user);
    await expect(auth.verifyCsrf(request, login.csrfToken)).resolves.toBe(true);
    await expect(auth.verifyCsrf(request, 'a'.repeat(43))).resolves.toBe(false);
  });

  it('rejects wrong, expired, disabled, and malformed sessions', async () => {
    const now = { value: new Date('2026-09-16T00:00:00.000Z') };
    const db = new Database(':memory:');
    applyMigrations(db);
    databases.push(db);
    const auth = createCompanyAuthService({
      database: db,
      workspace: { id: 'workspace-1', displayName: 'Test', rootPath: '/srv/company' },
      now: () => now.value,
      sessionTtlMs: 1_000
    });
    await auth.bootstrap({
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    });

    await expect(auth.login({ displayName: 'Operator', password: 'wrong' }))
      .rejects.toMatchObject({ code: 'COMPANY_CREDENTIALS_INVALID', statusCode: 401 });
    const login = await auth.login({ displayName: 'Operator', password: 'operator-secret' });
    expect(await auth.authenticate({ headers: { cookie: 'company_session=malformed' } })).toBeUndefined();
    now.value = new Date('2026-09-16T00:00:01.001Z');
    expect(await auth.authenticate({ headers: { cookie: login.setCookie.split(';', 1)[0] } })).toBeUndefined();

    now.value = new Date('2026-09-16T00:00:02.000Z');
    const fresh = await auth.login({ displayName: 'Operator', password: 'operator-secret' });
    const operator = db.prepare('SELECT id FROM company_users WHERE display_name = ?').get('Operator') as { id: string };
    db.prepare('UPDATE company_users SET disabled = 1 WHERE id = ?').run(operator.id);
    expect(await auth.authenticate({ headers: { cookie: fresh.setCookie.split(';', 1)[0] } })).toBeUndefined();
  });

  it('enforces operator/reviewer permissions at the service boundary', async () => {
    const { auth } = fixture();
    await auth.bootstrap({
      operator: { displayName: 'Operator', password: 'operator-secret' },
      reviewer: { displayName: 'Reviewer', password: 'reviewer-secret' }
    });
    const operator = await auth.login({ displayName: 'Operator', password: 'operator-secret' });
    const reviewer = await auth.login({ displayName: 'Reviewer', password: 'reviewer-secret' });

    expect(auth.can(operator.user, 'project:create')).toBe(true);
    expect(auth.can(operator.user, 'project:confirm')).toBe(true);
    expect(auth.can(reviewer.user, 'proposal:read')).toBe(true);
    expect(auth.can(reviewer.user, 'proposal:approve')).toBe(true);
    expect(auth.can(reviewer.user, 'workspace:path:update')).toBe(false);
    expect(auth.can(operator.user, 'workspace:path:update')).toBe(true);
    expect(() => auth.requireRole(reviewer.user, ['operator'])).toThrowError(
      expect.objectContaining({ code: 'COMPANY_FORBIDDEN', statusCode: 403 })
    );
  });
});
