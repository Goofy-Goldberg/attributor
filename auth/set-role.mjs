import pg from "pg";

const [email, role] = process.argv.slice(2);
if (!email || !["user", "admin"].includes(role) || !process.env.DATABASE_URL) {
  console.error("Usage: npm run set-role -- user@stratc.org user|admin (DATABASE_URL required)");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      'UPDATE auth."user" SET role = $1, "updatedAt" = NOW() WHERE lower(email) = lower($2) AND "emailVerified" = true RETURNING id, email',
      [role, email],
    );
    if (result.rowCount !== 1) {
      throw new Error("No verified account has that email address.");
    }
    await client.query('DELETE FROM auth.session WHERE "userId" = $1', [result.rows[0].id]);
    await client.query("COMMIT");
    console.log(`Updated ${result.rows[0].email} to ${role}. They must sign in again.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
