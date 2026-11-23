import { api, inDays, setup } from "./helpers";

export const year = new Date().getUTCFullYear();
export const born = (age: number) => `${year - age}-01-01`;

export const ITEMS = [
  { label: "Marriage certificate", required: true },
  { label: "Passport", per_person: "everyone", required: true, expiry: "expiry" },
  { label: "Police certificate", per_person: "adults", required: true, expiry: "issue", valid_months: 6 },
  { label: "Spouse's employment letter", per_person: "spouse", required: false },
  { label: "School letter", per_person: "children", required: true },
  { label: "Job offer", per_person: "principal", required: true },
];

export const FAMILY = [
  { role: "principal", name: "Omar Haddad", dob: born(40) },
  { role: "spouse", name: "Amira Haddad" },
  { role: "child", name: "Layla Haddad", dob: born(10) },
  { role: "child", name: "Yusuf Haddad", dob: born(20) },
  { role: "child", name: "Sami Haddad" },
];

export async function family(over: Record<string, unknown> = {}, email = "owner@firm.test") {
  const { cookie, client } = await setup(email);
  const res = await api("/api/requests", {
    method: "POST",
    cookie,
    body: { client_id: client.id, title: "Spousal sponsorship", deadline: inDays(30), items: ITEMS, people: FAMILY, ...over },
  });
  const req = await res.json<any>();
  return { cookie, client, req, res };
}
