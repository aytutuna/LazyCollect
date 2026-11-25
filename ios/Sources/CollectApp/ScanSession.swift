#if os(iOS)
import CollectScan
import CollectScanModel
import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A shot waiting for the corner editor: the photo upright, the corners to start from and what the answer is for.
struct CornerRequest: Identifiable {
    let id = UUID()
    let photo: RgbaImage
    let source: Data
    let corners: Quad
    let filter: CaptureFilter
    /// The page a recut replaces; nil for a new shot.
    let replacing: UUID?
}

enum CornerAnswer {
    case use(Quad)
    case whole
    case cancel
}

/// The pages of one scan: each photo is read, its page looked for and, when it is found clearly, cut out and cleaned up with
/// the chosen filter; else the corner editor opens at the corners the model guessed. Done writes the pages as one PDF.
@MainActor
final class ScanSession: ObservableObject {
    @Published private(set) var pages: [ScanPage] = []
    @Published var editing: CornerRequest?
    @Published private(set) var working = false
    @Published var problem: String?
    var filter = CaptureFilter.enhanced

    private let finder: CornerModel? = FastViTCornerModel.isAvailable ? FastViTCornerModel.shared : nil
    private var sources: [UUID: Data] = [:]
    private var thumbnails: [UUID: UIImage] = [:]

    private enum Outcome: Sendable {
        case page(ScanPage)
        case corners(RgbaImage, Quad)
        case failed
    }

    /// A shot read, its page looked for and, when found clearly, cut out; else the photo and the corners to start from.
    private nonisolated static func read(_ data: Data, filter: CaptureFilter, finder: CornerModel?) -> Outcome {
        guard let photo = PhotoReader.decode(data) else { return .failed }
        let found = PageFinder.find(photo, model: finder)
        if found.clear, let page = PagePipeline.page(photo: photo, corners: found.corners, filter: filter) {
            return .page(page)
        }
        return .corners(photo, found.corners)
    }

    func add(photo data: Data) {
        working = true
        problem = nil
        let filter = filter
        let finder = finder
        Task {
            let outcome = await Task.detached(priority: .userInitiated) { ScanSession.read(data, filter: filter, finder: finder) }.value
            working = false
            switch outcome {
            case .page(let page): append(page, source: data)
            case .corners(let photo, let corners): editing = CornerRequest(photo: photo, source: data, corners: corners, filter: filter, replacing: nil)
            case .failed: problem = "That photo could not be read."
            }
        }
    }

    /// The editor's answer: the page is cut along the corners as placed, or is the whole photo, or the shot is dropped.
    func answer(_ request: CornerRequest, _ answer: CornerAnswer) {
        if editing?.id == request.id { editing = nil }
        var corners = request.corners
        var whole = false
        switch answer {
        case .cancel: return
        case .use(let placed): corners = placed
        case .whole: whole = true
        }
        let cut = corners
        let wholePhoto = whole
        working = true
        Task {
            let page = await Task.detached(priority: .userInitiated) { () -> ScanPage? in
                let id = request.replacing ?? UUID()
                if wholePhoto { return PagePipeline.wholePage(photo: request.photo, filter: request.filter, id: id) }
                return PagePipeline.page(photo: request.photo, corners: cut, filter: request.filter, id: id)
            }.value
            working = false
            guard let page else {
                problem = "The page could not be cut out."
                return
            }
            if let replacing = request.replacing, !pages.contains(where: { $0.id == replacing }) { return }
            append(page, source: request.source)
        }
    }

    private func append(_ page: ScanPage, source: Data) {
        sources[page.id] = source
        thumbnails[page.id] = nil
        if let i = pages.firstIndex(where: { $0.id == page.id }) {
            pages[i] = page
        } else {
            pages.append(page)
        }
    }

    /// The page cut again: its photo is read and the editor opens at the corners it was cut along.
    func recut(_ page: ScanPage) {
        guard !working, let data = sources[page.id] else { return }
        working = true
        Task {
            let photo = await Task.detached(priority: .userInitiated) { PhotoReader.decode(data) }.value
            working = false
            guard let photo else {
                problem = "That photo could not be read."
                return
            }
            let corners = PageFinder.clamped(page.corners, width: photo.width, height: photo.height)
            editing = CornerRequest(photo: photo, source: data, corners: corners, filter: page.filter, replacing: page.id)
        }
    }

    func delete(_ id: UUID) {
        pages.removeAll { $0.id == id }
        sources[id] = nil
        thumbnails[id] = nil
    }

    /// `id` one place earlier (`by` -1) or later (1).
    func shift(_ id: UUID, by step: Int) {
        guard let i = pages.firstIndex(where: { $0.id == id }), pages.indices.contains(i + step) else { return }
        pages.swapAt(i, i + step)
    }

    func pdf() -> Data {
        ScanPdf.make(pages)
    }

    func thumbnail(_ page: ScanPage) -> UIImage? {
        if let kept = thumbnails[page.id] { return kept }
        guard let source = CGImageSourceCreateWithData(page.jpeg as CFData, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 360]
        guard let small = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let image = UIImage(cgImage: small)
        thumbnails[page.id] = image
        return image
    }
}

private extension CaptureFilter {
    var title: String {
        switch self {
        case .enhanced: return "Enhanced"
        case .original: return "Original"
        case .grayscale: return "Gray"
        case .blackAndWhite: return "B&W"
        case .whiteboard: return "Board"
        }
    }
}

/// The scanner: photos in, pages out, one PDF at the end.
struct ScannerView: View {
    let label: String
    let done: (Prepared) -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var scan = ScanSession()
    @State private var camera = false
    @State private var picking = false
    @State private var failed: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if scan.pages.isEmpty {
                    Spacer()
                    VStack(spacing: 8) {
                        Image(systemName: "doc.viewfinder").font(.system(size: 54)).foregroundStyle(.secondary)
                        Text("Take a photo of each page.").foregroundStyle(.secondary)
                        Text("The page is found and straightened for you.").font(.footnote).foregroundStyle(.secondary)
                    }
                    Spacer()
                } else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 12)], spacing: 12) {
                            ForEach(Array(scan.pages.enumerated()), id: \.element.id) { index, page in
                                pageCell(index, page)
                            }
                        }
                        .padding()
                    }
                }
                if let text = scan.problem ?? failed { Text(text).foregroundStyle(.red).padding(.horizontal) }
                controls
            }
            .navigationTitle("Scan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: finish).disabled(scan.pages.isEmpty || scan.working)
                }
            }
            .overlay { if scan.working { ProgressView().controlSize(.large) } }
            .fullScreenCover(isPresented: $camera) {
                CameraPicker { image in
                    if let data = image.jpegData(compressionQuality: 0.95) { scan.add(photo: data) }
                }
                .ignoresSafeArea()
            }
            .fullScreenCover(item: $scan.editing) { request in
                CornerEditorView(request: request) { scan.answer(request, $0) }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result else { return }
                for url in urls {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    if let data = try? Data(contentsOf: url) { scan.add(photo: data) }
                }
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            Picker("Look", selection: Binding(get: { scan.filter }, set: { scan.filter = $0 })) {
                ForEach(CaptureFilter.displayOrder, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            HStack {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { camera = true } label: { Label("Take a photo", systemImage: "camera").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                }
                Button { picking = true } label: { Label("From photos or files", systemImage: "photo").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
            }
            .disabled(scan.working)
        }
        .padding()
    }

    private func pageCell(_ index: Int, _ page: ScanPage) -> some View {
        VStack {
            ZStack(alignment: .topLeading) {
                if let image = scan.thumbnail(page) {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 180)
                }
                Text("\(index + 1)").font(.caption.bold()).padding(5).background(.regularMaterial, in: Circle()).padding(4)
            }
            HStack {
                Button { scan.shift(page.id, by: -1) } label: { Image(systemName: "arrow.left") }.disabled(index == 0)
                Button { scan.recut(page) } label: { Image(systemName: "crop") }
                Button { scan.shift(page.id, by: 1) } label: { Image(systemName: "arrow.right") }.disabled(index == scan.pages.count - 1)
                Button(role: .destructive) { scan.delete(page.id) } label: { Image(systemName: "trash") }
            }
            .buttonStyle(.borderless)
        }
    }

    private func finish() {
        do {
            let data = scan.pdf()
            done(try Intake.write(data, name: "\(Intake.base(label)).pdf"))
            dismiss()
        } catch Intake.Failure.tooBig {
            failed = "The scan is over 25 MB. Remove a page or two."
        } catch {
            failed = "The scan could not be saved."
        }
    }
}

#endif
