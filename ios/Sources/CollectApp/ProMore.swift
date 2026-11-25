#if os(iOS)
import CollectKit
import StoreKit
import SwiftUI

struct ClientsView: View {
    @EnvironmentObject var session: ProSession
    @State private var rows: [Client] = []
    @State private var next: Int?
    @State private var query = ""
    @State private var adding = false
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(rows) { client in
                    NavigationLink {
                        ClientRequestsView(client: client)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(client.name)
                            if let email = client.email { Text(email).font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                }
                if let next { Button("Load more") { Task { await load(offset: next) } } }
                if rows.isEmpty && loaded { Text("No clients yet.").foregroundStyle(.secondary) }
                if let problem = session.problem { Text(problem).foregroundStyle(.red) }
            }
            .navigationTitle("Clients")
            .searchable(text: $query)
            .onSubmit(of: .search) { Task { await load() } }
            .onChange(of: query) { _, text in if text.isEmpty { Task { await load() } } }
            .refreshable { await load() }
            .task { await load() }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add a client")
                }
            }
            .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) { AddClientSheet { _ in } }
        }
    }

    private func load(offset: Int = 0) async {
        do {
            let page = try await session.api.clients(query: query, offset: offset)
            rows = offset == 0 ? page.rows : rows + page.rows
            next = page.next
            session.problem = nil
        } catch {
            session.handle(error)
        }
        loaded = true
    }
}

struct ClientRequestsView: View {
    @EnvironmentObject var session: ProSession
    let client: Client
    @State private var rows: [RequestRow] = []

    var body: some View {
        List {
            Section {
                if let email = client.email { Text(email) }
                if let phone = client.phone { Text(phone) }
                if let reference = client.reference { Text("Reference \(reference)") }
            }
            Section("Requests") {
                ForEach(rows) { row in
                    NavigationLink {
                        RequestDetailView(id: row.id)
                    } label: {
                        RequestRowView(row: row)
                    }
                }
                if rows.isEmpty { Text("No requests yet.").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(client.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                let page = try await session.api.requests(view: "all", query: client.name)
                rows = page.rows.filter { $0.clientId == client.id }
            } catch {
                session.handle(error)
            }
        }
    }
}

struct AddClientSheet: View {
    @EnvironmentObject var session: ProSession
    @Environment(\.dismiss) private var dismiss
    let added: (Client) -> Void
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var permission = false
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Phone", text: $phone).keyboardType(.phonePad)
                }
                Section {
                    Toggle("This person agreed to be contacted", isOn: $permission)
                } footer: {
                    Text("Reminders go only to people who agreed. This is recorded against your account.")
                }
                if let problem { Section { Text(problem).foregroundStyle(.red) } }
            }
            .navigationTitle("New client")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        busy = true
                        Task {
                            do {
                                let client = try await session.api.addClient(name: name.trimmingCharacters(in: .whitespaces), email: email.trimmingCharacters(in: .whitespaces), phone: phone.trimmingCharacters(in: .whitespaces), contactOK: permission)
                                added(client)
                                dismiss()
                            } catch let e as APIError {
                                problem = e.code == "invalid" ? "Check the name, email and phone." : AppModel.words(e)
                            } catch {
                                problem = "That did not work. Try again."
                            }
                            busy = false
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
        }
    }
}

struct NewRequestView: View {
    @EnvironmentObject var session: ProSession
    @Environment(\.dismiss) private var dismiss
    @State private var clients: [Client] = []
    @State private var templates: [Template] = []
    @State private var client = ""
    @State private var template = ""
    @State private var title = ""
    @State private var deadline = Calendar.current.date(byAdding: .day, value: 14, to: Date()) ?? Date()
    @State private var email = true
    @State private var adding = false
    @State private var busy = false
    @State private var problem: String?

    private var chosenClient: Client? { clients.first { $0.id == client } }

    var body: some View {
        NavigationStack {
            Form {
                Section("Client") {
                    Picker("Client", selection: $client) {
                        Text("Choose").tag("")
                        ForEach(clients) { Text($0.name).tag($0.id) }
                    }
                    Button("Add a new client") { adding = true }
                }
                Section("Checklist") {
                    Picker("Start from", selection: $template) {
                        Text("Choose").tag("")
                        ForEach(templates) { Text($0.name).tag($0.id) }
                    }
                    TextField("Title", text: $title)
                    DatePicker("Due", selection: $deadline, in: Date()..., displayedComponents: .date)
                }
                Section {
                    Toggle("Email the link now", isOn: $email)
                } footer: {
                    Text(email ? "The client gets an email with the link. They need an email address and must have agreed to be contacted." : "You can send the link later from the request.")
                }
                if let problem { Section { Text(problem).foregroundStyle(.red) } }
            }
            .navigationTitle("New request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create", action: create).disabled(client.isEmpty || template.isEmpty || title.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
            .onChange(of: template) { _, id in
                if title.isEmpty, let t = templates.first(where: { $0.id == id }) { title = t.name }
            }
            .task { await load() }
            .sheet(isPresented: $adding) {
                AddClientSheet { new in
                    clients.append(new)
                    client = new.id
                }
            }
        }
    }

    private func load() async {
        do {
            clients = try await session.api.clients().rows
            templates = try await session.api.templates()
        } catch {
            session.handle(error)
        }
    }

    private func create() {
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            do {
                let made = try await session.api.createRequest(client: client, template: template, title: title.trimmingCharacters(in: .whitespaces), deadline: deadline)
                do {
                    _ = try await session.api.sendLink(request: made.id, email: email)
                } catch {
                    // the request exists; only the email did not go
                    problem = nil
                    session.handle(error)
                }
                dismiss()
            } catch let e as APIError {
                problem = e.code == "invalid" ? "Check the title and the due date." : AppModel.words(e)
                if e.status == 401 || e.status == 402 { session.handle(e) }
            } catch {
                problem = "That did not work. Try again."
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var session: ProSession
    @ObservedObject private var plan = PlanStore.shared
    @State private var confirm = false
    @State private var managing = false

    var body: some View {
        NavigationStack {
            List {
                if let me = session.me {
                    Section("Account") {
                        Text(me.user.email)
                        if let name = me.firm.name { Text(name) }
                        Text(me.user.role == "owner" ? "Owner" : "Team member").foregroundStyle(.secondary)
                    }
                    Section("Plan") {
                        Text(planText(me.firm))
                        if !me.firm.usable { Text("Reminders and new requests are off until the plan is active.").foregroundStyle(.orange) }
                        planActions(me)
                        if let message = plan.message { Text(message).foregroundStyle(.red) }
                    }
                }
                Section {
                    Button("Sign out", role: .destructive) { confirm = true }
                }
                if let problem = session.problem { Section { Text(problem).foregroundStyle(.red) } }
            }
            .navigationTitle("Settings")
            .task { await plan.load() }
            .manageSubscriptionsSheet(isPresented: $managing)
            .confirmationDialog("Sign out of Lazy Collect?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await session.signOut() } }
            }
        }
    }

    @ViewBuilder
    private func planActions(_ me: Me) -> some View {
        // Apple's word is final for its own plans: only one it has ended shows Subscribe and Restore like no plan at all
        let live = me.firm.planStatus == "active" || me.firm.planStatus == "past_due"
        if me.firm.planSource == "apple" && live {
            Button("Manage subscription") { managing = true }
        } else if me.firm.subscribed && me.firm.planSource != "apple" && me.firm.planStatus != "canceled" {
            Text("This plan is managed on the website.").font(.footnote).foregroundStyle(.secondary)
        } else if me.user.role != "owner" {
            Text("Only the owner can start the plan.").font(.footnote).foregroundStyle(.secondary)
        } else {
            if let price = plan.product?.displayPrice {
                Button("Subscribe, \(price) a month") { subscribe(me) }.disabled(plan.busy)
            }
            Button("Restore purchases") { restore(me) }.disabled(plan.busy)
        }
    }

    private func subscribe(_ me: Me) {
        Task {
            if await plan.buy(firmId: me.firm.id, api: session.api) { await session.loadMe() }
        }
    }

    private func restore(_ me: Me) {
        Task {
            if await plan.restore(firmId: me.firm.id, api: session.api) { await session.loadMe() }
        }
    }

    private func planText(_ firm: Me.Firm) -> String {
        switch firm.planStatus {
        case "trialing": return firm.trialEndsAt.map { "Free trial until \(dueText($0))" } ?? "Free trial"
        case "active": return firm.cancelAtPeriodEnd ? "Active, ends \(firm.currentPeriodEnd.map(dueText) ?? "soon")" : "Active"
        case "past_due": return "Payment failed"
        default: return "No active plan"
        }
    }
}
#endif
