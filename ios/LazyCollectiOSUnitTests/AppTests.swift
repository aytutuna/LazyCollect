import CollectKit
import ImageIO
import UIKit
import XCTest
@testable import CollectApp

final class AppTests: XCTestCase {
    private func photo(width: Int, height: Int) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.jpegData(withCompressionQuality: 0.9) { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private func size(of data: Data) -> (Int, Int) {
        let source = CGImageSourceCreateWithData(data as CFData, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as! [CFString: Any]
        return (props[kCGImagePropertyPixelWidth] as! Int, props[kCGImagePropertyPixelHeight] as! Int)
    }

    func testABigPhotoIsShrunkToTheLongEdge() throws {
        let out = try XCTUnwrap(Intake.jpeg(from: photo(width: 4800, height: 3200)))
        let (w, h) = size(of: out)
        XCTAssertEqual(max(w, h), Intake.longEdge)
        XCTAssertEqual(min(w, h), 1600)
    }

    func testASmallPhotoIsNotEnlarged() throws {
        let out = try XCTUnwrap(Intake.jpeg(from: photo(width: 800, height: 600)))
        let (w, h) = size(of: out)
        XCTAssertEqual(w, 800)
        XCTAssertEqual(h, 600)
    }

    func testSeveralPhotosBecomeOnePDF() throws {
        let one = try Intake.prepare(photos: [photo(width: 300, height: 200)], label: "Passport")
        XCTAssertEqual(one.name, "Passport.jpg")
        let many = try Intake.prepare(photos: [photo(width: 300, height: 200), photo(width: 300, height: 200)], label: "Bank/statement")
        XCTAssertEqual(many.name, "Bank statement.pdf")
        let head = try Data(contentsOf: many.url).prefix(5)
        XCTAssertEqual(String(decoding: head, as: UTF8.self), "%PDF-")
    }

    func testSomethingThatIsNotAnImageIsRefused() {
        XCTAssertThrowsError(try Intake.prepare(photos: [Data("hello".utf8)], label: "x"))
    }

    func testBase64URLRoundTrips() {
        let data = Data([0xfb, 0xff, 0xfe, 0x01])
        XCTAssertEqual(b64url(data), "-__-AQ")
        XCTAssertEqual(unb64url("-__-AQ"), data)
    }

    func testAnswersAreWorded() {
        XCTAssertEqual(AppModel.words(APIError(status: 404, code: "not_found")), "This link has expired or was replaced. Ask for a new one.")
        XCTAssertTrue(AppModel.words(APIError(status: 500, code: "weird")).contains("weird"))
    }

    func testTheKeychainKeepsAValueUntilItIsCleared() {
        let keychain = Keychain()
        keychain.write("test", Data("a".utf8))
        keychain.write("test", Data("b".utf8))
        XCTAssertEqual(keychain.read("test"), Data("b".utf8))
        keychain.write("test", nil)
        XCTAssertNil(keychain.read("test"))
    }
}
