#if os(iOS)
import CollectKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private let dayFormat: DateFormatter = {
    let f = DateFormatter()
    f.dateStyle = .medium
    return f
}()

func dueText(_ ms: Int) -> String {
    dayFormat.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
}

func statusText(_ item: Item) -> String {
    switch item.status {
    case "approved": return "Approved"
    case "submitted": return item.isFile ? "Received" : "Answered"
    case "rejected": return "Needs another try"
    case "unavailable": return "You said you don't have it"
    case "waived": return "Not needed"
    default: return item.required ? "To do" : "Optional"
    }
}

func statusIcon(_ status: String) -> (name: String, color: Color) {
    switch status {
    case "approved": return ("checkmark.circle.fill", .green)
    case "submitted": return ("checkmark.circle", .green)
    case "rejected": return ("exclamationmark.circle.fill", .orange)
    case "unavailable", "waived": return ("minus.circle", .secondary)
    default: return ("circle", .secondary)
    }
}

struct ClientRequestView: View {
    @EnvironmentObject var app: AppModel
    let token: String

    var body: some View {
        Inner(model: ClientModel(token: token, app: app))
    }

    private struct Inner: View {
        @StateObject var model: ClientModel
        @State private var writing = false

        init(model: ClientModel) {
            _model = StateObject(wrappedValue: model)
        }

        var body: some View {
            List {
                if let view = model.view {
                    header(view)
                    ForEach(sections(view), id: \.title) { section in
                        Section(section.title) {
                            ForEach(section.items) { item in
                                NavigationLink {
                                    ItemView(model: model, itemId: item.id)
                                } label: {
                                    row(item)
                                }
                            }
                        }
                    }
                    Section("Messages") {
                        ForEach(view.notes) { note in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(note.author == "client" ? "You" : view.firmName).font(.caption).foregroundStyle(.secondary)
                                Text(note.body)
                            }
                        }
                        Button("Write to \(view.contact?.name ?? view.firmName)") { writing = true }
                    }
                    if let contact = view.contact {
                        Section("Contact") {
                            if let name = contact.name { Text(name) }
                            if let email = contact.email { Text(email) }
                            if let phone = contact.phone { Text(phone) }
                            if let address = contact.address { Text(address) }
                        }
                    }
                } else if !model.loaded {
                    ProgressView()
                }
                if let problem = model.problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .navigationTitle(model.view?.title ?? "Request")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await model.load() }
            .task { await model.load() }
            .sheet(isPresented: $writing) { NoteSheet(model: model) }
        }

        private func header(_ view: ClientView) -> some View {
            Section {
                Text(view.firmName).font(.headline)
                Label("Due \(dueText(view.deadline))", systemImage: "calendar")
                if let note = view.note, !note.isEmpty { Text(note) }
                if view.status == "complete" {
                    Text("Everything asked for is in. You can still add more until it is reviewed.").foregroundStyle(.secondary)
                }
                let left = view.items.filter { $0.required && ["empty", "rejected"].contains($0.status) }.count
                if left > 0 { Text("\(left) still to send").foregroundStyle(.secondary) }
            }
        }

        private func row(_ item: Item) -> some View {
            let icon = statusIcon(item.status)
            let sending = model.uploads.contains { $0.item == item.id }
            return HStack {
                Image(systemName: icon.name).foregroundStyle(icon.color)
                VStack(alignment: .leading) {
                    Text(item.label)
                    Text(sending ? "Sending..." : statusText(item)).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }

        private struct Section_ {
            let title: String
            let items: [Item]
        }

        // Items of one person on a request with several people are kept together; the rest come first.
        private func sections(_ view: ClientView) -> [Section_] {
            let general = model.items.filter { $0.personPos == nil }
            var out = general.isEmpty ? [] : [Section_(title: "To send", items: general)]
            for person in view.people {
                let mine = model.items.filter { $0.personPos == person.position }
                if !mine.isEmpty { out.append(Section_(title: person.name, items: mine)) }
            }
            return out
        }
    }
}

struct NoteSheet: View {
    @ObservedObject var model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Your message", text: $text, axis: .vertical).lineLimit(4...10)
                if let problem = model.problem { Text(problem).foregroundStyle(.red) }
            }
            .navigationTitle("Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        busy = true
                        Task {
                            if await model.send(note: text.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() }
                            busy = false
                        }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                }
            }
        }
    }
}

struct ItemView: View {
    @ObservedObject var model: ClientModel
    let itemId: String

    @State private var photos: [PhotosPickerItem] = []
    @State private var camera = false
    @State private var scanning = false
    @State private var picking = false
    @State private var example: UIImage?
    @State private var showExample = false
    @State private var dontHave = false
    @State private var why = ""

    var body: some View {
        if let item = model.item(itemId) {
            Form {
                Section {
                    Text(item.label).font(.headline)
                    if let help = item.help, !help.isEmpty { Text(help).foregroundStyle(.secondary) }
                    Label(statusText(item), systemImage: statusIcon(item.status).name)
                        .foregroundStyle(statusIcon(item.status).color)
                        .font(.footnote)
                }
                if item.status == "rejected" {
                    Section("Sent back") {
                        ForEach(item.rejectReasons, id: \.self) { code in
                            VStack(alignment: .leading) {
                                Text(Reasons.text(code)).bold()
                                Text(Reasons.fix(code)).font(.footnote)
                            }
                        }
                        if let note = item.rejectNote, !note.isEmpty { Text(note) }
                    }
                }
                if item.isFile {
                    fileSections(item)
                } else {
                    QuestionSection(model: model, item: item)
                }
                if let problem = model.problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .navigationTitle(item.label)
            .navigationBarTitleDisplayMode(.inline)
            .alert("I don't have this", isPresented: $dontHave) {
                TextField("Why (optional)", text: $why)
                Button("Confirm") {
                    let note = why.trimmingCharacters(in: .whitespacesAndNewlines)
                    why = ""
                    Task { await model.unavailable(item, note: note.isEmpty ? nil : note) }
                }
                Button("Cancel", role: .cancel) { why = "" }
            } message: {
                Text("Your accountant or consultant will see this and can ask again.")
            }
        } else {
            Text("This item is no longer part of the request.").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func fileSections(_ item: Item) -> some View {
        let sending = model.uploads.filter { $0.item == item.id }
        let locked = item.status == "approved"
        if item.example != nil {
            Section {
                Button("See an example") {
                    Task {
                        example = await model.example(item)
                        showExample = example != nil
                    }
                }
            }
            .sheet(isPresented: $showExample) {
                if let example { Image(uiImage: example).resizable().scaledToFit().padding() }
            }
        }
        if !item.files.isEmpty || !sending.isEmpty {
            Section("Sent") {
                ForEach(item.files) { file in
                    HStack {
                        Image(systemName: "doc")
                        Text(file.name).lineLimit(1)
                        Spacer()
                        if !locked {
                            Button(role: .destructive) { Task { await model.delete(file) } } label: { Image(systemName: "trash") }
                                .buttonStyle(.borderless)
                        }
                    }
                }
                ForEach(sending) { job in
                    VStack(alignment: .leading) {
                        Text(job.file.name).lineLimit(1)
                        switch job.state {
                        case .sending:
                            ProgressView(value: job.progress)
                        case .failed(let text):
                            Text(text).font(.footnote).foregroundStyle(.red)
                            HStack {
                                Button("Try again") { model.retry(job) }
                                Button("Remove", role: .destructive) { model.dismiss(job) }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
            }
        }
        if locked {
            Section { Text("This one was approved. It cannot be changed.").foregroundStyle(.secondary) }
        } else {
            Section {
                Button { scanning = true } label: { Label("Scan a document", systemImage: "doc.viewfinder") }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { camera = true } label: { Label("Take a photo", systemImage: "camera") }
                }
                PhotosPicker(selection: $photos, maxSelectionCount: 10, matching: .images) {
                    Label("Choose photos", systemImage: "photo.on.rectangle")
                }
                Button { picking = true } label: { Label("Choose a file", systemImage: "folder") }
                if item.status != "unavailable" {
                    Button { dontHave = true } label: { Label("I don't have this", systemImage: "minus.circle") }
                } else {
                    Button { Task { await model.available(item) } } label: { Label("I do have it now", systemImage: "arrow.uturn.backward") }
                }
            } header: {
                Text("Add")
            } footer: {
                Text("Several photos are put together in one PDF, in the order you pick them.")
            }
            if item.expiryRule != nil { ExpirySection(model: model, item: item) }
        }
        EmptyView()
            .fullScreenCover(isPresented: $camera) {
                CameraPicker { image in
                    if let data = image.jpegData(compressionQuality: 1) { take(photos: [data], item: item) }
                }
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $scanning) {
                ScannerView(label: item.label) { model.upload($0, to: item) }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf, .image]) { result in
                guard case .success(let url) = result else { return }
                do { model.upload(try Intake.prepare(file: url, label: item.label), to: item) } catch { model.fail(error) }
            }
            .onChange(of: photos) { _, picked in
                guard !picked.isEmpty else { return }
                Task {
                    var data: [Data] = []
                    for p in picked {
                        if let d = try? await p.loadTransferable(type: Data.self) { data.append(d) }
                    }
                    photos = []
                    take(photos: data, item: item)
                }
            }
    }

    private func take(photos: [Data], item: Item) {
        do { model.upload(try Intake.prepare(photos: photos, label: item.label), to: item) } catch { model.fail(error) }
    }
}

struct QuestionSection: View {
    @ObservedObject var model: ClientModel
    let item: Item
    @State private var text = ""
    @State private var date = Date()
    @State private var chosen: Set<String> = []
    @State private var primed = false

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    var body: some View {
        Section {
            switch item.kind {
            case "yesno":
                Picker("Answer", selection: Binding(get: { item.answer?.string ?? "" }, set: { v in save(.string(v)) })) {
                    Text("Not answered").tag("")
                    Text("Yes").tag("yes")
                    Text("No").tag("no")
                }
                .pickerStyle(.segmented)
            case "choice":
                Picker("Answer", selection: Binding(get: { item.answer?.string ?? "" }, set: { v in save(.string(v)) })) {
                    Text("Not answered").tag("")
                    ForEach(item.options ?? [], id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.inline)
            case "multi":
                ForEach(item.options ?? [], id: \.self) { option in
                    Toggle(option, isOn: Binding(
                        get: { chosen.contains(option) },
                        set: { on in
                            if on { chosen.insert(option) } else { chosen.remove(option) }
                            save(.array((item.options ?? []).filter { chosen.contains($0) }.map { JSON.string($0) }))
                        }
                    ))
                }
            case "date":
                DatePicker("Date", selection: $date, displayedComponents: .date)
                Button("Save") { save(.string(Self.day.string(from: date))) }
            case "number":
                TextField("Number", text: $text).keyboardType(.decimalPad)
                Button("Save") { save(.string(text.trimmingCharacters(in: .whitespaces))) }
            case "longtext":
                TextField("Your answer", text: $text, axis: .vertical).lineLimit(3...10)
                Button("Save") { save(.string(text.trimmingCharacters(in: .whitespacesAndNewlines))) }
            default:
                TextField("Your answer", text: $text)
                Button("Save") { save(.string(text.trimmingCharacters(in: .whitespacesAndNewlines))) }
            }
        } header: {
            Text("Your answer")
        }
        .onAppear {
            guard !primed else { return }
            primed = true
            chosen = Set(item.answer?.strings ?? [])
            text = item.answer?.string ?? ""
            if item.kind == "date", let s = item.answer?.string, let d = Self.day.date(from: s) { date = d }
        }
    }

    private func save(_ value: JSON) {
        Task { await model.answer(item, value) }
    }
}

struct ExpirySection: View {
    @ObservedObject var model: ClientModel
    let item: Item
    @State private var date = Date()
    @State private var set = false

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private var isExpiry: Bool { item.expiryRule == "expiry" }

    var body: some View {
        Section {
            DatePicker(isExpiry ? "Expires on" : "Issued on", selection: $date, displayedComponents: .date)
            Button("Save the date") {
                let value = Self.day.string(from: date)
                Task { await model.dates(item, expires: isExpiry ? value : nil, issued: isExpiry ? nil : value) }
            }
        } header: {
            Text(isExpiry ? "Date the document expires" : "Date the document was issued")
        }
        .onAppear {
            guard !set else { return }
            set = true
            if let s = isExpiry ? item.expiresOn : item.issuedOn, let d = Self.day.date(from: s) { date = d }
        }
    }
}
#endif
