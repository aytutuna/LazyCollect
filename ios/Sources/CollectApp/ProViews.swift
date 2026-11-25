#if os(iOS)
import CollectKit
import QuickLook
import SwiftUI
import UIKit

struct ProRootView: View {
    @EnvironmentObject var app: AppModel
    let token: String

    var body: some View {
        Tabs(session: ProSession(token: token, app: app))
    }

    private struct Tabs: View {
        @EnvironmentObject var app: AppModel
        @StateObject var session: ProSession
        @State private var tab = 0

        init(session: ProSession) {
            _session = StateObject(wrappedValue: session)
        }

        var body: some View {
            TabView(selection: $tab) {
                RequestsView()
                    .tabItem { Label("Requests", systemImage: "tray.full") }
                    .tag(0)
                ClientsView()
                    .tabItem { Label("Clients", systemImage: "person.2") }
                    .tag(1)
                LinksStack()
                    .tabItem { Label("My links", systemImage: "link") }
                    .tag(2)
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(3)
            }
            .environmentObject(session)
            .onChange(of: app.path) { _, path in if !path.isEmpty { tab = 2 } }
            .task {
                await session.loadMe()
                await PlanStore.shared.watch(session)
            }
        }
    }
}

private struct ViewChoice: Identifiable {
    let id: String
    let title: String
}

private let views = [
    ViewChoice(id: "to_review", title: "To review"),
    ViewChoice(id: "waiting", title: "Waiting on clients"),
    ViewChoice(id: "overdue", title: "Overdue"),
    ViewChoice(id: "due_soon", title: "Due this week"),
    ViewChoice(id: "expiring", title: "Expiring"),
    ViewChoice(id: "done", title: "Done"),
    ViewChoice(id: "all", title: "All"),
]

struct RequestsView: View {
    @EnvironmentObject var session: ProSession
    @State private var view = "to_review"
    @State private var query = ""
    @State private var rows: [RequestRow] = []
    @State private var next: Int?
    @State private var counts: RequestCounts?
    @State private var creating = false
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Show", selection: $view) {
                        ForEach(views) { Text(label($0)).tag($0.id) }
                    }
                }
                Section {
                    ForEach(rows) { row in
                        NavigationLink {
                            RequestDetailView(id: row.id)
                        } label: {
                            RequestRowView(row: row)
                        }
                    }
                    if let next {
                        Button("Load more") { Task { await load(offset: next) } }
                    }
                    if rows.isEmpty && loaded {
                        Text("Nothing here.").foregroundStyle(.secondary)
                    }
                }
                if let problem = session.problem { Section { Text(problem).foregroundStyle(.red) } }
            }
            .navigationTitle("Requests")
            .searchable(text: $query)
            .onSubmit(of: .search) { Task { await load() } }
            .onChange(of: query) { _, text in if text.isEmpty { Task { await load() } } }
            .onChange(of: view) { _, _ in Task { await load() } }
            .refreshable { await load() }
            .task { await load() }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { creating = true } label: { Image(systemName: "plus") }.accessibilityLabel("New request")
                }
            }
            .sheet(isPresented: $creating, onDismiss: { Task { await load() } }) { NewRequestView() }
        }
    }

    private func label(_ v: ViewChoice) -> String {
        guard let counts else { return v.title }
        let n: Int
        switch v.id {
        case "to_review": n = counts.toReview
        case "waiting": n = counts.waiting
        case "overdue": n = counts.overdue
        case "due_soon": n = counts.dueSoon
        case "expiring": n = counts.expiring
        case "done": n = counts.done
        default: n = counts.all
        }
        return "\(v.title) (\(n))"
    }

    private func load(offset: Int = 0) async {
        do {
            let page = try await session.api.requests(view: view, query: query, offset: offset)
            rows = offset == 0 ? page.rows : rows + page.rows
            next = page.next
            if let c = page.counts { counts = c }
            session.problem = nil
        } catch {
            session.handle(error)
        }
        loaded = true
    }
}

struct RequestRowView: View {
    let row: RequestRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.clientName).font(.headline)
            Text(row.title).font(.subheadline)
            HStack {
                Text("Due \(dueText(row.deadline))")
                if row.submitted > 0 { Text("\(row.submitted) to review").foregroundStyle(.orange) }
                if row.empty + row.rejected > 0 { Text("\(row.empty + row.rejected) missing") }
                if row.unanswered > 0 { Text("Message") }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }
}

struct PreviewFile: Identifiable {
    let id = UUID()
    let url: URL
}

struct QuickLook: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL

        init(_ url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

struct RequestDetailView: View {
    @EnvironmentObject var session: ProSession
    let id: String

    @State private var detail: RequestDetail?
    @State private var preview: PreviewFile?
    @State private var sendingBack: ReviewItem?
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        List {
            if let detail {
                Section {
                    Label("Due \(dueText(detail.deadline))", systemImage: "calendar")
                    if let note = detail.note, !note.isEmpty { Text(note) }
                    Text(detail.status.capitalized).foregroundStyle(.secondary)
                }
                ForEach(groups(detail), id: \.title) { group in
                    Section(group.title) {
                        ForEach(group.items) { item in
                            ReviewRow(item: item, open: open, approve: { approve(item) }, sendBack: { sendingBack = item })
                        }
                    }
                }
            } else {
                ProgressView()
            }
            if let message { Section { Text(message) } }
            if let problem = session.problem { Section { Text(problem).foregroundStyle(.red) } }
        }
        .navigationTitle(detail?.title ?? "Request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Remind now") { remind() }
                    Button("Send the link by email") { sendLink() }
                    Button("Copy the link") { copyLink() }
                } label: { Image(systemName: "ellipsis.circle") }
                    .disabled(busy)
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $preview) { QuickLook(url: $0.url).ignoresSafeArea() }
        .sheet(item: $sendingBack) { item in
            SendBackSheet(item: item) { reasons, note in
                await review { try await session.api.reject(request: id, item: item, reasons: reasons, note: note) }
            }
        }
    }

    private struct Group_ {
        let title: String
        let items: [ReviewItem]
    }

    private func groups(_ d: RequestDetail) -> [Group_] {
        let shown = d.items.filter { !$0.hidden }
        let general = shown.filter { $0.personPos == nil }
        var out = general.isEmpty ? [] : [Group_(title: "Items", items: general)]
        for p in d.people {
            let mine = shown.filter { $0.personPos == p.position }
            if !mine.isEmpty { out.append(Group_(title: p.name, items: mine)) }
        }
        return out
    }

    private func load() async {
        do {
            detail = try await session.api.request(id: id)
            session.problem = nil
        } catch {
            session.handle(error)
        }
    }

    private func open(_ file: FileRef) {
        Task {
            do { preview = PreviewFile(url: try await session.api.fileURL(file: file)) } catch { session.handle(error) }
        }
    }

    private func approve(_ item: ReviewItem) {
        Task { await review { try await session.api.approve(request: id, item: item) } }
    }

    private func review(_ call: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await call()
            await load()
        } catch let e as APIError where e.status == 409 {
            // the client changed it while it was open
            message = "This item changed while you were looking at it. Review it again."
            await load()
        } catch {
            session.handle(error)
        }
    }

    private func remind() {
        Task {
            busy = true
            defer { busy = false }
            do {
                try await session.api.remind(request: id)
                message = "Reminder sent."
            } catch {
                session.handle(error)
            }
        }
    }

    private func sendLink() {
        Task {
            busy = true
            defer { busy = false }
            do {
                _ = try await session.api.sendLink(request: id, email: true)
                message = "The link was emailed."
            } catch {
                session.handle(error)
            }
        }
    }

    private func copyLink() {
        Task {
            do {
                if let url = try await session.api.link(request: id) {
                    UIPasteboard.general.string = url
                    message = "Link copied."
                } else {
                    message = "There is no live link. Send it by email to make one."
                }
            } catch {
                session.handle(error)
            }
        }
    }
}

struct ReviewRow: View {
    let item: ReviewItem
    let open: (FileRef) -> Void
    let approve: () -> Void
    let sendBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(item.label).font(.headline)
                Spacer()
                Text(status).font(.footnote).foregroundStyle(.secondary)
            }
            if let flag = item.expiryFlag { Text(flag.capitalized).font(.footnote).foregroundStyle(.orange) }
            if !item.answerText.isEmpty { Text(item.answerText) }
            ForEach(item.files) { file in
                Button { open(file) } label: { Label(file.name, systemImage: "doc") }
                    .buttonStyle(.borderless)
            }
            if item.status == "unavailable", let note = item.unavailableNote { Text("Client has no copy: \(note)").font(.footnote) }
            if item.status == "rejected" {
                Text(item.rejectReasons.map(Reasons.text).joined(separator: ", ")).font(.footnote).foregroundStyle(.secondary)
            }
            if item.status == "submitted" {
                HStack {
                    Button("Approve", action: approve).buttonStyle(.borderedProminent)
                    Button("Send back", action: sendBack).buttonStyle(.bordered)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var status: String {
        switch item.status {
        case "approved": return "Approved"
        case "submitted": return "To review"
        case "rejected": return "Sent back"
        case "unavailable": return "No copy"
        case "waived": return "Waived"
        default: return "Missing"
        }
    }
}

extension ReviewItem {
    var answerText: String {
        answer?.strings.joined(separator: ", ") ?? ""
    }
}

struct SendBackSheet: View {
    let item: ReviewItem
    let send: ([String], String?) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reasons: Set<String> = []
    @State private var note = ""
    @State private var busy = false

    private var options: [Reason] { item.kind == "file" ? Reasons.files : Reasons.questions }

    private var ready: Bool {
        let plain = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if reasons.contains("other") && plain.isEmpty { return false }
        return !reasons.isEmpty || (item.kind != "file" && !plain.isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Why") {
                    ForEach(options, id: \.code) { option in
                        Toggle(option.text, isOn: Binding(
                            get: { reasons.contains(option.id) },
                            set: { on in if on { reasons.insert(option.id) } else { reasons.remove(option.id) } }
                        ))
                    }
                }
                Section("Note for the client") {
                    TextField("Optional, unless you chose Other", text: $note, axis: .vertical).lineLimit(2...6)
                }
            }
            .navigationTitle("Send back")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send back") {
                        busy = true
                        let plain = note.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            await send(options.map(\.code).filter { reasons.contains($0) }, plain.isEmpty ? nil : plain)
                            dismiss()
                        }
                    }
                    .disabled(!ready || busy)
                }
            }
        }
    }
}
#endif
