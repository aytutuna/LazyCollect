#if os(iOS)
import CollectKit
import SwiftUI
import UIKit

struct Upload: Identifiable {
    enum State: Equatable {
        case sending
        case failed(String)
    }

    let id = UUID()
    let item: String
    let file: Prepared
    var progress = 0.0
    var state = State.sending
}

/// One request, as the client sees it, with the files on their way up.
@MainActor
final class ClientModel: ObservableObject {
    @Published private(set) var view: ClientView?
    @Published private(set) var items: [Item] = []
    @Published var uploads: [Upload] = []
    @Published var problem: String?
    @Published var loaded = false

    let token: String
    private let api: APIClient
    private let app: AppModel

    init(token: String, app: AppModel) {
        self.token = token
        self.app = app
        api = app.api(token: token)
    }

    func load() async {
        do {
            let fresh = try await api.clientView()
            view = fresh
            items = fresh.items
            app.updateClient(token, firm: fresh.firmName, title: fresh.title)
            problem = nil
        } catch let e as APIError where e.status == 404 || e.status == 401 {
            problem = "This link has expired or was replaced. Ask for a new one."
            app.sessionEnded(token)
        } catch let e as APIError {
            problem = AppModel.words(e)
        } catch {
            problem = "Could not load the request."
        }
        loaded = true
    }

    func item(_ id: String) -> Item? { items.first { $0.id == id } }

    func fail(_ error: Error) {
        if let e = error as? APIError {
            problem = AppModel.words(e)
        } else if let e = error as? Intake.Failure {
            switch e {
            case .unreadable: problem = "That photo could not be read."
            case .unsupported: problem = "That kind of file is not accepted. Send a photo or a PDF."
            case .tooBig: problem = "The file is over 25 MB."
            }
        } else {
            problem = "That did not work. Try again."
        }
    }

    func answer(_ item: Item, _ value: JSON) async {
        do {
            items = try await api.answer(item: item.id, value)
            problem = nil
        } catch {
            fail(error)
        }
    }

    func dates(_ item: Item, expires: String?, issued: String?) async {
        do {
            items = try await api.dates(item: item.id, expires: expires, issued: issued)
            problem = nil
        } catch {
            fail(error)
        }
    }

    func unavailable(_ item: Item, note: String?) async {
        do {
            try await api.markUnavailable(item: item.id, note: note)
            await load()
        } catch {
            fail(error)
        }
    }

    func available(_ item: Item) async {
        do {
            try await api.clearUnavailable(item: item.id)
            await load()
        } catch {
            fail(error)
        }
    }

    func delete(_ file: FileRef) async {
        do {
            try await api.deleteUpload(file: file.id)
            await load()
        } catch {
            fail(error)
        }
    }

    func send(note: String) async -> Bool {
        do {
            try await api.sendNote(note)
            await load()
            return true
        } catch {
            fail(error)
            return false
        }
    }

    func example(_ item: Item) async -> UIImage? {
        guard let data = try? await api.exampleImage(item: item.id) else { return nil }
        return UIImage(data: data)
    }

    /// Puts a prepared file on its way. The same upload id goes with every retry, so a file whose reply was lost is not stored twice.
    func upload(_ file: Prepared, to item: Item) {
        let job = Upload(item: item.id, file: file)
        uploads.append(job)
        Task { await run(job) }
    }

    func retry(_ job: Upload) {
        guard let i = uploads.firstIndex(where: { $0.id == job.id }) else { return }
        uploads[i].state = .sending
        uploads[i].progress = 0
        Task { await run(uploads[i]) }
    }

    func dismiss(_ job: Upload) {
        uploads.removeAll { $0.id == job.id }
        try? FileManager.default.removeItem(at: job.file.url.deletingLastPathComponent())
    }

    private func run(_ job: Upload) async {
        do {
            _ = try await api.uploadFile(item: job.item, file: job.file.url, name: job.file.name, uploadId: job.id) { [weak self] done in
                Task { @MainActor in self?.progress(job.id, done) }
            }
            dismiss(job)
            await load()
        } catch let e as APIError {
            mark(job.id, failed: AppModel.words(e))
        } catch {
            mark(job.id, failed: "The upload did not finish.")
        }
    }

    private func progress(_ id: UUID, _ done: Double) {
        if let i = uploads.firstIndex(where: { $0.id == id }) { uploads[i].progress = done }
    }

    private func mark(_ id: UUID, failed text: String) {
        if let i = uploads.firstIndex(where: { $0.id == id }) { uploads[i].state = .failed(text) }
    }
}
#endif
