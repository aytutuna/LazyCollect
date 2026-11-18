export type Me = {
  user: { id: string; email: string; name: string | null; role: "owner" | "member" };
  firm: { id: string; name: string | null; plan_status: string; trial_ends_at: number | null };
};

export type Firm = {
  id: string;
  name: string | null;
  legal_name: string | null;
  address: string | null;
  phone: string | null;
  province: string | null;
  plan_status: string;
  trial_ends_at: number | null;
};

export type Client = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  email_ok_at: number | null;
  sms_ok_at: number | null;
};

export type TemplateItem = { label: string; help?: string; required: boolean };

export type Template = { id: string; name: string; builtin: boolean; items: TemplateItem[] };

export type RequestRow = {
  id: string;
  client_id: string;
  client_name: string;
  title: string;
  deadline: number;
  status: string;
  empty: number;
  submitted: number;
  approved: number;
  rejected: number;
};

export type Item = {
  id: string;
  position: number;
  label: string;
  help: string | null;
  required: boolean;
  status: "empty" | "submitted" | "approved" | "rejected";
  reject_note: string | null;
};

export type RequestDetail = {
  id: string;
  client_id: string;
  title: string;
  note: string | null;
  deadline: number;
  status: string;
  sent_at: number | null;
  items: Item[];
};

export type ClientView = {
  firm_name: string;
  title: string;
  note: string | null;
  deadline: number;
  status: string;
  items: Item[];
};
