export type Me = {
  user: { id: string; email: string; name: string | null; role: "owner" | "member" };
  firm: {
    id: string;
    name: string | null;
    tz: string;
    plan_status: string;
    trial_ends_at: number | null;
    current_period_end: number | null;
    past_due_since: number | null;
    cancel_at_period_end: boolean;
    subscribed: boolean;
    plan_source: string | null;
    closed_at: number | null;
    held: boolean;
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
  reference: string | null;
  email_ok_at: number | null;
  email_stop_at: number | null;
  email_bounced_at: number | null;
  sms_ok_at: number | null;
};

export type Kind = "file" | "yesno" | "text" | "longtext" | "number" | "date" | "choice" | "multi";

export type Filter = "everyone" | "adults" | "spouse" | "children" | "principal";

export type TemplateItem = {
  label: string;
  help?: string;
  required: boolean;
  kind?: Kind;
  options?: string[];
  show_if?: { item: number; value: string };
  example?: string;
  per_person?: Filter;
  expiry?: "expiry" | "issue";
  valid_months?: number;
  translation?: boolean;
};

export type Role = "principal" | "spouse" | "child" | "other";

export type Applicant = { id: string; position: number; role: Role; name: string; dob: string | null };

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
  unavailable: number;
  waived: number;
  unanswered: number;
  expiring: number;
  expiring_on: string | null;
};

export type RequestCounts = { all: number; to_review: number; waiting: number; expiring: number; overdue: number; due_soon: number; done: number };

export type ClientRow = Client & { requests: number };

export type Item = {
  id: string;
  position: number;
  label: string;
  help: string | null;
  required: boolean;
  status: "empty" | "submitted" | "approved" | "rejected" | "unavailable" | "waived";
  reject_note: string | null;
  reject_reasons: string[];
  unavailable_note: string | null;
  kind: Kind;
  // the id of an uploaded example, or the name of a built-in one
  example: string | null;
  options: string[] | null;
  show_if_pos: number | null;
  show_if_value: string | null;
  answer: string | string[] | null;
  answer_at: number | null;
  hidden: boolean;
  person_pos: number | null;
  label_base: string | null;
  for_pos: number | null;
  companion: "question" | "translation" | "affidavit" | null;
  translation: boolean;
  expiry_rule: "expiry" | "issue" | null;
  valid_months: number | null;
  expires_on: string | null;
  issued_on: string | null;
  valid_to: string | null;
  expiry_flag: "expired" | "short" | "soon" | null;
};

export type FileRow = { id: string; name: string; size: number; mime: string; uploaded_at: number; sent_back_at: number | null };

export type ItemWithFiles = Item & { files: FileRow[] };

export type RequestDetail = {
  id: string;
  client_id: string;
  title: string;
  note: string | null;
  deadline: number;
  status: string;
  sent_at: number | null;
  first_opened_at: number | null;
  reminders_on: boolean;
  next_reminder_at: number | null;
  ended_at: number | null;
  keep_until: number | null;
  hold_at: number | null;
  valid_until: string;
  valid_until_set: boolean;
  per_person_items: number;
  people: Applicant[];
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
  decision?: string;
  reasons?: string[];
};

export type Person = { id: string; email: string; name: string | null; role: "owner" | "member"; created_at: number; sessions: number; passkeys: number };

export type PasskeyRow = { id: string; name: string; user_verified: boolean; created_at: number; last_used_at: number | null };

export type SessionRow = { id: string | null; label: string | null; created_at: number; last_seen_at: number; current: boolean };

export type PendingInvite = { id: string; email: string; name: string | null; created_at: number; expires_at: number };

export type Message = { id: string; kind: "invite" | "reminder" | "deadline" | "rejected" | "answer"; seq: number; status: "sending" | "sent" | "failed"; sent_at: number; bounced_at: number | null; manual: 0 | 1 };

export type LinkResult = { url: string; emailed?: true; email_failed?: true };

export type ClientItem = Omit<Item, "position" | "show_if_pos" | "show_if_value" | "answer_at" | "hidden" | "label_base" | "for_pos" | "companion" | "translation" | "valid_to" | "expiry_flag"> & { files: Omit<FileRow, "mime">[] };

export type Note = { id: string; author: "client" | "user"; body: string; created_at: number };

export type Thread = { notes: Note[]; unanswered: number };

export type ClientView = {
  firm_name: string;
  tz: string;
  title: string;
  note: string | null;
  deadline: number;
  status: string;
  expires_at: number;
  paused: boolean;
  contact: { name: string | null; email: string | null; phone: string | null; address: string | null } | null;
  notes: Note[];
  people: { position: number; role: Role; name: string }[];
  items: ClientItem[];
};

export type ImportResult = { rows: { status: "new" | "update" | "skip"; reason?: string }[]; counts: { new: number; update: number; skip: number } };

export type Batch = {
  id: string;
  title: string;
  source_kind: "template" | "request" | "repeat";
  source_name: string | null;
  deadline: number | null;
  reminders_on: boolean;
  send_at: number;
  status: "scheduled" | "sending" | "done" | "cancelled";
  total: number;
  limited_at: number | null;
  stop_reason: string | null;
  created_at: number;
  finished_at: number | null;
  pending: number;
  sent: number;
  no_email: number;
  skipped: number;
  failed: number;
  cancelled: number;
  opened: number;
  complete: number;
  review: number;
};

export type BatchRow = {
  request_id: string;
  client_id: string;
  client_name: string;
  email: string | null;
  state: "pending" | "sent" | "no_email" | "skipped" | "failed" | "cancelled";
  reason: string | null;
  sent_at: number | null;
  title: string;
  status: string;
  deadline: number;
  first_opened_at: number | null;
  to_review: number;
};
