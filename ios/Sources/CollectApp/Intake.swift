#if os(iOS)
import ImageIO
import PDFKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What goes up for an item: a photo shrunk on the phone, photos combined into one PDF, or a PDF as it is.
struct Prepared {
    let url: URL
    let name: String
}

enum Intake {
    static let longEdge = 2400
    static let maxBytes = 25 * 1024 * 1024

    enum Failure: Error {
        case unreadable
        case unsupported
        case tooBig
    }

    /// The JPEG of an image in any format the system reads, with its rotation applied and its long edge at most 2400 pixels.
    static func jpeg(from data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let width = props?[kCGImagePropertyPixelWidth] as? Int ?? longEdge
        let height = props?[kCGImagePropertyPixelHeight] as? Int ?? longEdge
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(longEdge, max(width, height)),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let target = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(target, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        return CGImageDestinationFinalize(target) ? out as Data : nil
    }

    static func pdf(ofJPEGs pages: [Data]) -> Data? {
        let document = PDFDocument()
        for data in pages {
            guard let image = UIImage(data: data), let page = PDFPage(image: image) else { return nil }
            document.insert(page, at: document.pageCount)
        }
        return document.dataRepresentation()
    }

    static func base(_ label: String) -> String {
        let cleaned = String(label.components(separatedBy: CharacterSet(charactersIn: "\\/:*?\"<>|")).joined(separator: " ").trimmingCharacters(in: .whitespaces).prefix(80))
        return cleaned.isEmpty ? "Document" : cleaned
    }

    static func write(_ data: Data, name: String) throws -> Prepared {
        guard data.count <= maxBytes else { throw Failure.tooBig }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("uploads", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try data.write(to: url)
        return Prepared(url: url, name: name)
    }

    /// Photos: one goes up as a JPEG, several as one PDF in the order they were picked.
    static func prepare(photos: [Data], label: String) throws -> Prepared {
        let pages = photos.compactMap { jpeg(from: $0) }
        guard !pages.isEmpty, pages.count == photos.count else { throw Failure.unreadable }
        if pages.count == 1 { return try write(pages[0], name: "\(base(label)).jpg") }
        guard let pdf = pdf(ofJPEGs: pages) else { throw Failure.unreadable }
        return try write(pdf, name: "\(base(label)).pdf")
    }

    /// A file from the Files app.
    static func prepare(file url: URL, label: String) throws -> Prepared {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .pdf) == true {
            return try write(data, name: url.lastPathComponent)
        }
        if type?.conforms(to: .image) == true {
            guard let jpeg = jpeg(from: data) else { throw Failure.unreadable }
            return try write(jpeg, name: "\(url.deletingPathExtension().lastPathComponent).jpg")
        }
        throw Failure.unsupported
    }
}

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
#endif
