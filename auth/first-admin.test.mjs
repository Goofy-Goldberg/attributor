import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { installFirstAdmin } from "./first-admin.mjs";

const databaseURL = process.env.TEST_DATABASE_URL;

test("only the first verified account becomes admin", { skip: !databaseURL }, async () => {
  assert.match(new URL(databaseURL).pathname, /^\/attributor_auth_test(?:_|$)/);
  const pool = new pg.Pool({ connectionString: databaseURL, max: 5 });
  let createdSchema = false;
  try {
    await pool.query("CREATE SCHEMA auth");
    createdSchema = true;
    await pool.query(`
      CREATE TABLE auth."user" (
        id text PRIMARY KEY,
        "emailVerified" boolean NOT NULL,
        role text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE TABLE auth.session ("userId" text NOT NULL)');

    await pool.query(`INSERT INTO auth."user" (id, "emailVerified", role, "createdAt") VALUES
      ('first', true, 'user', '2026-01-01'), ('second', true, 'user', '2026-01-02')`);
    await pool.query(`INSERT INTO auth.session ("userId") VALUES ('first')`);
    assert.deepEqual(await installFirstAdmin(pool), { promotedExistingUser: true });
    let users = await pool.query('SELECT id, role FROM auth."user" ORDER BY id');
    assert.deepEqual(users.rows, [{ id: "first", role: "admin" }, { id: "second", role: "user" }]);
    assert.equal((await pool.query("SELECT count(*) FROM auth.session")).rows[0].count, "0");

    assert.deepEqual(await installFirstAdmin(pool), { promotedExistingUser: false });
    await pool.query(`UPDATE auth."user" SET role = 'user' WHERE id = 'first'`);
    await pool.query(`INSERT INTO auth."user" (id, "emailVerified", role) VALUES ('third', true, 'user')`);
    assert.equal((await pool.query(`SELECT role FROM auth."user" WHERE id = 'third'`)).rows[0].role, "user");

    await pool.query('TRUNCATE auth.session, auth."user", auth.first_admin_claim');
    await pool.query(`INSERT INTO auth."user" (id, "emailVerified", role) VALUES ('pending', false, 'user')`);
    assert.equal((await pool.query("SELECT count(*) FROM auth.first_admin_claim")).rows[0].count, "0");
    await pool.query(`UPDATE auth."user" SET "emailVerified" = true WHERE id = 'pending'`);
    assert.equal((await pool.query(`SELECT role FROM auth."user" WHERE id = 'pending'`)).rows[0].role, "admin");

    await pool.query('TRUNCATE auth.session, auth."user", auth.first_admin_claim');
    await Promise.all(["one", "two"].map((id) => pool.query(
      'INSERT INTO auth."user" (id, "emailVerified", role) VALUES ($1, true, $2)', [id, "user"],
    )));
    users = await pool.query('SELECT role FROM auth."user"');
    assert.equal(users.rows.filter(({ role }) => role === "admin").length, 1);
    assert.equal((await pool.query("SELECT count(*) FROM auth.first_admin_claim")).rows[0].count, "1");
  } finally {
    if (createdSchema) {
      await pool.query("DROP SCHEMA auth CASCADE");
    }
    await pool.end();
  }
});
