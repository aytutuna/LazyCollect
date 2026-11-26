import CryptoKit
import XCTest
@testable import CollectKit

final class KitTests: XCTestCase {
    override func setUp() {
        Stub.reset()
    }

    func testBindingHashIsTheHashOfChallengeDotData() {
        let hash = AppCheck.bindingHash(challenge: "abc", data: "me@example.com")
        XCTAssertEqual(hash, Data(SHA256.hash(data: Data("abc.me@example.com".utf8))))
        XCTAssertEqual(hash.count, 32)
    }

    func testPostsCarryTheHeaderAndBearer() async throws {
        Stub.on("POST /api/x", .init(body: "{}"))
        let api = Stub.client()
        api.token = "tok"
        let _: Done = try await api.post("/x", ["a": 1])
        let req = Stub.seen[0]
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Collect"), "1")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(try JSONDecoder().decode(JSON.self, from: Stub.bodies[0]), ["a": 1])
    }

    func testGetsSendNoHeaderAndErrorsKeepTheCode() async throws {
        Stub.on("GET /api/me", .init(status: 401, body: "{\"error\":\"unauthorized\"}"))
        let api = Stub.client()
        do {
            _ = try await api.me()
            XCTFail("expected an error")
        } catch let e as APIError {
            XCTAssertEqual(e, APIError(status: 401, code: "unauthorized"))
        }
        XCTAssertNil(Stub.seen[0].value(forHTTPHeaderField: "X-Collect"))
    }

    func testClientViewDecodes() async throws {
        let json = """
        {"firm_name":"Firm","tz":"America/Toronto","title":"Study permit","note":null,"deadline":1800000000000,"status":"open",
         "expires_at":1900000000000,"contact":null,"notes":[{"id":"n1","author":"user","body":"Hi","created_at":1}],
         "people":[],"items":[
          {"id":"i1","label":"Passport","help":null,"required":true,"status":"rejected","reject_note":"Blurry","reject_reasons":["blurry"],
           "unavailable_note":null,"kind":"file","example":"passport","options":null,"answer":null,"person_pos":null,"expiry_rule":"expiry",
           "valid_months":6,"expires_on":null,"issued_on":null,
           "files":[{"id":"f1","name":"p.jpg","size":10,"uploaded_at":2,"sent_back_at":3}]},
          {"id":"i2","label":"Languages","help":null,"required":false,"status":"submitted","reject_note":null,"reject_reasons":[],
           "unavailable_note":null,"kind":"multi","example":null,"options":["en","fr"],"answer":["en","fr"],"person_pos":null,
           "expiry_rule":null,"valid_months":null,"expires_on":null,"issued_on":null,"files":[]}]}
        """
        Stub.on("GET /api/c/me", .init(body: json))
        let view = try await Stub.client().clientView()
        XCTAssertEqual(view.firmName, "Firm")
        XCTAssertEqual(view.items[0].files[0].sentBackAt, 3)
        XCTAssertEqual(view.items[0].rejectReasons, ["blurry"])
        XCTAssertTrue(view.items[0].isFile)
        XCTAssertEqual(view.items[1].answer?.strings, ["en", "fr"])
    }

    func testAttestsTheKeyOnceThenAssertsOverTheCallsData() async throws {
        Stub.on("POST /api/app/challenge", .init(body: "{\"challenge\":\"c1\",\"required\":true}"), .init(body: "{\"challenge\":\"c2\",\"required\":true}"))
        Stub.on("POST /api/app/attest", .init(body: "{\"ok\":true}"))
        let attester = FakeAttester()
        let store = MemoryStore()
        let check = AppCheck(api: Stub.client(), attester: attester, store: store)

        let proof = try await check.attestation(for: "me@example.com")
        XCTAssertEqual(attester.hashes["attest"], [AppCheck.bindingHash(challenge: "c1", data: "attest")])
        XCTAssertEqual(attester.hashes["assert"], [AppCheck.bindingHash(challenge: "c2", data: "me@example.com")])
        XCTAssertEqual(store.value(for: "appattest.key"), "key1")
        guard case .object(let o)? = proof else { return XCTFail("no proof") }
        XCTAssertEqual(o["challenge"], "c2")
        XCTAssertEqual(o["key_id"], "key1")
        XCTAssertEqual(o["assertion"]?.string, Data("assertion".utf8).base64EncodedString())

        // the next call only asserts
        Stub.on("POST /api/app/challenge", .init(body: "{\"challenge\":\"c3\",\"required\":true}"))
        _ = try await check.attestation(for: "other")
        XCTAssertEqual(attester.keys, 1)
        XCTAssertEqual(attester.hashes["attest"]?.count, 1)
        XCTAssertEqual(attester.hashes["assert"]?.last, AppCheck.bindingHash(challenge: "c3", data: "other"))
    }

    func testNoProofWhenTheWorkerDoesNotCheck() async throws {
        Stub.on("POST /api/app/challenge", .init(body: "{\"challenge\":\"c1\",\"required\":false}"))
        let check = AppCheck(api: Stub.client(), attester: FakeAttester(), store: MemoryStore())
        let proof = try await check.attestation(for: "x")
        XCTAssertNil(proof)
    }

    func testAnUnsupportedPhoneCannotProveItself() async throws {
        Stub.on("POST /api/app/challenge", .init(body: "{\"challenge\":\"c1\",\"required\":true}"))
        let attester = FakeAttester()
        attester.isSupported = false
        let check = AppCheck(api: Stub.client(), attester: attester, store: MemoryStore())
        do {
            _ = try await check.attestation(for: "x")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? AppCheckError, .unsupported)
        }
    }

    func testAKeyTheWorkerRefusesIsMadeAgainOnce() async throws {
        Stub.on("POST /api/app/challenge", .init(body: "{\"challenge\":\"c\",\"required\":true}"))
        Stub.on("POST /api/app/attest", .init(body: "{\"ok\":true}"))
        Stub.on("POST /api/app/auth/start", .init(status: 400, body: "{\"error\":\"attestation\"}"), .init(body: "{\"ok\":true}"))
        let attester = FakeAttester()
        let store = MemoryStore()
        store.set("old", for: "appattest.key")
        let backend = Backend(api: Stub.client(), check: AppCheck(api: Stub.client(), attester: attester, store: store))
        try await backend.sendCode(to: " Me@Example.com ")
        XCTAssertEqual(attester.keys, 1)
        XCTAssertEqual(store.value(for: "appattest.key"), "key1")
    }

    func testTheLinkTokenIsFoundInAnAddress() {
        let token = "na_" + String(repeating: "a", count: 43)
        XCTAssertEqual(ClientLink.token(in: "https://collect.alazy.app/c/\(token)"), token)
        XCTAssertEqual(ClientLink.token(in: token), token)
        XCTAssertNil(ClientLink.token(in: "https://example.com/"))
    }

    func testTheAccountTokenIsTheFirmIdAsAUUID() {
        XCTAssertEqual(APIClient.accountToken(firmId: "0123456789abcdef0123456789ABCDEF"), "01234567-89ab-cdef-0123-456789abcdef")
        XCTAssertNil(APIClient.accountToken(firmId: "short"))
        XCTAssertNotNil(UUID(uuidString: APIClient.accountToken(firmId: String(repeating: "a", count: 32))!))
    }

    func testBillingTellsTheWorkerTheTransaction() async throws {
        Stub.on("POST /api/billing/apple", .init(body: "{\"ok\":true,\"plan_status\":\"active\"}"))
        try await Stub.client().billApple(transaction: "2000000000001")
        XCTAssertEqual(try JSONDecoder().decode(JSON.self, from: Stub.bodies[0]), ["transaction_id": "2000000000001"])
    }

    func testMeDecodes() async throws {
        let json = """
        {"user":{"id":"u","email":"a@b.test","name":null,"role":"owner"},
         "firm":{"id":"f","name":"Firm","tz":"America/Toronto","plan_status":"trialing","trial_ends_at":5,"current_period_end":null,
                 "past_due_since":null,"cancel_at_period_end":false,"subscribed":false,"plan_source":null,"closed_at":null,"held":false,"usable":true}}
        """
        Stub.on("GET /api/me", .init(body: json))
        let me = try await Stub.client().me()
        XCTAssertEqual(me.firm.planStatus, "trialing")
        XCTAssertNil(me.firm.planSource)
        XCTAssertTrue(me.firm.usable)
    }

    func testReviewNamesTheFilesSeen() async throws {
        Stub.on("POST /api/requests/r1/items/i1/review", .init(body: "{\"ok\":true}"))
        let item = try JSONDecoder.snake.decode(ReviewItem.self, from: Data("""
        {"id":"i1","position":1,"label":"T4","help":null,"required":true,"status":"submitted","reject_note":null,"reject_reasons":[],
         "unavailable_note":null,"kind":"file","options":null,"answer":null,"answer_at":null,"hidden":false,"person_pos":null,
         "expires_on":null,"issued_on":null,"expiry_flag":null,
         "files":[{"id":"f1","name":"t4.pdf","size":5,"uploaded_at":1,"sent_back_at":null,"mime":"application/pdf"}]}
        """.utf8))
        try await Stub.client().reject(request: "r1", item: item, reasons: ["blurry"], note: nil)
        let body = try JSONDecoder().decode(JSON.self, from: Stub.bodies[0])
        XCTAssertEqual(body, ["decision": "reject", "reasons": ["blurry"], "note": nil, "files": ["f1"], "answered_at": nil])
    }
}

extension JSONDecoder {
    static var snake: JSONDecoder { APIClient.decoder }
}
