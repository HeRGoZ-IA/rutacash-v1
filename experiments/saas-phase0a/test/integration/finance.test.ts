// [pg+api] Libro SINTÉTICO sobre PostgreSQL REAL con conexiones independientes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { balanceOf, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { startApi, type TestApi } from '../helpers/api.ts';
import { createLocalIssuer, type LocalIssuer } from '../helpers/issuer.ts';
import { setDbContext, withTransaction } from '../../src/db/tx.ts';
import * as F from '../helpers/fixtures.ts';

let db: TestDb;
let iss: LocalIssuer;
let api: TestApi;
let anaToken: string;
let evaToken: string;

before(async () => {
  db = await createTestDb('finance');
  await F.seed(db.superPool);
  iss = await createLocalIssuer();
  api = await startApi(db.apiPool, iss.verifier);
  anaToken = await iss.issue(F.ANA);   // admin BR
  evaToken = await iss.issue(F.EVA);   // cobradora BR, ruta BR-1
});
after(async () => {
  // Cerrar SIEMPRE antes de comprobar: un pool abierto impediría que el proceso termine.
  const errors = [...api.errors];
  await api.close();
  await db.close();
  assert.deepEqual(errors, [], 'la API no debe producir errores internos inesperados');
});

/** Cuenta nueva en la ruta BR-1 para que cada escenario empiece limpio. */
async function newAccount(balanceMinor: bigint, company = F.COMPANY_BR, route: string | null = F.ROUTE_BR1): Promise<string> {
  const id = randomUUID();
  await db.superPool.query('insert into adex.accounts (id, company_id, route_id, name, balance_minor) values ($1, $2, $3, $4, $5)',
    [id, company, route, `fin-${id.slice(0, 8)}`, balanceMinor.toString()]);
  return id;
}

const withdraw = (a: TestApi, token: string, membership: string, account: string, amount: string, operationId = randomUUID()) =>
  a.call('POST', `/v1/accounts/${account}/withdrawals`, { token, membership, body: { operationId, amount } });
const deposit = (a: TestApi, token: string, membership: string, account: string, amount: string, operationId = randomUUID()) =>
  a.call('POST', `/v1/accounts/${account}/deposits`, { token, membership, body: { operationId, amount } });

const movementsOf = (acc: string) => count(db.superPool, 'select 1 from adex.movements where account_id = $1', [acc]);
const auditOf = (acc: string, outcome?: string) =>
  count(db.superPool, `select 1 from adex.audit_log where entity_id = $1 ${outcome ? 'and outcome = $2' : ''}`, outcome ? [acc, outcome] : [acc]);
const opsOf = (opId: string) => count(db.superPool, 'select 1 from adex.operations where operation_id = $1', [opId]);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test('FIN-001 [pg+api] doble retiro concurrente: 5.000 − 4.000 − 4.000', async (t) => {
  await t.test('dos peticiones HTTP simultáneas, dos usuarios, 10 rondas', async () => {
    for (let round = 0; round < 10; round++) {
      const acc = await newAccount(500000n);
      const [a, b] = await Promise.all([
        withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '4000.00'),
        withdraw(api, evaToken, F.M_EVA_BR_COBRADOR, acc, '4000.00'),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [201, 422], `ronda ${round}`);
      const rejected = a.status === 422 ? a : b;
      assert.equal(rejected.body['reason'], 'INSUFFICIENT_FUNDS');
      assert.equal(rejected.body['balance'], '1000.00');
      assert.equal(await balanceOf(db.superPool, acc), 100000n, 'saldo final 1.000');
      assert.equal(await movementsOf(acc), 1, 'un único movimiento');
      assert.equal(await auditOf(acc, 'approved'), 1);
      assert.equal(await auditOf(acc, 'rejected'), 1);
      const mv = await db.superPool.query('select amount_minor::text a, balance_after_minor::text b from adex.movements where account_id = $1', [acc]);
      assert.deepEqual(mv.rows[0], { a: '400000', b: '100000' });
    }
  });

  await t.test('intercalado determinista: la segunda petición ESPERA el bloqueo de fila en PostgreSQL', async () => {
    const acc = await newAccount(500000n);
    const opA = randomUUID();
    const locked = deferred();
    const release = deferred();
    const pids: number[] = [];
    const paused = await startApi(db.apiPool, iss.verifier, {
      afterAccountLocked: async ({ operationId, client }) => {
        pids.push(Number((await client.query('select pg_backend_pid() as p')).rows[0].p));
        if (operationId === opA) { locked.resolve(); await release.promise; }
      },
    });
    try {
      const pA = withdraw(paused, anaToken, F.M_ANA_BR_ADMIN, acc, '4000.00', opA);
      await locked.promise;                                   // A tiene la fila bloqueada
      const pB = withdraw(paused, evaToken, F.M_EVA_BR_COBRADOR, acc, '4000.00');
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
        waiting = await count(db.superPool, `select 1 from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and query ilike '%for update%'`, [db.name]);
      }
      release.resolve();
      const [a, b] = await Promise.all([pA, pB]);
      assert.equal(waiting, 1, 'B estaba bloqueada esperando la fila que retiene A');
      assert.equal(a.status, 201);
      assert.equal(b.status, 422);
      assert.equal(b.body['balance'], '1000.00', 'B leyó el saldo YA actualizado por A');
      assert.equal(new Set(pids).size, 2, 'dos conexiones (backends) distintas de PostgreSQL');
    } finally {
      release.resolve(); // nunca dejar la petición A en pausa si una aserción falla
      await paused.close();
    }
  });

  await t.test('estrés: 20 retiros simultáneos de 400 sobre 5.000', async () => {
    const acc = await newAccount(500000n);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      i % 2 ? withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '400.00') : withdraw(api, evaToken, F.M_EVA_BR_COBRADOR, acc, '400.00')));
    assert.equal(rs.filter((r) => r.status === 201).length, 12);
    assert.equal(rs.filter((r) => r.status === 422).length, 8);
    assert.equal(await balanceOf(db.superPool, acc), 20000n);
    const sum = await db.superPool.query('select coalesce(sum(amount_minor), 0)::text s from adex.movements where account_id = $1', [acc]);
    assert.equal(sum.rows[0].s, '480000', 'saldo inicial − Σ movimientos = saldo final');
  });

  await t.test('control negativo: SIN bloqueo, la misma carrera produce doble gasto (la prueba lo detecta)', async () => {
    const acc = await newAccount(500000n);
    const naive = async (c: pg.Client, identity: string, membership: string, role: string) => {
      await c.query('begin');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true)`, [identity, membership, F.COMPANY_BR]);
      const bal = BigInt((await c.query('select balance_minor from adex.accounts where id = $1', [acc])).rows[0].balance_minor); // sin FOR UPDATE
      return async () => {
        const op = randomUUID();
        if (bal < 400000n) { await c.query('rollback'); return false; }
        await c.query(`insert into adex.operations (company_id, operation_id, kind, request_hash, membership_id, outcome) values ($1, $2, 'withdrawal', 'naive', $3, 'approved')`, [F.COMPANY_BR, op, membership]);
        await c.query('update adex.accounts set balance_minor = $2 where id = $1', [acc, (bal - 400000n).toString()]);
        await c.query(`insert into adex.movements (company_id, account_id, operation_id, kind, amount_minor, balance_after_minor, currency_code, identity_id, membership_id, role)
                       values ($1, $2, $3, 'withdrawal', 400000, $4, 'BRL', $5, $6, $7)`, [F.COMPANY_BR, acc, op, (bal - 400000n).toString(), identity, membership, role]);
        await c.query('commit');
        return true;
      };
    };
    const c1 = new pg.Client({ connectionString: db.apiUrl });
    const c2 = new pg.Client({ connectionString: db.apiUrl });
    await c1.connect(); await c2.connect();
    try {
      const finish1 = await naive(c1, F.ANA, F.M_ANA_BR_ADMIN, 'admin');     // ambas leen 5.000
      const finish2 = await naive(c2, F.EVA, F.M_EVA_BR_COBRADOR, 'cobrador');
      assert.equal(await finish1(), true);
      assert.equal(await finish2(), true);
    } finally {
      await c1.end(); await c2.end();
    }
    assert.equal(await movementsOf(acc), 2, 'dos retiros de 4.000 aprobados sobre 5.000');
    assert.equal(await balanceOf(db.superPool, acc), 100000n, 'actualización perdida: el saldo no refleja el segundo retiro');
  });
});

test('FIN-002 [pg+api] reintento con el mismo operationId no escribe de nuevo', async (t) => {
  await t.test('reintento secuencial de un retiro aprobado', async () => {
    const acc = await newAccount(500000n);
    const op = randomUUID();
    const r1 = await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '1000.00', op);
    const r2 = await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '1000.00', op);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r2.body['replayed'], true);
    assert.equal(r2.body['movementId'], r1.body['movementId']);
    assert.equal(r2.body['balanceAfter'], '4000.00');
    assert.equal(await balanceOf(db.superPool, acc), 400000n);
    assert.equal(await movementsOf(acc), 1);
    assert.equal(await auditOf(acc), 1);
    assert.equal(await opsOf(op), 1);
  });
  await t.test('un rechazo registrado se devuelve igual aunque luego haya saldo', async () => {
    const acc = await newAccount(100000n);
    const op = randomUUID();
    assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '2000.00', op)).status, 422);
    assert.equal((await deposit(api, anaToken, F.M_ANA_BR_ADMIN, acc, '5000.00')).status, 201);
    const again = await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '2000.00', op);
    assert.equal(again.status, 422);
    assert.equal(again.body['replayed'], true);
    assert.equal(await balanceOf(db.superPool, acc), 600000n);
    assert.equal(await auditOf(acc, 'rejected'), 1);
  });
  await t.test('5 duplicados SIMULTÁNEOS de la misma operación → un solo movimiento', async () => {
    const acc = await newAccount(500000n);
    const op = randomUUID();
    const rs = await Promise.all(Array.from({ length: 5 }, () => withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '1000.00', op)));
    assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201]);
    assert.equal(new Set(rs.map((r) => r.body['movementId'])).size, 1);
    assert.equal(rs.filter((r) => r.body['replayed'] === true).length, 4);
    assert.equal(await movementsOf(acc), 1);
    assert.equal(await balanceOf(db.superPool, acc), 400000n);
  });
});

test('FIN-003 [pg+api] mismo operationId con parámetros diferentes → 409 sin escrituras', async () => {
  const acc = await newAccount(500000n);
  const other = await newAccount(500000n);
  const op = randomUUID();
  assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '10.00', op)).status, 201);
  const variants = [
    () => withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '20.00', op),          // otro importe
    () => withdraw(api, anaToken, F.M_ANA_BR_ADMIN, other, '10.00', op),        // otra cuenta
    () => deposit(api, anaToken, F.M_ANA_BR_ADMIN, acc, '10.00', op),           // otro tipo
    () => withdraw(api, evaToken, F.M_EVA_BR_COBRADOR, acc, '10.00', op),       // otra membresía
  ];
  for (const v of variants) {
    const r = await v();
    assert.equal(r.status, 409);
    assert.equal(r.body['error'], 'IDEMPOTENCY_KEY_REUSED');
  }
  assert.equal(await balanceOf(db.superPool, acc), 499000n);
  assert.equal(await balanceOf(db.superPool, other), 500000n);
  assert.equal(await movementsOf(acc) + await movementsOf(other), 1);
  assert.equal(await opsOf(op), 1);
});

test('FIN-004 [pg+api] fallo provocado entre el saldo y la auditoría → rollback total', async (t) => {
  for (const point of ['afterBalanceUpdate', 'afterMovementInsert'] as const) {
    await t.test(`fallo en ${point}`, async () => {
      const acc = await newAccount(500000n);
      const op = randomUUID();
      let seenInsideTx: string | null = null;
      const failing = await startApi(db.apiPool, iss.verifier, {
        [point]: async ({ operationId, client }: { operationId: string; client: pg.PoolClient }) => {
          if (operationId !== op) return;
          seenInsideTx = (await client.query('select balance_minor::text b from adex.accounts where id = $1', [acc])).rows[0].b;
          throw new Error(`fallo inyectado (${point})`);
        },
      });
      try {
        const r = await withdraw(failing, anaToken, F.M_ANA_BR_ADMIN, acc, '1500.00', op);
        assert.equal(r.status, 500);
        assert.equal(failing.errors.length, 1);
      } finally {
        await failing.close();
      }
      assert.equal(seenInsideTx, '350000', 'dentro de la transacción el saldo SÍ había cambiado');
      assert.equal(await balanceOf(db.superPool, acc), 500000n, 'tras el fallo el saldo vuelve a 5.000');
      assert.equal(await movementsOf(acc), 0);
      assert.equal(await auditOf(acc), 0);
      assert.equal(await opsOf(op), 0, 'la clave de idempotencia tampoco queda consumida');
      // El mismo operationId puede reintentarse con éxito.
      const retry = await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '1500.00', op);
      assert.equal(retry.status, 201);
      assert.equal(await balanceOf(db.superPool, acc), 350000n);
    });
  }
});

test('FIN-005 [pg+api] movimiento y auditoría atómicos', async (t) => {
  await t.test('la propia escritura de auditoría falla en PostgreSQL → no queda movimiento', async () => {
    const acc = await newAccount(500000n);
    const op = randomUUID();
    await db.superPool.query(`alter table adex.audit_log add constraint t_fin005_block check (operation_id is distinct from '${op}')`);
    try {
      const r = await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, acc, '13.13', op);
      assert.equal(r.status, 500);
      api.errors.length = 0; // fallo esperado
    } finally {
      await db.superPool.query('alter table adex.audit_log drop constraint t_fin005_block');
    }
    assert.equal(await balanceOf(db.superPool, acc), 500000n);
    assert.equal(await movementsOf(acc), 0);
    assert.equal(await opsOf(op), 0);
  });
  await t.test('todo movimiento tiene exactamente una auditoría aprobada de la MISMA transacción', async () => {
    const orphans = await count(db.superPool, `
      select m.id from adex.movements m
       where (select count(*) from adex.audit_log a
               where a.company_id = m.company_id and a.operation_id = m.operation_id and a.outcome = 'approved'
                 and a.txid = m.txid and a.membership_id = m.membership_id and a.identity_id = m.identity_id and a.role = m.role) <> 1
         and m.operation_id in (select operation_id from adex.operations where request_hash <> 'naive')`);
    assert.equal(orphans, 0);
    assert.ok(await count(db.superPool, 'select 1 from adex.movements') > 20);
  });
  await t.test('libro y auditoría son append-only (propietario y superusuario incluidos)', async () => {
    // Propietario: FORCE RLS sin política de UPDATE/DELETE → no alcanza ninguna fila.
    const owner = new pg.Client({ connectionString: db.apiUrl.replace(/adex_api:[^@]+@/, `adex_owner:${encodeURIComponent(process.env['ADEX_PG_OWNER_PASS'] ?? '')}@`) });
    await owner.connect();
    try {
      assert.equal((await owner.query('update adex.audit_log set action = action')).rowCount, 0);
      assert.equal((await owner.query('delete from adex.movements')).rowCount, 0);
    } finally {
      await owner.end();
    }
    // Superusuario (ignora RLS): el disparador append-only lo impide.
    await assert.rejects(db.superPool.query('update adex.audit_log set action = action'), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(db.superPool.query('delete from adex.movements'), (e: { code?: string }) => e.code === '42501');
  });
});

test('FIN-006 [pg+api] libros financieros aislados entre empresas', async () => {
  const bruno = await iss.issue(F.BRUNO);
  const op = randomUUID();
  // El mismo operationId en dos empresas son dos operaciones distintas (clave por empresa).
  const br = await deposit(api, anaToken, F.M_ANA_BR_ADMIN, F.ACC_BR_COMPANY, '10.00', op);
  const co = await deposit(api, bruno, F.M_BRUNO_CO_ADMIN, F.ACC_CO_COMPANY, '10.00', op);
  assert.equal(br.status, 201);
  assert.equal(co.status, 201);
  assert.equal(br.body['currency'], 'BRL');
  assert.equal(co.body['currency'], 'COP');
  // Retirar del libro ajeno: no existe para esa membresía.
  const coBefore = await balanceOf(db.superPool, F.ACC_CO_COMPANY);
  assert.equal((await withdraw(api, anaToken, F.M_ANA_BR_ADMIN, F.ACC_CO_COMPANY, '1.00')).status, 404);
  assert.equal(await balanceOf(db.superPool, F.ACC_CO_COMPANY), coBefore);
  // Bajo RLS, el contexto CO solo ve movimientos y auditoría de CO.
  const viewed = await withTransaction(db.apiPool, async (c) => {
    await setDbContext(c, { identityId: F.BRUNO, membershipId: F.M_BRUNO_CO_ADMIN, companyId: F.COMPANY_CO });
    const r = await c.query('select distinct company_id from adex.movements union select distinct company_id from adex.audit_log');
    return r.rows.map((x) => x.company_id);
  });
  assert.deepEqual(viewed, [F.COMPANY_CO]);
});

test('LOCK-001 [pg] (complementaria) interbloqueo: PostgreSQL lo detecta y la transacción se reintenta completa', async (t) => {
  const run = async (order: 'opposite' | 'ordered') => {
    const a1 = await newAccount(0n, F.COMPANY_BR, null);
    const a2 = await newAccount(0n, F.COMPANY_BR, null);
    const [first, second] = [a1, a2].sort();
    let retries = 0;
    let arrived = 0;
    const gate = deferred();
    const tx = (x: string, y: string) => withTransaction(db.apiPool, async (c) => {
      await setDbContext(c, { identityId: F.ANA, membershipId: F.M_ANA_BR_ADMIN, companyId: F.COMPANY_BR });
      await c.query('update adex.accounts set balance_minor = balance_minor + 1 where id = $1', [x]);
      if (++arrived === 2) gate.resolve();
      await Promise.race([gate.promise, new Promise((r) => setTimeout(r, 1000))]);
      await c.query('update adex.accounts set balance_minor = balance_minor + 1 where id = $1', [y]);
    }, { onRetry: () => { retries++; } });
    if (order === 'opposite') await Promise.all([tx(a1, a2), tx(a2, a1)]);
    else await Promise.all([tx(first as string, second as string), tx(first as string, second as string)]);
    assert.equal(await balanceOf(db.superPool, a1), 2n, 'cada transacción aplicada exactamente una vez');
    assert.equal(await balanceOf(db.superPool, a2), 2n);
    return retries;
  };
  await t.test('orden opuesto → deadlock 40P01 detectado, una transacción reintentada', async () => {
    assert.equal(await run('opposite'), 1);
  });
  await t.test('orden determinista por id → sin deadlock ni reintentos', async () => {
    assert.equal(await run('ordered'), 0);
  });
});
