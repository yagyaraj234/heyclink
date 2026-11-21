import { createHash, randomInt } from "node:crypto";
import type { Lang } from "../contracts.ts";
import type { Query, Tx } from "./store.ts";

export const AUTH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS household_profiles (
    household text PRIMARY KEY REFERENCES households(id), name text NOT NULL, location text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS household_members (
    household text REFERENCES households(id), uid text NOT NULL, role text NOT NULL CHECK (role IN ('owner', 'cook')),
    PRIMARY KEY (household, uid), UNIQUE (household, role)
  );
  CREATE INDEX IF NOT EXISTS household_members_uid ON household_members(uid);
  CREATE TABLE IF NOT EXISTS cook_invites (
    household text PRIMARY KEY REFERENCES households(id), hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cook_invite_attempts (
    uid text NOT NULL, bucket timestamptz NOT NULL, attempts integer NOT NULL, PRIMARY KEY (uid, bucket)
  );
`;

type Role = "owner" | "cook";
type Profile = { name: string; location: string };
type Membership = Profile & { id: string; lang: Lang; role: Role };
type InviteState = { cookJoined: boolean; expiresAt: Date | null };
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const hash = (code: string) => createHash("sha256").update(code).digest("hex");

export function openHouseholdAuth(q: Query, tx: Tx) {
  const lockHousehold = (id: string) => q("SELECT id FROM households WHERE id = $1 FOR UPDATE", id);

  return {
    role: async (id: string, uid: string) =>
      (await q<{ role: Role }>("SELECT role FROM household_members WHERE household = $1 AND uid = $2", id, uid)).rows[0]?.role,
    async addOwner(id: string, uid: string, { name, location }: Profile) {
      await q("INSERT INTO household_profiles VALUES ($1, $2, $3)", id, name, location);
      await q("INSERT INTO household_members VALUES ($1, $2, 'owner')", id, uid);
    },
    async list(uid: string) {
      return (await q<Membership>(`
        SELECT h.id, p.name, p.location, m.role, h.data::json->'cook'->>'lang' AS lang
        FROM household_members m JOIN household_profiles p ON p.household = m.household
        JOIN households h ON h.id = m.household
        WHERE m.uid = $1 ORDER BY p.name, h.id
      `, uid)).rows;
    },
    async state(id: string) {
      return (await q<InviteState>(`
        SELECT EXISTS(SELECT 1 FROM household_members WHERE household = $1 AND role = 'cook') AS "cookJoined",
          (SELECT expires_at FROM cook_invites WHERE household = $1 AND expires_at > now()) AS "expiresAt"
      `, id)).rows[0]!;
    },
    invite: (id: string) => tx(async () => {
      await lockHousehold(id);
      if ((await q("SELECT 1 FROM household_members WHERE household = $1 AND role = 'cook'", id)).rowCount) return;
      const code = Array.from({ length: 12 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
      const { expires_at: expiresAt } = (await q<{ expires_at: Date }>(`
        INSERT INTO cook_invites VALUES ($1, $2, now() + interval '24 hours')
        ON CONFLICT (household) DO UPDATE SET hash = EXCLUDED.hash, expires_at = EXCLUDED.expires_at
        RETURNING expires_at
      `, id, hash(code))).rows[0]!;
      return { code, expiresAt };
    }),
    revoke: (id: string, cook: boolean) => tx(async () => {
      await lockHousehold(id);
      await q("DELETE FROM cook_invites WHERE household = $1", id);
      if (cook) await q("DELETE FROM household_members WHERE household = $1 AND role = 'cook'", id);
    }),
    allowJoinAttempt: (uid: string) => tx(async () => {
      await q("DELETE FROM cook_invite_attempts WHERE bucket < date_trunc('hour', now())");
      return !!(await q(`
        INSERT INTO cook_invite_attempts VALUES ($1, date_trunc('hour', now()), 1)
        ON CONFLICT (uid, bucket) DO UPDATE SET attempts = cook_invite_attempts.attempts + 1
        WHERE cook_invite_attempts.attempts < 20 RETURNING 1
      `, uid)).rowCount;
    }),
    async preview(code: string) {
      return (await q<{ name: string }>(`
        SELECT p.name FROM cook_invites i JOIN household_profiles p ON p.household = i.household
        WHERE i.hash = $1 AND i.expires_at > now()
      `, hash(code))).rows[0];
    },
    join: (code: string, uid: string) => tx(async () => {
      const digest = hash(code);
      const id = (await q<{ household: string }>("SELECT household FROM cook_invites WHERE hash = $1 AND expires_at > now()", digest)).rows[0]?.household;
      if (!id) return;
      await lockHousehold(id);
      if (!(await q("SELECT 1 FROM cook_invites WHERE household = $1 AND hash = $2 AND expires_at > clock_timestamp()", id, digest)).rowCount) return;
      const joined = await q("INSERT INTO household_members VALUES ($1, $2, 'cook') ON CONFLICT DO NOTHING", id, uid);
      if (!joined.rowCount) return;
      await q("DELETE FROM cook_invites WHERE household = $1", id);
      return id;
    }),
  };
}
