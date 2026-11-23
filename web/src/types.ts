export type Me = {
  user: { id: string; email: string; name: string | null; role: "owner" | "member" };
  firm: {
    id: string;
    name: string | null;
    tz: string;
    plan_status: string;
    trial_ends_at: number | null;
    current_period_end: number | null;
    cancel_at_period_end: boolean;
    subscribed: boolean;
    closed_at: number | null;
    usable: boolean;
  };
};

export type Firm = {
  id: string;
  name: string | null;
  legal_name: string | null;
  address: string | null;
  phone: string | null;
  province: string | null;
  tz: string;
  plan_status: string;
  trial_ends_at: number | null;
};

export type Client = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  email_ok_at: number | null;
  email_stop_at: number | null;
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

export type FileRow = { id: string; name: string; size: number; mime: string; uploaded_at: number };

export type ItemWithFiles = Item & { files: FileRow[] };

export type RequestDetail = {
  id: string;
  client_id: string;
  title: string;
  note: string | null;
  deadline: number;
  status: string;
  sent_at: number | null;
  reminders_on: boolean;
  next_reminder_at: number | null;
  ended_at: number | null;
  keep_until: number | null;
  hold_at: number | null;
  items: ItemWithFiles[];
};

export type TrashRequest = { id: string; title: string; client_name: string; deleted_at: number; deleted_reason: "retention" | null; purge_at: number };

export type TrashClient = { id: string; name: string; deleted_at: number; purge_at: number };

export type ActivityRow = {
  id: string;
  at: number;
  actor_type: "user" | "client" | "system";
  actor: string | null;
  action: string;
  object_type: string;
  object_id: string;
  request_id: string | null;
  client_id: string | null;
};

export type Message = { id: string; kind: "invite" | "reminder" | "deadline" | "rejected"; seq: number; status: "sending" | "sent" | "failed"; sent_at: number };

export type LinkResult = { url: string; emailed?: true; email_failed?: true };

export type ClientItem = Omit<Item, "position"> & { files: Omit<FileRow, "mime">[] };

export type ClientView = {
  firm_name: string;
  tz: string;
  title: string;
  note: string | null;
  deadline: number;
  status: string;
  items: ClientItem[];
};
