export async function installFirstAdmin(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('LOCK TABLE auth."user" IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth.first_admin_claim (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        "userId" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION auth.claim_first_admin() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."emailVerified" IS TRUE THEN
          INSERT INTO auth.first_admin_claim (singleton, "userId")
          VALUES (true, NEW.id)
          ON CONFLICT (singleton) DO NOTHING;
          IF FOUND THEN
            NEW.role := 'admin';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    // Preserve an existing admin, or promote the earliest verified account on upgrade.
    const promoted = await client.query(`
      WITH candidate AS (
        SELECT id FROM auth."user"
        WHERE "emailVerified" IS TRUE
        ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, "createdAt", id
        LIMIT 1
      ), claim AS (
        INSERT INTO auth.first_admin_claim (singleton, "userId")
        SELECT true, id FROM candidate
        ON CONFLICT (singleton) DO NOTHING
        RETURNING "userId"
      )
      UPDATE auth."user" AS u
      SET role = 'admin', "updatedAt" = now()
      FROM claim
      WHERE u.id = claim."userId" AND u.role IS DISTINCT FROM 'admin'
      RETURNING u.id
    `);
    await client.query(`
      CREATE OR REPLACE TRIGGER first_admin_claim
      BEFORE INSERT OR UPDATE OF "emailVerified" ON auth."user"
      FOR EACH ROW EXECUTE FUNCTION auth.claim_first_admin()
    `);
    if (promoted.rowCount) {
      await client.query('DELETE FROM auth.session WHERE "userId" = $1', [promoted.rows[0].id]);
    }
    await client.query("COMMIT");
    return { promotedExistingUser: promoted.rowCount === 1 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
